# ideablade-validation

A data-store agnostic, metadata-driven validation framework with a safe expression language, plus Angular providers, React hooks and a Breeze 3 adapter.

The core works with any persistence layer. The Breeze adapter is a ready-made integration built only on the core's public extension points (entity stores, model type resolvers, rule sources and validators), so you can connect any other data layer the same way ([Integrating your data layer](https://github.com/Breeze/ideablade-validation/blob/main/docs/concepts.md#integrating-your-data-layer)).

```sh
npm i ideablade-validation rxjs
```

| Import | Contents | Peer dependencies |
|---|---|---|
| `ideablade-validation` | Core: `createValidationService`, `ValidationService`, `ValidationMetadata`, validators, `SafeExpressionEvaluator`, `createEntityStore`, `ErrorVisibility` (which errors to show) | `rxjs ^7.4` |
| `ideablade-validation/angular` | `provideValidation`, `provideValidationScope`, tokens, `validationErrors`/`validationState` signals, `signalEntityStore`, `FormValidators` (reactive forms), `ValidationFormsDirectives` (template-driven forms), `provideErrorVisibility`, `injectErrorVisibility` | `@angular/core ≥17.1`, `@angular/forms` |
| `ideablade-validation/angular/signal-forms` | `validateWithMetadata` (Signal Forms), `shownErrors` | `@angular/core`, `@angular/forms` ≥22 |
| `ideablade-validation/react` | `ValidationProvider`, `useValidation`, `useValidationScope`, `useEntityStoreValidation`, `ValidationForm`, `useFieldValidation`, `ErrorVisibilityProvider`, `useShownErrors` | `react ≥18` |
| `ideablade-validation/breeze` | Optional ready-made Breeze integration: `breezeValidator`, `installBreezeValidators`, `breezeEntityStore`, `breezeModelType`, `breezeRuleSource`, `breezeIsNew` | `breeze-client ≥3` |

The package is ESM-only and requires Node.js ≥ 22 for server-side use. The metadata JSON schema ships at `ideablade-validation/schema/validation-metadata.schema.json`; for referencing it from `$schema`, a URL works best ([Referencing the schema](https://github.com/Breeze/ideablade-validation/blob/main/docs/metadata.md#referencing-the-schema)).

```ts
import { createValidationService } from 'ideablade-validation';

const service = createValidationService({
  metadata: { Customer: { properties: { email: { required: true, validators: ['email'] } } } },
});
service.validateModelSync({ email: 'x' }, 'Customer')[0].errorMessage; // "email is not a valid email address"
```

Full documentation: https://github.com/Breeze/ideablade-validation/tree/main/docs
