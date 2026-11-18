# Breeze

`@ideablade/validation/breeze` integrates with **breeze-client 3**, which is an optional peer dependency. Breeze isn't required for anything else in the library.

The integration works in both directions, and you can use either one or both together.

## 1. Breeze's validation inside this framework (`breeze` validator)

Register `breezeValidator` and reference it from metadata, typically as a **global** validator so that every entity is checked against Breeze's validators: the server metadata's `required`, `maxLength`, data type validators, and your own Breeze validators.

```ts
import { breezeValidator } from '@ideablade/validation/breeze';

createValidationService({ metadata, validators: [breezeValidator] });
```

```json
{ "global": { "validators": ["breeze"] } }
```

The validator calls `entity.entityAspect.validateEntity()` and maps each Breeze `ValidationError` to a framework `ValidationError`:

- the key, property name and message come from Breeze;
- the `displayName` comes from your metadata when present;
- `context.breezeError` holds the original error.

Non-entities are ignored.

### On form fields

Breeze's rules belong to properties, but `breeze` is a model-level validator. When a single property is validated, as the form integrations do for each control (`ValidationOptions.propertyName`), `breeze` checks that property alone: it runs the property's Breeze validators on the value being validated, which in a form is the control's value. It doesn't change the entity's Breeze errors. So a field bound to `customer.name` shows Breeze's `maxLength` next to the metadata's own rules for `name`, all as `ValidationError`s:

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

### Breeze async validators

Breeze 3 validators can be async: a validator whose function returns a Promise (an `async` function, or one created with `isAsync: true`). Breeze runs them only where it can wait for the answer, on save and from `entityAspect.validateEntityAsync()`, not on property change.

The single `"breeze"` entry covers them too. It follows the framework's rules for sync and async:

| Call | Runs | Breeze call |
|---|---|---|
| `validateModelSync` | Breeze's sync validators | `validateEntity()` |
| `validateModelAsync` | all of Breeze's validators, sync and async, each once | `validateEntityAsync()` |
| `validate()`, `useValidation`, Angular signals | sync errors first (`pending: true`), then all errors | both |

That's the same split Breeze makes itself: `validateEntityAsync()` is Breeze's complete check, the one it runs on save.

The `breeze` validator skips errors from validators that `installBreezeValidators` added (section 2), so you can use both directions together without seeing the metadata rules twice.

## 2. This framework's rules inside Breeze (`installBreezeValidators`)

When your UI binds to Breeze's validation errors, or you rely on Breeze validating before save, install the metadata rules into the `MetadataStore`:

```ts
import { installBreezeValidators } from '@ideablade/validation/breeze';

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

## 3. Validating a whole EntityManager (`breezeEntityStore`)

```ts
import { breezeEntityStore } from '@ideablade/validation/breeze';

validationService
  .validateEntityStore(breezeEntityStore(manager, { entityTypes: ['Order', 'OrderLine'] }))
  .subscribe(({ entities, validationErrors }) => ...);
```

The store:

- re-validates on `entityChanged`. The validation service coalesces bursts of events, such as one per entity a query returns, into a single run ([coalescing](concepts.md#coalescing));
- excludes deleted and detached entities. A deleted entity stays in the manager until it's saved, but it's on its way out, so it isn't validated and doesn't count for `unique`. To include deleted entities anyway, pass `entityStates`, such as `[EntityState.Unchanged, EntityState.Added, EntityState.Modified, EntityState.Deleted]`;
- serves `store(type)` from `manager.getEntities(type)`, with the same states.

Model conditions, `findEntity(id, type)` and the `unique` validator all work against the manager's cache.

## Model type names

The model type is `entity.entityType.shortName`. Use the same names as keys in your metadata, and on the server, where the .NET library uses the CLR type name by default.

`breezeModelType` is a [model type resolver](concepts.md#resolvers). It returns that name for Breeze entities and `undefined` for anything else. Register it so that code which finds the type from the model itself recognizes entities. The Angular template-driven-forms directives are an example.

```ts
createValidationService({ metadata, validators: [breezeValidator], modelTypeResolvers: [breezeModelType] });
// Angular: provideValidation({ metadata, validators: [breezeValidator], modelTypeResolvers: [breezeModelType] })
```

## `store(type)` for single entities and forms (`breezeStoreQuery`)

`store(type)` in expressions, and the `unique` validator that depends on it, need to see an entity's siblings. Entity store validation and the installed Breeze validators supply them. Validating a single entity (`validateModelSync`) or a form control doesn't, so `unique` would pass there without checking anything.

`breezeStoreQuery` is a [store resolver](concepts.md#resolvers) that fills that gap. For a Breeze entity, `store(type)` returns the live entities of that type in the entity's own `EntityManager`, without deleted or detached ones. A form control's view of the entity resolves the same way.

```ts
provideValidation({
  metadata,
  validators: [breezeValidator],
  modelTypeResolvers: [breezeModelType],
  storeResolvers: [breezeStoreQuery],
});
```

An explicit `options.store`, and the store of entity store validation, still take precedence.

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
import { breezeRuleSource } from '@ideablade/validation/breeze';

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
