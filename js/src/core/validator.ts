import { type Observable, catchError, defaultIfEmpty, from, isObservable, last, map, of } from 'rxjs';

import type { ValidationContext, ValidationContextBase, ValidatorFunctionContext } from './context.js';
import type { ValidatorMetadata } from './metadata.js';
import { ValidationError } from './validation-error.js';

/** Sync validator result: one or more errors, or null when valid. */
export type SyncValidationOutcome = ValidationError | ValidationError[] | null;
/** Async validator result: a completing Observable of the sync outcome. */
export type AsyncValidationOutcome = Observable<SyncValidationOutcome>;

/** A validator instance created by a {@link ValidatorFactory}. */
export interface Validator {
  readonly name: string;
  readonly group: string | undefined;
  readonly context?: Partial<ValidationContextBase>;
  readonly isAsync: boolean;
  /** Set by the framework to the metadata the validator was created from. */
  metadata?: ValidatorMetadata;
  validate(value: unknown, context?: ValidationContext): SyncValidationOutcome | AsyncValidationOutcome;
  /**
   * Optional, for sync validators: a complete check that may be asynchronous. `validateModelAsync` and `validate`
   * use it instead of `validate`, so a validator whose source has both sync and async rules (such as `breeze`)
   * needs only one metadata entry and runs each rule once.
   */
  validateAsync?(value: unknown, context?: ValidationContext): AsyncValidationOutcome;
}

/** Synchronous validation function: return true when the value is valid. */
export type ValidatorFunction = (value: any, context: ValidatorFunctionContext) => boolean; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Asynchronous validation function: resolve to true when the value is valid.
 * May return an Observable (last emitted value wins; it must complete), a Promise or a plain boolean.
 */
export type AsyncValidatorFunction = (
  value: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  context: ValidatorFunctionContext,
) => Observable<boolean> | Promise<boolean> | boolean;

/** Creates a validator for a given group and configured context. Registered by name. */
export interface ValidatorFactory {
  name: string;
  fn: (group: string | undefined, context?: Partial<ValidationContextBase>) => Validator;
}

/**
 * The key of a rule's errors: `name[_group]_propertyName` for a property rule, `name[_group][_id]` for a model-level
 * rule. A property rule's `id` is not part of it. The duplicate key check computes keys with this too, so the two
 * cannot disagree.
 */
export function errorKey(name: string, group: string | undefined, propertyName: string | undefined, id: string | undefined): string {
  let key = name;
  if (group) {
    key = `${key}_${group}`;
  }
  if (propertyName) {
    key = `${key}_${propertyName}`;
  } else if (id) {
    key = `${key}_${id}`;
  }
  return key;
}

/** Base class with key/context helpers shared by all validators. */
export abstract class ValidatorBase {
  metadata?: ValidatorMetadata;

  protected constructor(
    readonly name: string,
    readonly group: string | undefined,
    readonly context?: Partial<ValidationContextBase>,
  ) {}

  /**
   * `name[_group]_propertyName` for a property rule; `name[_group][_id]` for a model-level rule, so model-level rules
   * with the same validator name (several `expression` rules, say) get keys of their own when they have an `id`.
   */
  protected getKey(context?: ValidationContext): string {
    return errorKey(this.name, this.group, context?.propertyName, this.metadata?.id);
  }

  protected getValidatorFunctionContext(value: unknown, context?: ValidationContext): ValidatorFunctionContext {
    return {
      ...(this.context ?? {}),
      ...(context ?? ({} as ValidationContext)),
      displayName: context?.displayName || this.context?.displayName || context?.propertyName,
      value,
      validatorName: this.name,
    } as ValidatorFunctionContext;
  }

  protected createError(ctx: ValidatorFunctionContext, exception?: unknown): ValidationError {
    const errorCtx = exception === undefined ? ctx : { ...ctx, exception };
    return new ValidationError(this.getKey(ctx), errorCtx, this as unknown as Validator);
  }
}

/** Merges a default message template into a validator context. */
export function withMessage(
  context: Partial<ValidationContextBase> | undefined,
  defaultTemplate: string,
): Partial<ValidationContextBase> {
  return { ...context, messageTemplate: context?.messageTemplate || defaultTemplate };
}

/** A validator backed by a synchronous predicate. An exception thrown by the predicate counts as a failure. */
export class SyncValidator extends ValidatorBase implements Validator {
  readonly isAsync = false;

  constructor(
    name: string,
    group: string | undefined,
    private readonly validatorFn: ValidatorFunction,
    context?: Partial<ValidationContextBase>,
  ) {
    super(name, group, context);
  }

  /** Returns the error, or several when a subclass reports more than one in a pass; null when valid. */
  validate(value: unknown, context?: ValidationContext): ValidationError | ValidationError[] | null {
    const ctx = this.getValidatorFunctionContext(value, context);
    try {
      return this.validatorFn(value, ctx) ? null : this.createError(ctx);
    } catch (e) {
      return this.createError(ctx, e);
    }
  }
}

/** A validator backed by an asynchronous predicate. Errors and exceptions count as failures. */
export class AsyncValidator extends ValidatorBase implements Validator {
  readonly isAsync = true;

  constructor(
    name: string,
    group: string | undefined,
    private readonly validatorFn: AsyncValidatorFunction,
    context?: Partial<ValidationContextBase>,
  ) {
    super(name, group, context);
  }

  /** Emits the error, or several when a subclass reports more than one in a pass; null when valid. */
  validate(value: unknown, context?: ValidationContext): Observable<ValidationError | ValidationError[] | null> {
    const ctx = this.getValidatorFunctionContext(value, context);
    try {
      const result = this.validatorFn(value, ctx);
      const result$ = isObservable(result) ? result : result instanceof Promise ? from(result) : of(result);
      return result$.pipe(
        last(),
        defaultIfEmpty(true),
        map((isValid) => (isValid ? null : this.createError(ctx))),
        catchError((e: unknown) => of(this.createError(ctx, e))),
      );
    } catch (e) {
      return of(this.createError(ctx, e));
    }
  }
}

/** Convenience: define a synchronous validator factory from a predicate. */
export function syncValidator(
  name: string,
  predicate: ValidatorFunction,
  defaultMessageTemplate = '%displayName% is invalid',
): ValidatorFactory {
  return {
    name,
    fn: (group, context) => new SyncValidator(name, group, predicate, withMessage(context, defaultMessageTemplate)),
  };
}

/** Convenience: define an asynchronous validator factory from a predicate. */
export function asyncValidator(
  name: string,
  predicate: AsyncValidatorFunction,
  defaultMessageTemplate = '%displayName% is invalid',
): ValidatorFactory {
  return {
    name,
    fn: (group, context) => new AsyncValidator(name, group, predicate, withMessage(context, defaultMessageTemplate)),
  };
}
