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

The provider accepts either `service={existingService}` or any option of `createValidationService` (`metadata`, `validators`, `contextProviders`, `expressionScope`, `expressionEvaluator`, `asyncTimeout`, `includeDefaultValidators`). It creates the service once, on first render. `breezeValidator` is only needed if you use Breeze; other data layers register their own pieces the same way ([Integrating your data layer](concepts.md#integrating-your-data-layer)).

If you have a dependency-injection container (InversifyJS, tsyringe, …), create the service there and pass `service`.

> **In TempHire:** [`app-services.tsx`](https://github.com/Breeze/temphire.react/blob/main/client/src/app/core/services/app-services.tsx) creates the service with the Breeze validator, model type resolver and rule source, and [`main.tsx`](https://github.com/Breeze/temphire.react/blob/main/client/src/main.tsx) provides it with `<ValidationProvider>`.

## `useValidation(model, modelType?, options?)`

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
| `errorsFor(prop?)` / `messagesFor(prop?)` | Errors about one property: its rules, and model-level rules that name it (`propertyNames`). Without an argument, the errors about the model as a whole. |
| `revalidate()` | Force re-validation |

The hook validates the whole model, so a rule spanning properties, such as "start before end", shows for both, and a rule whose condition reads another property follows it. Sync rules run during render, so there's no flash of "valid". Async rules run in an effect. When the model changes, the previous async run is cancelled and its late results are ignored.

| Option | |
|---|---|
| `async` | Set `false` to skip async validators (default `true`) |
| `deps` | Extra dependencies that trigger re-validation (see below) |
| `disabled` | Skip validation, for example while loading |
| `predicate`, `context`, `store`, `expressionScope`, … | Passed to the service |

**Objects mutated in place** (Breeze entities, MobX objects) keep the same identity, so React can't see that they changed. When the model is in the service's [entity store](concepts.md#scopes-a-service-and-its-entity-store), the hook re-validates whenever the store reports a change. Otherwise, pass what changed in `deps`, or call `revalidate()`:

```tsx
const { messagesFor } = useValidation(entity, 'Customer', { deps: [entity.email, entity.name] });
```

Without a `modelType`, the registered [model type resolvers](concepts.md#resolvers) name the model, such as `breezeModelType` for Breeze entities: `useValidation(entity)`.

## Forms: `<ValidationForm>` and `useFieldValidation(property?)`

`ValidationForm` validates a model once for all the fields inside it, the counterpart of Angular's form directive. A field reads the errors about its property with `useFieldValidation`: its rules, and model-level rules that name it, so a rule spanning two fields shows on both, and a change in one re-checks the other.

```tsx
function TextField({ model, property }: { model: Customer; property: keyof Customer & string }) {
  const { message, invalid } = useFieldValidation(property);
  return <input value={model[property]} onChange={...} aria-invalid={invalid || undefined} title={message ?? undefined} />;
}

<ValidationForm model={customer}>
  <TextField model={customer} property="email" />
  <TextField model={customer} property="name" />
</ValidationForm>
```

`ValidationForm` takes `model`, an optional `modelType`, and the options of `useValidation`. `useFieldValidation` returns `errors`, `messages`, `message` (the messages joined, or `null`) and `invalid`; without a property name, the errors about the model as a whole. Outside a `ValidationForm` there are none.

> **In TempHire:** [`EntityFields.tsx`](https://github.com/Breeze/temphire.react/blob/main/client/src/app/core/validation/EntityFields.tsx) has the inputs, each showing its property's errors with `useFieldValidation`. [`ResourceAddressList.tsx`](https://github.com/Breeze/temphire.react/blob/main/client/src/app/resource-mgt/sections/ResourceAddressList.tsx) wraps each address card in `<ValidationForm model={address}>`, and [`ResourceSummary.tsx`](https://github.com/Breeze/temphire.react/blob/main/client/src/app/resource-mgt/ResourceSummary.tsx) shows a rule about two dates once.

## Scopes: `useValidationScope(entityStore)`

A validation service has one entity store, the entities of its scope, such as a unit of work's ([concepts.md](concepts.md#scopes-a-service-and-its-entity-store)). `useValidationScope` returns a service with the nearest provider's metadata and options and its own store; provide it to the components of the scope:

```tsx
function OrderEditor({ unitOfWork }: { unitOfWork: UnitOfWork }) {
  const store = useMemo(() => breezeEntityStore(unitOfWork.manager), [unitOfWork]);
  const service = useValidationScope(store);
  return <ValidationProvider service={service}><OrderForm order={unitOfWork.order} /></ValidationProvider>;
}
```

`store(type)` and `unique` then see the store's entities, and `useValidation` re-validates when they change. The store can be any [entity store](concepts.md#writing-an-entity-store): Breeze's, as here, or one built with `createEntityStore` for your own data layer.

> **In TempHire:** [`ResourceMgt.tsx`](https://github.com/Breeze/temphire.react/blob/main/client/src/app/resource-mgt/ResourceMgt.tsx) creates the route's scope with `useValidationScope(unitOfWork?.entityStore)` and provides it to the detail sections.

## `useEntityStoreValidation(store?, options?)`

This hook continuously validates every entity in a store, sync and async, and returns the latest `{ entities, validationErrors, pending }`. Without a store, it validates the entity store of the scope's service ([Scopes](#scopes-usevalidationscopeentitystore)), and every component of the scope shares that one validation:

```tsx
const result = useEntityStoreValidation();
const canSave = hasChanges && !!result && !result.pending && result.validationErrors.length === 0;
```

With a store, it validates that one:

```tsx
const store = useMemo(() => breezeEntityStore(manager), [manager]);   // or any other entity store
const result = useEntityStoreValidation(store);
return <ErrorList errors={result?.validationErrors ?? []} />;
```

Memoize the store: a new store object restarts validation. `null` validates nothing.

> **In TempHire:** the address and phone lists ([`ResourceAddressList.tsx`](https://github.com/Breeze/temphire.react/blob/main/client/src/app/resource-mgt/sections/ResourceAddressList.tsx)) call `useEntityStoreValidation()` to show the resource's rules. [`ResourceMgt.tsx`](https://github.com/Breeze/temphire.react/blob/main/client/src/app/resource-mgt/ResourceMgt.tsx) creates the scope, so it isn't under the scope's provider: it subscribes to the same shared validation with `useObservable(() => validation.validateEntityStore(), ...)` for its Save button.

## Lower-level hooks

- `useValidationService()` returns the service. Use it for imperative validation, for example on submit: `service.validateModelSync(model, type)`.
- `useObservable(() => observable$, initial, deps)` subscribes to any Observable.

> **In TempHire:** the name editor, [`ResourceNameEditor.tsx`](https://github.com/Breeze/temphire.react/blob/main/client/src/app/resource-mgt/ResourceNameEditor.tsx), uses Mantine's `useForm` and validates with `validateModelSync(values, 'ResourceName')`, mapping the errors to fields by `propertyNames`.
