using System.Diagnostics;
using IdeaBlade.Validation.Metadata;
using IdeaBlade.Validation.Validators;
using Xunit;

namespace IdeaBlade.Validation.Tests;

/// <summary>Error keys are unique per model: checked before the rules run, and reported when validation finds otherwise. Matches the TypeScript tests.</summary>
public class DuplicateErrorKeyTests
{
    private static ValidationService CreateService(ValidationServiceOptions? options, params string[] json) =>
        new(new ValidationMetadata(json.Select(ModelValidationMetadataMap.Parse), DefaultValidators.All.Append(DataAnnotationsValidator.Factory())), options: options);

    private static ValidationService CreateService(params string[] json) => CreateService(null, json);

    private static Dictionary<string, object?> Model(params (string Key, object? Value)[] values) => values.ToDictionary(v => v.Key, v => v.Value);

    private static string TwoExpressions(string a = "", string b = "") => $$"""
        { "Order": { "validators": [
          { "name": "expression"{{a}}, "context": { "expression": "model.a", "messageTemplate": "A" } },
          { "name": "expression"{{b}}, "context": { "expression": "model.b", "messageTemplate": "B" } }
        ] } }
        """;

    [Fact]
    public void RejectsTwoModelLevelRulesWithoutAnIdNamingTheKeyAndBothRules()
    {
        var service = CreateService(TwoExpressions());
        var ex = Assert.Throws<ValidationConfigurationException>(() => service.ValidateModel(Model(), "Order"));
        Assert.Contains("Model type 'Order'", ex.Message);
        Assert.Contains("'expression' (model-level: 'expression', model-level: 'expression')", ex.Message);
        // Every way in is checked, not only validation.
        Assert.Throws<ValidationConfigurationException>(() => service.HasAsyncValidators("Order"));
    }

    [Fact]
    public void TellsModelLevelRulesApartByIdAndPropertyRulesByGroupButNotById()
    {
        var withIds = CreateService(TwoExpressions(""", "id": "A" """, """, "id": "B" """));
        Assert.Equal(new[] { "expression_A", "expression_B" }, withIds.ValidateModel(Model(), "Order").Select(e => e.Key));

        // The key of a property rule has no id: both are 'expression_code'.
        var sameProperty = CreateService("""
            { "Order": { "properties": { "code": { "validators": [
              { "name": "expression", "id": "X", "context": { "expression": "model.code != 1" } },
              { "name": "expression", "id": "Y", "context": { "expression": "model.code != 2" } }
            ] } } } }
            """);
        var ex = Assert.Throws<ValidationConfigurationException>(() => sameProperty.ValidateModel(Model(), "Order"));
        Assert.Contains("'expression_code' (property 'code': 'expression' (id 'X'), property 'code': 'expression' (id 'Y'))", ex.Message);

        // Another group is another key.
        var grouped = CreateService("""
            { "Order": { "properties": { "code": { "validators": [
              { "name": "expression", "context": { "expression": "model.code != 1" } },
              { "group": "submit", "validators": [{ "name": "expression", "context": { "expression": "model.code != 2" } }] }
            ] } } } }
            """);
        Assert.Equal(new[] { "expression_code" }, grouped.ValidateModel(Model(("code", 1)), "Order").Select(e => e.Key));
        Assert.Equal(new[] { "expression_submit_code" }, grouped.ValidateModel(Model(("code", 2)), "Order").Select(e => e.Key));
    }

    [Fact]
    public void ComparesTheRulesAsTheyRunMergedMapsGlobalValidatorsExtendsAndFrom()
    {
        const string Required = """{ "Order": { "properties": { "code": { "validators": ["required"] } } } }""";
        // The same rule in two metadata maps, such as the server's and the client's.
        Assert.Contains("'required_code'", Assert.Throws<ValidationConfigurationException>(() => CreateService(Required, Required).ValidateModel(Model(), "Order")).Message);

        // A model's own rule repeating a global one.
        const string HasId = """{ "name": "expression", "id": "HAS_ID", "context": { "expression": "model.id" } }""";
        var global = CreateService($$"""{ "global": { "validators": [{{HasId}}] }, "Order": { "validators": [{{HasId}}] } }""");
        Assert.Contains("'expression_HAS_ID'", Assert.Throws<ValidationConfigurationException>(() => global.ValidateModel(Model(), "Order")).Message);

        // A derived type repeating its parent's property rule. The parent itself is fine.
        var extended = CreateService(Required, """{ "BigOrder": { "extends": "Order", "properties": { "code": { "validators": ["required"] } } } }""");
        Assert.Contains("'required_code'", Assert.Throws<ValidationConfigurationException>(() => extended.ValidateModel(Model(), "BigOrder")).Message);
        Assert.Equal(new[] { "required_code" }, extended.ValidateModel(Model(), "Order").Select(e => e.Key));

        // A property repeating a rule it inherits with `from`. `required: true` is fine: it adds the rule only if missing.
        var from = CreateService(Required, """{ "OrderEdit": { "properties": { "code": { "from": "Order", "validators": ["required"] } } } }""");
        Assert.Contains("'required_code'", Assert.Throws<ValidationConfigurationException>(() => from.ValidateModel(Model(), "OrderEdit")).Message);
        var shorthand = CreateService(Required, """{ "OrderEdit": { "properties": { "code": { "from": "Order", "required": true } } } }""");
        Assert.Equal(new[] { "required_code" }, shorthand.ValidateModel(Model(), "OrderEdit").Select(e => e.Key));
    }

    [Fact]
    public void LeavesTwoRulesThatBothHaveAConditionToTheValidationWhichReportsKeysThatDoClash()
    {
        static string Metadata(string a, string b) => $$"""
            { "Order": { "properties": { "code": { "validators": [{ "name": "required"{{a}} }, { "name": "required"{{b}} }] } } } }
            """;

        // A rule without a condition clashes whenever the other one applies.
        Assert.Throws<ValidationConfigurationException>(() => CreateService(Metadata("", """, "condition": "model.big" """)).ValidateModel(Model(), "Order"));

        var reported = new List<DuplicateErrorKeyInfo>();
        var service = CreateService(new ValidationServiceOptions { OnDuplicateErrorKey = reported.Add },
            Metadata(""", "condition": "model.big" """, """, "condition": "!model.small" """));
        // Only one applies: one error, nothing to report.
        Assert.Single(service.ValidateModel(Model(("big", true), ("small", true)), "Order"));
        Assert.Empty(reported);
        // Both apply: two errors with one key.
        var model = Model(("big", true), ("small", false));
        var errors = service.ValidateModel(model, "Order");
        Assert.Equal(new[] { "required_code", "required_code" }, errors.Select(e => e.Key));
        var info = Assert.Single(reported);
        Assert.Same(model, info.Model);
        Assert.Equal(("Order", "required_code"), (info.ModelType, info.Key));
        Assert.Equal(errors, info.Errors);
    }

    [Fact]
    public async Task ReportsAKeyThatTheDataAnnotationsShareWithAMetadataRuleAfterAsyncValidationToo()
    {
        // [Required] City reports required_city, and so does the metadata's required: two errors the metadata cannot show.
        var reported = new List<DuplicateErrorKeyInfo>();
        var service = CreateService(new ValidationServiceOptions { OnDuplicateErrorKey = reported.Add },
            """{ "global": { "validators": ["dataAnnotations"] }, "Address": { "properties": { "city": { "required": true } } } }""");
        var errors = await service.ValidateModelAsync(new DataAnnotationsValidatorTests.Address { Zipcode = "98101" });
        Assert.Equal(2, errors.Count(e => e.Key == "required_city"));
        var info = Assert.Single(reported);
        Assert.Equal(("Address", "required_city"), (info.ModelType, info.Key));
    }

    [Fact]
    public void WarnsOncePerModelTypeAndKeyByDefault()
    {
        var listener = new CapturingListener();
        Trace.Listeners.Add(listener);
        try
        {
            var service = CreateService("""
                { "WarnedOrder": { "properties": { "code": { "validators": [
                  { "name": "required", "condition": "true" }, { "name": "required", "condition": "true" }
                ] } } } }
                """);
            service.ValidateModel(Model(), "WarnedOrder");
            service.ValidateModel(Model(), "WarnedOrder");
            var warning = Assert.Single(listener.Messages, m => m.Contains("'WarnedOrder'"));
            Assert.Contains("2 errors about one 'WarnedOrder' share the key 'required_code'", warning);
        }
        finally
        {
            Trace.Listeners.Remove(listener);
        }
    }

    [Fact]
    public void ChecksAgainAfterTheMetadataChanges()
    {
        var service = CreateService(TwoExpressions());
        Assert.Throws<ValidationConfigurationException>(() => service.ValidateModel(Model(), "Order"));
        service.ValidationMetadata.SetMetadata(new[] { ModelValidationMetadataMap.Parse(TwoExpressions(""", "id": "A" """, """, "id": "B" """)) });
        Assert.Equal(2, service.ValidateModel(Model(), "Order").Count);
    }

    [Fact]
    public void ChecksATypeAgainWhenMetadataAddedLaterGivesItAClashingRule()
    {
        const string Required = """{ "Order": { "properties": { "code": { "validators": ["required"] } } } }""";
        var service = CreateService(Required);
        Assert.Equal(new[] { "required_code" }, service.ValidateModel(Model(), "Order").Select(e => e.Key));
        service.ValidationMetadata.AddMetadata(ModelValidationMetadataMap.Parse(Required));
        Assert.Contains("'required_code'", Assert.Throws<ValidationConfigurationException>(() => service.ValidateModel(Model(), "Order")).Message);
    }

    private sealed class CapturingListener : TraceListener
    {
        public List<string> Messages { get; } = new();
        public override void Write(string? message) { }
        public override void WriteLine(string? message) { if (message != null) lock (Messages) Messages.Add(message); }
    }
}
