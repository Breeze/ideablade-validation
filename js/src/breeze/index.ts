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
import { type Observable, defer, firstValueFrom } from 'rxjs';

import type { EntityInfo, ValidationContext, ValidationContextBase, ValidatorFunctionContext } from '../core/context.js';
import { createEntityStore } from '../core/entity-store.js';
import type { RuleSource, ValidatorMetadata } from '../core/metadata.js';
import { ValidationError, getPath } from '../core/validation-error.js';
import type {
  ModelTypeResolver,
  NotifyingEntityStore,
  ValidationOptions,
  ValidationService,
} from '../core/validation-service.js';
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
 * The entity states that count as "in the store": Unchanged, Added and Modified. Deleted entities stay in the manager
 * until saved, but they are on their way out; detached entities aren't in it at all.
 */
const LIVE_STATES = [EntityState.Unchanged, EntityState.Added, EntityState.Modified];

/** The live entities of a manager (see {@link LIVE_STATES}), optionally of some types and in some states. */
function liveEntities(manager: EntityManager, entityTypes?: string | string[], states: EntityState[] = LIVE_STATES): Entity[] {
  return manager.getEntities(entityTypes, states.filter((st) => !st.isDetached())) as Entity[];
}


/** A Breeze data or navigation property: both carry validators and a display name. */
type BreezeProperty = { readonly name: string; readonly validators: BreezeValidator[]; readonly displayName?: string };

/**
 * Validator `breezeProperty`: runs the Breeze validators of one entity property (`context.breezeProperty`) against a
 * value, without an entity. Used by {@link breezeRuleSource} so that a view model property declared with
 * `"from": "StaffingResource.firstName"` gets the rules Breeze built from the server model. `validateModelSync` runs
 * Breeze's sync validators; `validateModelAsync` and `validate` run all of them, sync and async.
 *
 * `validateAsync` is only there when the property has async Breeze validators. Without them the rule is plain sync,
 * so a form isn't left pending, waiting for an async check that has nothing to do.
 */
export class BreezePropertyValidator extends ValidatorBase implements Validator {
  readonly isAsync = false;
  declare metadata?: ValidatorMetadata;
  /** Runs all of the property's Breeze validators, sync and async; present only when it has async ones. */
  readonly validateAsync?: (value: unknown, context?: ValidationContext) => Observable<ValidationError[] | null>;

  constructor(group?: string, context?: Partial<ValidationContextBase>) {
    super('breezeProperty', group, { ...context, messageTemplate: context?.messageTemplate || 'Breeze validation error' });
    if ((context?.breezeProperty as BreezeProperty | undefined)?.validators.some((v) => v.isAsync)) {
      this.validateAsync = (value, context) => this.validateAll(value, context);
    }
  }

  static create(group?: string, context?: Partial<ValidationContextBase>): BreezePropertyValidator {
    return new BreezePropertyValidator(group, context);
  }

  validate(value: unknown, context?: ValidationContext): ValidationError[] | null {
    const ctx = this.getValidatorFunctionContext(value, context);
    const property = ctx.breezeProperty as BreezeProperty;
    return checkBreezeProperty(this, property, property.validators.filter((v) => !v.isAsync), value, ctx);
  }

  private validateAll(value: unknown, context?: ValidationContext): Observable<ValidationError[] | null> {
    return defer(async () => {
      const ctx = this.getValidatorFunctionContext(value, context);
      const property = ctx.breezeProperty as BreezeProperty;
      const breezeContext = breezeMessageContext(property, ctx);
      return mapPropertyErrors(this, await Promise.all(property.validators.map((v) => v.validateAsync(value, breezeContext))), ctx);
    });
  }
}

/** Breeze formats its messages with the display name of the property being validated, not of the source property. */
function breezeMessageContext(property: BreezeProperty, ctx: ValidatorFunctionContext, entity?: unknown): ValidationMessageContext {
  return {
    ...(entity ? { entity } : {}),
    property,
    propertyName: property.name,
    displayName: ctx.displayName || property.displayName,
  } as ValidationMessageContext;
}

/** Runs Breeze property validators on a value and maps their errors (sync validators only). */
function checkBreezeProperty(
  validator: Validator,
  property: BreezeProperty,
  validators: BreezeValidator[],
  value: unknown,
  ctx: ValidatorFunctionContext,
  entity?: unknown,
): ValidationError[] | null {
  const breezeContext = breezeMessageContext(property, ctx, entity);
  return mapPropertyErrors(validator, validators.map((v) => v.validate(value, breezeContext)), ctx);
}

/** Maps the errors of Breeze property validators. Keys follow the framework's convention (`required_firstName`). */
function mapPropertyErrors(validator: Validator, results: (BreezeValidationError | null)[], ctx: ValidatorFunctionContext): ValidationError[] | null {
  const errors = results.filter((e): e is BreezeValidationError => !!e);
  if (errors.length === 0) {
    return null;
  }
  return errors.map((breezeError) => {
    const name = breezeError.validator?.name ?? breezeError.key;
    const key = [name, validator.group, ctx.propertyName].filter(Boolean).join('_');
    const errorCtx = { ...ctx, messageTemplate: breezeError.errorMessage, breezeError } as ValidatorFunctionContext;
    return new BreezeMappedValidationError(key, errorCtx, validator, breezeError.errorMessage);
  });
}

/** Factory for the `breezeProperty` validator ({@link breezeRuleSource} registers it). */
export const breezePropertyValidator: ValidatorFactory = { name: 'breezeProperty', fn: BreezePropertyValidator.create };

/**
 * A rule source for Breeze's metadata: a property declared with `"from": "StaffingResource.firstName"` inherits the
 * validators Breeze has for that entity property (from the server model's `[Required]`, `[StringLength]` and so on,
 * plus any you added) and its display name. Pass the MetadataStore, or a function returning it if it is loaded later.
 *
 * @example
 * createValidationService({ metadata, ruleSources: [breezeRuleSource(manager.metadataStore)] });
 * // Angular: provideRuleSources(() => breezeRuleSource(inject(EntityManagerProvider).metadataStore))
 */
export function breezeRuleSource(metadataStore: MetadataStore | (() => MetadataStore)): RuleSource {
  const store = typeof metadataStore === 'function' ? metadataStore : () => metadataStore;
  return {
    validators: [breezePropertyValidator],
    getPropertyRules(modelType, propertyName) {
      const type = store().getEntityType(modelType, true) as EntityType | null;
      const property = type?.getProperty?.(propertyName) as BreezeProperty | null | undefined;
      if (!property) {
        return undefined;
      }
      return {
        ...(property.displayName ? { displayName: property.displayName } : {}),
        validators: property.validators.length ? [{ name: 'breezeProperty', context: { breezeProperty: property } }] : [],
      };
    },
  };
}

/**
 * Validator `breeze`: runs Breeze's validation for the model (an entity) and maps the resulting errors.
 * `validateModelSync` runs Breeze's sync validators (`entityAspect.validateEntity()`). `validateModelAsync` and
 * `validate` run all of them, sync and async (`entityAspect.validateEntityAsync()`, Breeze 3), the way Breeze does on save.
 *
 * The form integrations validate a view of the entity that holds the controls' values (`context.originalModel` is the
 * entity). For a view, `breeze` runs each property's sync Breeze validators, and Breeze's entity-level ones, on the
 * view's values, without changing the entity's validation errors.
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
    if (isView(value, context)) {
      return this.validateView(value, context);
    }
    value.entityAspect.validateEntity();
    // Errors left over from an earlier async run are not this (sync) run's result.
    return mapBreezeErrors(this, value, this.getValidatorFunctionContext(value, context), (e) => !e.validator?.isAsync);
  }

  /** Breeze's sync rules on a view's values: no Breeze call that would record errors on the entity. */
  private validateView(view: Entity, context?: ValidationContext): ValidationError[] | null {
    const ctx = this.getValidatorFunctionContext(view, context);
    const entity = ctx.originalModel ?? view;
    // The framework runs the rules installBreezeValidators added itself.
    const own = (validators: BreezeValidator[]) => validators.filter((v) => !v.isAsync && !INSTALLED.has(v));
    const type = view.entityType as EntityType;
    const errors: ValidationError[] = [];
    for (const property of [...type.dataProperties, ...type.navigationProperties] as BreezeProperty[]) {
      const value = getPath(view, property.name);
      const propertyCtx = {
        ...ctx,
        propertyName: property.name,
        displayName: ctx.metadata?.getProperty(property.name)?.displayName,
        value,
      } as ValidatorFunctionContext;
      errors.push(...(checkBreezeProperty(this, property, own(property.validators), value, propertyCtx, entity) ?? []));
    }
    const entityContext = { entity: view } as unknown as ValidationMessageContext;
    errors.push(...(mapPropertyErrors(this, own(type.validators).map((v) => v.validate(view, entityContext)), ctx) ?? []));
    return errors.length ? errors : null;
  }

  validateAsync(value: unknown, context?: ValidationContext): Observable<ValidationError[] | null> {
    return defer(async () => {
      if (!isBreezeEntity(value) || isRunning(value)) {
        return null;
      }
      if (isView(value, context)) {
        return this.validateView(value, context);
      }
      await value.entityAspect.validateEntityAsync();
      return mapBreezeErrors(this, value, this.getValidatorFunctionContext(value, context), () => true);
    });
  }
}

/** A form's view of an entity (`Object.create(entity)` with the controls' values), rather than the entity itself. */
function isView(value: Entity, context?: ValidationContext): boolean {
  const original = context?.originalModel;
  return original != null && original !== value;
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
        store: entity.entityAspect.entityManager ? (type: string) => liveEntities(entity.entityAspect.entityManager!, type) : () => [],
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
  /**
   * Only include entities in these states. Default: Unchanged, Added and Modified. Deleted entities stay in the
   * manager until saved, but they are on their way out, so they are neither validated nor seen by `store(type)`
   * (the `unique` validator, expressions). Detached entities are never included.
   */
  entityStates?: EntityState[];
}

/**
 * Wraps a Breeze EntityManager as an {@link EntityStore}; emits whenever entities are added, removed or changed.
 * Deleted and detached entities are left out by default (see {@link BreezeEntityStoreOptions.entityStates}).
 */
export function breezeEntityStore(manager: EntityManager, options: BreezeEntityStoreOptions = {}): NotifyingEntityStore {
  const query = (entityTypes?: string | string[]) => liveEntities(manager, entityTypes, options.entityStates);
  return createEntityStore({
    entities: () => query(options.entityTypes).map((entity) => ({ entityType: entity.entityType.shortName, entity })),
    changes: (notify) => {
      const token = manager.entityChanged.subscribe(notify);
      return () => manager.entityChanged.unsubscribe(token);
    },
    getEntities: (entityType) => query(entityType),
  });
}

/** Re-export for convenience. */
export { EntityState };
