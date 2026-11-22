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
            new[] { ("stringLength_zipcode", "Zipcode"), ("required_city", "City"), ("expression_stateId", "StateId") },
            errors.Select(e => (e.Key, e.PropertyNames.Single())));
        Assert.Equal(
            new[] { "The field Zipcode must be a string with a minimum length of 5 and a maximum length of 10.", "The City name field is required.", "StateId is required" },
            errors.Select(e => e.ErrorMessage));
    }

    [Fact]
    public void RunsIValidatableObjectAndPassesAValidModel()
    {
        var service = CreateService();
        Assert.Empty(service.ValidateModel(new Address { Zipcode = "98101", City = "Seattle", StateId = Guid.NewGuid() }));

        var error = Assert.Single(service.ValidateModel(new Address { Zipcode = "98101", City = "Nowhere", StateId = Guid.NewGuid() }));
        Assert.Equal(("validatableObject_city", "There is no such city"), (error.Key, error.ErrorMessage));
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
        Assert.Equal(new[] { "required_city" }, errors.Select(e => e.Key));
    }
}

/// <summary>Model-level rules that name the properties they are about.</summary>
public class PropertyNamesTests
{
    [Fact]
    public void AModelLevelRuleReportsThePropertiesItNames()
    {
        var service = new ValidationService(new ValidationMetadata(
            new[]
            {
                ModelValidationMetadataMap.Parse("""
                    {
                      "Booking": {
                        "validators": [
                          { "name": "expression", "id": "START_BEFORE_END", "propertyNames": ["startDate", "endDate"], "context": { "expression": "model.startDate < model.endDate", "messageTemplate": "Start must be before end" } },
                          { "name": "expression", "id": "MODEL_WIDE", "context": { "expression": "false", "messageTemplate": "Model-wide" } }
                        ],
                        "properties": { "note": { "required": true } }
                      }
                    }
                    """),
            },
            DefaultValidators.All));

        var errors = service.ValidateModel(new Dictionary<string, object?> { ["startDate"] = 5, ["endDate"] = 1, ["note"] = "" }, "Booking");

        Assert.Equal(
            new[] { "Start must be before end:startDate,endDate", "Model-wide:", "note is required:note" },
            errors.Select(e => $"{e.ErrorMessage}:{string.Join(",", e.PropertyNames)}"));
        Assert.True(errors[0].IsFor("endDate"));
        Assert.False(errors[1].IsFor("note"));
    }
}

/// <summary>Validators that report several errors at once, sync and async.</summary>
public class ManyErrorsTests
{
    private sealed class TwoErrorsAsync : AsyncValidator
    {
        public TwoErrorsAsync(string? group, ValidationContextBase? context) : base("twoErrors", group, context) { }

        protected override Task<bool> ValidateCoreAsync(object? value, ValidatorFunctionContext context, CancellationToken cancellationToken) => Task.FromResult(true);

        public override Task<IReadOnlyList<ValidationError>> ValidateAsync(object? value, ValidationContext? context = null, CancellationToken cancellationToken = default)
        {
            ValidationError Error(string property)
            {
                var ctx = GetValidatorFunctionContext(value, context);
                ctx.PropertyName = property;
                ctx.MessageTemplate = $"{property} is wrong";
                return new ValidationError($"twoErrors_{property}", ctx, this);
            }
            return Task.FromResult<IReadOnlyList<ValidationError>>(new[] { Error("a"), Error("b") });
        }
    }

    [Fact]
    public async Task AnAsyncValidatorCanReportSeveralErrors()
    {
        var service = new ValidationService(new ValidationMetadata(
            new[] { ModelValidationMetadataMap.Parse("""{ "T": { "validators": [{ "name": "twoErrors", "async": true }] } }""") },
            DefaultValidators.All.Append(new ValidatorFactory("twoErrors", (g, c) => new TwoErrorsAsync(g, c)))));

        var errors = await service.ValidateModelAsync(new Dictionary<string, object?>(), "T");
        Assert.Equal(new[] { "a is wrong", "b is wrong" }, errors.Select(e => e.ErrorMessage));
    }
}
