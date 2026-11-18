import {
  BehaviorSubject,
  EMPTY,
  type MonoTypeOperatorFunction,
  type Observable,
  Subject,
  auditTime,
  combineLatest,
  concat,
  concatMap,
  connect,
  defer,
  first,
  forkJoin,
  isObservable,
  map,
  merge,
  of,
  shareReplay,
  skip,
  startWith,
  switchMap,
  take,
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

/**
 * A source of entities to validate (e.g. a Breeze EntityManager, an NgRx store, a list), in one of two shapes:
 * an Observable of the entities, or change notifications plus a reader. Prefer the second for sources that raise
 * many change events: the service reads the entities once per coalesced burst instead of once per event.
 * {@link createEntityStore} builds one from events, callbacks or signals.
 */
export type EntityStore = ObservableEntityStore | NotifyingEntityStore;

/** An {@link EntityStore} that emits its entities whenever they change. */
export interface ObservableEntityStore {
  /** Emits the current entities whenever they change. */
  entities$: Observable<EntityInfo[]>;
  /** Optional fast lookup used for the `store(entityType)` expression function. */
  getEntities?: StoreQuery;
}

/** An {@link EntityStore} that signals changes; the service reads its entities when it validates. */
export interface NotifyingEntityStore {
  /** Emits whenever the entities change. What it emits is ignored. */
  changes$: Observable<unknown>;
  /** Returns the current entities. Read once at the start and once per (coalesced) change. */
  entities(): readonly EntityInfo[];
  /** Optional fast lookup used for the `store(entityType)` expression function. */
  getEntities?: StoreQuery;
}

/**
 * How entity store validation coalesces bursts of changes: a window in ms that starts at the first change of a
 * burst (default 0), or `false` to validate on every change. The first validation always runs immediately.
 */
export type Coalesce = number | false;

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
  /** Entity store validation: overrides {@link ValidationServiceOptions.coalesce} for this call. */
  coalesce?: Coalesce;
}

/**
 * Returns the model type of a model, or undefined when it doesn't recognize the model.
 * @example const breezeModelType: ModelTypeResolver = (m) => isBreezeEntity(m) ? m.entityType.shortName : undefined;
 */
export type ModelTypeResolver = (model: unknown) => string | undefined;

export interface ValidationServiceOptions {
  /** Providers that add context values per model (Angular: VALIDATOR_CONTEXT_PROVIDER). */
  contextProviders?: readonly ValidatorContextProvider[];
  /**
   * Resolve the model type of a model where none is given, such as in the Angular template-driven-forms
   * directives. The first resolver that returns a name wins (Angular: VALIDATION_MODEL_TYPE_RESOLVER).
   */
  modelTypeResolvers?: readonly ModelTypeResolver[];

  /** Trusted functions/values visible to all expressions (e.g. `{ today: () => new Date() }`). */
  expressionScope?: Record<string, unknown>;
  /**
   * Maximum time in ms to wait for the asynchronous validators of one model. On timeout validation
   * continues as if they reported no errors and `onAsyncTimeout` is called. Default 60,000; 0 disables.
   */
  asyncTimeout?: number;
  onAsyncTimeout?: (info: { model: unknown; modelType: string; timeout: number }) => void;
  /**
   * Coalesces bursts of entity store changes into one validation run. Sources often change many times in a row,
   * such as a query that adds 500 entities with one change event each; without coalescing, each change would
   * re-validate the whole store. Default 0: after the first validation, which runs immediately, changes made in
   * the same synchronous block cause a single run once the block finishes. A number collects the changes for that
   * many ms after the first one, then runs once (so a source that never stops changing is still validated regularly);
   * `false` validates on every change. Applies to every trigger: store changes, metadata changes,
   * `options.event$` and {@link ValidationService.revalidate}.
   */
  coalesce?: Coalesce;
  /**
   * The service's entity store: the entities of its scope, such as a unit of work's. See
   * {@link ValidationService.entityStore}.
   */
  entityStore?: EntityStore;
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
  /** The entity stores being validated (`validateEntityStore`, while subscribed), with the entities each held last. */
  private readonly entityStoreState: BehaviorSubject<EntityStore | undefined>;
  /** The latest entities of Observable stores, which can't be read on demand. */
  private readonly snapshots = new WeakMap<EntityStore, readonly EntityInfo[]>();
  private readonly contextProviders: readonly ValidatorContextProvider[];
  private readonly modelTypeResolvers: readonly ModelTypeResolver[];

  private readonly expressionScope: Record<string, unknown>;
  private readonly asyncTimeout: number;
  private readonly onAsyncTimeout?: ValidationServiceOptions['onAsyncTimeout'];
  private readonly coalesce: Coalesce;

  constructor(
    readonly validationMetadata: ValidationMetadata,
    options: ValidationServiceOptions = {},
  ) {
    this.contextProviders = options.contextProviders ?? [];
    this.modelTypeResolvers = options.modelTypeResolvers ?? [];

    this.expressionScope = options.expressionScope ?? {};
    this.asyncTimeout = options.asyncTimeout ?? 60_000;
    this.onAsyncTimeout = options.onAsyncTimeout;
    this.coalesce = options.coalesce ?? 0;
    this.entityStoreState = new BehaviorSubject(options.entityStore);
    this.options = options;
  }

  private readonly options: ValidationServiceOptions;

  /**
   * A service for another scope: the same metadata and options, and its own entity store. A service and its entity
   * store share a scope, such as a unit of work's: one for the app, or one per route (Angular:
   * `provideValidationScope`).
   */
  createScope(entityStore?: EntityStore): ValidationService {
    return new ValidationService(this.validationMetadata, { ...this.options, entityStore });
  }

  /**
   * The service's entity store: the entities of its scope, such as a unit of work's. A single model or a form
   * validated by this service is validated in it:
   *
   * - `store(type)`, and `unique`, see the model's siblings in it (an explicit `options.store` comes first);
   * - the forms re-validate when it changes ({@link entityStoreChanged$}): the model changed in code, or an entity a
   *   rule reads.
   *
   * It's also the store {@link validateEntityStore} validates when given none.
   */
  get entityStore(): EntityStore | undefined {
    return this.entityStoreState.value;
  }

  /** Replaces the entity store, such as when the scope moves on to another unit of work. */
  setEntityStore(entityStore: EntityStore | undefined): void {
    if (entityStore !== this.entityStoreState.value) {
      this.entityStoreState.next(entityStore);
    }
  }

  /** Emits whenever the entities of the {@link entityStore} change, and when another store is set. */
  get entityStoreChanged$(): Observable<void> {
    return this.entityStoreState.pipe(
      switchMap((store, index) => {
        const changes$ = store ? this.changesOf(store) : EMPTY;
        // Another store is a change too; the first one is where we start.
        return index === 0 ? changes$ : concat(of(undefined), changes$);
      }),
      map(() => undefined),
    );
  }

  /** The model type of `model` from the {@link ValidationServiceOptions.modelTypeResolvers}, or undefined. */
  resolveModelType(model: unknown): string | undefined {
    for (const resolve of this.modelTypeResolvers) {
      const modelType = resolve(model);
      if (modelType) {
        return modelType;
      }
    }
    return undefined;
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
   * Continuously validates all entities of a store, by default the service's {@link entityStore}. Re-validates when the
   * entities change, the metadata changes, `options.event$` emits or {@link revalidate} is called. Sync results are
   * emitted immediately; async results as they arrive.
   */
  validateEntityStore(entityStore?: EntityStore, options?: ValidationOptions): Observable<EntitiesValidationResult> {
    const store = entityStore ?? this.entityStore;
    if (!store) {
      throw new Error('validateEntityStore: pass an entity store, or give the service one (entityStore).');
    }
    return this.trigger(store, options).pipe(
      switchMap((entities) => {
        const opts = this.withStore(store, entities, options);
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
    // A notifying store is read only after coalescing, so a burst of changes costs one read, not one per change.
    const read = 'entities$' in entityStore ? undefined : () => Array.from(entityStore.entities());
    const source$: Observable<unknown> = 'entities$' in entityStore ? entityStore.entities$ : entityStore.changes$.pipe(startWith(null));
    return combineLatest([
      source$,
      this.validationMetadata.metadataChanged$.pipe(startWith(this.validationMetadata)),
      options?.event$ ? options.event$.pipe(startWith(null)) : of(null),
      this.revalidateRequested.pipe(startWith(null)),
    ]).pipe(
      coalesceAfterFirst(options?.coalesce ?? this.coalesce),
      map(([entities]) => (read ? read() : (entities as EntityInfo[]))),
    );
  }

  private withStore(entityStore: EntityStore, entities: EntityInfo[], options?: ValidationOptions): ValidationOptions {
    return { store: entityStore.getEntities ?? storeFromEntities(entities), ...options };
  }

  /** `store(type)` of the service's entity store. */
  private entityStoreQuery(): StoreQuery | undefined {
    const store = this.entityStore;
    if (!store) {
      return undefined;
    }
    if (store.getEntities) {
      return store.getEntities;
    }
    return (entityType) => this.entitiesOf(store).filter((ei) => ei.entityType === entityType).map((ei) => ei.entity);
  }

  /** A store's current entities: read from a notifying store; the latest emitted by an Observable one. */
  private entitiesOf(store: EntityStore): readonly EntityInfo[] {
    if ('changes$' in store) {
      return store.entities();
    }
    if (!this.snapshots.has(store)) {
      // Nobody listens yet: take the entities it emits on subscribe, if it replays them.
      store.entities$.pipe(take(1)).subscribe((entities) => this.snapshots.set(store, entities));
    }
    return this.snapshots.get(store) ?? [];
  }

  /** Emits when a store's entities change. */
  private changesOf(store: EntityStore): Observable<unknown> {
    if ('changes$' in store) {
      return store.changes$;
    }
    return store.entities$.pipe(
      tap((entities) => this.snapshots.set(store, entities)),
      skip(1), // the first emission is the current entities, not a change
    );
  }

  private entitiesPassingCondition(entities: EntityInfo[], options: ValidationOptions): EntityInfo[] {
    const resolver = options.conditionContextResolver;
    const scope = this.buildExpressionScope(options);
    return entities.filter((ei) => this.validationMetadata.getModelMetadata(ei.entityType).evalCondition(entities, ei.entity, resolver, scope));
  }

  /** A missing `options.store` falls back to the service's entity store. */
  private buildExpressionScope(options?: ValidationOptions): Record<string, unknown> {
    const store = options?.store ?? this.entityStoreQuery();
    return {
      ...this.expressionScope,
      ...(store ? { store } : {}),
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
        const propertyNames = validatorMetadata.propertyNames;
        add(validatorMetadata, model, {
          ...base,
          ...(propertyNames ? { propertyNames } : {}),
          ...(validatorMetadata.context as ValidationContextBase),
        } as ValidationContext);
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

/** Passes the first value through at once, then emits the latest value of each burst ({@link Coalesce}). */
function coalesceAfterFirst<T>(coalesce: Coalesce): MonoTypeOperatorFunction<T> {
  if (coalesce === false) {
    return (source) => source;
  }
  return connect((shared) => merge(shared.pipe(take(1)), shared.pipe(skip(1), auditTime(coalesce))));
}

function storeFromEntities(entities: readonly EntityInfo[]): StoreQuery {
  return (entityType: string) => entities.filter((ei) => ei.entityType === entityType).map((ei) => ei.entity);
}

/** Creates a static {@link EntityStore} from a list of entities. */
export function entityStoreOf(entities: EntityInfo[] | Observable<EntityInfo[]>): EntityStore {
  return { entities$: isObservable(entities) ? entities : of(entities) };
}
