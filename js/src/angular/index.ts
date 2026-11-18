/**
 * Angular integration: standalone providers, injection tokens, signal helpers and reactive-forms validators.
 *
 * @example
 * // app.config.ts
 * export const appConfig: ApplicationConfig = {
 *   providers: [
 *     provideValidation({ metadata: validationMetadata, validators: [breezeValidator, myValidator] }),
 *     provideValidatorContext(() => ({ contextFn: () => ({ user: inject(UserService).current }) })),
 *   ],
 * };
 *
 * // component
 * readonly validation = inject(ValidationService);
 */
import {
  type EnvironmentProviders,
  InjectionToken,
  type Provider,
  type Signal,
  computed,
  inject,
  makeEnvironmentProviders,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import type { AbstractControl, AsyncValidatorFn, ValidationErrors, ValidatorFn } from '@angular/forms';
import { type Observable, map, of, switchMap, timer } from 'rxjs';

import type { EntityInfo, GlobalValidationContext, ValidatorContextProvider } from '../core/context.js';
import type { ModelValidationMetadataLike } from '../core/metadata-config.js';
import { ValidationMetadata } from '../core/metadata.js';
import type { ValidationError } from '../core/validation-error.js';
import {
  type ModelValidationState,
  type ValidationOptions,
  ValidationService,
  type ValidationServiceOptions,
  type ValidatorPredicate,
} from '../core/validation-service.js';
import type { ValidatorFactory } from '../core/validator.js';
import type { ExpressionEvaluator } from '../expressions/index.js';
import { defaultValidators } from '../validators/default-validators.js';

export { ValidationMetadata, ValidationService };

/** Validation metadata maps (multi). */
export const VALIDATION_METADATA = new InjectionToken<ModelValidationMetadataLike[]>('IdeaBlade.ValidationMetadata');
/** Validator factories (multi). */
export const VALIDATOR_FACTORY = new InjectionToken<ValidatorFactory[]>('IdeaBlade.ValidatorFactory');
/** Context providers (multi). */
export const VALIDATOR_CONTEXT_PROVIDER = new InjectionToken<ValidatorContextProvider[]>('IdeaBlade.ValidatorContextProvider');
/** Trusted functions/values visible to expressions (multi; objects are merged). */
export const VALIDATION_EXPRESSION_SCOPE = new InjectionToken<Record<string, unknown>[]>('IdeaBlade.ValidationExpressionScope');
/** Replaces the default safe expression evaluator. */
export const VALIDATION_EXPRESSION_EVALUATOR = new InjectionToken<ExpressionEvaluator>('IdeaBlade.ValidationExpressionEvaluator');
/** Service options (async timeout...). */
export const VALIDATION_SERVICE_OPTIONS = new InjectionToken<Pick<ValidationServiceOptions, 'asyncTimeout' | 'onAsyncTimeout'>>(
  'IdeaBlade.ValidationServiceOptions',
);

export interface ValidationConfig extends Pick<ValidationServiceOptions, 'asyncTimeout' | 'onAsyncTimeout'> {
  /** Metadata maps (more can be added with {@link provideValidationMetadata} or `ValidationMetadata.setMetadata`). */
  metadata?: ModelValidationMetadataLike;
  /** Additional validator factories. */
  validators?: ValidatorFactory[];
  /** Register the generic validators. Default true. */
  includeDefaultValidators?: boolean;
  /** Trusted functions/values visible to expressions. */
  expressionScope?: Record<string, unknown>;
  /** Replaces the default {@link SafeExpressionEvaluator}. */
  expressionEvaluator?: ExpressionEvaluator;
}

function flat<T>(values: readonly (T | readonly T[])[] | null): T[] {
  return (values ?? []).flatMap((v) => (Array.isArray(v) ? v : [v as T]));
}

/** Registers {@link ValidationService}, {@link ValidationMetadata} and {@link FormValidators}. */
export function provideValidation(config: ValidationConfig = {}): EnvironmentProviders {
  const providers: Provider[] = [
    {
      provide: ValidationMetadata,
      useFactory: () =>
        new ValidationMetadata({
          metadata: flat(inject(VALIDATION_METADATA, { optional: true })) as ModelValidationMetadataLike,
          validators: flat(inject(VALIDATOR_FACTORY, { optional: true })),
          expressionEvaluator: inject(VALIDATION_EXPRESSION_EVALUATOR, { optional: true }) ?? undefined,
        }),
    },
    {
      provide: ValidationService,
      useFactory: () =>
        new ValidationService(inject(ValidationMetadata), {
          ...(inject(VALIDATION_SERVICE_OPTIONS, { optional: true }) ?? {}),
          contextProviders: flat(inject(VALIDATOR_CONTEXT_PROVIDER, { optional: true })),
          expressionScope: Object.assign({}, ...flat(inject(VALIDATION_EXPRESSION_SCOPE, { optional: true }))),
        }),
    },
    { provide: FormValidators, useFactory: () => new FormValidators(inject(ValidationService)) },
    { provide: VALIDATION_SERVICE_OPTIONS, useValue: { asyncTimeout: config.asyncTimeout, onAsyncTimeout: config.onAsyncTimeout } },
  ];
  if (config.includeDefaultValidators ?? true) {
    providers.push(...provideValidators(...defaultValidators));
  }
  if (config.validators?.length) {
    providers.push(...provideValidators(...config.validators));
  }
  if (config.metadata) {
    providers.push({ provide: VALIDATION_METADATA, useValue: config.metadata, multi: true });
  }
  if (config.expressionScope) {
    providers.push({ provide: VALIDATION_EXPRESSION_SCOPE, useValue: config.expressionScope, multi: true });
  }
  if (config.expressionEvaluator) {
    providers.push({ provide: VALIDATION_EXPRESSION_EVALUATOR, useValue: config.expressionEvaluator });
  }
  return makeEnvironmentProviders(providers);
}

/** Adds metadata maps (e.g. from a feature's routes). */
export function provideValidationMetadata(...metadata: ModelValidationMetadataLike[]): Provider[] {
  return metadata.map((m) => ({ provide: VALIDATION_METADATA, useValue: m, multi: true }));
}

/** Registers validator factories. */
export function provideValidators(...factories: ValidatorFactory[]): Provider[] {
  return factories.map((f) => ({ provide: VALIDATOR_FACTORY, useValue: f, multi: true }));
}

/**
 * Registers a validator factory created by a function that can `inject()` services.
 * @example provideValidatorFactory(() => { const api = inject(CustomerApi); return asyncValidator('customerExists', v => api.exists(v)); })
 */
export function provideValidatorFactory(factory: () => ValidatorFactory): Provider {
  return { provide: VALIDATOR_FACTORY, useFactory: factory, multi: true };
}

/**
 * Registers a context provider created by a function that can `inject()` services.
 * @example provideValidatorContext(() => { const session = inject(Session); return { contextFn: () => ({ user: session.user }) }; })
 */
export function provideValidatorContext(factory: () => ValidatorContextProvider): Provider {
  return { provide: VALIDATOR_CONTEXT_PROVIDER, useFactory: factory, multi: true };
}

/** Makes trusted functions/values available to expressions. */
export function provideExpressionScope(scope: Record<string, unknown> | (() => Record<string, unknown>)): Provider {
  return typeof scope === 'function'
    ? { provide: VALIDATION_EXPRESSION_SCOPE, useFactory: scope, multi: true }
    : { provide: VALIDATION_EXPRESSION_SCOPE, useValue: scope, multi: true };
}

/**
 * Signal of the synchronous validation errors of a model. Must be called in an injection context.
 * Re-validates when `model` (or any signal read by it) changes. For objects mutated in place (e.g. Breeze
 * entities) read a change-tracking signal inside `model`.
 */
export function validationErrors(model: () => unknown, modelType: string | (() => string), options?: ValidationOptions): Signal<ValidationError[]> {
  const service = inject(ValidationService);
  return computed(() => service.validateModelSync(model(), typeof modelType === 'function' ? modelType() : modelType, options));
}

/**
 * Signal of sync + async validation state (`{ errors, pending }`). Must be called in an injection context.
 * Async validation restarts (and the previous run is cancelled) whenever `model` changes.
 */
export function validationState(model: Signal<unknown>, modelType: string, options?: ValidationOptions): Signal<ModelValidationState> {
  const service = inject(ValidationService);
  const state$ = toObservable(model).pipe(switchMap((m) => service.validate(m, modelType, options)));
  return toSignal(state$, { initialValue: { errors: [], pending: true } }) as Signal<ModelValidationState>;
}

/** Shorthand for `inject(ValidationService)`. */
export function injectValidationService(): ValidationService {
  return inject(ValidationService);
}

/** Shorthand for `inject(FormValidators)`. */
export function injectFormValidators(): FormValidators {
  return inject(FormValidators);
}

const matchGroup = (group?: string): ValidatorPredicate => (v) => (!group && !v.group) || (!!group && v.group === group);

function errorsToMap(errors: ValidationError[]): ValidationErrors | null {
  if (errors.length === 0) {
    return null;
  }
  return errors.reduce<ValidationErrors>((acc, e) => {
    acc[e.key] = e;
    return acc;
  }, {});
}

/** A view of `model` whose `propertyName` returns `value`; other properties (incl. accessors) come from the model. */
function withProperty(model: unknown, propertyName: string, value: unknown): unknown {
  const view = Object.create((model ?? {}) as object);
  Object.defineProperty(view, propertyName, { value, enumerable: true, configurable: true, writable: true });
  return view;
}

/**
 * Bridges metadata validation to Angular reactive forms. A control's errors are the {@link ValidationError}s
 * of the model's property, keyed by error key (`control.errors['required_email'].errorMessage`).
 */
export class FormValidators {
  constructor(private readonly validationService: ValidationService) {}

  /** `[value, syncValidators, asyncValidators]` tuple for `FormBuilder.group`. */
  formControl(value: unknown, modelInfoFn: () => EntityInfo, propertyName: string, group?: string, context?: GlobalValidationContext): [unknown, ValidatorFn[], AsyncValidatorFn[]] {
    return [
      value,
      [this.createSyncValidatorFn(modelInfoFn, propertyName, group, context)],
      [this.createAsyncValidatorFn(modelInfoFn, propertyName, group, context)],
    ];
  }

  /** Sync ValidatorFn for a property: validates the model with the control's value substituted. */
  createSyncValidatorFn(modelInfoFn: () => EntityInfo, propertyName: string, group?: string, context?: GlobalValidationContext): ValidatorFn {
    const predicate = matchGroup(group);
    return (control: AbstractControl): ValidationErrors | null => {
      const { entity, entityType } = modelInfoFn();
      const errors = this.validationService
        .validateModelSync(withProperty(entity, propertyName, control.value), entityType, {
          predicate: (v, p) => !!p && p.propertyName === propertyName && predicate(v, p),
          context: { ...context, originalModel: entity },
        });
      return errorsToMap(errors);
    };
  }

  /** Async ValidatorFn for a property (debounced). Returns null immediately when the property has no async validators. */
  createAsyncValidatorFn(
    modelInfoFn: () => EntityInfo,
    propertyName: string,
    group?: string,
    context?: GlobalValidationContext,
    debounceMs = 300,
  ): AsyncValidatorFn {
    const predicate = matchGroup(group);
    return (control: AbstractControl): Observable<ValidationErrors | null> => {
      const { entity, entityType } = modelInfoFn();
      const property = this.validationService.validationMetadata.getModelMetadata(entityType).getProperty(propertyName);
      if (!property?.validators.some((v) => v.async && predicate(v, property))) {
        return of(null);
      }
      return timer(debounceMs).pipe(
        switchMap(() =>
          this.validationService.validateModelAsync(withProperty(entity, propertyName, control.value), entityType, {
            // Only the async rules: Angular runs the sync ones through createSyncValidatorFn.
            predicate: (v, p) => v.async && !!p && p.propertyName === propertyName && predicate(v, p),
            context: { ...context, originalModel: entity },
          }),
        ),
        map(errorsToMap),
      );
    };
  }
}

