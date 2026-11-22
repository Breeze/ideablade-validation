/**
 * Angular Signal Forms integration (`@angular/forms/signals`, Angular 22+). A separate entry point, so the rest of
 * the Angular integration keeps working on older Angular versions.
 *
 * @example
 * readonly nameForm = form(signal<ResourceName>({ ... }), (name) => validateWithMetadata(name, { modelType: 'ResourceName' }));
 */
import { DestroyRef, inject, resource, signal, untracked } from '@angular/core';
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
import { ErrorVisibility } from '../core/error-visibility.js';
import type { ValidatorMetadata } from '../core/metadata.js';
import type { ValidationError } from '../core/validation-error.js';
import { ValidationService, type ValidatorPredicate } from '../core/validation-service.js';
import { trackVisibility } from './index.js';

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
  /**
   * Decides which errors to show ({@link ErrorVisibility}): each error then has a `shown()` check, and
   * {@link shownErrors} filters a field's errors with it. The fields' `touched()` and `dirty()` count as touches.
   * Default: `inject(ErrorVisibility, { optional: true })`, or none when `service` is passed.
   */
  visibility?: ErrorVisibility | null;
}

/** A Signal Forms error for a metadata rule: `kind` is the error key, `message` the error message. */
export interface MetadataFormError extends FormValidationError.WithOptionalFieldTree {
  /** The framework's error, with the property, model, value and full context. */
  readonly validationError: ValidationError;
  /**
   * With an {@link ErrorVisibility}: whether to show the error now. Reactive: it follows touches, validations and save
   * attempts. Without one, it is not set; {@link shownErrors} then keeps the error.
   */
  readonly shown?: () => boolean;
}

/**
 * The errors of `errors` to show: without the metadata errors an {@link ErrorVisibility} hides. Other errors, and all of
 * them without a visibility, are kept. The field stays as invalid as its errors make it.
 *
 * ```ts
 * protected readonly shownErrors = shownErrors;
 * ```
 * ```html
 * @for (error of shownErrors(nameForm.firstName().errors()); track error.kind) { <small>{{ error.message }}</small> }
 * ```
 */
export function shownErrors<T extends FormValidationError>(errors: readonly T[]): T[] {
  return errors.filter((error) => (error as Partial<MetadataFormError>).shown?.() ?? true);
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
  // Injected like the service; with a service passed in, there may be no injection context, so none.
  const visibility = options.visibility !== undefined ? options.visibility : options.service ? null : injectVisibility();
  // Signal Forms replaces the model with a copy on every change: the visibility follows it from copy to copy.
  let previous: unknown;
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
    if (model == null) {
      return undefined;
    }
    const errors = syncErrors(model);
    if (visibility) {
      untracked(() => {
        visibility.transfer(previous, model);
        previous = model;
        visibility.observe(model, errors);
      });
    }
    return toFormErrors(errors, ctx, visibility);
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
      return toFormErrors((errors ?? []).filter((e) => !reported.has(e.key)), ctx, visibility);
    },
    onError: (error) => ({ kind: 'validationFailed', message: error instanceof Error ? error.message : String(error) }),
  });
}

/** The same group rule as the other form integrations: no group selects the validators without a group. */
function matchGroup(group?: string): ValidatorPredicate {
  return (v) => (!group && !v.group) || (!!group && v.group === group);
}

/** The {@link ErrorVisibility} provided where the form is created, if any. */
function injectVisibility(): ErrorVisibility | null {
  return inject(ErrorVisibility, { optional: true });
}

function toFormErrors(
  errors: readonly ValidationError[],
  ctx: FieldContext<unknown>,
  visibility?: ErrorVisibility | null,
): TreeValidationResult<MetadataFormError> {
  if (errors.length === 0) {
    return undefined;
  }
  const children = ctx.fieldTree as unknown as Record<string, unknown>;
  const model = untracked(() => ctx.value());
  // An error shows on each field it is about (`propertyNames`); without such a field, on the field validated.
  return errors.flatMap((validationError) => {
    const error: MetadataFormError = {
      kind: validationError.key,
      message: validationError.errorMessage,
      validationError,
      ...(visibility ? { shown: () => isShown(visibility, model, validationError, children) } : {}),
    };
    const fields = validationError.propertyNames.map((name) => children[name]).filter((child) => isFieldTree(child));
    return fields.length ? fields.map((fieldTree) => ({ ...error, fieldTree })) : [error];
  });
}

/** Reports the touched fields the error is about, then asks the visibility. */
function isShown(visibility: ErrorVisibility, model: unknown, error: ValidationError, children: Record<string, unknown>): boolean {
  trackVisibility(visibility);
  for (const name of error.propertyNames) {
    const child = children[name];
    if (isFieldTree(child)) {
      const state = (child as () => { touched(): boolean; dirty(): boolean })();
      if (state.touched() || state.dirty()) {
        untracked(() => visibility.markTouched(model, name));
      }
    }
  }
  return visibility.isShown(model, error);
}

function toPromise<T>(source: Observable<T>, abortSignal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let last: T | undefined;
    const subscription = source.subscribe({ next: (v) => (last = v), error: reject, complete: () => resolve(last as T) });
    abortSignal.addEventListener('abort', () => subscription.unsubscribe(), { once: true });
  });
}
