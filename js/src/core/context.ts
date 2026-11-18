import type { ExpressionEvaluator } from '../expressions/index.js';
import type { ModelMetadata } from './metadata.js';

/** Identifies a model instance together with its model type, e.g. an entity in a cache. */
export interface EntityInfo<T = any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  entityType: string;
  entity: T;
}

/** Values merged into the context of every validator, e.g. the current user's role. */
export interface GlobalValidationContext {
  [propertyName: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Context a validator is configured with (from metadata or code). */
export interface ValidationContextBase {
  /** Message template with %path% placeholders, e.g. `%displayName% is required`. */
  messageTemplate: string;
  displayName?: string;
  [propertyName: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Function exposed to expressions as `store(entityType)`: returns the entities of a type. */
export type StoreQuery = (entityType: string) => readonly unknown[];

/** Context available when a validator runs against a model. */
export interface ValidationContext extends ValidationContextBase {
  model: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  modelType: string;
  /** The property being validated, for a property validator. */
  propertyName?: string;
  /**
   * For a model-level validator: the properties its errors are about. Set from the metadata (`propertyNames`), or by
   * the validator itself. See `ValidationError.propertyNames`.
   */
  propertyNames?: readonly string[];
  metadata: ModelMetadata;
  isClient: boolean;
  isServer: boolean;
  /** Evaluator used for conditions and the `expression` validator. */
  expressionEvaluator?: ExpressionEvaluator;
  /** Extra trusted functions/values visible to expressions (e.g. `store`, `findEntity`). */
  expressionScope?: Record<string, unknown>;
}

/** Context passed to a validator function: the validation context plus the value under validation. */
export interface ValidatorFunctionContext extends ValidationContext {
  value: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  validatorName: string;
}

/**
 * Supplies additional context values for a model before it is validated.
 * This is the recommended way to make application services (current user, lookups, an entity cache...)
 * available to validators and conditions without putting them in the metadata.
 */
export interface ValidatorContextProvider {
  contextFn(model: unknown, modelType: string): Record<string, unknown> | undefined | null;
}
