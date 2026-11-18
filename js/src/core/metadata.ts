import { Observable, Subject } from 'rxjs';

import { type ExpressionEvaluator, SafeExpressionEvaluator } from '../expressions/index.js';
import type { EntityInfo, ValidationContext, ValidationContextBase } from './context.js';
import {
  type GlobalMetadataConfig,
  type ModelValidationConfig,
  type ModelValidationMetadataLike,
  type ModelValidationMetadataMap,
  type PropertyValidationConfig,
  type ValidatorConfig,
  type ValidatorConfigLike,
  type ValidatorGroupConfig,
  type ValidatorOrGroupConfig,
  isValidatorGroupConfig,
} from './metadata-config.js';
import type { Validator, ValidatorFactory } from './validator.js';

/** Thrown for metadata that cannot be honoured (unknown validator, failing condition, ...). */
export class ValidationConfigurationError extends Error {
  override readonly name = 'ValidationConfigurationError';
}

/** Substitutes the context used to evaluate conditions (e.g. evaluate against a parent entity). */
export type ConditionContextResolver = (context: ValidationContext) => ValidationContext;

const identityResolver: ConditionContextResolver = (context) => context;

/** Metadata describing one usage of a validator. */
export class ValidatorMetadata {
  readonly config: ValidatorConfig;
  private validators = new Map<boolean, Validator>();

  constructor(
    config: ValidatorConfigLike,
    private readonly owner: ValidationMetadata,
    private readonly groupConfig?: ValidatorGroupConfig,
  ) {
    this.config = typeof config === 'string' ? { name: config } : config;
    if (!this.config.name) {
      throw new ValidationConfigurationError(`Validator config lacks a name: ${JSON.stringify(config)}`);
    }
  }

  get id(): string | undefined {
    return this.config.id;
  }

  get name(): string {
    return this.config.name;
  }

  get context(): Partial<ValidationContextBase> | undefined {
    return this.config.context;
  }

  get async(): boolean {
    return !!this.config.async;
  }

  get group(): string | undefined {
    return this.groupConfig?.group;
  }

  get condition(): string | undefined {
    return this.config.condition;
  }

  /** Evaluates the `condition` (if any). Variables: `context`, `model`, `value`, `isClient`, `isServer` and the expression scope. */
  evalCondition(context: ValidationContext, contextResolver: ConditionContextResolver = identityResolver): boolean {
    const condition = this.config.condition;
    if (!condition) {
      return true;
    }
    const resolved = contextResolver(context);
    try {
      return !!this.owner.expressionEvaluator.evaluate(condition, {
        ...resolved.expressionScope,
        context: resolved,
        model: resolved.model,
        value: resolved.propertyName && resolved.model != null ? resolved.model[resolved.propertyName] : resolved.model,
        isClient: resolved.isClient,
        isServer: resolved.isServer,
      });
    } catch (e) {
      throw new ValidationConfigurationError(
        `Condition '${condition}' failed for validator '${this.name}' and model type '${resolved.modelType}': ${(e as Error).message}`,
        { cause: e },
      );
    }
  }

  /** Returns the validator instance (created once per metadata entry). */
  getValidator(): Validator {
    const cached = this.validators.get(this.async);
    if (cached) {
      return cached;
    }
    const factories = this.owner.validatorFactories.filter((f) => f.name === this.name);
    if (factories.length === 0) {
      throw new ValidationConfigurationError(`No validator factory registered with name '${this.name}'.`);
    }
    // Several factories may share a name (e.g. a sync and an async 'unique' validator); pick by async-ness.
    const validator = factories.map((f) => f.fn(this.group, this.context)).find((v) => v.isAsync === this.async);
    if (!validator) {
      throw new ValidationConfigurationError(
        `No ${this.async ? 'asynchronous' : 'synchronous'} validator registered with name '${this.name}'.`,
      );
    }
    validator.metadata = this;
    this.validators.set(this.async, validator);
    return validator;
  }
}

function toValidatorMetadata(configs: readonly ValidatorOrGroupConfig[] | undefined, owner: ValidationMetadata): ValidatorMetadata[] {
  return (configs ?? []).flatMap((config) =>
    isValidatorGroupConfig(config)
      ? (config.validators ?? []).map((v) => new ValidatorMetadata(v, owner, config))
      : [new ValidatorMetadata(config, owner)],
  );
}

/** Validators that apply to every model type. */
export class GlobalMetadata {
  readonly validators: readonly ValidatorMetadata[];

  constructor(configs: GlobalMetadataConfig[], owner: ValidationMetadata) {
    this.validators = toValidatorMetadata(
      configs.flatMap((c) => c.validators ?? []),
      owner,
    );
  }
}

/** Validation metadata for one property of a model. */
export class PropertyMetadata {
  private _validators?: ValidatorMetadata[];

  constructor(
    readonly propertyName: string,
    readonly configs: readonly PropertyValidationConfig[],
    private readonly owner: ValidationMetadata,
  ) {}

  get displayName(): string | undefined {
    return lastDefined(this.configs.map((c) => c.displayName));
  }

  get validators(): readonly ValidatorMetadata[] {
    if (this._validators) {
      return this._validators;
    }
    const validators = this.configs.flatMap((c) => toValidatorMetadata(c.validators, this.owner));
    const hasUngrouped = (name: string) => validators.some((v) => v.name === name && !v.group);

    const required = lastDefined(this.configs.map((c) => c.required));
    if (required && !hasUngrouped('required')) {
      validators.push(new ValidatorMetadata({ name: 'required', id: 'REQUIRED' }, this.owner));
    }
    const minLength = lastDefined(this.configs.map((c) => c.minLength));
    if (minLength != null && !hasUngrouped('minLength')) {
      validators.push(new ValidatorMetadata({ name: 'minLength', id: 'MIN_LENGTH', context: { minLength } }, this.owner));
    }
    const maxLength = lastDefined(this.configs.map((c) => c.maxLength));
    if (maxLength != null && !hasUngrouped('maxLength')) {
      validators.push(new ValidatorMetadata({ name: 'maxLength', id: 'MAX_LENGTH', context: { maxLength } }, this.owner));
    }
    return (this._validators = validators);
  }

  /** Reads this property's value from a model. */
  getValue(model: unknown): unknown {
    return model == null ? undefined : (model as Record<string, unknown>)[this.propertyName];
  }
}

/** Validation metadata for a model type (an entity or any object). */
export class ModelMetadata {
  private _validators?: ValidatorMetadata[];
  private _properties?: PropertyMetadata[];

  constructor(
    readonly owner: ValidationMetadata,
    readonly modelType: string,
    readonly configs: readonly ModelValidationConfig[],
  ) {}

  get extends(): string | undefined {
    return lastDefined(this.configs.map((c) => c.extends));
  }

  get condition(): string | undefined {
    return lastDefined(this.configs.map((c) => c.condition)) ?? this.parent?.condition;
  }

  get parent(): ModelMetadata | undefined {
    const parentType = this.extends;
    if (!parentType) {
      return undefined;
    }
    if (parentType === this.modelType) {
      throw new ValidationConfigurationError(`Model type '${this.modelType}' cannot extend itself.`);
    }
    return this.owner.getModelMetadata(parentType);
  }

  /** Model-level validators: global validators (or the parent's), followed by this model's own. */
  get validators(): readonly ValidatorMetadata[] {
    if (this._validators) {
      return this._validators;
    }
    const inherited = this.parent ? this.parent.validators : this.owner.globalMetadata.validators;
    const own = this.configs.flatMap((c) => toValidatorMetadata(c.validators, this.owner));
    return (this._validators = [...inherited, ...own]);
  }

  /** Property metadata, including properties inherited through `extends`. Same-named properties are merged. */
  get properties(): readonly PropertyMetadata[] {
    if (this._properties) {
      return this._properties;
    }
    const byName = new Map<string, PropertyValidationConfig[]>();
    for (const p of this.parent?.properties ?? []) {
      byName.set(p.propertyName, [...p.configs]);
    }
    for (const config of this.configs) {
      for (const [name, propertyConfig] of Object.entries(config.properties ?? {})) {
        byName.set(name, [...(byName.get(name) ?? []), propertyConfig]);
      }
    }
    return (this._properties = [...byName].map(([name, configs]) => new PropertyMetadata(name, configs, this.owner)));
  }

  getProperty(propertyName: string): PropertyMetadata | undefined {
    return this.properties.find((p) => p.propertyName === propertyName);
  }

  getAsyncProperties(): PropertyMetadata[] {
    return this.properties.filter((p) => p.validators.some((v) => v.async));
  }

  /**
   * Evaluates the model `condition` (if any) used when validating an entity store.
   * Variables: `model`, `entityInfos`, `findEntity(id, type)`, `isClient`, `isServer` and the expression scope.
   */
  evalCondition(
    entityInfos: readonly EntityInfo[],
    model: unknown,
    contextResolver: ConditionContextResolver = identityResolver,
    expressionScope: Record<string, unknown> = {},
  ): boolean {
    const condition = this.condition;
    if (!condition) {
      return true;
    }
    const resolved = contextResolver({
      model,
      modelType: this.modelType,
      metadata: this,
      isClient: true,
      isServer: false,
      messageTemplate: '',
      expressionScope,
    });
    const findEntity = (id: unknown, type: string) =>
      entityInfos.find((ei) => ei.entityType === type && (ei.entity as { id?: unknown })?.id === id)?.entity;
    try {
      return !!this.owner.expressionEvaluator.evaluate(condition, {
        findEntity,
        ...resolved.expressionScope,
        entityInfos,
        context: resolved,
        model: resolved.model,
        isClient: resolved.isClient,
        isServer: resolved.isServer,
      });
    } catch (e) {
      throw new ValidationConfigurationError(
        `Condition '${condition}' failed for model type '${this.modelType}': ${(e as Error).message}`,
        { cause: e },
      );
    }
  }
}

export interface ValidationMetadataOptions {
  /** Validation metadata (JSON) — one map or several to be merged. */
  metadata?: ModelValidationMetadataLike;
  /** Validator factories. Usually `[...defaultValidators, ...yourValidators]`. */
  validators?: readonly ValidatorFactory[];
  /** Evaluator for conditions and expressions. Defaults to a {@link SafeExpressionEvaluator}. */
  expressionEvaluator?: ExpressionEvaluator;
}

/**
 * The parsed validation metadata for all model types.
 *
 * Several metadata maps can be supplied; definitions of the same model type are merged
 * (validators and properties are concatenated, scalar settings such as `displayName` use the last value).
 */
export class ValidationMetadata {
  readonly validatorFactories: readonly ValidatorFactory[];
  readonly expressionEvaluator: ExpressionEvaluator;

  private maps: ModelValidationMetadataMap[] = [];
  private models = new Map<string, ModelMetadata>();
  private _global?: GlobalMetadata;
  private readonly metadataChanged = new Subject<ValidationMetadata>();

  constructor(options: ValidationMetadataOptions = {}) {
    this.validatorFactories = [...(options.validators ?? [])];
    this.validatorFactories.forEach((factory, ix) => {
      if (!factory?.name) {
        throw new ValidationConfigurationError(`Validator factory #${ix} lacks a name.`);
      }
      if (typeof factory.fn !== 'function') {
        throw new ValidationConfigurationError(`Validator factory '${factory.name}' lacks a factory function.`);
      }
    });
    this.expressionEvaluator = options.expressionEvaluator ?? new SafeExpressionEvaluator();
    this.setMetadata(options.metadata ?? [], true);
  }

  /** Emits after {@link setMetadata} replaces the metadata. Entity store validations re-run on this. */
  get metadataChanged$(): Observable<ValidationMetadata> {
    return this.metadataChanged.asObservable();
  }

  get globalMetadata(): GlobalMetadata {
    return (this._global ??= new GlobalMetadata(
      this.maps.map((m) => m.global ?? {}),
      this,
    ));
  }

  /** Model types with explicit metadata. */
  get modelTypes(): string[] {
    return [...new Set(this.maps.flatMap((m) => Object.keys(m).filter((k) => k !== 'global')))];
  }

  /**
   * Returns metadata for a model type. Types without explicit metadata get a metadata object
   * containing only the global validators.
   */
  getModelMetadata(modelType: string): ModelMetadata {
    let model = this.models.get(modelType);
    if (!model) {
      const configs = this.maps
        .map((m) => (m as Record<string, ModelValidationConfig | undefined>)[modelType])
        .filter((c): c is ModelValidationConfig => !!c);
      model = new ModelMetadata(this, modelType, configs);
      this.models.set(modelType, model);
    }
    return model;
  }

  /** All model metadata with explicit configuration. */
  getModelMetadatas(): ModelMetadata[] {
    return this.modelTypes.map((t) => this.getModelMetadata(t));
  }

  /** Replaces the metadata (e.g. after loading it from the server) and notifies subscribers. */
  setMetadata(metadata: ModelValidationMetadataLike, suppressChangeEvent = false): void {
    const list = Array.isArray(metadata) ? metadata : [metadata];
    this.maps = list.flatMap((m) => (Array.isArray(m) ? m : [m])).filter((m): m is ModelValidationMetadataMap => !!m);
    this.models.clear();
    this._global = undefined;
    if (!suppressChangeEvent) {
      this.metadataChanged.next(this);
    }
  }

  /** Adds metadata maps to the existing metadata and notifies subscribers. */
  addMetadata(metadata: ModelValidationMetadataLike): void {
    const list = Array.isArray(metadata) ? metadata : [metadata];
    this.setMetadata([...this.maps, ...list.flatMap((m) => (Array.isArray(m) ? m : [m]))]);
  }
}

function lastDefined<T>(values: (T | undefined)[]): T | undefined {
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] !== undefined) {
      return values[i];
    }
  }
  return undefined;
}
