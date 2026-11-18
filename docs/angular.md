# Angular

`@ideablade/validation/angular` provides standalone providers, injection tokens, signal helpers, reactive-forms validators and template-driven-forms directives. Tested with Angular 22; it works with Angular 17.1 and later (it needs `makeEnvironmentProviders`, `inject`, signal inputs and `@angular/core/rxjs-interop`). It also needs `@angular/forms`.

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
| Tokens | `VALIDATION_METADATA`, `VALIDATOR_FACTORY`, `VALIDATOR_CONTEXT_PROVIDER`, `VALIDATION_EXPRESSION_SCOPE`, `VALIDATION_EXPRESSION_EVALUATOR`, `VALIDATION_SERVICE_OPTIONS`, `VALIDATION_MODEL_TYPE_RESOLVER`, `VALIDATION_STORE_RESOLVER`. |

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
