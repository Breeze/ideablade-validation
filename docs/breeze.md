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
- `…Async` variants when async rules exist.

Inside these validators, `store(type)` resolves to `entity.entityAspect.entityManager.getEntities(type)`. The `breeze` validator is skipped, which prevents recursion.

`uninstall()` removes the validators. Breeze keeps errors that removed validators already recorded, so call `entityAspect.clearValidationErrors()` if needed.

## 3. Validating a whole EntityManager (`breezeEntityStore`)

```ts
import { breezeEntityStore } from '@ideablade/validation/breeze';

validationService
  .validateEntityStore(breezeEntityStore(manager, { entityTypes: ['Order', 'OrderLine'] }))
  .subscribe(({ entities, validationErrors }) => ...);
```

The store:

- emits on every `entityChanged` event, coalesced with `auditTime(0)` by default (`auditTime: -1` makes it synchronous);
- excludes detached entities;
- serves `store(type)` from `manager.getEntities(type)`.

Model conditions, `findEntity(id, type)` and the `unique` validator all work against the manager's cache.

## Model type names

The model type is `entity.entityType.shortName`. Use the same names as keys in your metadata, and on the server, where the .NET library uses the CLR type name by default.
