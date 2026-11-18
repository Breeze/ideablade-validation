# Angular

`@ideablade/validation/angular` provides standalone providers, injection tokens, signal helpers, reactive-forms validators and template-driven-forms directives. Signal Forms support is in `@ideablade/validation/angular/signal-forms` ([below](#signal-forms)). Tested with Angular 22; it works with Angular 17.1 and later (it needs `makeEnvironmentProviders`, `inject`, signal inputs and `@angular/core/rxjs-interop`). It also needs `@angular/forms`.

The library uses no decorators. Everything is functional DI, so it needs no Angular compiler step and is AOT/zoneless friendly. The two directives ship as partial declarations, the format Angular libraries publish, which the Angular CLI links when it builds your app.

## Setup

```ts
// app.config.ts
import { ApplicationConfig, inject } from '@angular/core';
import { provideValidation, provideValidatorContext, provideValidatorFactory } from '@ideablade/validation/angular';
import { breezeValidator } from '@ideablade/validation/breeze';
import { asyncValidator } from '@ideablade/validation';
import validationMetadata from './validation.metadata.json';

export const appConfig: ApplicationConfig = {
  providers: [
    provideValidation({
      metadata: validationMetadata,
      validators: [breezeValidator],
      asyncTimeout: 30_000,
      expressionScope: { today: () => new Date() },
    }),
    // Validators that need services
    provideValidatorFactory(() => {
      const api = inject(UserApi);
      return asyncValidator('loginAvailable', (login) => api.isAvailable(login), '%displayName% is taken');
    }),
    // Context for every validation, such as the current user
    provideValidatorContext(() => {
      const session = inject(SessionService);
      return { contextFn: () => ({ user: session.user, roles: session.roles }) };
    }),
  ],
};
```

Feature areas can add metadata with `provideValidationMetadata(featureMetadata)` in their route providers. To load metadata at runtime, call `inject(ValidationMetadata).setMetadata(json)`.

| API | Purpose |
|---|---|
| `provideValidation(config)` | Registers `ValidationService`, `ValidationMetadata`, `FormValidators` and (by default) the built-in validators. |
| `provideValidationMetadata(...maps)` | Adds metadata (multi). |
| `provideValidators(...factories)` | Adds validator factories. |
| `provideValidatorFactory(() => factory)` | Adds a factory that can `inject()`. |
| `provideValidatorContext(() => provider)` | Adds a context provider that can `inject()`. |
| `provideExpressionScope(scope \| () => scope)` | Adds functions or values for expressions. |
| `provideModelTypeResolvers(...resolvers)` | Adds model type resolvers (also `modelTypeResolvers` in `provideValidation`). |
| `provideStoreResolvers(...resolvers)` | Adds store resolvers, which give `store(type)` and `unique` a store in forms (also `storeResolvers` in `provideValidation`). |
| `provideRuleSources(...sources)` | Adds rule sources for `from` references; a function may `inject()` (also `ruleSources` in `provideValidation`). |
| Tokens | `VALIDATION_METADATA`, `VALIDATOR_FACTORY`, `VALIDATOR_CONTEXT_PROVIDER`, `VALIDATION_EXPRESSION_SCOPE`, `VALIDATION_EXPRESSION_EVALUATOR`, `VALIDATION_SERVICE_OPTIONS`, `VALIDATION_MODEL_TYPE_RESOLVER`, `VALIDATION_STORE_RESOLVER`, `VALIDATION_RULE_SOURCE`. |

## Using the service

```ts
@Component({ ... })
export class OrderComponent {
  private readonly validation = inject(ValidationService);

  save(order: Order) {
    // Sync and async rules; emits all errors once
    this.validation.validateModelAsync(order, 'Order').subscribe(errors => {
      if (errors.length) { this.show(errors); return; }
      ...
    });
  }
}
```

Validate everything in a Breeze manager and show a live error list:

```ts
readonly result = toSignal(inject(ValidationService).validateEntityStore(breezeEntityStore(this.manager)));
```

### Validating a set of entities

When the entities live in signals, `signalEntityStore` creates the store. It re-validates whenever a signal it reads changes. Call it in an injection context, or pass `{ injector }`.

```ts
readonly orders = signal<Order[]>([]);
readonly result = toSignal(inject(ValidationService).validateEntityStore(
  signalEntityStore(() => this.orders().map((entity) => ({ entityType: 'Order', entity }))),
));
```

For other sources, see [Writing an entity store](concepts.md#writing-an-entity-store).

## Signals

```ts
readonly customer = signal<Customer>(...);
readonly errors = validationErrors(this.customer, 'Customer');          // Signal<ValidationError[]>, sync rules
readonly state  = validationState(this.customer, 'Customer');           // Signal<{ errors, pending }>, sync + async
readonly emailErrors = computed(() => this.errors().filter(e => e.propertyName === 'email'));
```

Both functions must be called in an injection context (field initializers, a constructor, or `runInInjectionContext`). For objects mutated in place, such as Breeze entities, read a change counter inside the function so the signal recomputes:

```ts
readonly errors = validationErrors(() => (this.changes(), this.entity), 'Customer');
```

## Signal Forms

`validateWithMetadata` from `@ideablade/validation/angular/signal-forms` applies the metadata rules of a model type to a Signal Forms form (`@angular/forms/signals`). Signal Forms needs Angular 22, so it has its own entry point; the rest of the Angular integration keeps working with Angular 17.1 and later.

Call it in the schema function of `form()`, which runs in an injection context:

```ts
import { form, FormField } from '@angular/forms/signals';
import { validateWithMetadata } from '@ideablade/validation/angular/signal-forms';

@Component({
  imports: [FormField],
  template: `
    <input [formField]="nameForm.firstName" />
    @for (error of nameForm.firstName().errors(); track error.kind) { <small>{{ error.message }}</small> }
  `,
})
export class NameEditorComponent {
  readonly name = signal<ResourceName>({ firstName: '', middleName: '', lastName: '' });
  readonly nameForm = form(this.name, (path) => validateWithMetadata(path, { modelType: 'ResourceName' }));
}
```

- **Where errors show:** an error of a property shows on that property's field. Model-level errors, and errors of properties the form has no field for, show on the field you passed, usually the form's root.
- **Sync rules** run whenever the model changes, so cross-property rules stay up to date.
- **Async rules** run debounced (`debounce`, default 300 ms), once the sync ones pass. They include Breeze's async validators when the rules come from `breezeRuleSource`.
- **The errors:** `kind` is the framework's error key (`required_firstName`), `message` the error message, and `validationError` the full `ValidationError`.

| Option | Default |
|---|---|
| `modelType` | The model type resolvers. A string, or a function of the model. |
| `group` | Validators without a group, as in the other form integrations. |
| `context` | Extra context for the validators. |
| `predicate` | All validators (after the group filter). |
| `debounce` | 300 ms, for async rules. |
| `service` | `inject(ValidationService)`. |

A view model whose properties inherit an entity's rules with [`from`](metadata.md#inheriting-a-propertys-rules-from) gets the entity's Breeze rules in a Signal Form, with no rules restated. See [breeze.md](breeze.md#rules-for-view-models-breezerulesource).

## Reactive forms

`FormValidators` turns the metadata rules for a property into Angular `ValidatorFn`/`AsyncValidatorFn`. The control's value is substituted into a view of the model; the model itself is not modified. The control's `errors` map error keys to `ValidationError`s:

```ts
private readonly fv = inject(FormValidators);
readonly form = inject(FormBuilder).group({
  email: this.fv.formControl(this.customer.email, () => ({ entity: this.customer, entityType: 'Customer' }), 'email'),
  login: ['', this.fv.createSyncValidatorFn(info, 'login'), this.fv.createAsyncValidatorFn(info, 'login', 'signup')],
});
```

```html
@for (e of form.controls.email.errors | keyvalue; track e.key) { <small>{{ e.value.errorMessage }}</small> }
```

## Template-driven forms

Import `ValidationFormsDirectives` next to `FormsModule`. Every `ngModel` is then validated against the metadata rules of its property. Sync rules run as an Angular validator, async rules as an async validator.

```ts
@Component({
  imports: [FormsModule, ValidationFormsDirectives],
  template: `
    <form [validationModel]="customer" validationModelType="Customer">
      <input name="email" [(ngModel)]="customer.email" #email="ngModel" />
      @for (e of email.errors | keyvalue; track e.key) { <small>{{ e.value.errorMessage }}</small> }

      <input name="altEmail" [(ngModel)]="customer.altEmail" validationPropertyName="email" />
    </form>
  `,
})
export class CustomerFormComponent { ... }
```

There's no attribute to add to each field. The field directive's selector is `[ngModel]`, so it attaches wherever `ngModel` is used. It does nothing until it knows a model.

A field runs its property's rules, plus model-level validators that can check a single property. `breeze` is one of them, so on a Breeze entity a field shows Breeze's own rules for its property too ([breeze.md](breeze.md#on-form-fields)). The form element can be any element with `ngForm`, such as one card of a list: `<div ngForm [validationModel]="address">`.

| Input | On | Default |
|---|---|---|
| `validationModel` | `<form>` or field | The field uses the form's. |
| `validationModelType` | `<form>` or field | What the model type resolvers return for the model, then the form's. |
| `validationPropertyName` | field | The control's `name`. |
| `validationGroup` | `<form>` or field | The form's; without one, only validators without a group run. |
| `validationContext` | `<form>` or field | The form's. |

### Resolvers

When a model doesn't have an explicit `validationModelType`, the directives ask the registered model type resolvers. Register store resolvers too, so that `unique` and `store(type)` work in forms. [Resolvers](concepts.md#resolvers) explains both kinds and how to write your own.

```ts
provideValidation({
  metadata,
  modelTypeResolvers: [
    breezeModelType,                                  // Breeze entities: entityType.shortName
    (model) => (model as { $type?: string })?.$type,  // your own convention
  ],
  storeResolvers: [breezeStoreQuery],                 // store(type) and unique for Breeze entities
});
```

Without a resolver that recognizes the model, set `validationModelType` on the field or the form.

A field can bring its own model, for example an `ngModel` outside a form:

```html
<input [(ngModel)]="note.text" [validationModel]="note" validationModelType="Note" validationPropertyName="text" />
```

As with reactive forms, the control's value is substituted into a view of the model, and the control's `errors` map error keys to `ValidationError`s. When a form or field input changes, such as `validationGroup`, the control re-validates. Async rules are debounced by 300 ms.
