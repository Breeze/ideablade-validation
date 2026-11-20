using IdeaBlade.Validation.Metadata;
using IdeaBlade.Validation.Validators;
using Xunit;

namespace IdeaBlade.Validation.Tests;

/// <summary>
/// <c>$schema</c> points editors at the schema, and <c>$comment</c> explains the rules to whoever maintains them.
/// Neither is a rule: the metadata may carry them at the top and in every object, and validating ignores them.
/// </summary>
public class MetadataCommentTests
{
    private const string Metadata = """
        {
          "$schema": "../node_modules/@ideablade/validation/schema/validation-metadata.schema.json",
          "$comment": ["The rules for people.", "A second paragraph."],
          "global": {
            "$comment": "Every model has an id.",
            "validators": [{ "$comment": "id", "name": "expression", "context": { "expression": "model.id != null", "messageTemplate": "Missing id" } }]
          },
          "Person": {
            "$comment": "A person.",
            "validators": [{ "$comment": "Only during hiring.", "group": "hire", "validators": ["required"] }],
            "properties": {
              "firstName": { "$comment": "As on the passport.", "required": true }
            }
          }
        }
        """;

    [Fact]
    public void TheyAreNotModelTypes()
    {
        var map = ModelValidationMetadataMap.Parse(Metadata);

        Assert.Equal(new[] { "Person" }, map.Models.Keys);
    }

    [Fact]
    public void TheyChangeNothingAboutValidation()
    {
        var service = new ValidationService(new ValidationMetadata(
            new[] { ModelValidationMetadataMap.Parse(Metadata) }, DefaultValidators.All));
        var options = new ValidationOptions { Predicate = (v, _) => v.Group == null };

        Assert.Empty(service.ValidateModel(new Dictionary<string, object?> { ["id"] = 1, ["firstName"] = "Ann" }, "Person", options));
        Assert.Equal(
            new[] { "Missing id", "firstName is required" },
            service.ValidateModel(new Dictionary<string, object?> { ["firstName"] = "" }, "Person", options).Select(e => e.ErrorMessage).OrderBy(m => m, StringComparer.Ordinal));
    }
}
