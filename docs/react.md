# React

`@ideablade/validation/react` provides a context provider and hooks. It works with React 18 and 19, and your components never handle Observables directly.

## Setup

```tsx
import { ValidationProvider } from '@ideablade/validation/react';
import { breezeValidator } from '@ideablade/validation/breeze';
import metadata from './validation.metadata.json';

root.render(
  <ValidationProvider metadata={metadata} validators={[breezeValidator]} expressionScope={{ today: () => new Date() }}>
    <App />
  </ValidationProvider>,
);
```

The provider accepts either `service={existingService}` or any option of `createValidationService` (`metadata`, `validators`, `contextProviders`, `expressionScope`, `expressionEvaluator`, `asyncTimeout`, `includeDefaultValidators`). It creates the service once, on first render.

If you have a dependency-injection container (InversifyJS, tsyringe, …), create the service there and pass `service`.

## `useValidation(model, modelType, options?)`

```tsx
function CustomerForm({ customer }: { customer: Customer }) {
  const { errors, isValid, pending, messagesFor } = useValidation(customer, 'Customer');

  return (
    <form>
      <input value={customer.email} onChange={...} />
      {messagesFor('email').map((m) => <small key={m}>{m}</small>)}
      <button disabled={!isValid}>{pending ? 'Checking…' : 'Save'}</button>
    </form>
  );
}
```

| Result | |
|---|---|
| `errors` | All errors: sync errors, plus async errors once they arrive |
| `isValid` | No errors and nothing pending |
| `pending` | Async validators are running |
| `errorsFor(prop?)` / `messagesFor(prop?)` | Errors for one property. Call without an argument to get model-level errors. |
| `revalidate()` | Force re-validation |

Sync rules run during render, so there's no flash of "valid". Async rules run in an effect. When the model changes, the previous async run is cancelled and its late results are ignored.

| Option | |
|---|---|
| `async` | Set `false` to skip async validators (default `true`) |
| `deps` | Extra dependencies that trigger re-validation (see below) |
| `disabled` | Skip validation, for example while loading |
| `predicate`, `context`, `store`, `expressionScope`, … | Passed to the service |

**Objects mutated in place** (Breeze entities, MobX objects) keep the same identity, so React can't see that they changed. Pass what changed in `deps`, or call `revalidate()`:

```tsx
const { messagesFor } = useValidation(entity, 'Customer', { deps: [entity.email, entity.name] });
```

## `useEntityStoreValidation(store, options?)`

This hook continuously validates every entity in a store and returns the latest `{ entities, validationErrors }`:

```tsx
const store = useMemo(() => breezeEntityStore(manager), [manager]);
const result = useEntityStoreValidation(store);
return <ErrorList errors={result?.validationErrors ?? []} />;
```

Memoize the store: a new store object restarts validation.

## Lower-level hooks

- `useValidationService()` returns the service. Use it for imperative validation, for example on submit: `service.validateModelSync(model, type)`.
- `useObservable(() => observable$, initial, deps)` subscribes to any Observable.
