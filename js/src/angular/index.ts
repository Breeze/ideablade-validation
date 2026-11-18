/**
 * Angular integration: standalone providers, injection tokens, signal helpers, reactive-forms validators and
 * template-driven-forms directives.
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
import * as i0 from '@angular/core';
import {
  type EnvironmentProviders,
  InjectionToken,
  type OnChanges,
  type Provider,
  type Signal,
  type SimpleChanges,
  computed,
  inject,
  input,
  makeEnvironmentProviders,
} from '@angular/core';
import { takeUntilDestroyed, toObservable, toSignal } from '@angular/core/rxjs-interop';
import {
  type AbstractControl,
  type AsyncValidator,
  type AsyncValidatorFn,
  NG_ASYNC_VALIDATORS,
  NG_VALIDATORS,
  type ValidationErrors,
  type Validator,
  type ValidatorFn,
} from '@angular/forms';
import { type Observable, Subject, map, of, switchMap, timer } from 'rxjs';

import type { EntityInfo, GlobalValidationContext, ValidatorContextProvider } from '../core/context.js';
import type { ModelValidationMetadataLike } from '../core/metadata-config.js';
import { ValidationMetadata } from '../core/metadata.js';
import type { ValidationError } from '../core/validation-error.js';
import {
  type ModelTypeResolver,
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
/** Model type resolvers (multi; the first that returns a name wins). */
export const VALIDATION_MODEL_TYPE_RESOLVER = new InjectionToken<ModelTypeResolver[]>('IdeaBlade.ValidationModelTypeResolver');
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
  /** Resolve the model type of models where none is given, such as `breezeModelType`. */
  modelTypeResolvers?: ModelTypeResolver[];
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
          modelTypeResolvers: flat(inject(VALIDATION_MODEL_TYPE_RESOLVER, { optional: true })),
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
  if (config.modelTypeResolvers?.length) {
    providers.push(...provideModelTypeResolvers(...config.modelTypeResolvers));
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

/** Registers model type resolvers, such as `breezeModelType`. */
export function provideModelTypeResolvers(...resolvers: ModelTypeResolver[]): Provider[] {
  return resolvers.map((r) => ({ provide: VALIDATION_MODEL_TYPE_RESOLVER, useValue: r, multi: true }));
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


// ---------------------------------------------------------------------------------------------------------------------
// Template-driven forms
//
// The library is compiled with plain tsc (no Angular compiler), so the directives below carry hand-written partial
// declarations (`ɵfac`/`ɵdir`), the same format ng-packagr publishes. The Angular CLI links them at build time; in JIT
// the compiler does it at runtime. The typed static fields are what the Angular compiler reads from the .d.ts. The linker parses
// the declarations statically, so they must stay literals (no helper calls for inputs). The casts
// only satisfy the facade typings, which omit `minVersion`; the emitted JS is the plain literal call the linker expects.

/**
 * Sets the model, model type, group and context for every `ngModel` in a template-driven form, so the fields
 * don't have to repeat them:
 *
 * ```html
 * <form [validationModel]="customer" validationModelType="Customer">
 *   <input name="email" [(ngModel)]="customer.email" #email="ngModel" />
 * </form>
 * ```
 */
export class ValidationFormDirective implements OnChanges {
  /** The model the form edits. */
  readonly validationModel = input<unknown>();
  /** The model type. Optional when a model type resolver (such as `breezeModelType`) recognizes the model. */
  readonly validationModelType = input<string>();
  /** Validator group; only validators of that group run (default: validators without a group). */
  readonly validationGroup = input<string>();
  /** Extra context passed to the validators. */
  readonly validationContext = input<GlobalValidationContext>();

  /** @internal Emits when an input changes, so the fields re-validate. */
  readonly changes = new Subject<void>();

  ngOnChanges(): void {
    this.changes.next();
  }

  static ɵfac: i0.ɵɵFactoryDeclaration<ValidationFormDirective, never> = i0.ɵɵngDeclareFactory({
    minVersion: '12.0.0',
    version: '17.1.0',
    ngImport: i0,
    type: ValidationFormDirective,
    deps: [],
    target: i0.ɵɵFactoryTarget.Directive,
  } as never) as never;

  static ɵdir: i0.ɵɵDirectiveDeclaration<
    ValidationFormDirective,
    'form:not([ngNoForm]),ng-form,[ngForm]',
    never,
    {
      validationModel: { alias: 'validationModel'; required: false; isSignal: true };
      validationModelType: { alias: 'validationModelType'; required: false; isSignal: true };
      validationGroup: { alias: 'validationGroup'; required: false; isSignal: true };
      validationContext: { alias: 'validationContext'; required: false; isSignal: true };
    },
    {},
    never,
    never,
    true,
    never
  > = i0.ɵɵngDeclareDirective({
    minVersion: '17.1.0',
    version: '17.1.0',
    type: ValidationFormDirective,
    isStandalone: true,
    selector: 'form:not([ngNoForm]),ng-form,[ngForm]',
    inputs: {
      validationModel: { classPropertyName: 'validationModel', publicName: 'validationModel', isSignal: true, isRequired: false, transformFunction: null },
      validationModelType: { classPropertyName: 'validationModelType', publicName: 'validationModelType', isSignal: true, isRequired: false, transformFunction: null },
      validationGroup: { classPropertyName: 'validationGroup', publicName: 'validationGroup', isSignal: true, isRequired: false, transformFunction: null },
      validationContext: { classPropertyName: 'validationContext', publicName: 'validationContext', isSignal: true, isRequired: false, transformFunction: null },
    },
    usesOnChanges: true,
    ngImport: i0,
  } as never) as never;
}

/**
 * Validates an `ngModel` with the metadata rules of its model's property: sync rules as an Angular validator, async
 * rules as an async validator. It applies to every `[ngModel]` once imported, and does nothing until a model is known.
 *
 * - The model, model type, group and context come from the field's inputs or from the enclosing
 *   {@link ValidationFormDirective}.
 * - The property defaults to the control's `name`; set `validationPropertyName` when they differ.
 *
 * The control's `errors` map error keys to {@link ValidationError}s:
 *
 * ```html
 * <input name="email" [(ngModel)]="customer.email" #email="ngModel" />
 * @for (e of email.errors | keyvalue; track e.key) { <small>{{ e.value.errorMessage }}</small> }
 * ```
 */
export class ValidationFieldDirective implements Validator, OnChanges {
  /** The model; defaults to the form's. */
  readonly validationModel = input<unknown>();
  /** The model type; defaults to what the model type resolvers return, then to the form's. */
  readonly validationModelType = input<string>();
  /** The property; defaults to the control's `name`. */
  readonly validationPropertyName = input<string>();
  /** Validator group; defaults to the form's. */
  readonly validationGroup = input<string>();
  /** Extra context passed to the validators; defaults to the form's. */
  readonly validationContext = input<GlobalValidationContext>();
  /** The control's name (also an `NgModel` input). */
  readonly name = input<string>();

  private readonly formValidators = inject(FormValidators);
  private readonly validationService = inject(ValidationService);
  private readonly form = inject(ValidationFormDirective, { optional: true });
  private onValidatorChange?: () => void;

  /** The async half, registered as `NG_ASYNC_VALIDATORS`. */
  readonly asyncValidator: AsyncValidator = {
    validate: (control) => {
      const target = this.target();
      return target
        ? this.formValidators.createAsyncValidatorFn(() => target.info, target.propertyName, target.group, target.context)(control)
        : of(null);
    },
  };

  constructor() {
    this.form?.changes.pipe(takeUntilDestroyed()).subscribe(() => this.onValidatorChange?.());
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (Object.values(changes).some((c) => !c.firstChange)) {
      this.onValidatorChange?.();
    }
  }

  validate(control: AbstractControl): ValidationErrors | null {
    const target = this.target();
    return target
      ? this.formValidators.createSyncValidatorFn(() => target.info, target.propertyName, target.group, target.context)(control)
      : null;
  }

  registerOnValidatorChange(fn: () => void): void {
    this.onValidatorChange = fn;
  }

  private target(): { info: EntityInfo; propertyName: string; group?: string; context?: GlobalValidationContext } | null {
    const model = this.validationModel() ?? this.form?.validationModel();
    const propertyName = this.validationPropertyName() ?? this.name();
    if (model == null || !propertyName) {
      return null;
    }
    const entityType = this.validationModelType() ?? this.validationService.resolveModelType(model) ?? this.form?.validationModelType();
    if (!entityType) {
      throw new Error(`Cannot validate '${propertyName}': set validationModelType on the field or the form, or register a model type resolver that recognizes the model.`);
    }
    return {
      info: { entity: model, entityType },
      propertyName,
      group: this.validationGroup() ?? this.form?.validationGroup(),
      context: this.validationContext() ?? this.form?.validationContext(),
    };
  }

  static ɵfac: i0.ɵɵFactoryDeclaration<ValidationFieldDirective, never> = i0.ɵɵngDeclareFactory({
    minVersion: '12.0.0',
    version: '17.1.0',
    ngImport: i0,
    type: ValidationFieldDirective,
    deps: [],
    target: i0.ɵɵFactoryTarget.Directive,
  } as never) as never;

  static ɵdir: i0.ɵɵDirectiveDeclaration<
    ValidationFieldDirective,
    '[ngModel]:not([formControlName]):not([formControl])',
    never,
    {
      validationModel: { alias: 'validationModel'; required: false; isSignal: true };
      validationModelType: { alias: 'validationModelType'; required: false; isSignal: true };
      validationPropertyName: { alias: 'validationPropertyName'; required: false; isSignal: true };
      validationGroup: { alias: 'validationGroup'; required: false; isSignal: true };
      validationContext: { alias: 'validationContext'; required: false; isSignal: true };
      name: { alias: 'name'; required: false; isSignal: true };
    },
    {},
    never,
    never,
    true,
    never
  > = i0.ɵɵngDeclareDirective({
    minVersion: '17.1.0',
    version: '17.1.0',
    type: ValidationFieldDirective,
    isStandalone: true,
    selector: '[ngModel]:not([formControlName]):not([formControl])',
    inputs: {
      validationModel: { classPropertyName: 'validationModel', publicName: 'validationModel', isSignal: true, isRequired: false, transformFunction: null },
      validationModelType: { classPropertyName: 'validationModelType', publicName: 'validationModelType', isSignal: true, isRequired: false, transformFunction: null },
      validationPropertyName: { classPropertyName: 'validationPropertyName', publicName: 'validationPropertyName', isSignal: true, isRequired: false, transformFunction: null },
      validationGroup: { classPropertyName: 'validationGroup', publicName: 'validationGroup', isSignal: true, isRequired: false, transformFunction: null },
      validationContext: { classPropertyName: 'validationContext', publicName: 'validationContext', isSignal: true, isRequired: false, transformFunction: null },
      name: { classPropertyName: 'name', publicName: 'name', isSignal: true, isRequired: false, transformFunction: null },
    },
    providers: [
      { provide: NG_VALIDATORS, useExisting: ValidationFieldDirective, multi: true },
      { provide: NG_ASYNC_VALIDATORS, useFactory: () => inject(ValidationFieldDirective).asyncValidator, multi: true },
    ],
    usesOnChanges: true,
    ngImport: i0,
  } as never) as never;
}

/**
 * The template-driven-forms directives. Import them next to `FormsModule`:
 * `imports: [FormsModule, ValidationFormsDirectives]`.
 */
export const ValidationFormsDirectives = [ValidationFormDirective, ValidationFieldDirective] as const;
