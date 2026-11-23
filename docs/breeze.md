# Breeze

`ideablade-validation/breeze` integrates with **breeze-client 3**, which is an optional peer dependency. Breeze isn't required for anything else in the library.

This module is a ready-made integration, not a special case: it implements the core's generic, public extension points (an [entity store](concepts.md#writing-an-entity-store), a [model type resolver](concepts.md#resolvers), a [rule source](concepts.md#rule-sources) and a [validator](validators.md#writing-a-validator)) for Breeze. If your app uses another persistence layer, implement the same pieces for it; see [Integrating your data layer](concepts.md#integrating-your-data-layer).

The integration works in both directions, and you can use either one or both together.

## 1. Breeze's validation inside this framework (`breeze` validator)

Register `breezeValidator` and reference it from metadata, typically as a **global** validator so that every entity is checked against Breeze's validators: the server metadata's `required`, `maxLength`, data type validators, and your own Breeze validators.

```ts
import { breezeValidator } from 'ideablade-validation/breeze';

createValidationService({ metadata, validators: [breezeValidator] });
```

```json
{ "global": { "validators": ["breeze"] } }
```

The validator runs the entity's Breeze validators itself - each property's, then the entity type's - and maps each Breeze `ValidationError` to a framework `ValidationError`. It never calls `validateEntity()`: nothing is recorded on the entity and no Breeze event is raised, so it's safe to run while a UI renders, and the entity's own validation state stays Breeze's.

- the property name and message come from Breeze, and the key is `<validator>_<property>`, such as `maxLength_name`;
- the `displayName` comes from your metadata when present;
- `context.breezeError` holds the original error.

Non-entities are ignored.

> **In TempHire:** [`validation.metadata.json`](https://github.com/Breeze/temphire.server/blob/main/TempHire.Server/Validation/validation.metadata.json) starts with `{ "global": { "validators": ["breeze"] } }`, and the client registers `breezeValidator` in [`app.config.ts`](https://github.com/Breeze/temphire.angular/blob/master/client/src/app/app.config.ts).

### On form fields

A form validates a view of the entity that holds the fields' values. `breeze` runs the same validators on the view's values, the ones being typed. Its errors are `ValidationError`s about their property, so a field bound to `customer.name` shows Breeze's `maxLength` next to the metadata's own rules for `name`:

```html
<form [validationModel]="customer">
  <input name="name" [(ngModel)]="customer.name" #name="ngModel" />
  @for (e of name.errors | keyvalue; track e.key) { <small>{{ e.value.errorMessage }}</small> }
</form>
```

Rules that `installBreezeValidators` added to Breeze (section 2) are left out here, because the framework already runs them itself.

### On the server

There's no Breeze on a .NET server, but Breeze's rules come from the server model's data annotations. Register the .NET `DataAnnotationsValidator` under the same name, and the same `{ "global": { "validators": ["breeze"] } }` runs those annotations there ([dotnet.md](dotnet.md#data-annotations)):

```csharp
services.AddIdeaBladeValidation(v => v.AddMetadataFile("validation.metadata.json").AddDataAnnotations("breeze"));
```

> **In TempHire:** [`Program.cs`](https://github.com/Breeze/temphire.server/blob/main/TempHire.Server/Program.cs) registers `AddDataAnnotations("breeze")`.

### Breeze async validators

Breeze 3 validators can be async: a validator whose function returns a Promise (an `async` function, or one created with `isAsync: true`). Breeze runs them only where it can wait for the answer, on save and from `entityAspect.validateEntityAsync()`, not on property change.

The single `"breeze"` entry covers them too. It follows the framework's rules for sync and async:

| Call | Runs | Breeze call |
|---|---|---|
| `validateModelSync` | Breeze's sync validators |
| `validateModelAsync` | all of Breeze's validators, sync and async, each once |
| `validate()`, `useValidation`, Angular signals | sync errors first (`pending: true`), then all errors |

That's the same split Breeze makes itself: its async validators run in `validateEntityAsync()`, its complete check, the one it runs on save.

The `breeze` validator skips errors from validators that `installBreezeValidators` added (section 2), so you can use both directions together without seeing the metadata rules twice.

## 2. This framework's rules inside Breeze (`installBreezeValidators`)

When your UI binds to Breeze's validation errors, or you rely on Breeze validating before save, install the metadata rules into the `MetadataStore`:

```ts
import { installBreezeValidators } from 'ideablade-validation/breeze';

const uninstall = installBreezeValidators(manager.metadataStore, validationService, {
  // entityTypes: ['Customer', 'Order'],   // default: all entity types
  // includeAsync: true,                    // async rules run on save / validateEntityAsync (Breeze 3)
  // validationOptions: { predicate: (v) => v.group !== 'submit' },
});
```

For every entity type, this adds the following Breeze validators:

- one **property-level** validator per property that has metadata rules. Breeze runs it on property change, and errors attach to that property.
- one **entity-level** validator for model-level rules.
- `…Async` variants when async rules exist. They run only the async rules, so `validateEntityAsync()` and save don't report a sync rule twice.

Inside these validators, `store(type)` returns the live entities of that type in the entity's `EntityManager`: Unchanged, Added and Modified, never deleted or detached ones. The `breeze` validator is skipped, which prevents recursion.

`uninstall()` removes the validators. Breeze keeps errors that removed validators already recorded, so call `entityAspect.clearValidationErrors()` if needed.

> **In TempHire:** [`entity-manager-provider.ts`](https://github.com/Breeze/temphire.angular/blob/master/client/src/app/core/services/entity-manager-provider.ts) loads the validation metadata at sign-in, next to Breeze's, and installs it with `installBreezeValidators`.

## 3. Validating a whole EntityManager (`breezeEntityStore`)

```ts
import { breezeEntityStore } from 'ideablade-validation/breeze';

validationService
  .validateEntityStore(breezeEntityStore(manager, { entityTypes: ['Order', 'OrderLine'] }))
  .subscribe(({ entities, validationErrors }) => ...);
```

The store:

- re-validates on `entityChanged`. The validation service coalesces bursts of events, such as one per entity a query returns, into a single run ([coalescing](concepts.md#coalescing));
- excludes deleted and detached entities. A deleted entity stays in the manager until it's saved, but it's on its way out, so it isn't validated and doesn't count for `unique`. To include deleted entities anyway, pass `entityStates`, such as `[EntityState.Unchanged, EntityState.Added, EntityState.Modified, EntityState.Deleted]`;
- serves `store(type)` from `manager.getEntities(type)`, with the same states.

Model conditions, `findEntity(id, type)` and the `unique` validator all work against the manager's cache.

> **In TempHire:** each unit of work exposes `breezeEntityStore(manager)` as its `entityStore` ([`unit-of-work.ts`](https://github.com/Breeze/temphire.angular/blob/master/client/src/app/core/services/unit-of-work.ts)).

## Model type names

The model type is `entity.entityType.shortName`. Use the same names as keys in your metadata, and on the server, where the .NET library uses the CLR type name by default.

`breezeModelType` is a [model type resolver](concepts.md#resolvers). It returns that name for Breeze entities and `undefined` for anything else. Register it so that code which finds the type from the model itself recognizes entities. The Angular template-driven-forms directives are an example.

```ts
createValidationService({ metadata, validators: [breezeValidator], modelTypeResolvers: [breezeModelType] });
// Angular: provideValidation({ metadata, validators: [breezeValidator], modelTypeResolvers: [breezeModelType] })
```

> **In TempHire:** [`app.config.ts`](https://github.com/Breeze/temphire.angular/blob/master/client/src/app/app.config.ts) registers `breezeModelType`, so the entity editors never name a model type.

## New entities: `breezeIsNew`

For [error visibility](concepts.md#showing-errors-error-visibility): an entity is new while it is added (`EntityState.Added`), so its first errors wait until the user gets to them. Loaded entities show all their errors. Anything else, such as a view model, counts as new.

```ts
new ErrorVisibility({ isNew: breezeIsNew });
// Angular: provideErrorVisibility({ isNew: breezeIsNew })
```

> **In TempHire:** both clients' resource screens use it, so a resource opened for editing shows its errors at once, and a new one waits: [`resource-mgt.component.ts`](https://github.com/Breeze/temphire.angular/blob/master/client/src/app/resource-mgt/resource-mgt.component.ts) (Angular), [`ResourceMgt.tsx`](https://github.com/Breeze/temphire.react/blob/main/client/src/app/resource-mgt/ResourceMgt.tsx) (React).

## Single entities and forms: the manager as the entity store

`store(type)` in expressions, and the `unique` validator that depends on it, need to see an entity's siblings. Give the validation service of the scope its `EntityManager` as its [entity store](concepts.md#scopes-a-service-and-its-entity-store): single entities and forms validated by that service then see the manager's live entities (without deleted or detached ones), and the forms re-validate when anything in the manager changes.

```ts
const scoped = service.createScope(breezeEntityStore(unitOfWork.manager));
// Angular, in a route's or component's providers:
provideValidationScope(() => breezeEntityStore(inject(UnitOfWork).manager));
```

> **In TempHire:** the resource management route's scope uses the entity store of the unit of work it shows: [`resource-mgt.component.ts`](https://github.com/Breeze/temphire.angular/blob/master/client/src/app/resource-mgt/resource-mgt.component.ts) (Angular), [`ResourceMgt.tsx`](https://github.com/Breeze/temphire.react/blob/main/client/src/app/resource-mgt/ResourceMgt.tsx) (React).

## Rules for view models (`breezeRuleSource`)

A dialog or form often edits a view model instead of the entity, and assigns the values to the entity when it closes. TempHire's name editor is an example: it edits a `{ firstName, middleName, lastName }` copy of a `StaffingResource`'s names. The `breeze` validator can't check the view model, because it isn't an entity. You don't want to restate the server model's `[Required]` and `[StringLength]` rules in the validation metadata either.

`breezeRuleSource` is a [rule source](concepts.md#rule-sources) that gives a view model property the Breeze rules of an entity property. Declare the view model's properties with [`from`](metadata.md#inheriting-a-propertys-rules-from):

```json
{
  "ResourceName": {
    "properties": {
      "firstName":  { "from": "StaffingResource", "displayName": "First name" },
      "middleName": { "from": "StaffingResource", "displayName": "Middle name" },
      "lastName":   { "from": "StaffingResource", "displayName": "Last name" }
    }
  }
}
```

Register the rule source with the `MetadataStore`. If the store is filled later, pass a function that returns it:

```ts
import { breezeRuleSource } from 'ideablade-validation/breeze';

createValidationService({ metadata, ruleSources: [breezeRuleSource(() => manager.metadataStore)] });
// Angular:
provideRuleSources(() => breezeRuleSource(inject(EntityManagerProvider).metadataStore));
```

For each referenced property, `breezeRuleSource` supplies:

- **a `breezeProperty` validator** that runs the property's Breeze validators on the view model's value. `validateModelSync` runs Breeze's sync validators; `validateModelAsync`, `validate` and the form integrations also run its async ones.
  - Breeze formats the messages, with the view model's display name: `'First name' is required`.
  - Error keys follow the framework's convention, named after the Breeze validator: `required_firstName`, `maxLength_firstName`.
- **Breeze's display name** for the property, used when the metadata doesn't set one.

It knows every property of every entity type in the store, including properties without validators, so a mistyped `from` is still reported as an error. Entities themselves aren't affected: they keep using the `breeze` validator.

> **In TempHire:** `ResourceName` is declared in [`client-validation-metadata.ts`](https://github.com/Breeze/temphire.angular/blob/master/client/src/app/core/validation/client-validation-metadata.ts), the rule source is registered in [`app.config.ts`](https://github.com/Breeze/temphire.angular/blob/master/client/src/app/app.config.ts), and the name editor is [`resource-name-editor.component.ts`](https://github.com/Breeze/temphire.angular/blob/master/client/src/app/resource-mgt/resource-name-editor.component.ts) (Angular) and [`ResourceNameEditor.tsx`](https://github.com/Breeze/temphire.react/blob/main/client/src/app/resource-mgt/ResourceNameEditor.tsx) (React).
