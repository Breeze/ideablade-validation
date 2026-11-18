# Angular

`@ideablade/validation/angular` provides standalone providers, injection tokens, signal helpers and reactive-forms validators. Tested with Angular 22; it works with Angular 17 and later (it needs `makeEnvironmentProviders`, `inject` and `@angular/core/rxjs-interop`).

The library uses no decorators. Everything is functional DI, so it needs no Angular compiler step and is AOT/zoneless friendly.

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
| Tokens | `VALIDATION_METADATA`, `VALIDATOR_FACTORY`, `VALIDATOR_CONTEXT_PROVIDER`, `VALIDATION_EXPRESSION_SCOPE`, `VALIDATION_EXPRESSION_EVALUATOR`, `VALIDATION_SERVICE_OPTIONS`. |

## Using the service

```ts
@Component({ ... })
export class OrderComponent {
  private readonly validation = inject(ValidationService);

  save(order: Order) {
    const errors = this.validation.validateModelSync(order, 'Order');
    if (errors.length) { this.show(errors); return; }
    this.validation.validateModelAsync(order, 'Order').subscribe(asyncErrors => ...);
  }
}
```

Validate everything in a Breeze manager and show a live error list:

```ts
readonly result = toSignal(inject(ValidationService).validateEntityStore(breezeEntityStore(this.manager)));
```

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
