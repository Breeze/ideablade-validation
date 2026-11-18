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
| **Model type** | A string that names the kind of object, such as `"Customer"`. Breeze uses `entityType.shortName`; .NET uses the CLR type name by default. Metadata is keyed by model type. Where code has only a model to go on, it asks the registered **model type resolvers**. Validations that have no store of their own ask the **store resolvers** for `store(type)`. See [Resolvers](#resolvers). |
| **Metadata** | JSON that lists, per model type, the model-level validators, property validators, conditions and inheritance (`extends`). A `global` section applies to all types. See [metadata.md](metadata.md). |
| **Validator factory** | `{ name, fn(group, context) => Validator }`. You register factories through dependency injection (Angular providers, React provider props, .NET `IServiceCollection`) or as plain arrays. Metadata refers to validators by `name`. See [validators.md](validators.md). |
| **Validator** | Validates one value. *Sync* validators return errors directly; *async* validators return an Observable (TS) or a Task (.NET). Several factories may share a name, one sync and one async; `"async": true` in metadata selects the async one. |
| **Context** | A bag of values passed to the validator. It merges, in order: the per-call `options.context`, values from context providers, the model info (`model`, `modelType`, `propertyName`, `displayName`, `metadata`, `isClient`, `isServer`), and the validator's configured `context` from metadata. Message templates read from it: `%displayName% must be at most %maxLength% characters`. |
| **Context provider** | `{ contextFn(model, modelType) }`, registered in DI. Use it to make application services available to validators (the current user, a lookup cache…) without putting them in metadata. |
| **Condition** | An expression on a validator: it runs only when the condition is truthy. On a model, a condition decides whether the model is validated at all during entity-store validation. See [expressions.md](expressions.md). |
| **Group** | `{ "group": "submit", "validators": [...] }`. Groups let you run subsets of rules, for example only the rules for a workflow step. Choose them with `options.predicate`. Grouped validators also get distinct error keys (`required_submit_email`). |
| **Entity store** | Any source of entities: `{ entities$, getEntities? }`, or `{ changes$, entities(), getEntities? }` for sources that only signal changes. `validateEntityStore` re-validates whenever the entities change, the metadata changes, `options.event$` emits, or `revalidate()` is called, and it coalesces bursts of those changes ([coalescing](#coalescing)). Use `breezeEntityStore(manager)` for Breeze, `signalEntityStore` for Angular signals, and `createEntityStore` for anything else ([below](#writing-an-entity-store)). |
| **ValidationError** | `key` (`name[_group][_property]`), `id` (from metadata, else `key`), `propertyName`, `model`, `modelType`, `value`, `errorMessage`, and the full `context`. |

## Resolvers

Some validations start from nothing but a model: a form field bound to an object, or a single entity checked on its own. Two kinds of resolver fill in what such a validation doesn't know. You register them once on the service, and the framework asks them whenever it needs to.

| Resolver | Signature | Answers | Asked by |
|---|---|---|---|
| **Model type resolver** | `(model) => string \| undefined` | Which model type is this? This decides which metadata applies. | The Angular template-driven-forms directives, when a field or form has no `validationModelType`. Your own code, through `service.resolveModelType(model)`. |
| **Store resolver** | `(model) => StoreQuery \| undefined` | Which other entities sit next to this one? This becomes `store(type)` in expressions and in the `unique` validator. | Every validation that has no store of its own: `validateModelSync`, `validateModelAsync`, `validate`, `FormValidators`, the template-driven directives, the Angular signal helpers and React's `useValidation`. Your own code, through `service.resolveStore(model)`. |

### How they're consulted

- **Return `undefined` for models you don't recognize.** A resolver should handle only the models it knows about, so several can live side by side, such as one for Breeze entities and one for your own view models.
- **Resolvers run in registration order, and the first answer wins.**
- **Explicit settings come first.** A model type set in the call or the template (`validationModelType`) is used before any resolver. For the store, an explicit `options.store` comes first, and so does the store of entity store validation, which already knows the whole set. Resolvers only fill in what's missing.
- **No answer:**
  - Without a model type, the template-driven directives throw an error asking for `validationModelType`.
  - Without a store, `store(type)` isn't defined in expressions, and `unique` passes because it has nothing to compare against.
- **Forms validate a view of the model.** Form validation checks a view of the model that has the control's value substituted in. The view inherits from the model, so a resolver that reads properties, or checks for them with `in`, sees the model's values. An `instanceof` check also passes. Only an identity check (`model === entity`) fails. If you need the model object itself, `Object.getPrototypeOf(view)` returns it.

### Writing your own

```ts
import { createValidationService, type ModelTypeResolver, type StoreResolver } from '@ideablade/validation';

// View models tagged with a $type property
const taggedModelType: ModelTypeResolver = (model) => (model as { $type?: string } | null)?.$type;

// Rows that belong to a grid: unique checks against the other rows of the same grid
const gridRows: StoreResolver = (model) => {
  const grid = (model as { grid?: { rows: Row[] } } | null)?.grid;
  return grid ? (type) => grid.rows.filter((row) => row.$type === type) : undefined;
};

const service = createValidationService({
  metadata,
  modelTypeResolvers: [taggedModelType],
  storeResolvers: [gridRows],
});
```

### Registering them

| Where | Model type resolvers | Store resolvers |
|---|---|---|
| Core | `createValidationService({ modelTypeResolvers })` | `createValidationService({ storeResolvers })` |
| Angular | `provideValidation({ modelTypeResolvers })`, `provideModelTypeResolvers(...)`, `VALIDATION_MODEL_TYPE_RESOLVER` | `provideValidation({ storeResolvers })`, `provideStoreResolvers(...)`, `VALIDATION_STORE_RESOLVER` |
| React | `<ValidationProvider modelTypeResolvers={...}>` | `<ValidationProvider storeResolvers={...}>` |

React's `useValidation(model, modelType)` takes the model type as an argument, so model type resolvers only matter there if your own code calls `service.resolveModelType`.

### Breeze

`@ideablade/validation/breeze` provides one of each. For a Breeze app, register both:

```ts
import { breezeModelType, breezeStoreQuery, breezeValidator } from '@ideablade/validation/breeze';

provideValidation({
  metadata,
  validators: [breezeValidator],
  modelTypeResolvers: [breezeModelType],   // the entity type's short name
  storeResolvers: [breezeStoreQuery],      // live entities of the entity's own EntityManager
});
```

See [breeze.md](breeze.md#model-type-names) for the details.

## Rule sources

Not every rule lives in the validation metadata. Data frameworks keep their own: Breeze builds `required` and `maxLength` validators from the server model's `[Required]` and `[StringLength]` attributes, and an ORM or a schema registry knows column lengths. For entities that's fine, because the `breeze` validator runs those rules on the entity. A **view model** that edits some of an entity's properties has no such link.

A **rule source** makes those outside rules available to the metadata. A property declared with [`from`](metadata.md#inheriting-a-propertys-rules-from) inherits the rules of another model type's property. The metadata asks every registered rule source for that property's rules, and adds whatever they return in front of the rules the metadata itself has for it:

```json
{ "PersonName": { "properties": { "firstName": { "from": "Person" }, "surname": { "from": "Person.lastName" } } } }
```

With Breeze's rule source registered, `PersonName.firstName` gets Breeze's rules for `Person.firstName`, and the rules stay defined once, on the server model.

| | |
|---|---|
| Interface | `RuleSource` (TS), `IValidationRuleSource` (.NET) |
| What it returns | `getPropertyRules(modelType, propertyName)` returns a property entry (`displayName`, `validators`, shorthands) for the properties it knows, or `undefined`. |
| Validators | The returned entries refer to validators by name. A rule source lists the factories it needs in `validators`, and they're registered along with the metadata. |
| When it's asked | Only for `from` references. Entities keep their own rules, so nothing is reported twice. |
| Order | Rule sources first, then the metadata's own rules for the referenced property, then the inheriting property's own settings. Later settings win, so the metadata can rename (`displayName`) or add to what a rule source supplies. |

### Writing your own

Return an entry, possibly without validators, for **every** property the source knows. `from` treats a reference that neither the metadata nor any rule source knows as a typo and throws an error.

```ts
import { type RuleSource, createValidationService } from '@ideablade/validation';

// Column lengths from a database schema. It only uses built-in validators, so it lists none.
const columns: RuleSource = {
  getPropertyRules: (modelType, propertyName) => {
    const column = schema.tables[modelType]?.columns[propertyName];
    return column ? { maxLength: column.maxLength, required: !column.nullable } : undefined;
  },
};

const service = createValidationService({ metadata, ruleSources: [columns] });
```

### Registering them

| Where | |
|---|---|
| Core, React | `createValidationService({ ruleSources })`, `<ValidationProvider ruleSources={...}>` |
| Angular | `provideValidation({ ruleSources })`, or `provideRuleSources(...)`, which also accepts a function that can `inject()`: `provideRuleSources(() => breezeRuleSource(inject(EntityManagerProvider).metadataStore))` |
| .NET | `AddIdeaBladeValidation(v => v.AddRuleSource(source))` or `AddRuleSource<T>()`, or the `ruleSources` constructor argument of `ValidationMetadata` |

Rules are looked up when a property is first validated, and then cached until the metadata changes. Register a rule source whose data loads later, such as a Breeze `MetadataStore` that's fetched from the server, as a function: `breezeRuleSource(() => manager.metadataStore)`.

### Breeze

`breezeRuleSource(metadataStore)` from `@ideablade/validation/breeze` knows every property of every entity type in the store. For a property, it returns Breeze's display name and a `breezeProperty` validator that runs that property's Breeze validators on a value, both sync and async. See [breeze.md](breeze.md#rules-for-view-models-breezerulesource).

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
