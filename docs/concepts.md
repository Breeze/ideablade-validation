# Concepts

`@ideablade/validation` (TypeScript) and `IdeaBlade.Validation` (.NET) validate **any object** against rules described in **JSON metadata**. The framework doesn't care where objects come from: Breeze entities, plain objects, view models, EF entities and DTOs all work. The same metadata runs in the browser and on the server.

The core doesn't depend on any persistence layer either. What it needs from one, it gets through a few public extension points: an entity store, a model type resolver, and optionally rule sources and validators. `@ideablade/validation/breeze` is a ready-made implementation of those for Breeze, and any other data layer is integrated the same way ([Integrating your data layer](#integrating-your-data-layer)).

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
            ValidationError[]  (key, id, propertyNames, errorMessage, context)
```

## Building blocks

| Concept | What it is |
|---|---|
| **Model type** | A string that names the kind of object, such as `"Customer"`. Your data layer decides the names: Breeze's integration uses `entityType.shortName`; .NET uses the CLR type name by default. Metadata is keyed by model type. Where code has only a model to go on, it asks the registered **model type resolvers**. Validations that have no store of their own ask the **store resolvers** for `store(type)`. See [Resolvers](#resolvers). |
| **Metadata** | JSON that lists, per model type, the model-level validators, property validators, conditions and inheritance (`extends`). A `global` section applies to all types. See [metadata.md](metadata.md). |
| **Validator factory** | `{ name, fn(group, context) => Validator }`. You register factories through dependency injection (Angular providers, React provider props, .NET `IServiceCollection`) or as plain arrays. Metadata refers to validators by `name`. See [validators.md](validators.md). |
| **Validator** | Validates one value. *Sync* validators return errors directly; *async* validators return an Observable (TS) or a Task (.NET). Several factories may share a name, one sync and one async; `"async": true` in metadata selects the async one. |
| **Context** | A bag of values passed to the validator. It merges, in order: the per-call `options.context`, values from context providers, the model info (`model`, `modelType`, `propertyName`, `displayName`, `metadata`, `isClient`, `isServer`), and the validator's configured `context` from metadata. Message templates read from it: `%displayName% must be at most %maxLength% characters`. |
| **Context provider** | `{ contextFn(model, modelType) }`, registered in DI. Use it to make application services available to validators (the current user, a lookup cache…) without putting them in metadata. |
| **Condition** | An expression on a validator: it runs only when the condition is truthy. On a model, a condition decides whether the model is validated at all during entity-store validation. See [expressions.md](expressions.md). |
| **Group** | `{ "group": "submit", "validators": [...] }`. Groups let you run subsets of rules, for example only the rules for a workflow step. Choose them with `options.predicate`. Grouped validators also get distinct error keys (`required_submit_email`). |
| **Entity store** | Any source of entities: `{ entities$, getEntities? }`, or `{ changes$, entities(), getEntities? }` for sources that only signal changes. `validateEntityStore` re-validates whenever the entities change, the metadata changes, `options.event$` emits, or `revalidate()` is called, and it coalesces bursts of those changes ([coalescing](#coalescing)). Use `breezeEntityStore(manager)` for Breeze, `signalEntityStore` for Angular signals, and `createEntityStore` for anything else ([below](#writing-an-entity-store)). |
| **ValidationError** | `key` (`name[_group]_property` for a property rule, `name[_group][_id]` for a model-level one; see [Error keys](metadata.md#error-keys)), `id` (from metadata, else `key`), `propertyNames`, `model`, `modelType`, `value`, `errorMessage`, and the full `context`. |

## Resolvers

Some validations start from nothing but a model, such as a form bound to an object. A **model type resolver** answers what such a validation doesn't know: which model type is this? That decides which metadata applies. You register resolvers once on the service.

| Signature | Asked by |
|---|---|
| `(model) => string \| undefined` | The Angular template-driven-forms directives and Signal Forms, when no model type is set. Your own code, through `service.resolveModelType(model)`. |

- **Return `undefined` for models you don't recognize.** A resolver should handle only the models it knows about, so several can live side by side, such as one for Breeze entities and one for your own view models.
- **Resolvers run in registration order, and the first answer wins.**
- **Explicit settings come first.** A model type set in the call or the template (`validationModelType`) is used before any resolver.
- **No answer:** the template-driven directives throw an error asking for `validationModelType`.
- **Forms validate a view of the model.** A form checks a view of the model that has the controls' values in place of the properties. The view inherits from the model, so a resolver that reads properties, or checks for them with `in`, sees the model's values. An `instanceof` check also passes. Only an identity check (`model === entity`) fails. If you need the model object itself, `Object.getPrototypeOf(view)` returns it.

```ts
import { createValidationService, type ModelTypeResolver } from '@ideablade/validation';

// View models tagged with a $type property
const taggedModelType: ModelTypeResolver = (model) => (model as { $type?: string } | null)?.$type;

const service = createValidationService({ metadata, modelTypeResolvers: [taggedModelType] });
```

| Where | Registering |
|---|---|
| Core | `createValidationService({ modelTypeResolvers })` |
| Angular | `provideValidation({ modelTypeResolvers })`, `provideModelTypeResolvers(...)`, `VALIDATION_MODEL_TYPE_RESOLVER` |
| React | `<ValidationProvider modelTypeResolvers={...}>` |

React's `useValidation(model, modelType)` takes the model type as an argument, so model type resolvers only matter there if your own code calls `service.resolveModelType`. For Breeze, `breezeModelType` returns the entity type's short name ([breeze.md](breeze.md#model-type-names)).

## Scopes: a service and its entity store

A validation service has one **entity store**: the entities of its scope, such as a unit of work's ([Writing an entity store](#writing-an-entity-store) shows the two shapes a store can have). The service and the store share that scope: an app with one global unit of work has one service; an app with a unit of work per route has a service per route.

```ts
const service = createValidationService({ metadata, entityStore });   // any store, e.g. breezeEntityStore(manager)
const scoped = service.createScope(otherStore);   // same metadata and options, its own store
scoped.setEntityStore(nextStore);                  // the scope moved on to another unit of work
```

A single model or a form validated by the service is validated in its store:

- **`store(type)`**, and the `unique` validator, see the model's siblings in the store. This applies to `validateModelSync`, `validateModelAsync`, `validate`, and every form integration. An explicit `options.store` comes first.
- **The forms re-validate when the store changes**, so a change made elsewhere updates every field: the model changed in code, or another entity a rule reads, such as an address deleted from a resource that must keep one. `service.entityStoreChanged$` emits on each change, and when another store is set.
- **`validateEntityStore()`** without arguments validates it continuously, sync and async, and follows it when `setEntityStore` replaces it. Every caller gets the same shared validation, so a Save button and a list of broken rules react to one result. While async validators run, the result has `pending: true`; a Save button waits for `!pending && validationErrors.length === 0`.

This is also how rules about related entities stay current. A rule on a resource that reads its addresses (`store('Address')`) is re-checked when an address changes, because the whole store is re-validated, while a data layer that validates entity by entity, such as Breeze, re-checks the resource only when the resource itself changes or is saved.

The framework doesn't know what kind of store it is; every store has the same shape. Without a store, `store(type)` isn't defined, and `unique` passes because it has nothing to compare against.

| Where | A scope's service |
|---|---|
| Core | `service.createScope(entityStore)`, `service.setEntityStore(entityStore)` |
| Angular | `provideValidationScope(() => entityStore)` in a route's or component's providers; `inject(ValidationService).setEntityStore(...)` |
| React | `useValidationScope(entityStore)`, passed to a nested `<ValidationProvider service={...}>` |

> **In TempHire:** the resource management route has its own scope, for the unit of work it shows. In Angular, [`resource-mgt.component.ts`](https://github.com/Breeze/temphire.angular/blob/master/client/src/app/resource-mgt/resource-mgt.component.ts) provides it with `provideValidationScope()` and moves it to another unit of work with `setEntityStore`; in React, [`ResourceMgt.tsx`](https://github.com/Breeze/temphire.react/blob/main/client/src/app/resource-mgt/ResourceMgt.tsx) creates it with `useValidationScope`. The scope's `validateEntityStore()` keeps its Save button and the "at least one address" alert current.

## Rules that span properties

A model-level rule can be about several properties, such as "the start date is before the end date". Name them with `propertyNames` in the metadata, and the error reports them:

```json
{
  "Booking": {
    "validators": [
      {
        "name": "expression",
        "id": "START_BEFORE_END",
        "propertyNames": ["startDate", "endDate"],
        "context": { "expression": "model.startDate < model.endDate", "messageTemplate": "The start must be before the end" }
      }
    ]
  }
}
```

`ValidationError.propertyNames` holds the properties an error is about: the property of a property rule, the properties a model-level rule names, or none for a rule about the model as a whole. `error.isFor('endDate')` tests one. A validator can also set `context.propertyNames` itself. Give such rules an `id`: it makes the error key unique (`expression_START_BEFORE_END`), so a field with two model-level `expression` rules shows both errors ([Error keys](metadata.md#error-keys)).

The form integrations validate the whole model, with the current values of all fields, whenever any field changes. Each field shows the errors about its property, so both dates show the rule above, and a change in one re-checks the other. A rule whose `condition` reads another field is re-checked the same way. Errors about no property are the form's own: `modelErrors` on Angular's form directive, and `errorsFor()` without a name in React.

> **In TempHire:** "a staffing resource is at least 18 years old when hired" names `dateOfBirth` and `hireDate` (`ADULT_WHEN_HIRED` in [`validation.metadata.json`](https://github.com/Breeze/temphire.server/blob/main/TempHire.Server/Validation/validation.metadata.json)). Both date fields show it, and the summary card shows its message once, under the dates: [`resource-summary.component.ts`](https://github.com/Breeze/temphire.angular/blob/master/client/src/app/resource-mgt/resource-summary.component.ts) (Angular), [`ResourceSummary.tsx`](https://github.com/Breeze/temphire.react/blob/main/client/src/app/resource-mgt/ResourceSummary.tsx) (React).

## Showing errors: error visibility

A new model breaks its rules before the user has done anything: an empty form misses every required field. Showing all of that in red at once is jarring. Showing a field's errors only once it has been touched misses errors that land on fields the user has not touched: a rule across two fields, a condition, a rule about the whole model. And everything should show once the user tries to save.

`ErrorVisibility` decides which errors to show. Validation itself does not change: every rule runs, forms are as valid or invalid as before, and saving still checks everything.

- **Models that are not new show all their errors.** If loaded data breaks a rule, the user should see it. `isNew` decides; by default every model is new, and for Breeze, `breezeIsNew` counts only added entities ([breeze.md](breeze.md#new-entities-breezeisnew)).
- **A new model's first validation sets its baseline**: the errors it starts with. They are hidden.
- **A baseline error shows once a field it is about has been touched**: edited, or left.
- **Any other error shows at once**, on every field it is about: something the user did caused it. Hire date before the date of birth shows on both dates, a field that a condition makes required shows when the condition changes, and deleting the last address shows "at least one address".
- **A baseline error that goes away leaves the baseline**, so it shows if it comes back.
- **`revealAll()` on a save attempt** shows every error the models have then. Models first validated afterwards, such as another address added after the attempt, start with a baseline of their own.

```ts
const visibility = new ErrorVisibility({ isNew: breezeIsNew });

visibility.shown(model, errors);    // the errors to show
visibility.revealAll();             // on a save attempt
visibility.reset();                 // for another record
```

The form integrations feed it: they report each validation and each touch, and offer the errors to show next to all of them ([Angular](angular.md#showing-errors-errorvisibility), [React](react.md#showing-errors-errorvisibility)). Errors shown outside a form, such as a rule about the whole model in a message of its own, use `visibility.shown(model, errors)`; `visibility.watch(service.validateEntityStore())` gives their models a baseline when no form validates them.

Models are told apart by identity, and errors by their key, so give model-level rules an `id`. The service checks that a model's rules report different keys, and warns about errors that share one anyway ([Error keys](metadata.md#error-keys)). A form that replaces its model with a copy on every change (Signal Forms, immutable React state) carries the state from copy to copy; the integrations do that for you.

> **In TempHire:** the resource management screen of both clients. A new resource, or an address or phone number added to one, is not red when it appears; its errors show as the user gets to the fields. Save stays enabled: with rules broken, it shows every error and says why nothing was saved, and on which tabs. Each detail tab shows a count of the errors it has to show, so one the user isn't looking at is marked too. Loaded resources show their errors at once. See [`resource-mgt.component.ts`](https://github.com/Breeze/temphire.angular/blob/master/client/src/app/resource-mgt/resource-mgt.component.ts) (Angular) and [`ResourceMgt.tsx`](https://github.com/Breeze/temphire.react/blob/main/client/src/app/resource-mgt/ResourceMgt.tsx) (React).

## Rule sources

Not every rule lives in the validation metadata. Data frameworks keep their own: Breeze builds `required` and `maxLength` validators from the server model's `[Required]` and `[StringLength]` attributes, and an ORM or a schema registry knows column lengths. For entities that's fine when a validator already runs those rules on the entity, as the `breeze` validator does for Breeze entities. A **view model** that edits some of an entity's properties has no such link.

A **rule source** makes those outside rules available to the metadata. A property declared with [`from`](metadata.md#inheriting-a-propertys-rules-from) inherits the rules of another model type's property. The metadata asks every registered rule source for that property's rules, and adds whatever they return in front of the rules the metadata itself has for it:

```json
{ "PersonName": { "properties": { "firstName": { "from": "Person" }, "surname": { "from": "Person.lastName" } } } }
```

With Breeze's rule source registered, for example, `PersonName.firstName` gets Breeze's rules for `Person.firstName`, and the rules stay defined once, on the server model.

| | |
|---|---|
| Interface | `RuleSource` (TS), `IValidationRuleSource` (.NET) |
| What it returns | `getPropertyRules(modelType, propertyName)` returns a property entry (`displayName`, `validators`, shorthands) for the properties it knows, or `undefined`. |
| Validators | The returned entries refer to validators by name. A rule source lists the factories it needs in `validators`, and they're registered along with the metadata. |
| When it's asked | Only for `from` references. Entities keep their own rules, so nothing is reported twice. |
| Order | Rule sources first, then the metadata's own rules for the referenced property, then the inheriting property's own settings. Later settings win, so the metadata can rename (`displayName`) or add to what a rule source supplies. |

> **In TempHire:** the name editor edits a `ResourceName` view model whose properties inherit `StaffingResource`'s Breeze rules with `from` ([`client-validation-metadata.ts`](https://github.com/Breeze/temphire.angular/blob/master/client/src/app/core/validation/client-validation-metadata.ts)), through `breezeRuleSource`, registered in [`app.config.ts`](https://github.com/Breeze/temphire.angular/blob/master/client/src/app/app.config.ts).

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

## Integrating your data layer

The framework works with any persistence layer: Breeze, an ORM or a REST client, a GraphQL cache, NgRx, MobX, or plain objects in memory. The core never talks to a data layer directly. It asks for what it needs through a few public extension points, and an integration is just an implementation of them.

`@ideablade/validation/breeze` is such an integration, ready-made for Breeze. It's built only on these extension points and on what the core exports, with no special access. Integrating another data layer takes the same pieces, and you only need the ones your app uses:

| Extension point | What it tells the framework | Needed for | Core API | Breeze's implementation |
|---|---|---|---|---|
| **Entity store** | Which entities belong to the scope, and when they change | Validating a whole unit of work; `store(type)` and `unique`; forms that re-validate when the data changes | `EntityStore`, `createEntityStore` ([Writing an entity store](#writing-an-entity-store)); `createValidationService({ entityStore })`, `createScope`, `setEntityStore` ([Scopes](#scopes-a-service-and-its-entity-store)) | `breezeEntityStore(manager)` |
| **Model type resolver** | Which model type, and so which metadata, an object has | Code that has only the model, such as Angular's template-driven forms and Signal Forms ([Resolvers](#resolvers)) | `ModelTypeResolver`, `modelTypeResolvers` | `breezeModelType` |
| **Rule source** (optional) | Rules the data layer already knows, such as column lengths or required fields | View models that inherit an entity's rules with `from` ([Rule sources](#rule-sources)) | `RuleSource`, `ruleSources` | `breezeRuleSource(metadataStore)` |
| **Validator** (optional) | The data layer's own validation, reported as `ValidationError`s | Running rules that live in the data layer on its entities, usually as a `global` validator | `ValidatorFactory`, `validators` ([validators.md](validators.md#writing-a-validator)) | `breezeValidator` (named `breeze`) |
| **Save pipeline** | That entities are valid before they're saved | Blocking a save with errors | `validateEntityStoreOneTime(store)`, `validateEntities(list)`, `validateModelAsync(model, type)`; or call the service from the data layer's own validation hook | `installBreezeValidators(metadataStore, service)` adds the rules to Breeze's validation, which runs on save |

A sketch for a simple in-memory data layer whose entities carry their type in a `$type` property:

```ts
import { createEntityStore, createValidationService, syncValidator, type ModelTypeResolver } from '@ideablade/validation';
import { firstValueFrom } from 'rxjs';

// Your data layer, for example:
interface Db {
  all(): { $type: string }[];
  onChange(listener: () => void): () => void;   // returns a function that stops listening
  isValid(entity: object): boolean;             // its own validation, if it has any
  save(): Promise<void>;
}
declare const db: Db;

// Entity store: the entities of the scope, and when they change.
const entityStore = createEntityStore({
  entities: () => db.all().map((entity) => ({ entityType: entity.$type, entity })),
  changes: (notify) => db.onChange(notify),
  getEntities: (type) => db.all().filter((entity) => entity.$type === type),   // optional fast store(type)
});

// Model type resolver: read the type from the model; return undefined for objects it doesn't know.
const dbModelType: ModelTypeResolver = (model) => (model as { $type?: string } | null)?.$type;

// Optional validator for the data layer's own rules. Reference it as { "global": { "validators": ["db"] } }.
const dbValidator = syncValidator('db', (model) => !model?.$type || db.isValid(model), 'The record is invalid');

const service = createValidationService({
  metadata,
  entityStore,
  modelTypeResolvers: [dbModelType],
  validators: [dbValidator],
  // ruleSources: [columnRules],   // optional, see Rule sources
});

// Save pipeline: validate everything once, sync and async, then save.
async function save() {
  const { validationErrors } = await firstValueFrom(service.validateEntityStoreOneTime(entityStore));
  if (validationErrors.length) throw new Error(validationErrors.map((e) => e.errorMessage).join('\n'));
  await db.save();
}
```

A resolver should read the model's properties, as above, rather than look the object up by identity: forms validate a view of the model ([Resolvers](#resolvers)). A validator that reports several errors at once, each about its own property, as `breeze` does, implements `Validator` and returns an array of `ValidationError`s ([validators.md](validators.md#writing-a-validator)).

Angular and React register the same pieces through their providers (`provideValidation`, `provideValidationScope`, `<ValidationProvider>`, `useValidationScope`), and Angular's `signalEntityStore` is another ready-made entity store. On .NET, the extension points are `IValidationEntityStore` and `IValidationEntityTypeLookup` ([dotnet.md](dotnet.md#entity-stores)), the `ModelTypeResolver` option, `IValidationRuleSource`, and `ValidatorFactory`. Nothing there depends on Breeze: `DataAnnotationsValidator` runs the data annotations of any CLR object ([dotnet.md](dotnet.md#data-annotations)).

> **In TempHire:** a complete integration with Breeze on both sides. On the client, [`app.config.ts`](https://github.com/Breeze/temphire.angular/blob/master/client/src/app/app.config.ts) registers the validator, the model type resolver and the rule source, [`entity-manager-provider.ts`](https://github.com/Breeze/temphire.angular/blob/master/client/src/app/core/services/entity-manager-provider.ts) installs the rules into Breeze, and [`unit-of-work.ts`](https://github.com/Breeze/temphire.angular/blob/master/client/src/app/core/services/unit-of-work.ts) gives each unit of work its entity store. The server validates every save with an entity store of its own, built for its model: see [Validating a save](dotnet.md#validating-a-save).

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
