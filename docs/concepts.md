# Concepts

`@ideablade/validation` (TypeScript) and `IdeaBlade.Validation` (.NET) validate **any object** against rules described in **JSON metadata**. The framework doesn't care where objects come from: Breeze entities, plain objects, view models, EF entities and DTOs all work. The same metadata runs in the browser and on the server.

```
          JSON metadata                         Validator factories (DI)
 { "Customer": { "properties": {...} } }      required, email, range, ..., yours
                    │                                     │
                    ▼                                     ▼
             ValidationMetadata ──────── getValidator() ──┘
                    │
                    ▼
             ValidationService ◄── context providers, expression scope
             │      │        │
   validateModelSync│   validateEntityStore(store)  (re-validates on change)
          validateModelAsync
                    │
                    ▼
            ValidationError[]  (key, id, propertyName, errorMessage, context)
```

## Building blocks

| Concept | What it is |
|---|---|
| **Model type** | A string that names the kind of object, such as `"Customer"`. Breeze uses `entityType.shortName`; .NET uses the CLR type name by default. Metadata is keyed by model type. Where code has only a model to go on, it asks the registered **model type resolvers** (`modelTypeResolvers` option, `service.resolveModelType(model)`), such as `breezeModelType`. |
| **Metadata** | JSON that lists, per model type, the model-level validators, property validators, conditions and inheritance (`extends`). A `global` section applies to all types. See [metadata.md](metadata.md). |
| **Validator factory** | `{ name, fn(group, context) => Validator }`. You register factories through dependency injection (Angular providers, React provider props, .NET `IServiceCollection`) or as plain arrays. Metadata refers to validators by `name`. See [validators.md](validators.md). |
| **Validator** | Validates one value. *Sync* validators return errors directly; *async* validators return an Observable (TS) or a Task (.NET). Several factories may share a name, one sync and one async; `"async": true` in metadata selects the async one. |
| **Context** | A bag of values passed to the validator. It merges, in order: the per-call `options.context`, values from context providers, the model info (`model`, `modelType`, `propertyName`, `displayName`, `metadata`, `isClient`, `isServer`), and the validator's configured `context` from metadata. Message templates read from it: `%displayName% must be at most %maxLength% characters`. |
| **Context provider** | `{ contextFn(model, modelType) }`, registered in DI. Use it to make application services available to validators (the current user, a lookup cache…) without putting them in metadata. |
| **Condition** | An expression on a validator: it runs only when the condition is truthy. On a model, a condition decides whether the model is validated at all during entity-store validation. See [expressions.md](expressions.md). |
| **Group** | `{ "group": "submit", "validators": [...] }`. Groups let you run subsets of rules, for example only the rules for a workflow step. Choose them with `options.predicate`. Grouped validators also get distinct error keys (`required_submit_email`). |
| **Entity store** | Any source of entities: `{ entities$, getEntities? }`, or `{ changes$, entities(), getEntities? }` for sources that only signal changes. `validateEntityStore` re-validates whenever the entities change, the metadata changes, `options.event$` emits, or `revalidate()` is called, and it coalesces bursts of those changes ([coalescing](#coalescing)). Use `breezeEntityStore(manager)` for Breeze, `signalEntityStore` for Angular signals, and `createEntityStore` for anything else ([below](#writing-an-entity-store)). |
| **ValidationError** | `key` (`name[_group][_property]`), `id` (from metadata, else `key`), `propertyName`, `model`, `modelType`, `value`, `errorMessage`, and the full `context`. |

## Writing an entity store

An entity store comes in one of two shapes. Both can add an optional `getEntities(type)`, a fast lookup for `store(type)`.

| Shape | What it provides | Use it when |
|---|---|---|
| **Observable** `{ entities$ }` | An Observable that emits the full list of `{ entityType, entity }` pairs whenever it changes. | The source already gives you an Observable of the data: an NgRx `select`, a `BehaviorSubject` you maintain, a live query in RxDB or Apollo. The list is built anyway, so passing it on costs nothing extra. |
| **Notifying** `{ changes$, entities() }` | An Observable that only says *something changed*, plus a function that reads the current entities. | The source raises events, calls listeners or updates signals without handing you the data, or building the list is expensive. Breeze's `EntityManager` is an example. |

The difference shows when changes come in bursts. The service coalesces both shapes into one validation run per burst ([coalescing](#coalescing)), but it can only skip work it hasn't done yet:

- An **Observable** store has already built a list for every emission before the service sees it. If a burst emits 500 lists, 499 of them are built and thrown away.
- A **notifying** store's `changes$` emissions carry no data. The service calls `entities()` once per burst, after it has coalesced, so a burst of 500 events costs one read.

So for an event- or signal-based source, don't turn it into an Observable store by calling a read function on every event (`events$.pipe(map(() => read()))`). Use the notifying shape instead. Keep the Observable shape for sources that already produce the list.

```ts
// Observable: the source already emits the data.
const orderStore: EntityStore = {
  entities$: ngrxStore.select(selectOrders).pipe(map((orders) => orders.map((entity) => ({ entityType: 'Order', entity })))),
};

// Notifying: the source only says that something changed.
const cartStore: EntityStore = {
  changes$: fromEvent(cart, 'change'),
  entities: () => cart.items.map((entity) => ({ entityType: 'CartItem', entity })),
};
```

For a fixed list, or an Observable of lists you already have, `entityStoreOf(listOrObservable)` creates the Observable shape.

### `createEntityStore`

Most sources that only signal changes don't expose an Observable at all. They raise events, call listeners, or update signals. `createEntityStore` builds a notifying store from such a source, without RxJS on your side. You give it two things:

- `entities()`, which returns the current entities as `{ entityType, entity }` pairs;
- `changes`, which tells the store when the source changed. This is a function that starts listening, calls `notify` on every change, and returns how to stop listening. It can return a function, an object with `unsubscribe()`, or nothing. An Observable works too.

```ts
import { createEntityStore } from '@ideablade/validation';

const store = createEntityStore({
  entities: () => cart.items.map((entity) => ({ entityType: 'CartItem', entity })),
  changes: (notify) => {
    cart.addEventListener('change', notify);
    return () => cart.removeEventListener('change', notify);
  },
  // getEntities: (type) => cart.itemsOfType(type),   // optional fast store(type)
});
```

For signal libraries whose `effect()` returns a disposer, such as Preact or Solid, `changes` is one line: `(notify) => effect(() => { items.value; notify(); })`. For Angular signals, use `signalEntityStore` from `@ideablade/validation/angular` ([angular.md](angular.md#validating-a-set-of-entities)).

Don't batch the notifications yourself: the validation service coalesces them ([coalescing](#coalescing)). `breezeEntityStore` and `signalEntityStore` are built on `createEntityStore` too.

Without `getEntities`, `store(type)` in expressions and the `unique` validator filter the latest `entities()` snapshot.

## Coalescing

Entity stores often change many times in a row. Breeze, for example, raises one change event for every entity a query returns, and an Observable store may emit a new array for every little change. Re-validating the whole store on each change would mean loading 500 entities validates the store 500 times.

`validateEntityStore` therefore coalesces bursts of changes. This happens in the service, so it applies to every kind of store and to every trigger: store changes, metadata changes, `options.event$` and `revalidate()`.

- The first validation runs immediately.
- After that, by default (`coalesce: 0`), changes made in the same synchronous block, such as all the events of one query, result in a single run once the block finishes. It uses the latest entities.
- A number of milliseconds collects the changes for that long after the first one, then runs once. A source that never stops changing is still validated at that interval.
- `coalesce: false` validates on every single change.

Set it for the service with `createValidationService({ coalesce })` (Angular: `provideValidation({ coalesce })`), or per call with `validateEntityStore(store, { coalesce })`.

## Sync vs. async

- `validateModelSync(model, type)` returns `ValidationError[]` (empty when valid). It runs only the sync validators, so it's immediate.
- `validateModelAsync(model, type)` runs **all** validators, sync and async, and returns a cold `Observable<ValidationError[]>` that emits all errors once. One call is enough; you never need to combine it with `validateModelSync`. Async validators are subject to a timeout (`asyncTimeout`, default 60 s): on timeout they count as valid, the sync errors are emitted, and `onAsyncTimeout` is called. .NET's `ValidateModelAsync` behaves the same way.
- `validate(model, type)` returns an `Observable<{ errors, pending }>`. It emits the sync errors immediately with `pending: true`, then all errors once the async validators finish. Every validator runs once. This is the best fit for UIs.
- `validateEntityStore(store)` / `validateEntityStoreOneTime(store)` / `validateEntities(list)` validate many models at once, sync and async.

A sync validator may also implement `validateAsync(value, context)`, a complete check that may be asynchronous. `validateModelAsync` calls it instead of `validate`, and `validate()` shows the sync result until it finishes. This is for validators whose source has both sync and async rules, such as [`breeze`](breeze.md): one metadata entry covers both, and each rule runs once.

An exception thrown inside a validator (sync, async or a rejected promise) counts as a **validation failure**. The exception is available as `error.context.exception`. A broken *configuration* is a programmer error and **throws** a `ValidationConfigurationError`. That covers an unknown validator name, a failing condition expression, and a sync/async mismatch.

## Why RxJS?

The framework uses RxJS for async validation and for continuously validating changing entity stores. We reviewed whether RxJS is still the right choice in 2026:

- **Keep it.** RxJS 7.8 is stable and maintained. Angular still lists it as a peer dependency, and Breeze 3 does too. Continuous store validation (re-run on entity, metadata or event changes, cancel stale async runs, coalesce bursts) is exactly what Observables are good at. Writing that with Promises and signals would mean rebuilding `switchMap`/`combineLatest` by hand.
- **Keep it small and optional at the edges.**
  - The sync API (`validateModelSync`) is plain arrays.
  - Async validators may return a **Promise** or a boolean as well as an Observable.
  - React consumers never see an Observable: the hooks subscribe for them.
  - Angular consumers can use signals (`validationErrors()`, `validationState()`).
- **It's a peer dependency** (`rxjs ^7.4`), so apps share one copy with Angular and Breeze. RxJS 8/9 are still in beta; the code avoids deprecated APIs to ease that upgrade.
