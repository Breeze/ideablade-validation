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
  isModelTypeKey,
  isValidatorGroupConfig,
} from './metadata-config.js';
import { type Validator, type ValidatorFactory, errorKey } from './validator.js';

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

  /** For a model-level validator: the properties its errors are about (`propertyNames` in the metadata). */
  get propertyNames(): readonly string[] | undefined {
    return this.config.propertyNames;
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

/** A property another property inherits its rules from (`"from": "Customer.email"`). */
export interface PropertyReference {
  readonly modelType: string;
  readonly propertyName: string;
}

/** Validation metadata for one property of a model. */
export class PropertyMetadata {
  private _validators?: ValidatorMetadata[];
  private _resolvedConfigs?: readonly PropertyValidationConfig[];
  private resolving = false;

  constructor(
    readonly propertyName: string,
    /** This property's own configs (merged from all metadata maps and `extends`), without the inherited `from` rules. */
    readonly configs: readonly PropertyValidationConfig[],
    private readonly owner: ValidationMetadata,
  ) {}

  /** The property whose rules this one inherits (`from`), if any. */
  get from(): PropertyReference | undefined {
    const from = lastDefined(this.configs.map((c) => c.from));
    if (!from) {
      return undefined;
    }
    const dot = from.indexOf('.');
    return dot < 0 ? { modelType: from, propertyName: this.propertyName } : { modelType: from.slice(0, dot), propertyName: from.slice(dot + 1) };
  }

  /**
   * The configs that make up this property: the inherited ones (`from`: first the rule sources, then the referenced
   * property's metadata, recursively), followed by this property's own. Later configs win for scalar settings.
   */
  get resolvedConfigs(): readonly PropertyValidationConfig[] {
    if (this._resolvedConfigs) {
      return this._resolvedConfigs;
    }
    const from = this.from;
    if (!from) {
      return (this._resolvedConfigs = this.configs);
    }
    if (this.resolving) {
      throw new ValidationConfigurationError(`Property '${this.propertyName}' has a circular 'from' chain through '${from.modelType}.${from.propertyName}'.`);
    }
    this.resolving = true;
    try {
      const fromSources = this.owner.ruleSources
        .map((source) => source.getPropertyRules(from.modelType, from.propertyName))
        .filter((c): c is PropertyValidationConfig => !!c);
      const fromMetadata = this.owner.getModelMetadata(from.modelType).getProperty(from.propertyName)?.resolvedConfigs;
      if (fromSources.length === 0 && !fromMetadata) {
        throw new ValidationConfigurationError(
          `Property '${this.propertyName}' inherits from '${from.modelType}.${from.propertyName}', which has no metadata and no rule source knows.`,
        );
      }
      return (this._resolvedConfigs = [...fromSources, ...(fromMetadata ?? []), ...this.configs]);
    } finally {
      this.resolving = false;
    }
  }

  get displayName(): string | undefined {
    return lastDefined(this.resolvedConfigs.map((c) => c.displayName));
  }

  get validators(): readonly ValidatorMetadata[] {
    if (this._validators) {
      return this._validators;
    }
    const configs = this.resolvedConfigs;
    const validators = configs.flatMap((c) => toValidatorMetadata(c.validators, this.owner));
    const hasUngrouped = (name: string) => validators.some((v) => v.name === name && !v.group);

    const required = lastDefined(configs.map((c) => c.required));
    if (required && !hasUngrouped('required')) {
      validators.push(new ValidatorMetadata({ name: 'required', id: 'REQUIRED' }, this.owner));
    }
    const minLength = lastDefined(configs.map((c) => c.minLength));
    if (minLength != null && !hasUngrouped('minLength')) {
      validators.push(new ValidatorMetadata({ name: 'minLength', id: 'MIN_LENGTH', context: { minLength } }, this.owner));
    }
    const maxLength = lastDefined(configs.map((c) => c.maxLength));
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

  private keysChecked = false;

  /**
   * Throws a {@link ValidationConfigurationError} if two of the model's rules would report errors with the same key.
   * Errors are told apart by their key: error visibility, the form integrations and templates that track errors all
   * rely on it, and a second error with the same key is hidden or dropped without a word. The rules compared are the
   * model's as they run: from every metadata map, the global validators, `extends` and `from`.
   *
   * Two rules that both have a `condition` are not compared: they may never apply together, such as `required` when
   * one setting is on and `required` when it is off. The service reports the errors it actually gets with the same key
   * ({@link ValidationServiceOptions.onDuplicateErrorKey}). The service runs this check before it first validates a
   * model of the type; the result is kept until the metadata changes.
   */
  checkErrorKeys(): void {
    if (this.keysChecked) {
      return;
    }
    const rules = new Map<string, { rule: ValidatorMetadata; propertyName?: string }[]>();
    const add = (rule: ValidatorMetadata, propertyName?: string) => {
      const key = errorKey(rule.name, rule.group, propertyName, rule.id);
      rules.set(key, [...(rules.get(key) ?? []), { rule, propertyName }]);
    };
    this.validators.forEach((rule) => add(rule));
    this.properties.forEach((property) => property.validators.forEach((rule) => add(rule, property.propertyName)));

    const clashes = [...rules]
      .filter(([, same]) => same.length > 1 && same.some((r) => !r.rule.condition))
      .map(([key, same]) => `'${key}' (${same.map((r) => describeRule(r.rule, r.propertyName)).join(', ')})`);
    if (clashes.length > 0) {
      throw new ValidationConfigurationError(
        `Model type '${this.modelType}' has rules whose errors would share a key, which is how errors are told apart: ` +
          `${clashes.join('; ')}. A model-level rule's 'id' is part of its key; a property rule's key is its validator ` +
          `name, group and property. Give the rules different ids or groups, or combine them into one rule. The rules ` +
          `may come from several metadata maps, the global validators, 'extends' or 'from'.`,
      );
    }
    this.keysChecked = true;
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

/**
 * Supplies the rules of model type properties that live outside the validation metadata, such as Breeze's
 * metadata. A property's `from` reference inherits them (see {@link PropertyMetadata.from}).
 */
export interface RuleSource {
  /** Validator factories the returned rules refer to. They are registered along with the metadata. */
  readonly validators?: readonly ValidatorFactory[];
  /**
   * The rules of a property, or undefined when this source doesn't know the property. Return a config, possibly
   * without validators, for every property the source knows: `from` reports a reference nobody knows as an error.
   */
  getPropertyRules(modelType: string, propertyName: string): PropertyValidationConfig | undefined;
}

export interface ValidationMetadataOptions {
  /** Validation metadata (JSON) — one map or several to be merged. */
  metadata?: ModelValidationMetadataLike;
  /** Validator factories. Usually `[...defaultValidators, ...yourValidators]`. */
  validators?: readonly ValidatorFactory[];
  /** Evaluator for conditions and expressions. Defaults to a {@link SafeExpressionEvaluator}. */
  expressionEvaluator?: ExpressionEvaluator;
  /** Sources of property rules outside the metadata, consulted for `from` references (e.g. `breezeRuleSource`). */
  ruleSources?: readonly RuleSource[];
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
  readonly ruleSources: readonly RuleSource[];

  private maps: ModelValidationMetadataMap[] = [];
  private models = new Map<string, ModelMetadata>();
  private _global?: GlobalMetadata;
  private readonly metadataChanged = new Subject<ValidationMetadata>();

  constructor(options: ValidationMetadataOptions = {}) {
    this.ruleSources = [...(options.ruleSources ?? [])];
    // The rule sources' factories; the same factory object registered twice counts once.
    this.validatorFactories = [...new Set([...(options.validators ?? []), ...this.ruleSources.flatMap((r) => r.validators ?? [])])];
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
    return [...new Set(this.maps.flatMap((m) => Object.keys(m).filter(isModelTypeKey)))];
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

/** A rule as an error message names it: `property 'city': 'expression' (id 'CITY_FORMAT', group 'submit')`. */
function describeRule(rule: ValidatorMetadata, propertyName?: string): string {
  const details = [rule.id ? `id '${rule.id}'` : '', rule.group ? `group '${rule.group}'` : '', rule.condition ? 'with a condition' : '']
    .filter(Boolean)
    .join(', ');
  return `${propertyName ? `property '${propertyName}'` : 'model-level'}: '${rule.name}'${details ? ` (${details})` : ''}`;
}

function lastDefined<T>(values: (T | undefined)[]): T | undefined {
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] !== undefined) {
      return values[i];
    }
  }
  return undefined;
}
