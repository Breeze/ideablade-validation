/**
 * Breeze (breeze-client 3) integration.
 *
 * Two directions:
 * 1. Breeze → this framework: `breezeValidator` is a validator named `breeze` that runs Breeze's own
 *    validation and reports Breeze's errors as ValidationErrors: sync validators from `validateModelSync`, sync and
 *    async validators (`validateEntityAsync()`, Breeze 3) from `validateModelAsync` and `validate`.
 *    Typically registered as a global validator in the metadata: `{ "global": { "validators": ["breeze"] } }`.
 * 2. This framework → Breeze: `installBreezeValidators` adds Breeze `Validator`s to the entity types of a
 *    MetadataStore so that Breeze's own validation (property changes, `validateEntity`, save) runs the metadata rules.
 *
 * Plus `breezeEntityStore` to validate the contents of an EntityManager with `ValidationService.validateEntityStore`.
 */
import {
  type Entity,
  type EntityManager,
  EntityState,
  type EntityType,
  type MetadataStore,
  Validator as BreezeValidator,
  type ValidationMessageContext,
  type ValidationError as BreezeValidationError,
} from 'breeze-client';
import { Observable, auditTime, defer, firstValueFrom, map, startWith } from 'rxjs';

import type { EntityInfo, ValidationContext, ValidationContextBase, ValidatorFunctionContext } from '../core/context.js';
import type { ValidatorMetadata } from '../core/metadata.js';
import { ValidationError, getPath } from '../core/validation-error.js';
import type { EntityStore, ModelTypeResolver, ValidationOptions, ValidationService } from '../core/validation-service.js';
import { type Validator, ValidatorBase, type ValidatorFactory } from '../core/validator.js';

/** True for Breeze entities (objects with an entityAspect). */
export function isBreezeEntity(value: unknown): value is Entity {
  return typeof value === 'object' && value !== null && 'entityAspect' in value && 'entityType' in value;
}

/**
 * Model type resolver for Breeze entities: the entity type's short name; undefined for anything else.
 * Register it with `modelTypeResolvers: [breezeModelType]` (Angular: `provideValidation({ modelTypeResolvers: [breezeModelType] })`).
 */
export const breezeModelType: ModelTypeResolver = (model) => (isBreezeEntity(model) ? model.entityType.shortName : undefined);

/**
 * Validator `breeze`: runs Breeze's validation for the model (an entity) and maps the resulting errors.
 * `validateModelSync` runs Breeze's sync validators (`entityAspect.validateEntity()`). `validateModelAsync` and
 * `validate` run all of them, sync and async (`entityAspect.validateEntityAsync()`, Breeze 3), the way Breeze does on save.
 */
export class BreezeValidationAdapter extends ValidatorBase implements Validator {
  readonly isAsync = false;
  declare metadata?: ValidatorMetadata;

  constructor(group?: string, context?: Partial<ValidationContextBase>) {
    super('breeze', group, { ...context, messageTemplate: context?.messageTemplate || 'Breeze validation error' });
  }

  static create(group?: string, context?: Partial<ValidationContextBase>): BreezeValidationAdapter {
    return new BreezeValidationAdapter(group, context);
  }

  validate(value: unknown, context?: ValidationContext): ValidationError[] | null {
    if (!isBreezeEntity(value) || isRunning(value)) {
      return null;
    }
    value.entityAspect.validateEntity();
    // Errors left over from an earlier async run are not this (sync) run's result.
    return mapBreezeErrors(this, value, this.getValidatorFunctionContext(value, context), (e) => !e.validator?.isAsync);
  }

  validateAsync(value: unknown, context?: ValidationContext): Observable<ValidationError[] | null> {
    return defer(async () => {
      if (!isBreezeEntity(value) || isRunning(value)) {
        return null;
      }
      await value.entityAspect.validateEntityAsync();
      return mapBreezeErrors(this, value, this.getValidatorFunctionContext(value, context), () => true);
    });
  }
}

/** Maps the entity's current Breeze errors that pass `include` (skipping errors of validators installed by {@link installBreezeValidators}). */
function mapBreezeErrors(
  validator: Validator,
  entity: Entity,
  ctx: ValidatorFunctionContext,
  include: (error: BreezeValidationError) => boolean,
): ValidationError[] | null {
  const breezeErrors = entity.entityAspect
    .getValidationErrors()
    .filter((e) => !(e.validator && INSTALLED.has(e.validator)) && include(e));
  if (breezeErrors.length === 0) {
    return null;
  }
  return breezeErrors.map((breezeError) => {
    const validatorCtx: Record<string, unknown> = { ...(breezeError.validator?.context ?? {}) };
    for (const key of Object.keys(validatorCtx)) {
      if (key.startsWith('$')) {
        delete validatorCtx[key];
      }
    }
    const property = breezeError.propertyName ? ctx.metadata?.getProperty(breezeError.propertyName) : undefined;
    const errorCtx = {
      ...breezeError.context,
      ...ctx,
      ...validatorCtx,
      propertyName: breezeError.propertyName ?? ctx.propertyName,
      displayName: property?.displayName || breezeError.property?.displayName || ctx.displayName,
      value: breezeError.propertyName ? getPath(entity, breezeError.propertyName) : entity,
      // Breeze has already formatted the message; use it verbatim.
      messageTemplate: breezeError.errorMessage,
      breezeError,
    } as ValidatorFunctionContext;
    return new BreezeMappedValidationError(breezeError.key, errorCtx, validator, breezeError.errorMessage);
  });
}

/** A ValidationError carrying a message already formatted by Breeze. */
export class BreezeMappedValidationError extends ValidationError {
  constructor(
    key: string,
    context: ValidatorFunctionContext,
    validator: Validator,
    private readonly breezeMessage: string,
  ) {
    super(key, context, validator);
  }

  override getErrorMessage(): string {
    return this.breezeMessage;
  }
}

/** Factory for the `breeze` validator. */
export const breezeValidator: ValidatorFactory = { name: 'breeze', fn: BreezeValidationAdapter.create };

/** Marker set on an entityAspect while metadata rules run from inside Breeze, to avoid recursion with the `breeze` validator. */
const RUNNING = Symbol('ideablade-validation-running');

/** Breeze validators added by {@link installBreezeValidators}; the `breeze` validators skip their errors. */
const INSTALLED = new WeakSet<BreezeValidator>();

function isRunning(entity: Entity): boolean {
  return !!(entity.entityAspect as { [RUNNING]?: boolean })[RUNNING];
}

export interface InstallBreezeValidatorsOptions {
  /** Entity type short names to install on. Default: every entity type that has metadata or global validators. */
  entityTypes?: string[];
  /** Options passed to each validation (predicate, context, ...). */
  validationOptions?: ValidationOptions;
  /** Also install async validators (run by Breeze on save and validateEntityAsync). Default true. */
  includeAsync?: boolean;
  /** Validator name prefix used in Breeze. Default `ideablade`. */
  name?: string;
}

/**
 * Adds Breeze validators to the entity types of a MetadataStore that run this framework's metadata rules:
 * one per property with metadata (so errors attach to the property and re-validate on change) and one
 * entity-level validator for model-level rules. Returns a function that removes them again (Breeze keeps
 * errors already recorded by removed validators; call `entityAspect.clearValidationErrors()` to drop them).
 */
export function installBreezeValidators(
  metadataStore: MetadataStore,
  service: ValidationService,
  options: InstallBreezeValidatorsOptions = {},
): () => void {
  const prefix = options.name ?? 'ideablade';
  const includeAsync = options.includeAsync ?? true;
  const installed: { list: BreezeValidator[]; validator: BreezeValidator }[] = [];
  const add = (list: BreezeValidator[], validator: BreezeValidator) => {
    list.push(validator);
    installed.push({ list, validator });
  };

  const entityTypes = (metadataStore.getEntityTypes() as EntityType[]).filter(
    (t) => 'keyProperties' in t && (!options.entityTypes || options.entityTypes.includes(t.shortName)),
  );

  for (const entityType of entityTypes) {
    const modelType = entityType.shortName;
    const modelMetadata = service.validationMetadata.getModelMetadata(modelType);
    const notBreeze = (v: ValidatorMetadata) => v.name !== 'breeze';
    const userPredicate = options.validationOptions?.predicate ?? (() => true);

    const run = (entity: Entity, predicate: ValidationOptions['predicate'], async: boolean): Promise<ValidationError[]> | ValidationError[] => {
      const opts: ValidationOptions = {
        store: (type) => entity.entityAspect.entityManager?.getEntities(type) ?? [],
        ...options.validationOptions,
        // The async Breeze validator runs only the async rules; the sync one already covers the others.
        predicate: (v, p) => notBreeze(v) && (!async || v.async) && userPredicate(v, p) && predicate!(v, p),
      };
      const aspect = entity.entityAspect as { [RUNNING]?: boolean };
      aspect[RUNNING] = true;
      try {
        return async ? firstValueFrom(service.validateModelAsync(entity, modelType, opts)) : service.validateModelSync(entity, modelType, opts);
      } finally {
        aspect[RUNNING] = false;
      }
    };

    const makeValidator = (name: string, predicate: NonNullable<ValidationOptions['predicate']>, async: boolean) => {
      const context: ValidationMessageContext = {
        isAsync: async,
        messageTemplate: '%message%',
        message: (vc: ValidationMessageContext) => ((vc as { errors?: ValidationError[] }).errors ?? []).map((e) => e.errorMessage).join('; '),
      };
      const valFn = (value: unknown, ctx: ValidationMessageContext) => {
        const entity = (ctx.entity ?? value) as Entity;
        if (!isBreezeEntity(entity)) {
          return true;
        }
        const result = run(entity, predicate, async);
        const finish = (errors: ValidationError[]) => {
          (ctx as { errors?: ValidationError[] }).errors = errors;
          return errors.length === 0;
        };
        return result instanceof Promise ? result.then(finish) : finish(result);
      };
      const validator = new BreezeValidator(name, valFn, context);
      INSTALLED.add(validator);
      return validator;
    };

    const modelLevel = (v: ValidatorMetadata, p?: unknown) => !p && notBreeze(v);
    const hasModelRules = (async: boolean) => modelMetadata.validators.some((v) => v.async === async && notBreeze(v));
    if (hasModelRules(false)) {
      add(entityType.validators, makeValidator(prefix, modelLevel, false));
    }
    if (includeAsync && hasModelRules(true)) {
      add(entityType.validators, makeValidator(`${prefix}Async`, modelLevel, true));
    }

    for (const property of modelMetadata.properties) {
      const breezeProperty = entityType.getProperty(property.propertyName);
      if (!breezeProperty) {
        continue;
      }
      const forProperty = (v: ValidatorMetadata, p?: { propertyName: string }) => p?.propertyName === property.propertyName;
      if (property.validators.some((v) => !v.async)) {
        add(breezeProperty.validators, makeValidator(prefix, forProperty as never, false));
      }
      if (includeAsync && property.validators.some((v) => v.async)) {
        add(breezeProperty.validators, makeValidator(`${prefix}Async`, forProperty as never, true));
      }
    }
  }

  return () => {
    for (const { list, validator } of installed) {
      const ix = list.indexOf(validator);
      if (ix >= 0) {
        list.splice(ix, 1);
      }
    }
  };
}

export interface BreezeEntityStoreOptions {
  /** Only include these entity types (short names). */
  entityTypes?: string[];
  /** Only include entities in these states. Default: all attached states (not Detached). */
  entityStates?: EntityState[];
  /** Coalesce bursts of entity changes (ms). Default 0 (one emission per macrotask). Use -1 to emit synchronously. */
  auditTime?: number;
}

/** Wraps a Breeze EntityManager as an {@link EntityStore}; emits whenever entities are added, removed or changed. */
export function breezeEntityStore(manager: EntityManager, options: BreezeEntityStoreOptions = {}): EntityStore {
  const read = (): EntityInfo[] =>
    (manager.getEntities(options.entityTypes ?? undefined, options.entityStates ?? undefined) as Entity[])
      .filter((e) => !e.entityAspect.entityState.isDetached())
      .map((entity) => ({ entityType: entity.entityType.shortName, entity }));

  const changes$ = new Observable<void>((subscriber) => {
    const token = manager.entityChanged.subscribe(() => subscriber.next());
    return () => manager.entityChanged.unsubscribe(token);
  });
  const audit = options.auditTime ?? 0;
  const entities$ = (audit >= 0 ? changes$.pipe(auditTime(audit)) : changes$).pipe(
    startWith(undefined),
    map(() => read()),
  );

  return {
    entities$,
    getEntities: (entityType: string) => manager.getEntities(entityType) as Entity[],
  };
}

/** Re-export for convenience. */
export { EntityState };
