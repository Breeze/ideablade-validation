using IdeaBlade.Validation.Metadata;
using IdeaBlade.Validation.Validators;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace IdeaBlade.Validation.Tests;

/// <summary>Property-level <c>from</c> references and rule sources, matching the TypeScript tests.</summary>
public class FromReferenceTests
{
    private const string Base = """
        {
          "Customer": {
            "validators": [{ "name": "expression", "context": { "expression": "false", "messageTemplate": "model rule" } }],
            "properties": {
              "email": { "displayName": "E-mail", "required": true, "validators": ["email"] },
              "name": { "displayName": "Name", "maxLength": 5 },
              "phone": { "required": true }
            }
          }
        }
        """;

    private static ValidationService CreateService(string json, IEnumerable<IValidationRuleSource>? ruleSources = null, params string[] more)
    {
        var maps = new[] { json }.Concat(more).Select(ModelValidationMetadataMap.Parse);
        return new ValidationService(new ValidationMetadata(maps, DefaultValidators.All, ruleSources: ruleSources));
    }

    private static Dictionary<string, object?> Model(params (string Key, object? Value)[] values) => values.ToDictionary(v => v.Key, v => v.Value);

    [Fact]
    public void InheritsTheValidatorsAndDisplayNameOfTheReferencedPropertyOnly()
    {
        var service = CreateService(Base, null, """{ "CustomerEdit": { "properties": { "email": { "from": "Customer" }, "label": { "from": "Customer.name" } } } }""");
        var errors = service.ValidateModel(Model(("email", "nope"), ("label", "Too long")), "CustomerEdit");
        Assert.Equal(new[] { "E-mail is not a valid email address", "Name must be at most 5 characters" }, errors.Select(e => e.ErrorMessage));
        Assert.Equal(new[] { "email_email", "maxLength_label" }, errors.Select(e => e.Key));
    }

    [Fact]
    public void OwnSettingsGoOnTop()
    {
        var service = CreateService(Base, null, """{ "CustomerEdit": { "properties": { "email": { "from": "Customer", "displayName": "Mail", "required": true, "maxLength": 3 } } } }""");
        Assert.Equal(new[] { "Mail is required" }, service.ValidateModel(Model(("email", "")), "CustomerEdit").Select(e => e.ErrorMessage));
        Assert.Equal(new[] { "Mail must be at most 3 characters" }, service.ValidateModel(Model(("email", "a@b.co")), "CustomerEdit").Select(e => e.ErrorMessage));
    }

    [Fact]
    public void OwnValidatorsGoAfterTheInheritedOnes()
    {
        var service = CreateService(Base, null, """
            { "CustomerEdit": { "properties": { "email": {
              "from": "Customer",
              "validators": [
                { "name": "expression", "context": { "expression": "!value || value.endsWith('.com')", "messageTemplate": "%displayName% must be a .com address" } },
                { "group": "signup", "validators": ["required"] }
              ]
            } } } }
            """);

        var property = service.ValidationMetadata.GetModelMetadata("CustomerEdit").GetProperty("email")!;
        Assert.Equal(new[] { "email:", "expression:", "required:signup", "required:" }, property.Validators.Select(v => $"{v.Name}:{v.Group}"));
        Assert.Equal(new[] { "E-mail is not a valid email address", "E-mail must be a .com address" },
            service.ValidateModel(Model(("email", "nope")), "CustomerEdit").Select(e => e.ErrorMessage));

        // The extra validators belong to CustomerEdit only; the source property is unchanged.
        Assert.Equal(new[] { "email", "required" }, service.ValidationMetadata.GetModelMetadata("Customer").GetProperty("email")!.Validators.Select(v => v.Name));
    }

    [Fact]
    public void FollowsChainsAndReportsCyclesAndUnknownReferences()
    {
        var chained = CreateService(Base, null, """{ "A": { "properties": { "email": { "from": "Customer" } } }, "B": { "properties": { "email": { "from": "A" } } } }""");
        Assert.Equal(new[] { "E-mail is required" }, chained.ValidateModel(Model(("email", "")), "B").Select(e => e.ErrorMessage));

        var cyclic = CreateService("""{ "A": { "properties": { "x": { "from": "B" } } }, "B": { "properties": { "x": { "from": "A" } } } }""");
        Assert.Contains("circular 'from'", Assert.Throws<ValidationConfigurationException>(() => cyclic.ValidateModel(Model(), "A")).Message);

        var unknown = CreateService("""{ "A": { "properties": { "x": { "from": "Nope" } } } }""");
        Assert.Contains("no metadata and no rule source knows", Assert.Throws<ValidationConfigurationException>(() => unknown.ValidateModel(Model(), "A")).Message);
    }

    private sealed class ServerRules : IValidationRuleSource
    {
        public IEnumerable<ValidatorFactory> Validators { get; } = new[]
        {
            ValidatorFactory.Sync("shout", (v, c) => v is string s && s == s.ToUpperInvariant(), "%displayName% must be upper case"),
        };

        public PropertyValidationConfig? GetPropertyRules(string modelType, string propertyName) =>
            modelType == "Server" && propertyName == "code"
                ? new PropertyValidationConfig { DisplayName = "Server code", Validators = { new ValidatorConfig("shout") } }
                : null;
    }

    [Fact]
    public void AsksTheRuleSourcesAndRegistersTheirValidators()
    {
        var service = CreateService("""{ "Form": { "properties": { "code": { "from": "Server" }, "label": { "from": "Server.code", "displayName": "Label" } } } }""", new[] { new ServerRules() });
        Assert.Equal(new[] { "Server code must be upper case", "Label must be upper case" },
            service.ValidateModel(Model(("code", "abc"), ("label", "x")), "Form").Select(e => e.ErrorMessage));
    }

    [Fact]
    public void RuleSourcesRegisterThroughDependencyInjection()
    {
        var services = new ServiceCollection();
        services.AddIdeaBladeValidation(v => v
            .AddMetadataJson("""{ "Form": { "properties": { "code": { "from": "Server" } } } }""")
            .AddRuleSource(new ServerRules()));
        using var provider = services.BuildServiceProvider();
        using var scope = provider.CreateScope();
        var service = scope.ServiceProvider.GetRequiredService<ValidationService>();
        Assert.Equal(new[] { "Server code must be upper case" }, service.ValidateModel(Model(("code", "abc")), "Form").Select(e => e.ErrorMessage));
    }
}
