# Validators

## Built-in validators

All of these are registered by default (`defaultValidators` in TS, `DefaultValidators.All` in .NET). Except for `required` and `expression`, they **pass empty values**: `null`, `undefined`, `''` and `[]`. Combine them with `required` to make a value mandatory.

| Name | Context settings | Default message |
|---|---|---|
| `required` | `trim` (whitespace-only fails) | `%displayName% is required` |
| `minLength` | `minLength` | `%displayName% must be at least %minLength% characters` |
| `maxLength` | `maxLength` | `%displayName% must be at most %maxLength% characters` |
| `pattern` | `expression` (pattern string, `"/src/flags"` or RegExp), `flags` (for a pattern string: `i`, `m`, `s` and `u` work the same on client and server; avoid `g` and `y`, which make JavaScript's `test()` stateful) | `%displayName% '%value%' does not match the required format` |
| `email` | | `%displayName% is not a valid email address` |
| `zipCode` | | US ZIP or ZIP+4 |
| `phone` | | 10-digit US phone; punctuation allowed |
| `social` | | US SSN, `123-45-6789` or `123456789` |
| `fein` | | US FEIN, `12-3456789` |
| `currency` | | numbers, or strings like `1,234.56`, `-12`, `$5.00` |
| `numeric` | `allowDecimals`, `allowLeadingZeros`, `allowNegative` (all default false) | whole/decimal number message |
| `integer` | | `%displayName% must be an integer` (negatives allowed) |
| `range` (aliases `numericRange`, `dateRange`) | `minValue`, `maxValue` (either optional), `exclusive` | `%displayName% must be between %minValueText% and %maxValueText%` |
| `date` | `allowString` | `%displayName% must be a valid date` |
| `compare` | `other` (property name), `op` (`== != < <= > >=`) | `%displayName% is invalid` |
| `invalidValues` | `values` (entries like `"/^Z/i"` are patterns) | `'%value%' is not a valid value for %displayName%` |
| `validValues` | `values` | same |
| `expression` | `expression`, `skipEmpty` | `%displayName% is invalid` |
| `unique` | `ignoreCase`. Needs `store(type)`: entity store validation and `options.store` supply one, and for single models and forms, the service's [entity store](concepts.md#scopes-a-service-and-its-entity-store). Without a store it passes. | `%displayName% must be unique` |
| `breeze` (TS, from `ideablade-validation/breeze`) | Breeze's sync validators, plus its async ones (Breeze 3) in `validateModelAsync` and `validate` | Breeze's own messages |

### Range bounds

`minValue`/`maxValue` accept the following:

- **numbers**, or numeric strings;
- **dates**, as ISO or other parseable strings;
- **relative dates**: `now`, `today`, `now-18y`, `today+30d`, `now+2h`. The units are `y` (years), `M` (months), `w` (weeks), `d` (days), `h` (hours) and `m` (minutes). A missing unit means years, so `now-20` is 20 years ago. Year offsets are capped at 150.
- **relative years**: `year`, `year+1`, `year-5`. These give the calendar year as a number.

When the bound is a date, the value is compared as a date. Messages can use `%minValueText%`/`%maxValueText%` (formatted).

## Writing a validator

### TypeScript

```ts
import { syncValidator, asyncValidator, SyncValidator, withMessage } from 'ideablade-validation';

// 1. A one-liner
export const evenValidator = syncValidator('even', (v) => v == null || v % 2 === 0, '%displayName% must be even');

// 2. Async: may return Observable<boolean>, Promise<boolean> or boolean
export const loginAvailable = (api: UserApi) =>
  asyncValidator('loginAvailable', (login: string) => api.isAvailable(login), '%displayName% is already taken');

// 3. A class with settings from metadata context
export class MultipleOfValidator extends SyncValidator {
  constructor(group?: string, context?: Partial<ValidationContextBase>) {
    super('multipleOf', group, (v, ctx) => v == null || v % ctx.factor === 0,
      withMessage(context, '%displayName% must be a multiple of %factor%'));
  }
}
export const multipleOf = { name: 'multipleOf', fn: (g, c) => new MultipleOfValidator(g, c) };
```

The validator function receives `(value, context)`. The `context` contains `model`, `modelType`, `propertyName`, `displayName`, `isClient`, `isServer`, your metadata `context` settings, values from context providers and options, and `expressionScope` (with `store`, when available). You can add values to `context` for use in the message, as `range` does with `%minValueText%`.

A model-level validator can say which properties an error is about by setting `context.propertyNames`, as the metadata's `propertyNames` does. The forms show the error on those fields.

### Registering

| Environment | How |
|---|---|
| Plain TS | `createValidationService({ validators: [evenValidator] })` |
| Angular | `provideValidation({ validators: [...] })`, `provideValidators(...)`, or `provideValidatorFactory(() => loginAvailable(inject(UserApi)))` |
| React | `<ValidationProvider validators={[...]}>`, or create the service yourself |
| .NET | `services.AddIdeaBladeValidation(v => v.AddValidators(new ValidatorFactory("even", (group, ctx) => new EvenValidator(group, ctx))))`. See [dotnet.md](dotnet.md#writing-validators). |

### Application-specific validators

The built-in set covers rules that are useful in any application. Keep rules that depend on your domain, such as tax rules, or that query your own services, in your application and register them alongside the built-in ones. To reuse a built-in validator under another name, for example a stricter `required` that a workflow step can select separately, register it with that name:

```ts
{ name: 'requiredToSubmit', fn: (group, ctx) => new RequiredValidator(group, ctx, 'requiredToSubmit') }
```
