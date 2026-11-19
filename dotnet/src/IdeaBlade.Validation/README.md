# IdeaBlade.Validation

Data-store agnostic, metadata-driven validation for .NET. This is the server-side counterpart of the
`@ideablade/validation` npm package. Both use the same JSON metadata, the same validator names and the same
safe expression language, so client and server validate identically.

```csharp
services.AddIdeaBladeValidation(v => v
    .AddMetadataFile("validation.metadata.json")
    .AddValidators(ValidatorFactory.Sync("isSku", (value, ctx) => value is string s && s.StartsWith("SKU")))
    .AddContextProvider<CurrentUserContextProvider>());

// in a scoped service / controller
var errors = await validationService.ValidateModelAsync(order);
if (errors.HasErrors()) { /* errors[i].ErrorMessage, .PropertyNames, .Id */ }
```

- Targets `netstandard2.0`, `net8.0` and `net10.0`.
- Works with any persistence layer: POCOs, DTOs, EF entities, a save bundle. It doesn't depend on Breeze or any ORM. Implement `IValidationEntityStore` to validate a set of entities from your own source, such as an EF change tracker, and `IValidationRuleSource` to supply rules your data layer already knows.
- `DataAnnotationsValidator` runs a model's data annotations. It works on any CLR object; registered as `breeze`, it pairs with the client's `breeze` validator.
- Conditions and `expression` validators run in a sandboxed interpreter. It has no JavaScript engine and no `eval`, and it has a step budget and a regex timeout.
- Bring your own engine by implementing `IExpressionEvaluator`.

Full documentation: [docs/dotnet.md](https://github.com/Breeze/ideablade-validation/blob/main/docs/dotnet.md)
(in the repository at `../../docs/dotnet.md`).
