import {
  type Observable,
  Subject,
  combineLatest,
  concat,
  concatMap,
  defer,
  first,
  forkJoin,
  isObservable,
  map,
  of,
  shareReplay,
  startWith,
  switchMap,
  tap,
  timeout,
} from 'rxjs';

import type {
  EntityInfo,
  GlobalValidationContext,
  StoreQuery,
  ValidationContext,
  ValidationContextBase,
  ValidatorContextProvider,
} from './context.js';
import type { ConditionContextResolver, ModelMetadata, PropertyMetadata, ValidationMetadata, ValidatorMetadata } from './metadata.js';
import type { ValidationError } from './validation-error.js';
import type { AsyncValidationOutcome, SyncValidationOutcome, Validator } from './validator.js';

/** Decides whether a validator runs. Receives the property metadata for property validators. */
export type ValidatorPredicate = (validator: ValidatorMetadata, property?: PropertyMetadata) => boolean;

export interface EntitiesValidationResult {
  entities: EntityInfo[];
  validationErrors: ValidationError[];
}

/** Result of {@link ValidationService.validate}: sync errors immediately, async errors when complete. */
export interface ModelValidationState {
  errors: ValidationError[];
  /** True while asynchronous validators are still running. */
  pending: boolean;
}

/** A source of entities to validate (e.g. a Breeze EntityManager, an NgRx store, a list). */
export interface EntityStore {
  /** Emits the current entities whenever they change. */
  entities$: Observable<EntityInfo[]>;
  /** Optional fast lookup used for the `store(entityType)` expression function. */
  getEntities?: StoreQuery;
}

export interface ValidationOptions {
  /** Controls which validators run. */
  predicate?: ValidatorPredicate;
  /** Values merged into every validator's context. */
  context?: GlobalValidationContext;
  /** Emitting on this observable re-runs entity store validation. */
  event$?: Observable<unknown>;
  /** Substitutes the context used to evaluate conditions. */
  conditionContextResolver?: ConditionContextResolver;
  /** Implementation of the `store(entityType)` expression function for this call. */
  store?: StoreQuery;
  /** Additional trusted functions/values visible to expressions for this call. */
  expressionScope?: Record<string, unknown>;
}

export interface ValidationServiceOptions {
  /** Providers that add context values per model (Angular: VALIDATOR_CONTEXT_PROVIDER). */
  contextProviders?: readonly ValidatorContextProvider[];
  /** Trusted functions/values visible to all expressions (e.g. `{ today: () => new Date() }`). */
  expressionScope?: Record<string, unknown>;
  /**
   * Maximum time in ms to wait for the asynchronous validators of one model. On timeout validation
   * continues as if they reported no errors and `onAsyncTimeout` is called. Default 60,000; 0 disables.
   */
  asyncTimeout?: number;
  onAsyncTimeout?: (info: { model: unknown; modelType: string; timeout: number }) => void;
}

const all: ValidatorPredicate = () => true;

function flatten(outcomes: readonly SyncValidationOutcome[]): ValidationError[] {
  return outcomes.flatMap((o) => (o == null ? [] : Array.isArray(o) ? o : [o]));
}

/**
 * Runs the validators described by {@link ValidationMetadata} against models.
 * Framework-agnostic; Angular and React integrations wrap an instance of this class.
 */
export class ValidationService {
  private readonly modelValidated = new Subject<{ modelInfo: EntityInfo; validationErrors: ValidationError[] }>();
  private readonly revalidateRequested = new Subject<unknown>();
  private readonly contextProviders: readonly ValidatorContextProvider[];
  private readonly expressionScope: Record<string, unknown>;
  private readonly asyncTimeout: number;
  private readonly onAsyncTimeout?: ValidationServiceOptions['onAsyncTimeout'];

  constructor(
    readonly validationMetadata: ValidationMetadata,
    options: ValidationServiceOptions = {},
  ) {
    this.contextProviders = options.contextProviders ?? [];
    this.expressionScope = options.expressionScope ?? {};
    this.asyncTimeout = options.asyncTimeout ?? 60_000;
    this.onAsyncTimeout = options.onAsyncTimeout;
  }

  /** Emits after each model validation (sync or async). */
  get modelValidated$(): Observable<{ modelInfo: EntityInfo; validationErrors: ValidationError[] }> {
    return this.modelValidated.asObservable();
  }

  /** Re-runs all active entity store validations, e.g. after a change the store does not report. */
  revalidate(reason?: unknown): void {
    this.revalidateRequested.next(reason);
  }

  /** Runs the synchronous validators for a model. Returns an empty array when valid. */
  validateModelSync(model: unknown, modelType: string, options?: ValidationOptions): ValidationError[] {
    const errors = flatten(this.plan(model, modelType, options, true).map(runSync));
    this.notify(model, modelType, errors);
    return errors;
  }

  /**
   * Runs all validators for a model, sync and async, and emits all errors once. The observable is cold and completes.
   * Async validators are subject to `asyncTimeout`: on timeout they count as valid and the sync errors are emitted.
   * A sync validator that implements `validateAsync` (such as `breeze`) runs that instead of `validate`.
   */
  validateModelAsync(model: unknown, modelType: string, options?: ValidationOptions): Observable<ValidationError[]> {
    return defer(() => {
      const { syncErrors, async$ } = this.split(this.plan(model, modelType, options));
      return this.complete(model, modelType, syncErrors, async$);
    });
  }

  /**
   * Runs all validators for a model. Emits the sync errors immediately (`pending: true` while async validators
   * run) and then all errors once async validation completes. Every validator runs once.
   */
  validate(model: unknown, modelType: string, options?: ValidationOptions): Observable<ModelValidationState> {
    return defer(() => {
      const steps = this.plan(model, modelType, options);
      // Validators with a full async check show their sync result while the async check runs.
      const interimErrors = flatten(steps.filter((s) => !s.validator.isAsync && s.validator.validateAsync).map(runSync));
      const { syncErrors, async$ } = this.split(steps);
      if (async$.length === 0) {
        this.notify(model, modelType, syncErrors);
        return of({ errors: syncErrors, pending: false });
      }
      return concat(
        of({ errors: [...syncErrors, ...interimErrors], pending: true }),
        this.complete(model, modelType, syncErrors, async$).pipe(map((errors) => ({ errors, pending: false }))),
      );
    });
  }

  /**
   * True if validating the model type involves asynchronous work: async validators, or sync validators with a
   * `validateAsync` check (optionally filtered by a predicate).
   */
  hasAsyncValidators(modelType: string, predicate: ValidatorPredicate = all): boolean {
    const metadata = this.validationMetadata.getModelMetadata(modelType);
    const isAsync = (v: ValidatorMetadata) => v.async || !!v.getValidator().validateAsync;
    return (
      metadata.validators.some((v) => isAsync(v) && predicate(v)) ||
      metadata.properties.some((p) => p.validators.some((v) => isAsync(v) && predicate(v, p)))
    );
  }

  /**
   * Continuously validates all entities of a store. Re-validates when the entities change, the metadata changes,
   * `options.event$` emits or {@link revalidate} is called. Sync results are emitted immediately; async results as they arrive.
   */
  validateEntityStore(entityStore: EntityStore, options?: ValidationOptions): Observable<EntitiesValidationResult> {
    return this.trigger(entityStore, options).pipe(
      switchMap((entities) => {
        const opts = this.withStore(entityStore, entities, options);
        const valid = entities.length ? this.entitiesPassingCondition(entities, opts) : [];
        if (valid.length === 0) {
          return of({ entities, validationErrors: [] as ValidationError[] });
        }
        return combineLatest(valid.map((ei) => this.validate(ei.entity, ei.entityType, opts).pipe(map((s) => s.errors)))).pipe(
          map((results) => ({ entities, validationErrors: results.flat() })),
        );
      }),
      shareReplay({ bufferSize: 1, refCount: true }),
    );
  }

  /** Validates all entities of a store once (sync and async) and completes. */
  validateEntityStoreOneTime(entityStore: EntityStore, options?: ValidationOptions): Observable<EntitiesValidationResult> {
    return this.trigger(entityStore, options).pipe(
      first(),
      concatMap((entities) => this.validateEntities(entities, this.withStore(entityStore, entities, options))),
    );
  }

  /** Validates a list of entities once (sync and async) and completes. */
  validateEntities(entities: EntityInfo[], options?: ValidationOptions): Observable<EntitiesValidationResult> {
    return defer(() => {
      const opts: ValidationOptions = { store: storeFromEntities(entities), ...options };
      const valid = entities.length ? this.entitiesPassingCondition(entities, opts) : [];
      if (valid.length === 0) {
        return of({ entities, validationErrors: [] as ValidationError[] });
      }
      return forkJoin(valid.map((ei) => this.validateModelAsync(ei.entity, ei.entityType, opts))).pipe(
        map((results) => ({ entities, validationErrors: results.flat() })),
      );
    });
  }

  private trigger(entityStore: EntityStore, options?: ValidationOptions): Observable<EntityInfo[]> {
    return combineLatest([
      entityStore.entities$,
      this.validationMetadata.metadataChanged$.pipe(startWith(this.validationMetadata)),
      options?.event$ ? options.event$.pipe(startWith(null)) : of(null),
      this.revalidateRequested.pipe(startWith(null)),
    ]).pipe(map(([entities]) => entities));
  }

  private withStore(entityStore: EntityStore, entities: EntityInfo[], options?: ValidationOptions): ValidationOptions {
    return { store: entityStore.getEntities ?? storeFromEntities(entities), ...options };
  }

  private entitiesPassingCondition(entities: EntityInfo[], options: ValidationOptions): EntityInfo[] {
    const resolver = options.conditionContextResolver;
    const scope = this.buildExpressionScope(options);
    return entities.filter((ei) => this.validationMetadata.getModelMetadata(ei.entityType).evalCondition(entities, ei.entity, resolver, scope));
  }

  private buildExpressionScope(options?: ValidationOptions): Record<string, unknown> {
    return {
      ...this.expressionScope,
      ...(options?.store ? { store: options.store } : {}),
      ...options?.expressionScope,
    };
  }

  /** Runs the sync part of the steps and starts the async part (async validators and `validateAsync` checks). */
  private split(steps: Step[]): { syncErrors: ValidationError[]; async$: AsyncValidationOutcome[] } {
    const syncErrors: ValidationError[] = [];
    const async$: AsyncValidationOutcome[] = [];
    for (const step of steps) {
      const { validator, value, context } = step;
      if (validator.isAsync) {
        const outcome = validator.validate(value, context);
        async$.push(isObservable(outcome) ? outcome : of(outcome));
      } else if (validator.validateAsync) {
        async$.push(validator.validateAsync(value, context));
      } else {
        syncErrors.push(...flatten([runSync(step)]));
      }
    }
    return { syncErrors, async$ };
  }

  /** Waits for the async outcomes (with the timeout) and emits the sync errors plus the async errors. */
  private complete(model: unknown, modelType: string, syncErrors: ValidationError[], async$: AsyncValidationOutcome[]): Observable<ValidationError[]> {
    if (async$.length === 0) {
      this.notify(model, modelType, syncErrors);
      return of(syncErrors);
    }
    let asyncErrors$ = forkJoin(async$).pipe(map(flatten));
    if (this.asyncTimeout > 0) {
      asyncErrors$ = asyncErrors$.pipe(
        timeout({
          first: this.asyncTimeout,
          with: () => {
            this.onAsyncTimeout?.({ model, modelType, timeout: this.asyncTimeout });
            return of([] as ValidationError[]);
          },
        }),
      );
    }
    return asyncErrors$.pipe(
      map((asyncErrors) => [...syncErrors, ...asyncErrors]),
      tap((errors) => this.notify(model, modelType, errors)),
    );
  }

  private notify(model: unknown, modelType: string, errors: ValidationError[]): void {
    this.modelValidated.next({ modelInfo: { entity: model, entityType: modelType }, validationErrors: errors });
  }

  /** The validators to run for a model, with their values and contexts. Applies the predicate and conditions. */
  private plan(model: unknown, modelType: string, options?: ValidationOptions, syncOnly = false): Step[] {
    const metadata: ModelMetadata = this.validationMetadata.getModelMetadata(modelType);
    const predicate = options?.predicate ?? all;
    const resolver = options?.conditionContextResolver;

    const providedContext = this.contextProviders.reduce<Record<string, unknown>>(
      (ctx, provider) => ({ ...ctx, ...(provider.contextFn(model, modelType) ?? {}) }),
      {},
    );
    const base = {
      ...(options?.context ?? {}),
      ...providedContext,
      model,
      modelType,
      metadata,
      isClient: true,
      isServer: false,
      expressionEvaluator: this.validationMetadata.expressionEvaluator,
      expressionScope: this.buildExpressionScope(options),
    };

    const steps: Step[] = [];
    const add = (validatorMetadata: ValidatorMetadata, value: unknown, context: ValidationContext) => {
      if ((!syncOnly || !validatorMetadata.async) && validatorMetadata.evalCondition(context, resolver)) {
        steps.push({ validator: validatorMetadata.getValidator(), value, context });
      }
    };

    for (const validatorMetadata of metadata.validators) {
      if (predicate(validatorMetadata)) {
        add(validatorMetadata, model, { ...base, ...(validatorMetadata.context as ValidationContextBase) } as ValidationContext);
      }
    }

    for (const property of metadata.properties) {
      for (const validatorMetadata of property.validators) {
        if (predicate(validatorMetadata, property)) {
          const context = {
            ...base,
            propertyName: property.propertyName,
            displayName: property.displayName,
            ...(validatorMetadata.context as ValidationContextBase),
          } as ValidationContext;
          add(validatorMetadata, property.getValue(model), context);
        }
      }
    }
    return steps;
  }
}

/** A validator to run, with its value and context. */
interface Step {
  validator: Validator;
  value: unknown;
  context: ValidationContext;
}

function runSync(step: Step): SyncValidationOutcome {
  const outcome = step.validator.validate(step.value, step.context);
  return isObservable(outcome) ? null : outcome;
}

function storeFromEntities(entities: readonly EntityInfo[]): StoreQuery {
  return (entityType: string) => entities.filter((ei) => ei.entityType === entityType).map((ei) => ei.entity);
}

/** Creates a static {@link EntityStore} from a list of entities. */
export function entityStoreOf(entities: EntityInfo[] | Observable<EntityInfo[]>): EntityStore {
  return { entities$: isObservable(entities) ? entities : of(entities) };
}
