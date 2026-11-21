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
  ChangeDetectorRef,
  DestroyRef,
  type EnvironmentProviders,
  InjectionToken,
  type Injector,
  type OnChanges,
  type Provider,
  type Signal,
  type SimpleChanges,
  computed,
  inject,
  input,
  makeEnvironmentProviders,
  signal,
  untracked,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import {
  type AbstractControl,
  type AsyncValidator,
  type AsyncValidatorFn,
  type FormGroup,
  NG_ASYNC_VALIDATORS,
  NG_VALIDATORS,
  type ValidationErrors,
  type Validator,
  type ValidatorFn,
} from '@angular/forms';
import { type Observable, type Subscription, filter, map, of, switchMap, timer } from 'rxjs';

import type { EntityInfo, GlobalValidationContext, StoreQuery, ValidatorContextProvider } from '../core/context.js';
import { createEntityStore } from '../core/entity-store.js';
import type { ModelValidationMetadataLike } from '../core/metadata-config.js';
import { type RuleSource, ValidationMetadata } from '../core/metadata.js';
import type { ValidationError } from '../core/validation-error.js';
import {
  type ModelTypeResolver,
  type ModelValidationState,
  type EntityStore,
  type NotifyingEntityStore,
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
/** Rule sources, consulted for `from` references (multi). */
export const VALIDATION_RULE_SOURCE = new InjectionToken<RuleSource[]>('IdeaBlade.ValidationRuleSource');
/** Store resolvers (multi; the first that returns a lookup wins). */

/** Trusted functions/values visible to expressions (multi; objects are merged). */
export const VALIDATION_EXPRESSION_SCOPE = new InjectionToken<Record<string, unknown>[]>('IdeaBlade.ValidationExpressionScope');
/** Replaces the default safe expression evaluator. */
export const VALIDATION_EXPRESSION_EVALUATOR = new InjectionToken<ExpressionEvaluator>('IdeaBlade.ValidationExpressionEvaluator');
/** Service options (async timeout, coalescing). */
export const VALIDATION_SERVICE_OPTIONS = new InjectionToken<Pick<ValidationServiceOptions, 'asyncTimeout' | 'onAsyncTimeout' | 'coalesce'>>(
  'IdeaBlade.ValidationServiceOptions',
);

export interface ValidationConfig extends Pick<ValidationServiceOptions, 'asyncTimeout' | 'onAsyncTimeout' | 'coalesce'> {
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

  /** Sources of property rules outside the metadata, such as `breezeRuleSource(metadataStore)`. */
  ruleSources?: RuleSource[];
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
          ruleSources: flat(inject(VALIDATION_RULE_SOURCE, { optional: true })),
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
    { provide: VALIDATION_SERVICE_OPTIONS, useValue: { asyncTimeout: config.asyncTimeout, onAsyncTimeout: config.onAsyncTimeout, coalesce: config.coalesce } },
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
  if (config.ruleSources?.length) {
    providers.push(...provideRuleSources(...config.ruleSources));
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
/**
 * Gives a route or component its own {@link ValidationService}, for the scope of its unit of work: the same metadata and
 * options as the parent's, and its own entity store. The forms in it validate in that store: `store(type)` and
 * `unique` see the entities, and the fields re-validate when they change. Without a store here, set it once known,
 * with `inject(ValidationService).setEntityStore(store)`.
 *
 * @example
 * { path: 'orders', component: OrdersComponent, providers: [OrdersUnitOfWork, provideValidationScope(() => inject(OrdersUnitOfWork).entityStore)] }
 */
export function provideValidationScope(entityStore?: () => EntityStore | undefined): Provider[] {
  return [
    { provide: ValidationService, useFactory: () => inject(ValidationService, { skipSelf: true }).createScope(entityStore?.()) },
    { provide: FormValidators, useFactory: () => new FormValidators(inject(ValidationService)) },
  ];
}

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

/**
 * Registers rule sources. Pass a function to create one that can `inject()` services.
 * @example provideRuleSources(() => breezeRuleSource(inject(EntityManagerProvider).metadataStore))
 */
export function provideRuleSources(...sources: (RuleSource | (() => RuleSource))[]): Provider[] {
  return sources.map((source) =>
    typeof source === 'function'
      ? { provide: VALIDATION_RULE_SOURCE, useFactory: source, multi: true }
      : { provide: VALIDATION_RULE_SOURCE, useValue: source, multi: true },
  );
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

/**
 * An {@link EntityStore} over signals: re-validates whenever a signal read by `entities` changes. Must be called in
 * an injection context, or pass an `injector`.
 *
 * @example
 * readonly orders = signal<Order[]>([]);
 * readonly result = toSignal(inject(ValidationService).validateEntityStore(
 *   signalEntityStore(() => this.orders().map((entity) => ({ entityType: 'Order', entity })))));
 */
export function signalEntityStore(
  entities: () => readonly EntityInfo[],
  options: { injector?: Injector; getEntities?: StoreQuery } = {},
): NotifyingEntityStore {
  const source = computed(entities);
  let read: readonly EntityInfo[] | undefined;
  return createEntityStore({
    entities: () => (read = untracked(source)),
    // toObservable emits the current value from an effect; skip values the service has already read.
    changes: toObservable(source, { injector: options.injector }).pipe(filter((value) => value !== read)),
    getEntities: options.getEntities,
  });
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

/**
 * The async rules about a property: its own, and model-level ones that name it. A control's async validator runs only
 * these; Angular runs the sync ones through the sync validator.
 */
function asyncRulesAbout(propertyName: string, group?: string): ValidatorPredicate {
  const predicate = matchGroup(group);
  return (v, p) => v.async && predicate(v, p) && (p ? p.propertyName === propertyName : !!v.propertyNames?.includes(propertyName));
}

function errorsToMap(errors: readonly ValidationError[]): ValidationErrors | null {
  if (errors.length === 0) {
    return null;
  }
  return errors.reduce<ValidationErrors>((acc, e) => {
    acc[e.key] = e;
    return acc;
  }, {});
}

/** A view of `model` with the given property values; other properties (incl. accessors) come from the model. */
function withValues(model: unknown, values: readonly (readonly [string, unknown])[]): unknown {
  const view = Object.create((model ?? {}) as object);
  for (const [propertyName, value] of values) {
    Object.defineProperty(view, propertyName, { value, enumerable: true, configurable: true, writable: true });
  }
  return view;
}

function sameValues(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}

/** What a {@link FormModelValidation} validates: the model and its type, and the group and context to use. */
export interface FormModelTarget {
  info: EntityInfo;
  group?: string;
  context?: GlobalValidationContext;
}

/**
 * Validates one model for all the form controls bound to it. Every control's errors come from one validation of the
 * whole model, with each control's current value in place of its property, so:
 *
 * - a control shows the errors of its property's rules, and of model-level rules that name the property
 *   (`propertyNames`), such as a "start before end" rule on both dates;
 * - a change in one control re-validates all the others, because a value can break or fix another field's rule, or
 *   change a condition;
 * - a change made elsewhere re-validates them all too: a change of the service's entity store (the model changed in
 *   code, or an entity a rule reads), or a call to {@link revalidate}. The same store gives the rules `store(type)`.
 *
 * Errors about the model as a whole (no `propertyNames`) are in {@link modelErrors}. The template-driven-forms
 * directives create one per form; {@link FormValidators.validateFormGroup} creates one for a reactive form group.
 */
export class FormModelValidation {
  private readonly controls = new Map<AbstractControl, { propertyName: string; subscription: Subscription }>();
  private last?: { values: readonly unknown[]; errors: ValidationError[] };
  private refreshing = false;
  private storeChanges?: Subscription;
  private readonly state = signal<readonly ValidationError[]>([]);

  /** All errors of the latest validation. */
  readonly errors: Signal<readonly ValidationError[]> = this.state.asReadonly();
  /** Errors about the model as a whole: model-level rules that name no properties. */
  readonly modelErrors: Signal<readonly ValidationError[]> = computed(() => this.state().filter((e) => e.propertyNames.length === 0));

  constructor(
    private readonly validationService: ValidationService,
    private readonly target: () => FormModelTarget | null,
    private readonly onRefresh?: () => void,
  ) {}

  /** Adds a control bound to `propertyName`; its value takes the property's place in the validation. */
  register(control: AbstractControl, propertyName: string): void {
    const entry = this.controls.get(control);
    if (entry) {
      if (entry.propertyName !== propertyName) {
        entry.propertyName = propertyName;
        this.last = undefined;
      }
      return;
    }
    const subscription = control.valueChanges.subscribe(() => this.refresh(control));
    this.controls.set(control, { propertyName, subscription });
    this.last = undefined;
  }

  unregister(control: AbstractControl): void {
    this.controls.get(control)?.subscription.unsubscribe();
    if (this.controls.delete(control)) {
      this.last = undefined;
    }
  }

  /** The errors for a control, as Angular wants them: keyed by error key. Registers the control. */
  errorsFor(control: AbstractControl, propertyName: string): ValidationErrors | null {
    this.register(control, propertyName);
    return errorsToMap(this.validate(control).filter((e) => e.isFor(propertyName)));
  }

  /**
   * The async errors for a control, as Angular's async validators want them: the async rules about its property, run
   * (after `debounceMs`) on the model with all the controls' current values, as {@link errorsFor} runs the sync ones.
   * Emits null at once when the property has no async rules. Registers the control.
   */
  asyncErrorsFor(control: AbstractControl, propertyName: string, debounceMs = 300): Observable<ValidationErrors | null> {
    this.register(control, propertyName);
    const target = this.target();
    if (!target || target.info.entity == null) {
      return of(null);
    }
    const { info, group, context } = target;
    const asyncRules = asyncRulesAbout(propertyName, group);
    if (!this.validationService.hasAsyncValidators(info.entityType, asyncRules)) {
      return of(null);
    }
    const model = withValues(info.entity, this.entries(control));
    return timer(debounceMs).pipe(
      switchMap(() =>
        this.validationService.validateModelAsync(model, info.entityType, {
          predicate: asyncRules,
          context: { ...context, originalModel: info.entity },
        }),
      ),
      map((errors) => errorsToMap(errors.filter((e) => e.isFor(propertyName)))),
    );
  }

  /**
   * Validates the model with the controls' current values (once per change of the model or a value). When several
   * controls edit the same property, `control`'s value is the one used.
   */
  validate(control?: AbstractControl): ValidationError[] {
    const target = this.target();
    if (!target || target.info.entity == null) {
      return [];
    }
    const { info, group, context } = target;
    this.watch();
    const entries = this.entries(control);
    const values = [info.entity, info.entityType, group, context, ...entries.flat()];
    if (this.last && sameValues(this.last.values, values)) {
      return this.last.errors;
    }
    const errors = this.validationService.validateModelSync(withValues(info.entity, entries), info.entityType, {
      predicate: matchGroup(group),
      context: { ...context, originalModel: info.entity },
    });
    this.last = { values, errors };
    untracked(() => this.state.set(errors));
    return errors;
  }

  /** Re-validates every control, e.g. after the model changed in a way nothing reported. */
  revalidate(): void {
    this.last = undefined;
    this.validate();
    this.refresh();
  }

  /** Stops watching the model and releases the controls. */
  dispose(): void {
    for (const control of [...this.controls.keys()]) {
      this.unregister(control);
    }
    this.storeChanges?.unsubscribe();
    this.storeChanges = undefined;
  }

  /** `[propertyName, value]` of every control, `control`'s last so its value wins for a property edited twice. */
  private entries(control?: AbstractControl): (readonly [string, unknown])[] {
    const ordered = [...this.controls.entries()];
    const own = control ? ordered.findIndex(([c]) => c === control) : -1;
    if (own >= 0) {
      ordered.push(...ordered.splice(own, 1));
    }
    return ordered.map(([c, { propertyName }]) => [propertyName, c.value] as const);
  }

  /** Updates every control except the one that just changed (it has already validated). */
  private refresh(except?: AbstractControl): void {
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      for (const control of this.controls.keys()) {
        if (control !== except) {
          control.updateValueAndValidity();
        }
      }
    } finally {
      this.refreshing = false;
    }
    this.onRefresh?.();
  }

  /** Re-validates when the service's entity store changes. */
  private watch(): void {
    this.storeChanges ??= this.validationService.entityStoreChanged$.subscribe(() => this.revalidate());
  }
}

/**
 * Bridges metadata validation to Angular reactive forms. A control's errors are the {@link ValidationError}s
 * of the model's property, keyed by error key (`control.errors['required_email'].errorMessage`).
 */
export class FormValidators {
  constructor(private readonly validationService: ValidationService) {}

  /**
   * Validates a reactive form group against a model, all controls together, as the template-driven-forms directives
   * do: each control's errors come from validating the model with all the group's current values, so a rule spanning
   * properties updates every field it names, and a change in one control re-validates the others. Control names are
   * property names. Returns the {@link FormModelValidation} (model-level errors, `revalidate`, `dispose`).
   *
   * Async rules about a control's property run as its async validator, debounced, on the model with all the group's
   * current values too ({@link FormModelValidation.asyncErrorsFor}). Angular runs them once the control's sync rules
   * pass, and again when another control changes, as it re-checks the others.
   */
  validateFormGroup(formGroup: FormGroup, modelInfoFn: () => EntityInfo, group?: string, context?: GlobalValidationContext): FormModelValidation {
    const validation = new FormModelValidation(this.validationService, () => ({ info: modelInfoFn(), group, context }));
    for (const [propertyName, control] of Object.entries(formGroup.controls)) {
      validation.register(control, propertyName);
      control.addValidators((c) => validation.errorsFor(c, propertyName));
      control.addAsyncValidators((c) => validation.asyncErrorsFor(c, propertyName));
    }
    for (const control of Object.values(formGroup.controls)) {
      control.updateValueAndValidity();
    }
    return validation;
  }

  /** `[value, syncValidators, asyncValidators]` tuple for `FormBuilder.group`. */
  formControl(value: unknown, modelInfoFn: () => EntityInfo, propertyName: string, group?: string, context?: GlobalValidationContext): [unknown, ValidatorFn[], AsyncValidatorFn[]] {
    return [
      value,
      [this.createSyncValidatorFn(modelInfoFn, propertyName, group, context)],
      [this.createAsyncValidatorFn(modelInfoFn, propertyName, group, context)],
    ];
  }

  /**
   * Sync ValidatorFn for one control: validates the whole model with the control's value in place of the property,
   * and reports the errors about the property, model-level rules naming it included. For a group of controls that
   * depend on each other, use {@link validateFormGroup}.
   */
  createSyncValidatorFn(modelInfoFn: () => EntityInfo, propertyName: string, group?: string, context?: GlobalValidationContext): ValidatorFn {
    const predicate = matchGroup(group);
    return (control: AbstractControl): ValidationErrors | null => {
      const { entity, entityType } = modelInfoFn();
      const errors = this.validationService.validateModelSync(withValues(entity, [[propertyName, control.value]]), entityType, {
        predicate,
        context: { ...context, originalModel: entity },
      });
      return errorsToMap(errors.filter((e) => e.isFor(propertyName)));
    };
  }

  /** Async ValidatorFn for a property (debounced): the async rules about the property. Returns null at once when there are none. */
  createAsyncValidatorFn(
    modelInfoFn: () => EntityInfo,
    propertyName: string,
    group?: string,
    context?: GlobalValidationContext,
    debounceMs = 300,
  ): AsyncValidatorFn {
    const asyncRules = asyncRulesAbout(propertyName, group);
    return (control: AbstractControl): Observable<ValidationErrors | null> => {
      const { entity, entityType } = modelInfoFn();
      if (!this.validationService.hasAsyncValidators(entityType, asyncRules)) {
        return of(null);
      }
      return timer(debounceMs).pipe(
        switchMap(() =>
          this.validationService.validateModelAsync(withValues(entity, [[propertyName, control.value]]), entityType, {
            predicate: asyncRules,
            context: { ...context, originalModel: entity },
          }),
        ),
        map((errors) => errorsToMap(errors.filter((e) => e.isFor(propertyName)))),
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
 * don't have to repeat them, and validates the model once for all of them ({@link FormModelValidation}): a change in
 * one field re-validates the others. Any element with `ngForm` can be one, such as one card of a list.
 *
 * ```html
 * <form [validationModel]="customer" #form="validationForm">
 *   <input name="email" [(ngModel)]="customer.email" #email="ngModel" />
 *   @for (e of form.modelErrors(); track e.key) { <small>{{ e.errorMessage }}</small> }
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

  private readonly validationService = inject(ValidationService);
  private readonly changeDetector = inject(ChangeDetectorRef);

  /** The form's validation: all its errors, the model-level ones, and `revalidate()`. */
  readonly validation = new FormModelValidation(
    this.validationService,
    () => targetOf(this.validationService, this.validationModel(), this.validationModelType(), this.validationGroup(), this.validationContext()),
    () => this.changeDetector.markForCheck(),
  );
  /** All errors of the latest validation. */
  readonly errors = this.validation.errors;
  /** Errors about the model as a whole: model-level rules that name no properties. */
  readonly modelErrors = this.validation.modelErrors;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.validation.dispose());
  }

  ngOnChanges(): void {
    this.validation.revalidate();
  }

  /** Re-validates every field, e.g. after the model changed in a way nothing reported. */
  revalidate(): void {
    this.validation.revalidate();
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
    ['validationForm'],
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
    exportAs: ['validationForm'],
    usesOnChanges: true,
    ngImport: i0,
  } as never) as never;
}

/** The target of a form or field, with the model type from the inputs or the model type resolvers. */
function targetOf(
  service: ValidationService,
  model: unknown,
  modelType: string | undefined,
  group: string | undefined,
  context: GlobalValidationContext | undefined,
): FormModelTarget | null {
  if (model == null) {
    return null;
  }
  const entityType = modelType ?? service.resolveModelType(model);
  if (!entityType) {
    throw new Error('Cannot validate the form: set validationModelType, or register a model type resolver that recognizes the model.');
  }
  return { info: { entity: model, entityType }, group, context };
}

/**
 * Validates an `ngModel` with the metadata rules: sync rules as an Angular validator, async rules as an async
 * validator. It applies to every `[ngModel]` once imported, and does nothing until a model is known.
 *
 * - The model, model type, group and context come from the enclosing {@link ValidationFormDirective}. A field that
 *   sets any of them itself is validated on its own.
 * - The property defaults to the control's `name`; set `validationPropertyName` when they differ.
 * - The control's errors are those about its property: its rules, and model-level rules that name it
 *   (`propertyNames`). They are re-checked whenever another field of the form changes.
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

  private readonly validationService = inject(ValidationService);
  private readonly form = inject(ValidationFormDirective, { optional: true });
  private onValidatorChange?: () => void;
  private control?: AbstractControl;
  private own?: FormModelValidation;
  private registeredWith?: FormModelValidation;

  /**
   * The async half, registered as `NG_ASYNC_VALIDATORS`: the async rules about the property, on the model with all the
   * form's current values, as the sync half.
   */
  readonly asyncValidator: AsyncValidator = {
    validate: (control) => {
      const validation = this.validation();
      const propertyName = this.propertyName();
      return validation && propertyName ? validation.asyncErrorsFor(control, propertyName) : of(null);
    },
  };

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.control) {
        this.registeredWith?.unregister(this.control);
      }
      this.own?.dispose();
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (Object.values(changes).some((c) => !c.firstChange)) {
      this.own?.revalidate();
      this.onValidatorChange?.();
    }
  }

  validate(control: AbstractControl): ValidationErrors | null {
    this.control = control;
    const validation = this.validation();
    const propertyName = this.propertyName();
    if (validation !== this.registeredWith) {
      this.registeredWith?.unregister(control);
      this.registeredWith = validation;
    }
    return validation && propertyName ? validation.errorsFor(control, propertyName) : null;
  }

  registerOnValidatorChange(fn: () => void): void {
    this.onValidatorChange = fn;
  }

  private propertyName(): string | undefined {
    return this.validationPropertyName() ?? this.name();
  }

  /** The form's validation, or the field's own when it sets its model, type, group or context itself, or has no form. */
  private validation(): FormModelValidation | undefined {
    if (!this.propertyName()) {
      return undefined;
    }
    const ownSettings =
      this.validationModel() !== undefined ||
      this.validationModelType() !== undefined ||
      this.validationGroup() !== undefined ||
      this.validationContext() !== undefined;
    if (this.form && !ownSettings) {
      return this.form.validation;
    }
    return (this.own ??= new FormModelValidation(this.validationService, () => this.target()));
  }

  private target(): FormModelTarget | null {
    return targetOf(
      this.validationService,
      this.validationModel() ?? this.form?.validationModel(),
      this.validationModelType() ?? (this.validationModel() !== undefined ? undefined : this.form?.validationModelType()),
      this.validationGroup() ?? this.form?.validationGroup(),
      this.validationContext() ?? this.form?.validationContext(),
    );
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
