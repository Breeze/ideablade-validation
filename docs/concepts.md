# Concepts

`@ideablade/validation` (TypeScript) and `IdeaBlade.Validation` (.NET) validate **any object** against rules described in **JSON metadata**. The framework doesn't care where objects come from: Breeze entities, plain objects, view models, EF entities and DTOs all work. The same metadata runs in the browser and on the server.

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
            ValidationError[]  (key, id, propertyName, errorMessage, context)
```

## Building blocks

| Concept | What it is |
|---|---|
| **Model type** | A string that names the kind of object, such as `"Customer"`. Breeze uses `entityType.shortName`; .NET uses the CLR type name by default. Metadata is keyed by model type. |
| **Metadata** | JSON that lists, per model type, the model-level validators, property validators, conditions and inheritance (`extends`). A `global` section applies to all types. See [metadata.md](metadata.md). |
| **Validator factory** | `{ name, fn(group, context) => Validator }`. You register factories through dependency injection (Angular providers, React provider props, .NET `IServiceCollection`) or as plain arrays. Metadata refers to validators by `name`. See [validators.md](validators.md). |
| **Validator** | Validates one value. *Sync* validators return errors directly; *async* validators return an Observable (TS) or a Task (.NET). Several factories may share a name, one sync and one async; `"async": true` in metadata selects the async one. |
| **Context** | A bag of values passed to the validator. It merges, in order: the per-call `options.context`, values from context providers, the model info (`model`, `modelType`, `propertyName`, `displayName`, `metadata`, `isClient`, `isServer`), and the validator's configured `context` from metadata. Message templates read from it: `%displayName% must be at most %maxLength% characters`. |
| **Context provider** | `{ contextFn(model, modelType) }`, registered in DI. Use it to make application services available to validators (the current user, a lookup cache…) without putting them in metadata. |
| **Condition** | An expression on a validator: it runs only when the condition is truthy. On a model, a condition decides whether the model is validated at all during entity-store validation. See [expressions.md](expressions.md). |
| **Group** | `{ "group": "submit", "validators": [...] }`. Groups let you run subsets of rules, for example only the rules for a workflow step. Choose them with `options.predicate`. Grouped validators also get distinct error keys (`required_submit_email`). |
| **Entity store** | `{ entities$, getEntities? }`: any source of entities. `validateEntityStore` re-validates whenever the entities change, the metadata changes, `options.event$` emits, or `revalidate()` is called. Use `breezeEntityStore(manager)` for Breeze. |
| **ValidationError** | `key` (`name[_group][_property]`), `id` (from metadata, else `key`), `propertyName`, `model`, `modelType`, `value`, `errorMessage`, and the full `context`. |

## Sync vs. async

- `validateModelSync(model, type)` returns `ValidationError[]` (empty when valid) and runs only sync validators.
- `validateModelAsync(model, type)` returns a cold `Observable<ValidationError[]>` that emits once. It runs only async validators, with a timeout (`asyncTimeout`, default 60 s). On timeout it continues as valid and calls `onAsyncTimeout`.
- `validate(model, type)` returns an `Observable<{ errors, pending }>`. It emits sync errors immediately, then the combined result. This is the best fit for UIs.
- `validateEntityStore(store)` / `validateEntityStoreOneTime(store)` / `validateEntities(list)` validate many models at once.

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
