# IdeaBlade Validation

A **data-store agnostic, metadata-driven validation framework** for TypeScript and .NET.

## Why this framework

Many applications tie validation to the forms in their UI. Each form declares its own validators, so the rules for one entity end up spread across every screen that edits it, and they drift apart. Angular's validation framework works this way too: it validates form controls, so data can only be validated when a form shows it.

We think validation belongs to the data, not to the UI. The rules for each type live in one central place, a JSON metadata structure, and the client and the server share them. Much of that metadata doesn't need to be written by hand at all. Data frameworks such as Breeze already derive validation rules from the server model and the database schema. If a column is `varchar(255)`, the 255-character limit should flow through the application as metadata, not be hardcoded as a validator in some form.

Validation should also be independent of how the data is shown. Whenever state changes, it is validated, and the UI simply surfaces the errors wherever they're relevant. That may be a form, but it may just as well be a dashboard, a list or a summary page that has no form at all.

## Features

- Rules live in **JSON metadata**: per model type, with property rules, model rules, groups, conditions and inheritance. The same metadata runs in the browser and on the server.
- **Validators plug in by name** through dependency injection: Angular providers, React provider props, or .NET `IServiceCollection`.
- Validators can be **sync or async**. Async validators may return Observables, Promises or Tasks, with a timeout.
- **Continuous validation** of whole entity stores, such as a Breeze `EntityManager`, that re-validates as entities change.
- **No `eval`.** Conditions and expressions run in a safe, sandboxed expression interpreter that works under a strict CSP. One grammar is shared by both platforms.
- First-class **Angular** (standalone providers, signals, reactive and template-driven forms), **React** (hooks) and **Breeze 3** integrations, all optional peer dependencies.

| Package | Folder | Install |
|---|---|---|
| `@ideablade/validation` (npm) | [`js/`](js) | `npm i @ideablade/validation rxjs` |
| `IdeaBlade.Validation` (NuGet) | [`dotnet/`](dotnet) | `dotnet add package IdeaBlade.Validation` |

## Quick start (TypeScript)

```ts
import { createValidationService } from '@ideablade/validation';

const service = createValidationService({
  metadata: {
    Customer: {
      properties: {
        name:  { displayName: 'Name', required: true, maxLength: 50 },
        email: { displayName: 'E-mail', validators: ['email'] },
        creditLimit: { validators: [{ name: 'range', context: { minValue: 0, maxValue: 100000 } }] },
      },
      validators: [{
        name: 'expression',
        condition: "model.country === 'US'",
        context: { expression: 'model.zip != null', messageTemplate: 'US customers need a ZIP code' },
      }],
    },
  },
});

service.validateModelSync({ name: '', email: 'nope', country: 'US' }, 'Customer')
  .map((e) => e.errorMessage);
// ['US customers need a ZIP code', 'Name is required', 'E-mail is not a valid email address']
```

**Angular:**

```ts
providers: [provideValidation({ metadata, validators: [breezeValidator] })]
// then: inject(ValidationService), validationErrors(signal, 'Customer'), FormValidators, ValidationFormsDirectives
```

**React:**

```tsx
<ValidationProvider metadata={metadata}><App /></ValidationProvider>
// then: const { messagesFor, isValid } = useValidation(customer, 'Customer');
```

## Quick start (.NET)

```csharp
builder.Services.AddIdeaBladeValidation(options => options
    .AddMetadataFile("validation.metadata.json"));

// in a controller or service
var errors = validationService.ValidateModel(customer);
```

## Documentation

| Topic | |
|---|---|
| [Concepts](docs/concepts.md) | Architecture, context, groups, sync/async, and why RxJS |
| [Metadata reference](docs/metadata.md) | The JSON format ([schema](spec/validation-metadata.schema.json)) |
| [Validators](docs/validators.md) | Built-in validators, and writing your own |
| [Expressions](docs/expressions.md) | The safe expression language |
| [Security](docs/security.md) | Why expressions run in a safe interpreter instead of `eval` |
| [Angular](docs/angular.md) · [React](docs/react.md) · [Breeze](docs/breeze.md) · [.NET](docs/dotnet.md) | Integrations |

## Repository layout

```
js/        npm package: src/{core,validators,expressions,angular,react,breeze}, test/
dotnet/    NuGet package: src/IdeaBlade.Validation, test/IdeaBlade.Validation.Tests
spec/      shared JSON schema + expression conformance suite (run by both test suites)
docs/      documentation
```

## Development

```powershell
cd js; npm install; npm test; npm run build
cd dotnet; dotnet test; dotnet pack -c Release -o artifacts
```

Node.js ≥ 22 (the package is ESM-only) and the .NET 10 SDK are required.
