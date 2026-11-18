# @ideablade/validation

A data-store agnostic, metadata-driven validation framework with a safe expression language, plus Angular providers, React hooks and a Breeze 3 adapter.

```sh
npm i @ideablade/validation rxjs
```

| Import | Contents | Peer dependencies |
|---|---|---|
| `@ideablade/validation` | Core: `createValidationService`, `ValidationService`, `ValidationMetadata`, validators, `SafeExpressionEvaluator` | `rxjs ^7.4` |
| `@ideablade/validation/angular` | `provideValidation`, tokens, `validationErrors`/`validationState` signals, `FormValidators` (reactive forms), `ValidationFormsDirectives` (template-driven forms) | `@angular/core ≥17.1`, `@angular/forms` |
| `@ideablade/validation/react` | `ValidationProvider`, `useValidation`, `useEntityStoreValidation` | `react ≥18` |
| `@ideablade/validation/breeze` | `breezeValidator`, `installBreezeValidators`, `breezeEntityStore`, `breezeModelType` | `breeze-client ≥3` |

The package is ESM-only and requires Node.js ≥ 22 for server-side use. The metadata JSON schema ships at `@ideablade/validation/schema/validation-metadata.schema.json`.

```ts
import { createValidationService } from '@ideablade/validation';

const service = createValidationService({
  metadata: { Customer: { properties: { email: { required: true, validators: ['email'] } } } },
});
service.validateModelSync({ email: 'x' }, 'Customer')[0].errorMessage; // "email is not a valid email address"
```

Full documentation: https://github.com/Breeze/ideablade-validation/tree/main/docs
