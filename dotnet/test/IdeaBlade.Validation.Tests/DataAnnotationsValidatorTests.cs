using System.ComponentModel.DataAnnotations;
using IdeaBlade.Validation.Metadata;
using IdeaBlade.Validation.Validators;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace IdeaBlade.Validation.Tests;

/// <summary>Data annotations as a model-level validator: the server's counterpart of the client's <c>breeze</c> validator.</summary>
public class DataAnnotationsValidatorTests
{
    public class Address : IValidatableObject
    {
        [Required]
        [StringLength(10, MinimumLength = 5)]
        public string? Zipcode { get; set; }

        [Required]
        [Display(Name = "City name")]
        public string? City { get; set; }

        public Guid StateId { get; set; }

        public IEnumerable<ValidationResult> Validate(System.ComponentModel.DataAnnotations.ValidationContext validationContext) =>
            City == "Nowhere" ? new[] { new ValidationResult("There is no such city", new[] { nameof(City) }) } : Array.Empty<ValidationResult>();
    }

    private const string Metadata = """
        {
          "global": { "validators": ["dataAnnotations"] },
          "Address": { "properties": { "stateId": { "validators": [{ "name": "expression", "context": { "expression": "value !== '00000000-0000-0000-0000-000000000000'", "messageTemplate": "%displayName% is required" } }] } } }
        }
        """;

    private static ValidationService CreateService(string metadata = Metadata) =>
        new(new ValidationMetadata(new[] { ModelValidationMetadataMap.Parse(metadata) }, DefaultValidators.All.Append(DataAnnotationsValidator.Factory())));

    [Fact]
    public void ReportsEachFailedAnnotationAsAFrameworkErrorNextToTheMetadataRules()
    {
        var errors = CreateService().ValidateModel(new Address { Zipcode = "123" });

        Assert.Equal(
            new[] { ("stringLength_Zipcode", "Zipcode"), ("required_City", "City"), ("expression_stateId", "stateId") },
            errors.Select(e => (e.Key, e.PropertyName)));
        Assert.Equal(
            new[] { "The field Zipcode must be a string with a minimum length of 5 and a maximum length of 10.", "The City name field is required.", "stateId is required" },
            errors.Select(e => e.ErrorMessage));
    }

    [Fact]
    public void RunsIValidatableObjectAndPassesAValidModel()
    {
        var service = CreateService();
        Assert.Empty(service.ValidateModel(new Address { Zipcode = "98101", City = "Seattle", StateId = Guid.NewGuid() }));

        var error = Assert.Single(service.ValidateModel(new Address { Zipcode = "98101", City = "Nowhere", StateId = Guid.NewGuid() }));
        Assert.Equal(("validatableObject_City", "There is no such city"), (error.Key, error.ErrorMessage));
    }

    [Fact]
    public void RegistersUnderTheClientsBreezeName()
    {
        var services = new ServiceCollection();
        services.AddIdeaBladeValidation(v => v
            .AddMetadataJson("""{ "global": { "validators": ["breeze"] } }""")
            .AddDataAnnotations("breeze"));
        using var provider = services.BuildServiceProvider();
        using var scope = provider.CreateScope();
        var service = scope.ServiceProvider.GetRequiredService<ValidationService>();

        var errors = service.ValidateModel(new Address { Zipcode = "98101" });
        Assert.Equal(new[] { "breeze" }, errors.Select(e => e.Validator.Name).Distinct());
        Assert.Equal(new[] { "required_City" }, errors.Select(e => e.Key));
    }
}
