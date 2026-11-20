# Metadata reference

Metadata is JSON. It's usually generated on the server or authored per feature, and the TypeScript and .NET libraries read the same format. A JSON Schema is in [`spec/validation-metadata.schema.json`](../spec/validation-metadata.schema.json); reference it for editor completion:

```json
{
  "$schema": "../node_modules/@ideablade/validation/schema/validation-metadata.schema.json",
  "global": {
    "validators": ["breeze"]
  },
  "Person": {
    "properties": {
      "firstName": { "displayName": "First name", "required": true, "maxLength": 50 },
      "email":     { "displayName": "E-mail", "validators": ["email"] },
      "birthDate": {
        "displayName": "Date of birth",
        "validators": [{ "name": "dateRange", "context": { "minValue": "now-120y", "maxValue": "today" } }]
      }
    }
  },
  "Employee": {
    "extends": "Person",
    "condition": "!model.isTerminated",
    "validators": [
      {
        "name": "expression",
        "id": "END_AFTER_START",
        "context": {
          "expression": "model.endDate == null || model.endDate > model.startDate",
          "messageTemplate": "End date must be after start date"
        }
      }
    ],
    "properties": {
      "employeeNo": {
        "displayName": "Employee #",
        "validators": [
          { "group": "hire", "validators": ["required", { "name": "unique" }] }
        ]
      },
      "phone": {
        "validators": [{ "name": "phone", "condition": "model.country === 'US'" }]
      },
      "login": {
        "validators": [{ "name": "loginAvailable", "async": true }]
      }
    }
  }
}
```

**Comments.**  The top level, `global`, and every model, property, validator and group may have a `$comment`: a string, or an array of strings for one paragraph each. It is for the people who maintain the rules, to say why a rule exists or where else it is enforced. The schema allows it, and validating ignores it, like `$schema`.

Property names in the metadata are camelCase, as JavaScript objects name them. On .NET, a [naming convention](dotnet.md#property-names) maps them to PascalCase CLR properties.

The global `breeze` validator in this example comes from the optional [Breeze integration](breeze.md). Without Breeze, leave it out, or reference your own data layer's validator instead ([Integrating your data layer](concepts.md#integrating-your-data-layer)).

> **In TempHire:** [`validation.metadata.json`](https://github.com/Breeze/temphire.server/blob/main/TempHire.Server/Validation/validation.metadata.json) is the metadata of a real app: U.S. addresses, phone number formats, rates, dates, and rules across entities such as "a staffing resource has at least one address" (`store('Address')`) and "is at least 18 years old when hired" (`propertyNames`). The client adds metadata for its own view models in [`client-validation-metadata.ts`](https://github.com/Breeze/temphire.angular/blob/master/client/src/app/core/validation/client-validation-metadata.ts).

## Top level

| Key | Meaning |
|---|---|
| `global` | `{ "validators": [...] }`. These model-level validators apply to **every** model type, including types with no entry of their own. |
| *model type* | A model entry (below). The key is the model type name. |

You can supply several metadata documents. Entries for the same model type are **merged**:

- validator lists are concatenated;
- properties with the same name are merged (their validators are concatenated);
- scalar settings (`displayName`, `required`, `extends`, `condition`, …) take the last value.

This lets a feature module add rules to a shared model.

## Model entry

| Key | Meaning |
|---|---|
| `extends` | Inherit from another model type. Inherited items are the parent's validators (which already include the globals, so nothing is duplicated) and its properties. |
| `condition` | Expression. When validating an **entity store**, models where this is falsy are skipped entirely. Variables: `model`, `entityInfos`, `findEntity(id, type)`, `store(type)`, `isClient`, `isServer`. If missing, the parent's condition applies. |
| `validators` | Model-level validators. They receive the **whole model** as `value`. Their errors are about the properties they name (`propertyNames`, below), or about the model as a whole. |
| `properties` | Map of property name → property entry. |

## Property entry

| Key | Meaning |
|---|---|
| `from` | Inherit the rules of another model type's property, from this metadata and from the registered rule sources: `"Customer"` for the property of the same name, `"Customer.email"` for another one. See [Inheriting a property's rules](#inheriting-a-propertys-rules-from). |
| `displayName` | Used in messages as `%displayName%`. If missing, the property name is used. |
| `required` | Shorthand for `{ "name": "required", "id": "REQUIRED" }`. Not added if an ungrouped `required` validator is already listed. |
| `minLength` / `maxLength` | Shorthands for the `minLength` / `maxLength` validators (ids `MIN_LENGTH` / `MAX_LENGTH`). |
| `validators` | Property validators. They receive the property's value. |

## Validator entry

A validator can be a bare name (`"email"`) or an object:

| Key | Meaning |
|---|---|
| `name` | Registered validator name. Required. |
| `id` | Stable identifier, reported as `ValidationError.id`. Useful for mapping errors to help topics, or for suppressing specific rules. |
| `context` | Settings for the validator (`minValue`, `expression`, …) plus `messageTemplate` / `displayName` overrides. |
| `async` | `true` selects the asynchronous validator registered under `name`. |
| `condition` | Expression. The validator only runs when it's truthy. Variables: `model`, `value`, `context`, `isClient`, `isServer`, plus the expression scope. |
| `propertyNames` | For a model-level validator: the properties its errors are about, such as `["startDate", "endDate"]` for a rule comparing them. Reported as `ValidationError.propertyNames`; forms show the error on each of those fields ([concepts.md](concepts.md#rules-that-span-properties)). |

## Groups

```json
{ "group": "submit", "validators": ["required", { "name": "range", "context": { "minValue": 1 } }] }
```

Grouped validators run by default. To select groups, pass a predicate:

```ts
service.validateModelSync(order, 'Order', { predicate: (v) => !v.group || v.group === 'submit' });
```

The group becomes part of the error key: `required_submit_quantity`.

## Inheriting a property's rules (`from`)

A view model, or a form model, often edits some properties of another model. For example, a dialog edits a copy of a person's names and assigns them to the `Person` when it closes. `from` lets each of its properties follow the rules of the corresponding `Person` property, without restating them:

```json
{
  "Person": {
    "properties": {
      "firstName": { "displayName": "First name", "required": true, "maxLength": 50 },
      "lastName":  { "displayName": "Last name", "required": true, "maxLength": 50 }
    }
  },
  "PersonName": {
    "properties": {
      "firstName": { "from": "Person" },
      "surname":   { "from": "Person.lastName" }
    }
  }
}
```

`PersonName.firstName` now has the rules of `Person.firstName`, so an empty value reports `First name is required`, and a long one `First name must be at most 50 characters`. `PersonName.surname` has those of `Person.lastName`.

**Which property:** `"from": "Person"` takes the property of the same name. `"from": "Person.lastName"` names it explicitly, for a property that's called differently.

### Where the inherited rules come from

`from` looks the referenced property up in two places and combines what it finds:

1. **The validation metadata**, as in the example above. If the metadata has an entry for `Person.firstName`, its validators and `displayName` are inherited. This includes rules that entry gets through its own `from`, so chains work.
2. **The registered [rule sources](concepts.md#rule-sources)**, for rules that live outside the metadata. With `breezeRuleSource` registered, for example, `"from": "Person"` also picks up the `[Required]` and `[StringLength]` rules Breeze gets from the server model. That works even when `Person` has no metadata entry at all ([breeze.md](breeze.md#rules-for-view-models-breezerulesource)).

Either one is enough. When both know the property, you get the rules of both: first the rule sources', then the metadata's, then the property's own settings. A reference that neither knows is an error.

### What's inherited, and what isn't

- **Inherited:** the referenced property's validators, with their groups and conditions, and its `displayName`.
- **Not inherited:** the referenced *model's* other properties and its model-level validators. That's the difference from `extends`, which brings in every rule of `Person`, including rules for fields the view model doesn't have.
- **Your own settings go on top.** Anything else in the entry is added after the inherited rules: more `validators`, groups, async validators. A `displayName` replaces the inherited one. A `required`, `minLength` or `maxLength` shorthand replaces an inherited shorthand from the metadata. A rule that comes from a rule source stays, though, so a `maxLength` stricter than Breeze's adds a second check.
- **You can only add, not remove.** To skip an inherited rule for a particular validation, filter it out with a `predicate`.
- **Conditions and expressions** that come with the inherited rules run against *this* model. A rule that reads `model.x` sees this model's `x`, or `undefined` if it has none.
- **Errors:** a reference that neither the metadata nor any rule source knows, and a circular chain, both throw a `ValidationConfigurationError` when the property is first validated.

> **In TempHire:** the name editor's `ResourceName` inherits each name's rules with `"from": "StaffingResource"` ([`client-validation-metadata.ts`](https://github.com/Breeze/temphire.angular/blob/master/client/src/app/core/validation/client-validation-metadata.ts)). `StaffingResource` has no metadata entry for its names: the rules come from Breeze, through `breezeRuleSource`.

## Message templates

`%name%` placeholders are replaced from the error context, and dotted paths work: `%model.number%`. Placeholders that are always available are `%displayName%`, `%propertyName%`, `%value%`, `%modelType%`, `%validatorName%`, plus everything in the validator's `context`.

## Loading metadata at runtime

```ts
const metadata = await fetch('/api/validation-metadata').then((r) => r.json());
service.validationMetadata.setMetadata(metadata); // or addMetadata(...)
```

Entity-store validations that are running re-validate automatically (`metadataChanged$`).

On .NET, load from files, streams, strings or objects: see [dotnet.md](dotnet.md).
