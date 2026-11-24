# .NET (`IdeaBlade.Validation`)

`IdeaBlade.Validation` is the server-side counterpart of `ideablade-validation`. It uses the same JSON metadata, the same validator names and messages, and the same expression language (both test suites run [`spec/expression-conformance.json`](../spec/expression-conformance.json)), so a rule behaves the same in the browser and on the server.

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
| `Configure(Action<ValidationServiceOptions>)` | `AsyncTimeout`, `OnAsyncTimeout`, `OnDuplicateErrorKey` ([Error keys](metadata.md#error-keys)), `ModelTypeResolver`, `NamingConvention` ([below](#property-names)), `ExpressionScope` |
| `ConfigureExpressions(Action<SafeExpressionEvaluatorOptions>)` | `Globals`, `AllowedMethods`, `MaxSteps`, `MaxCallDepth`, `CacheSize` |
| `UseExpressionEvaluator(sp => evaluator)` | Replace the expression engine |

Lifetimes: `ValidationMetadata` and the expression evaluator are singletons. `ValidationService` is **scoped**, so context providers can depend on the request's services.

> **In TempHire:** [`Program.cs`](https://github.com/Breeze/temphire.server/blob/main/TempHire.Server/Program.cs) registers the service with the app's [`validation.metadata.json`](https://github.com/Breeze/temphire.server/blob/main/TempHire.Server/Validation/validation.metadata.json) and the data annotations, and [`ValidationController`](https://github.com/Breeze/temphire.server/blob/main/TempHire.Server/Controllers/ValidationController.cs) serves the same metadata to the client, so both sides check the same rules.

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

`ValidationError` has `Key`, `Id`, `PropertyNames` (the properties it is about, as the model names them: a property rule's property, or those a model-level rule names in `propertyNames`), `MetadataPropertyNames` (the same, as the metadata names them), `IsFor(propertyName)`, `Value`, `ErrorMessage`, `GetErrorMessage(displayName)` and `Context`. `errors.HasErrors()` and `errors.Success()` are extension methods.

### Property names

The metadata names properties once, for every platform, in camelCase: `firstName`, `stateId`. JavaScript objects use those names as they are. CLR objects use PascalCase: `FirstName`, `StateId`. A **naming convention** translates between the two, as Breeze's `NamingConvention` does between a Breeze client and server. On .NET the default is `NamingConvention.CamelCase`.

It applies where a name crosses between the metadata and the model:

- **Reading a value.** The metadata's `stateId` reads the CLR property `StateId`. If the model has no property of that name, a property with the metadata's exact name is used, then one that matches it case-insensitively.
- **The names an error reports.** `ValidationError.PropertyNames` and `IsFor(name)` use the model's names (`StateId`), so server code can use them with its CLR objects. `MetadataPropertyNames` has the metadata's (`stateId`).
- **Messages.** A property without a `displayName` is named in a message as the model names it: `StateId is required`, like the data annotations' own messages.

Everything inside the metadata keeps the metadata's names: error keys (`required_stateId`, the same key as on the client), `propertyNames`, `from` references and `context.propertyName` in expressions. A model with no CLR properties of its own, such as a dictionary, an `ExpandoObject` or JSON, uses the metadata's names, so nothing is translated for it.

```csharp
.Configure(o => o.NamingConvention = NamingConvention.None)                       // the metadata uses the CLR names
.Configure(o => o.NamingConvention = new NamingConvention("snake_case", ToPascal, ToSnake))   // any other mapping
```

The TypeScript library needs no convention: its objects already have the metadata's names. Another server platform would default to its own convention.

> **In TempHire:** the metadata ([`validation.metadata.json`](https://github.com/Breeze/temphire.server/blob/main/TempHire.Server/Validation/validation.metadata.json)) uses the client's camelCase names, and the server reads them from the PascalCase entities with the default convention.

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

## Validating a save

The server is where a save has to be checked, whatever the client already checked. That raises a question the client never faces: what does the save get checked *against*?

### A save holds only what changed

A save request, whether it's a Breeze save bundle, a DTO graph or an EF change tracker, carries the entities the client added, modified or deleted. The parent of a changed child, its siblings, and its other children aren't in it unless they changed too. Rules about related entities need them all the same:

- "An order has at least one line" reads the order's lines (`store('OrderLine')`). A save that deletes one line holds only that line.
- `unique` compares a value with the other entities of its type.
- Model `condition`s and `findEntity(id, type)` look up other entities.

Validating only the entities in the save would miss these rules, or worse, pass them against an incomplete picture. A save that deletes an order's last line, and nothing else, would go through.

### Validate the database as it will be after the save

So before validating, load what the rules read, and apply the save on top. An entity store for the save does both:

- **`Entities`**, what gets validated: the added and modified entities, plus the stored entities whose rules the save may affect, such as the order whose line is being deleted.
- **`GetEntities(type)`**, behind `store(type)`: the stored rows of that type that the rules may read, for the entities concerned, with the save applied. Deleted rows are taken out, and added and modified ones replace or join the stored ones.

```csharp
sealed class SaveValidationStore : IValidationEntityStore, IValidationEntityTypeLookup
{
    // Reads everything the rules may need up front, asynchronously: rules call store(type)
    // while they evaluate, and that can't wait for a query.  Read untracked, so the rows
    // don't collide with the entities the ORM is about to save.
    public static async Task<SaveValidationStore> CreateAsync(AppDbContext db, SaveRequest save, CancellationToken ct) { ... }

    public IReadOnlyList<object> Entities { get; }                 // changed entities + affected parents
    public IEnumerable<object> GetEntities(string entityType) { ... }  // stored rows, with the save applied
}

var store = await SaveValidationStore.CreateAsync(db, save, ct);
var errors = await validation.ValidateEntitiesAsync(store, cancellationToken: ct);
```

The rules then run against **the database as it will be after the save**, not as the client saw it when it loaded the data. That's what keeps the data consistent when several people edit it at once. Another user may have changed or deleted records in the meantime, and the client can't know. Say an order has two lines, and two users each delete a different one. On each user's screen one line remains, so both saves pass on the client. The first save goes through. The second deletes a line nobody else touched, so an optimistic concurrency check (a row version on each row) has nothing to catch: it covers the rows in the save, not the rows a rule reads. Checked against the database, though, the order would be left with no lines, and the server refuses the save.

Concurrency checks and save validation complement each other. Neither serializes two saves that run at exactly the same moment, because both read the database before either writes. Closing that gap takes a database constraint, or a serializable transaction around validating and writing.

### This is your code, not the framework's

The framework knows the rules, not your model. To it, `store('OrderLine')` is a name to look up. Which lines belong to which order, which stored entities a save can affect, and how to load them from your database are knowledge of your model and your data layer. So the save's entity store is application code, and it has to keep up with the rules: a new rule that reads other entities may need more loaded.

That knowledge is in two places an AI coding assistant can read: the rules (`store(type)`, `findEntity`, `unique` and conditions in the metadata) and the model. An assistant such as Claude can write the store from them, and check it again whenever the rules change. Writing it around an aggregate, such as an order and all of its lines, instead of rule by rule keeps those changes rare: a new rule within the aggregate needs nothing new.

> **In TempHire:** every save is validated this way. [`SaveValidationStore`](https://github.com/Breeze/temphire.server/blob/main/TempHire.Server/Persistence/SaveValidationStore.cs) loads the staffing resources a save concerns and all of their children, and [`TempHirePersistenceManager`](https://github.com/Breeze/temphire.server/blob/main/TempHire.Server/Persistence/TempHirePersistenceManager.cs) runs the rules on it before Breeze saves. Its README explains it in [Validating the database as it will be after the save](https://github.com/Breeze/temphire.server#validating-the-database-as-it-will-be-after-the-save).

## Data annotations

`DataAnnotationsValidator` runs a model's data annotations (`[Required]`, `[StringLength]`, any `ValidationAttribute`, and `IValidatableObject`) as a model-level validator. It works on any CLR object and doesn't depend on Breeze. Each failure is a `ValidationError` like any other: its key is named after the attribute and the property as the metadata names it (`required_city`, `stringLength_zipcode`, the same keys as Breeze's on the client), `PropertyNames` holds the CLR property, and its message is the annotation's own. The metadata's name comes from the [naming convention](#property-names).

Reference it from the metadata, usually as a global validator. If your client uses Breeze, register it as `breeze` to pair it with the client's `breeze` validator: Breeze builds its client-side rules from these same annotations, so one metadata entry runs them on both sides.

```csharp
services.AddIdeaBladeValidation(v => v
    .AddMetadataFile("validation.metadata.json")   // { "global": { "validators": ["breeze"] }, ... }
    .AddDataAnnotations("breeze"));
```

> **In TempHire:** [`validation.metadata.json`](https://github.com/Breeze/temphire.server/blob/main/TempHire.Server/Validation/validation.metadata.json) has `{ "global": { "validators": ["breeze"] } }`, and [`TempHirePersistenceManager`](https://github.com/Breeze/temphire.server/blob/main/TempHire.Server/Persistence/TempHirePersistenceManager.cs) turns the errors into the Breeze `EntityError`s a failed save reports to the client.

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

- **Properties** are matched case-insensitively (`model.firstName` → `FirstName`), and also through `IDictionary<string, object?>`, `ExpandoObject`, `JsonElement` and `JsonNode`. This holds whatever the [naming convention](#property-names), so expressions written for the client run unchanged.
- **Numbers** become `double` inside expressions. `decimal` values beyond double precision lose precision, so compare money with a tolerance or in a custom validator.
- **Enums** become their names and **Guids** become strings: `model.status === 'Active'`.
- **Dates:** `DateTime` behaves like a JS `Date`. Relational operators compare by time, and `===` between two date objects is false, as in JS; use `getTime()`. `DateTimeOffset` is converted to UTC.
- **Regular expressions** (regex literals and the `pattern` validator) use .NET's ECMAScript mode where possible, with a **1-second match timeout**. A pattern that mode can't parse, such as one with `\p{L}`, falls back to .NET's default mode, where `\d` and `\w` also match non-ASCII digits and letters. The `i`, `m` and `s` flags work as in JavaScript, `g` works in `match`, `replace` and `replaceAll`, and `y` and `u` are ignored. So with `u`, Unicode categories (`\p{L}`, `\p{Lu}`, `\P{L}`) work on both sides, but `\u{1F600}` and `\p{Script=Greek}` throw on .NET, and only JavaScript matches a character outside the Basic Multilingual Plane, such as an emoji, with `.` or `[😀]` (.NET sees its two UTF-16 halves). Write `\p{…}` only with `u`: without it, JavaScript reads `\p{L}` as the text `p{L}`.
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
