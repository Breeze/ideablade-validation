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
| `validators` | Model-level validators. They receive the **whole model** as `value`, and their errors have no `propertyName` unless the validator sets one. |
| `properties` | Map of property name → property entry. |

## Property entry

| Key | Meaning |
|---|---|
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

## Groups

```json
{ "group": "submit", "validators": ["required", { "name": "range", "context": { "minValue": 1 } }] }
```

Grouped validators run by default. To select groups, pass a predicate:

```ts
service.validateModelSync(order, 'Order', { predicate: (v) => !v.group || v.group === 'submit' });
```

The group becomes part of the error key: `required_submit_quantity`.

## Message templates

`%name%` placeholders are replaced from the error context, and dotted paths work: `%model.number%`. Placeholders that are always available are `%displayName%`, `%propertyName%`, `%value%`, `%modelType%`, `%validatorName%`, plus everything in the validator's `context`.

## Loading metadata at runtime

```ts
const metadata = await fetch('/api/validation-metadata').then((r) => r.json());
service.validationMetadata.setMetadata(metadata); // or addMetadata(...)
```

Entity-store validations that are running re-validate automatically (`metadataChanged$`).

On .NET, load from files, streams, strings or objects: see [dotnet.md](dotnet.md).
