# .NET (`IdeaBlade.Validation`)

`IdeaBlade.Validation` is the server-side counterpart of `@ideablade/validation`. It uses the same JSON metadata, the same validator names and messages, and the same expression language (both test suites run [`spec/expression-conformance.json`](../spec/expression-conformance.json)), so a rule behaves the same in the browser and on the server.

- Targets `netstandard2.0` (.NET Framework 4.6.2+), `net8.0` and `net10.0`.
- Dependencies: `System.Text.Json`, `Microsoft.Extensions.DependencyInjection.Abstractions`, plus `Microsoft.Bcl.AsyncInterfaces` on netstandard2.0 only.
- Works with any persistence layer: it validates any CLR object (POCOs, DTOs, EF entities, a save bundle) and doesn't depend on Breeze or an ORM. Your data layer plugs in through the [model type resolver](#model-type-names), [entity stores](#entity-stores), rule sources (`IValidationRuleSource`) and validators ([concepts.md](concepts.md#integrating-your-data-layer)).

```
dotnet add package IdeaBlade.Validation
```

## Setup with dependency injection

```csharp
builder.Services.AddIdeaBladeValidation(v => v
    .AddMetadataFile("validation.metadata.json")               // or AddMetadataDirectory / AddMetadataJson / AddMetadataStream / AddMetadata(map)
    .AddValidators(
        ValidatorFactory.Sync("isSku", (value, ctx) => value is string s && s.StartsWith("SKU")),
        ValidatorFactory.Async("loginAvailable", async (value, ctx, ct) => !await users.ExistsAsync((string?)value, ct), "%displayName% is taken"))
    .AddContextProvider<CurrentUserContextProvider>()           // scoped; may use scoped services
    .AddExpressionFunction("isWeekend", (Func<DateTime, bool>)(d => d.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday))
    .Configure(o => o.AsyncTimeout = TimeSpan.FromSeconds(10))
    .ConfigureExpressions(o => o.MaxSteps = 50_000));
```

| Builder method | Purpose |
|---|---|
| `AddMetadata(map)` / `AddMetadataJson(json)` / `AddMetadataStream(stream)` / `AddMetadataFile(path)` | Add metadata. Several sources are merged as in TS. JSON comments and trailing commas are allowed. |
| `AddMetadataDirectory(dir, pattern = "*validation.metadata.json")` | Load all matching files |
| `AddMetadata(sp => maps)` | Metadata built from services, for example loaded from a database |
| `AddValidators(params ValidatorFactory[])` | Register validators |
| `ExcludeDefaultValidators()` | Don't register `DefaultValidators.All` |
| `AddContextProvider<T>()` | `IValidatorContextProvider`: adds context values per model |
| `AddDataAnnotations(name = "dataAnnotations")` | Registers `DataAnnotationsValidator` under `name` ([below](#data-annotations)) |
| `AddRuleSource(source)` / `AddRuleSource<T>()` | `IValidationRuleSource`: rules outside the metadata, inherited through `from` ([concepts.md](concepts.md#rule-sources)) |
| `AddExpressionFunction(name, delegate)` | A trusted function callable from expressions |
| `Configure(Action<ValidationServiceOptions>)` | `AsyncTimeout`, `OnAsyncTimeout`, `ModelTypeResolver`, `ExpressionScope` |
| `ConfigureExpressions(Action<SafeExpressionEvaluatorOptions>)` | `Globals`, `AllowedMethods`, `MaxSteps`, `MaxCallDepth`, `CacheSize` |
| `UseExpressionEvaluator(sp => evaluator)` | Replace the expression engine |

Lifetimes: `ValidationMetadata` and the expression evaluator are singletons. `ValidationService` is **scoped**, so context providers can depend on the request's services.

## Validating

```csharp
public class OrdersController(ValidationService validation) : ControllerBase
{
    [HttpPost]
    public async Task<IActionResult> Save(Order order, CancellationToken ct)
    {
        var errors = await validation.ValidateModelAsync(order, cancellationToken: ct);
        if (errors.HasErrors())
            return ValidationProblem(new ValidationProblemDetails(
                errors.SelectMany(e => e.PropertyNames.DefaultIfEmpty("").Select(p => (Property: p, e.ErrorMessage))).GroupBy(e => e.Property).ToDictionary(g => g.Key, g => g.Select(e => e.ErrorMessage).ToArray())));
        ...
    }
}
```

| Method | |
|---|---|
| `ValidateModel(model[, modelType], options)` | Sync validators only. Returns `IReadOnlyList<ValidationError>`, empty when valid. |
| `ValidateModelAsync(model[, modelType], options, ct)` | **Sync and async** validators, as in TS. Subject to `AsyncTimeout`: on timeout the async validators count as valid and the sync errors are returned. |
| `ValidateEntitiesAsync(IValidationEntityStore \| IEnumerable<object>, options, ct)` | Validates a set of entities, such as a save bundle. Honors model `condition`s. Expressions get `store(type)` and `findEntity(id, type)`. |
| `HasAsyncValidators(modelType, predicate)` | |
| `event ModelValidated` | Raised after each model validation |

`ValidationOptions` has `Predicate`, `Context`, `ConditionContextResolver`, `Store`, and `ExpressionScope`, the same meanings as in TS ([concepts.md](concepts.md)).

`ValidationError` has `Key`, `Id`, `PropertyNames` (the properties it is about: a property rule's property, or those a model-level rule names in `propertyNames`), `IsFor(propertyName)`, `Value`, `ErrorMessage`, `GetErrorMessage(displayName)` and `Context`. `errors.HasErrors()` and `errors.Success()` are extension methods.

### Model type names

By default the model type is the CLR type name. EF Core and Castle proxy types are unwrapped. Override this when your metadata uses other names, for example Breeze names:

```csharp
.Configure(o => o.ModelTypeResolver = model => model is IHasTypeName t ? t.TypeName : model.GetType().Name)
```

### Entity stores

```csharp
var errors = await validation.ValidateEntitiesAsync(saveBundle.Entities);           // IEnumerable<object>
var errors = await validation.ValidateEntitiesAsync(new ValidationEntityStore(list));
```

Implement `IValidationEntityStore` (`Entities`), plus `IValidationEntityTypeLookup` (`GetEntities(type)`) for a fast `store(type)`, to validate other sources such as an EF change tracker.

## Data annotations

`DataAnnotationsValidator` runs a model's data annotations (`[Required]`, `[StringLength]`, any `ValidationAttribute`, and `IValidatableObject`) as a model-level validator. It works on any CLR object and doesn't depend on Breeze. Each failure is a `ValidationError` like any other: its key is named after the attribute (`required_City`, `stringLength_Zipcode`), its property is the CLR property, and its message is the annotation's own.

Reference it from the metadata, usually as a global validator. If your client uses Breeze, register it as `breeze` to pair it with the client's `breeze` validator: Breeze builds its client-side rules from these same annotations, so one metadata entry runs them on both sides.

```csharp
services.AddIdeaBladeValidation(v => v
    .AddMetadataFile("validation.metadata.json")   // { "global": { "validators": ["breeze"] }, ... }
    .AddDataAnnotations("breeze"));
```

## Writing validators

```csharp
public sealed class MultipleOfValidator : Validator
{
    public MultipleOfValidator(string? group, ValidationContextBase? context)
        : base("multipleOf", group, WithMessage(context, "%displayName% must be a multiple of %factor%")) { }

    protected override bool ValidateCore(object? value, ValidatorFunctionContext context) =>
        value is null || Convert.ToDecimal(value) % context.GetValue<decimal>("factor") == 0;
}

services.AddIdeaBladeValidation(v => v.AddValidators(new ValidatorFactory("multipleOf", (g, c) => new MultipleOfValidator(g, c))));
```

`Validate` returns a validator's errors, and `ValidateAsync` an async one's: empty when the value is valid, one error by default when `ValidateCore` / `ValidateCoreAsync` fails. A validator that reports several errors in one pass, such as `DataAnnotationsValidator`, overrides them. In TypeScript, `validate` likewise returns a `ValidationError`, an array of them, or `null` (an Observable of that for async validators).

Async validators derive from `AsyncValidator` and override `ValidateCoreAsync(value, context, cancellationToken)`. If a validator throws, the exception counts as a failure and is stored in `context["exception"]`.

The context is a case-insensitive dictionary (`ValidationContextBase` / `ValidationContext` / `ValidatorFunctionContext`) with typed accessors: `Model`, `ModelType`, `PropertyName`, `DisplayName`, `MessageTemplate`, `IsClient` (false), `IsServer` (true), `GetValue<T>(name)` and `GetValues<T>(name)`.

## Expressions on the server

The interpreter is the same as in TS ([expressions.md](expressions.md)). It reads CLR objects as follows:

- **Properties** are matched case-insensitively (`model.firstName` → `FirstName`), and also through `IDictionary<string, object?>`, `ExpandoObject`, `JsonElement` and `JsonNode`.
- **Numbers** become `double` inside expressions. `decimal` values beyond double precision lose precision, so compare money with a tolerance or in a custom validator.
- **Enums** become their names and **Guids** become strings: `model.status === 'Active'`.
- **Dates:** `DateTime` behaves like a JS `Date`. Relational operators compare by time, and `===` between two date objects is false, as in JS; use `getTime()`. `DateTimeOffset` is converted to UTC.
- **Regex literals** use .NET's ECMAScript mode where possible, with a **1-second match timeout**.
- **Limits:** step budget (100,000), call depth (64) and parse depth (200).
- In model conditions, the variable holding all entities is `entities`. On the client it's `entityInfos`.

### Using a JavaScript engine instead

If you need full JavaScript on the server, plug in your own engine, for example Jint. Constrain it:

```csharp
public sealed class JintEvaluator : IExpressionEvaluator
{
    public object? Evaluate(string expression, IReadOnlyDictionary<string, object?> scope)
    {
        var engine = new Jint.Engine(o => o.TimeoutInterval(TimeSpan.FromMilliseconds(250)).MaxStatements(10_000).LimitRecursion(32));
        foreach (var (name, value) in scope) engine.SetValue(name, value);
        return engine.Evaluate(expression).ToObject();
    }
}

services.AddIdeaBladeValidation(v => v.UseExpressionEvaluator(_ => new JintEvaluator()));
```

This gives up client/server parity and the safety guarantees in [security.md](security.md), so prefer exposing the functions you need with `AddExpressionFunction`.

## Without DI

```csharp
var metadata = new ValidationMetadata(
    new[] { ModelValidationMetadataMap.LoadFile("validation.metadata.json") },
    DefaultValidators.All,
    new SafeExpressionEvaluator());
var service = new ValidationService(metadata);
```
