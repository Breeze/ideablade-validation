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
      validators: [breezeValidator],   // if you use Breeze; any validator factories go here
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
| `provideValidationScope(() => entityStore)` | Gives a route or component its own `ValidationService` and `FormValidators`, with its own entity store ([below](#scopes)). |
| `provideRuleSources(...sources)` | Adds rule sources for `from` references; a function may `inject()` (also `ruleSources` in `provideValidation`). |
| Tokens | `VALIDATION_METADATA`, `VALIDATOR_FACTORY`, `VALIDATOR_CONTEXT_PROVIDER`, `VALIDATION_EXPRESSION_SCOPE`, `VALIDATION_EXPRESSION_EVALUATOR`, `VALIDATION_SERVICE_OPTIONS`, `VALIDATION_MODEL_TYPE_RESOLVER`, `VALIDATION_RULE_SOURCE`. |

> **In TempHire:** [`app.config.ts`](https://github.com/Breeze/temphire.angular/blob/master/client/src/app/app.config.ts) sets the service up with the client's view-model metadata and the Breeze validator, model type resolver and rule source. The server's metadata is added at sign-in, when [`entity-manager-provider.ts`](https://github.com/Breeze/temphire.angular/blob/master/client/src/app/core/services/entity-manager-provider.ts) loads it next to Breeze's.

## Scopes

A validation service has one entity store, and shares its scope: one service for an app with one global unit of work, one per route for a unit of work per route ([concepts.md](concepts.md#scopes-a-service-and-its-entity-store)). `provideValidationScope` gives a route or component its own service, with the same metadata and options as the app's:

```ts
{
  path: 'orders',
  component: OrdersComponent,
  providers: [OrdersUnitOfWork, provideValidationScope(() => breezeEntityStore(inject(OrdersUnitOfWork).manager))],
}
```

The store can be any [entity store](concepts.md#writing-an-entity-store): Breeze's, as here, `signalEntityStore`, or one you write for your own data layer.

The forms in the scope validate in its store: `store(type)` and `unique` see its entities, and the fields re-validate when they change, such as an entity changed in code. When the scope moves on to another unit of work, `inject(ValidationService).setEntityStore(store)`.

The scope's service also validates its whole store continuously: `validateEntityStore()` without arguments, shared by everything in the scope. Commands such as Save react to its result:

```ts
private readonly validation = toSignal(inject(ValidationService).validateEntityStore());
readonly canSave = computed(() => {
  const result = this.validation();
  return this.unitOfWork.hasChanges() && !!result && !result.pending && result.validationErrors.length === 0;
});
```

> **In TempHire:** [`resource-mgt.component.ts`](https://github.com/Breeze/temphire.angular/blob/master/client/src/app/resource-mgt/resource-mgt.component.ts) has `provideValidationScope()` in its providers, and an `effect` that calls `setEntityStore` whenever it switches to another unit of work. Its Save button reacts to `toSignal(validation.validateEntityStore())`, and the address and phone lists ([`resource-address-list.component.ts`](https://github.com/Breeze/temphire.angular/blob/master/client/src/app/resource-mgt/sections/resource-address-list.component.ts)) show the resource's rules from the same validation.

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

Validate everything in an entity store, here a Breeze manager, and show a live error list:

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
readonly emailErrors = computed(() => this.errors().filter(e => e.isFor('email')));
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

- **Where errors show:** an error shows on the field of each property it is about (`propertyNames`), so a rule spanning two dates shows on both. Errors about the model as a whole, and about properties the form has no field for, show on the field you passed, usually the form's root.
- **Sync rules** run whenever the model changes, so cross-property rules stay up to date. They also run when the service's entity store changes.
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

> **In TempHire:** the name editor, [`resource-name-editor.component.ts`](https://github.com/Breeze/temphire.angular/blob/master/client/src/app/resource-mgt/resource-name-editor.component.ts), is a Signal Form over a `ResourceName` view model, validated with `validateWithMetadata`.

## Reactive forms

`validateFormGroup` validates a form group as a whole, as the template-driven directives do ([below](#template-driven-forms)): each control's errors come from validating the model with all the group's current values, and a change in one control re-checks the others. Control names are property names.

```ts
private readonly fv = inject(FormValidators);
readonly form = inject(FormBuilder).group({ startDate: [this.booking.startDate], endDate: [this.booking.endDate] });
readonly validation = this.fv.validateFormGroup(this.form, () => ({ entity: this.booking, entityType: 'Booking' }));
// this.validation.modelErrors(): errors about the booking as a whole
```

For single controls, `FormValidators` turns the metadata rules into Angular `ValidatorFn`/`AsyncValidatorFn`. The control's value is substituted into a view of the model; the model itself is not modified. The control's `errors` map error keys to `ValidationError`s, those about its property:

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

Import `ValidationFormsDirectives` next to `FormsModule`. Every `ngModel` is then validated against the metadata rules about its property. Sync rules run as an Angular validator, async rules as an async validator.

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

**A form validates its model as a whole.** Whenever a field changes, the form validates the model once, with every field's current value, and each field shows the errors about its property:

- its property's rules, and model-level rules that name it (`propertyNames`, [concepts.md](concepts.md#rules-that-span-properties)), so a "start before end" rule shows on both dates, and a change in one re-checks the other;
- rules whose `condition` reads another field are re-checked when that field changes;
- on a Breeze entity, Breeze's own rules for the property, through the `breeze` validator ([breeze.md](breeze.md#on-form-fields)).

Errors about the model as a whole are the form's: `#form="validationForm"` exposes `modelErrors()` (and `errors()`, all of them). The form also re-validates when the service's entity store changes ([Scopes](#scopes)), and on `revalidate()`. The form element can be any element with `ngForm`, such as one card of a list: `<div ngForm [validationModel]="address">`.

```html
<form [validationModel]="booking" #form="validationForm">
  <input name="startDate" [(ngModel)]="booking.startDate" />
  <input name="endDate" [(ngModel)]="booking.endDate" />
  @for (e of form.modelErrors(); track e.key) { <small>{{ e.errorMessage }}</small> }
</form>
```

| Input | On | Default |
|---|---|---|
| `validationModel` | `<form>` or field | The field uses the form's. |
| `validationModelType` | `<form>` or field | What the model type resolvers return for the model, then the form's. |
| `validationPropertyName` | field | The control's `name`. |
| `validationGroup` | `<form>` or field | The form's; without one, only validators without a group run. |
| `validationContext` | `<form>` or field | The form's. |

> **In TempHire:** every entity editor is a template-driven form. [`resource-address-list.component.ts`](https://github.com/Breeze/temphire.angular/blob/master/client/src/app/resource-mgt/sections/resource-address-list.component.ts) makes each address card a form with `ngForm [validationModel]="address"`, [`resource-summary.component.ts`](https://github.com/Breeze/temphire.angular/blob/master/client/src/app/resource-mgt/resource-summary.component.ts) uses `#form="validationForm"` to show a rule about two dates once, and [`field-errors.directive.ts`](https://github.com/Breeze/temphire.angular/blob/master/client/src/app/core/validation/field-errors.directive.ts) shows a field's errors as its `title`, on hover.

### Resolvers

When a model doesn't have an explicit `validationModelType`, the directives ask the registered model type resolvers ([concepts.md](concepts.md#resolvers)).

```ts
provideValidation({
  metadata,
  modelTypeResolvers: [
    breezeModelType,                                  // Breeze entities: entityType.shortName
    (model) => (model as { $type?: string })?.$type,  // your own convention
  ],
});
```

Without a resolver that recognizes the model, set `validationModelType` on the field or the form.

A field can bring its own model, for example an `ngModel` outside a form:

```html
<input [(ngModel)]="note.text" [validationModel]="note" validationModelType="Note" validationPropertyName="text" />
```

A field that sets its own model, model type, group or context is validated on its own, not with the form. As with reactive forms, the controls' values are substituted into a view of the model, and the control's `errors` map error keys to `ValidationError`s. When a form or field input changes, such as `validationGroup`, the fields re-validate. Async rules are debounced by 300 ms.
