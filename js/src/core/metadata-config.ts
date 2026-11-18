/**
 * JSON shape of validation metadata. See spec/validation-metadata.schema.json and docs/metadata.md.
 *
 * @example
 * {
 *   "global": { "validators": ["breeze"] },
 *   "Customer": {
 *     "condition": "!model.isArchived",
 *     "validators": [{ "name": "expression", "context": { "expression": "model.orders.length > 0", "messageTemplate": "A customer needs an order" } }],
 *     "properties": {
 *       "email": { "displayName": "E-mail", "required": true, "maxLength": 100, "validators": ["email"] }
 *     }
 *   }
 * }
 */
import type { ValidationContextBase } from './context.js';

export interface ValidatorConfig {
  /** Registered validator name. */
  name: string;
  /** Optional stable identifier reported as `ValidationError.id`. */
  id?: string;
  /** Validator configuration and message template. */
  context?: Partial<ValidationContextBase>;
  /** True to select the asynchronous validator registered under `name`. */
  async?: boolean;
  /** Expression; the validator only runs when it evaluates truthy. */
  condition?: string;
}

/** A validator name or full config. */
export type ValidatorConfigLike = string | ValidatorConfig;

/** A named group of validators, e.g. validators that only run during a particular workflow step. */
export interface ValidatorGroupConfig {
  group: string;
  validators: ValidatorConfigLike[];
}

export type ValidatorOrGroupConfig = ValidatorConfigLike | ValidatorGroupConfig;

export interface PropertyValidationConfig {
  /**
   * Inherit the rules of another model type's property: `"Customer"` for the property of the same name, or
   * `"Customer.email"`. The property gets that property's validators and `displayName`, from the metadata and from
   * the registered rule sources (such as Breeze's metadata); its own settings are added on top. Typical for view
   * models that edit some of an entity's properties.
   */
  readonly from?: string;
  readonly displayName?: string;
  /** Shorthand for the `required` validator. */
  readonly required?: boolean;
  /** Shorthand for the `minLength` validator. */
  readonly minLength?: number;
  /** Shorthand for the `maxLength` validator. */
  readonly maxLength?: number;
  readonly validators?: ValidatorOrGroupConfig[];
}

export interface PropertyValidationConfigMap {
  [propertyName: string]: PropertyValidationConfig;
}

export interface ModelValidationConfig {
  /** Name of another model type whose validators and properties are inherited. */
  readonly extends?: string;
  /** Model-level validators; they receive the whole model as value. */
  readonly validators?: ValidatorOrGroupConfig[];
  readonly properties?: PropertyValidationConfigMap;
  /** Expression; models for which it is falsy are skipped when validating an entity store. */
  readonly condition?: string;
}

export interface GlobalMetadataConfig {
  /** Validators applied to every model type. */
  validators?: ValidatorOrGroupConfig[];
}

/** Validation metadata keyed by model type, plus an optional `global` section. */
export interface ModelValidationMetadataMap {
  global?: GlobalMetadataConfig;
  [modelType: string]: ModelValidationConfig | GlobalMetadataConfig | undefined;
}

/** One or more metadata maps (arrays may be nested one level, as produced by multi providers). */
export type ModelValidationMetadataLike = ModelValidationMetadataMap | (ModelValidationMetadataMap | ModelValidationMetadataMap[])[];

export function isValidatorGroupConfig(config: unknown): config is ValidatorGroupConfig {
  return typeof config === 'object' && config !== null && !!(config as ValidatorGroupConfig).group;
}
