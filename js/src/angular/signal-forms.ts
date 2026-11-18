/**
 * Angular Signal Forms integration (`@angular/forms/signals`, Angular 22+). A separate entry point, so the rest of
 * the Angular integration keeps working on older Angular versions.
 *
 * @example
 * readonly nameForm = form(signal<ResourceName>({ ... }), (name) => validateWithMetadata(name, { modelType: 'ResourceName' }));
 */
import { DestroyRef, inject, resource, signal } from '@angular/core';
import {
  type FieldContext,
  type SchemaPath,
  type TreeValidationResult,
  type ValidationError as FormValidationError,
  isFieldTree,
  validateAsync,
  validateTree,
} from '@angular/forms/signals';
import type { Observable, Subscription } from 'rxjs';

import type { GlobalValidationContext } from '../core/context.js';
import type { ValidatorMetadata } from '../core/metadata.js';
import type { ValidationError } from '../core/validation-error.js';
import { ValidationService, type ValidatorPredicate } from '../core/validation-service.js';

export interface ValidateWithMetadataOptions {
  /**
   * The model type, or a function of the model that returns it. Default: the registered model type resolvers
   * (such as `breezeModelType`).
   */
  modelType?: string | ((model: unknown) => string | undefined);
  /** Validator group; only validators of that group run. Default: validators without a group. */
  group?: string;
  /** Extra context passed to the validators. */
  context?: GlobalValidationContext;
  /** Further narrows the validators that run. */
  predicate?: ValidatorPredicate;
  /** Debounce for async rules, in ms. Default 300. */
  debounce?: number;
  /** The service to use. Default: `inject(ValidationService)`, so call this in the schema function of `form()`. */
  service?: ValidationService;
}

/** A Signal Forms error for a metadata rule: `kind` is the error key, `message` the error message. */
export interface MetadataFormError extends FormValidationError.WithOptionalFieldTree {
  /** The framework's error, with the property, model, value and full context. */
  readonly validationError: ValidationError;
}

/**
 * Applies the metadata rules of a model type to a Signal Forms field (usually the form's root). Errors of a property
 * show on that property's field; model-level errors, and errors of properties the form has no field for, show on
 * the field itself. Sync rules run on every change; async rules run debounced, once the sync ones pass.
 *
 * ```ts
 * readonly nameForm = form(this.name, (path) => validateWithMetadata(path, { modelType: 'ResourceName' }));
 * ```
 * ```html
 * @for (error of nameForm.firstName().errors(); track error.kind) { <small>{{ error.message }}</small> }
 * ```
 */
export function validateWithMetadata<TValue>(path: SchemaPath<TValue>, options: ValidateWithMetadataOptions = {}): void {
  const service = options.service ?? inject(ValidationService);
  const inGroup = matchGroup(options.group);
  const predicate: ValidatorPredicate = (v, p) => inGroup(v, p) && (options.predicate?.(v, p) ?? true);
  // Async validators, and sync ones with an async complete check (such as Breeze's, which may include async rules).
  const isAsync = (v: ValidatorMetadata) => v.async || !!v.getValidator().validateAsync;
  const asyncPredicate: ValidatorPredicate = (v, p) => isAsync(v) && predicate(v, p);

  const modelTypeOf = (model: unknown): string => {
    const modelType =
      typeof options.modelType === 'function' ? options.modelType(model) : (options.modelType ?? service.resolveModelType(model));
    if (!modelType) {
      throw new Error('validateWithMetadata: pass modelType, or register a model type resolver that recognizes the model.');
    }
    return modelType;
  };
  const syncErrors = (model: unknown) => service.validateModelSync(model, modelTypeOf(model), { predicate, context: options.context });

  // A change of the service's entity store (an entity changed in place, or one a rule reads) re-runs the validation, as
  // the form's own value changes do.
  const changes = signal(0);
  const subscription: Subscription = service.entityStoreChanged$.subscribe(() => changes.update((n) => n + 1));
  inject(DestroyRef).onDestroy(() => subscription.unsubscribe());

  validateTree(path, (ctx) => {
    changes();
    const model = ctx.value();
    return model == null ? undefined : toFormErrors(syncErrors(model), ctx);
  });

  validateAsync(path, {
    params: (ctx) => {
      const model = ctx.value();
      return model != null && service.hasAsyncValidators(modelTypeOf(model), asyncPredicate) ? { model } : undefined;
    },
    debounce: options.debounce ?? 300,
    factory: (params) =>
      resource({
        params: () => params(),
        loader: ({ params: { model }, abortSignal }) =>
          toPromise(service.validateModelAsync(model, modelTypeOf(model), { predicate: asyncPredicate, context: options.context }), abortSignal),
      }),
    onSuccess: (errors, ctx) => {
      // A sync validator's async check repeats its sync rules; those errors are already reported by validateTree.
      const reported = new Set(syncErrors(ctx.value()).map((e) => e.key));
      return toFormErrors((errors ?? []).filter((e) => !reported.has(e.key)), ctx);
    },
    onError: (error) => ({ kind: 'validationFailed', message: error instanceof Error ? error.message : String(error) }),
  });
}

/** The same group rule as the other form integrations: no group selects the validators without a group. */
function matchGroup(group?: string): ValidatorPredicate {
  return (v) => (!group && !v.group) || (!!group && v.group === group);
}

function toFormErrors(errors: readonly ValidationError[], ctx: FieldContext<unknown>): TreeValidationResult<MetadataFormError> {
  if (errors.length === 0) {
    return undefined;
  }
  // An error shows on each field it is about (`propertyNames`); without such a field, on the field validated.
  return errors.flatMap((validationError) => {
    const error = { kind: validationError.key, message: validationError.errorMessage, validationError };
    const fields = validationError.propertyNames
      .map((name) => (ctx.fieldTree as unknown as Record<string, unknown>)[name])
      .filter((child) => isFieldTree(child));
    return fields.length ? fields.map((fieldTree) => ({ ...error, fieldTree })) : [error];
  });
}

function toPromise<T>(source: Observable<T>, abortSignal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let last: T | undefined;
    const subscription = source.subscribe({ next: (v) => (last = v), error: reject, complete: () => resolve(last as T) });
    abortSignal.addEventListener('abort', () => subscription.unsubscribe(), { once: true });
  });
}
