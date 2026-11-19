using System.ComponentModel.DataAnnotations;
using IdeaBlade.Validation.Metadata;
using IdeaBlade.Validation.Validators;
using Xunit;

namespace IdeaBlade.Validation.Tests;

/// <summary>
/// The metadata names properties in camelCase, for every platform; CLR objects name them in PascalCase. The naming
/// convention translates between the two: values are read from the CLR property, and errors report the CLR names,
/// while everything inside the metadata (keys, <c>propertyNames</c>, expressions) keeps the metadata's.
/// </summary>
public class NamingConventionTests
{
    public class Booking
    {
        public string? GuestName { get; set; }
        public DateTime StartDate { get; set; }
        public DateTime EndDate { get; set; }

        [Required]
        public string? RoomNumber { get; set; }
    }

    private const string Metadata = """
        {
          "global": { "validators": ["dataAnnotations"] },
          "Booking": {
            "validators": [{
              "name": "expression",
              "propertyNames": ["startDate", "endDate"],
              "context": { "expression": "model.startDate < model.endDate", "messageTemplate": "The stay must end after it starts" }
            }],
            "properties": { "guestName": { "required": true } }
          }
        }
        """;

    private static ValidationService Service(string metadata = Metadata, NamingConvention? convention = null)
    {
        var validationMetadata = new ValidationMetadata(
            new[] { ModelValidationMetadataMap.Parse(metadata) },
            DefaultValidators.All.Append(DataAnnotationsValidator.Factory()));
        var options = new ValidationServiceOptions();
        if (convention != null) options.NamingConvention = convention;
        return new ValidationService(validationMetadata, options: options);
    }

    private static Booking Invalid() =>
        new() { GuestName = "", StartDate = new DateTime(2026, 5, 2), EndDate = new DateTime(2026, 5, 1) };

    [Fact]
    public void CamelCaseIsTheDefault_AndTranslatesBothWays()
    {
        Assert.Same(NamingConvention.CamelCase, new ValidationServiceOptions().NamingConvention);
        Assert.Equal("GuestName", NamingConvention.CamelCase.ToModelName("guestName"));
        Assert.Equal("guestName", NamingConvention.CamelCase.ToMetadataName("GuestName"));
        Assert.Equal("guestName", NamingConvention.None.ToModelName("guestName"));
    }

    [Fact]
    public void ErrorsReportTheModelsNames_KeysStayTheMetadatas()
    {
        var errors = Service().ValidateModel(Invalid());

        Assert.Equal(
            new[]
            {
                ("expression", new[] { "StartDate", "EndDate" }, new[] { "startDate", "endDate" }),
                ("required_roomNumber", new[] { "RoomNumber" }, new[] { "roomNumber" }),
                ("required_guestName", new[] { "GuestName" }, new[] { "guestName" }),
            }.Select(e => (e.Item1, string.Join(",", e.Item2), string.Join(",", e.Item3))).OrderBy(e => e.Item1),
            errors.Select(e => (e.Key, string.Join(",", e.PropertyNames), string.Join(",", e.MetadataPropertyNames))).OrderBy(e => e.Key));

        var guestName = errors.Single(e => e.Key == "required_guestName");
        Assert.True(guestName.IsFor("GuestName"));
        Assert.Equal("GuestName is required", guestName.ErrorMessage);
    }

    [Fact]
    public void ValuesAreReadFromTheModelsProperty()
    {
        var errors = Service().ValidateModel(new Booking { GuestName = "Ann", RoomNumber = "12", StartDate = new DateTime(2026, 5, 1), EndDate = new DateTime(2026, 5, 2) });

        Assert.Empty(errors);
    }

    [Fact]
    public void AModelWithoutClrPropertiesKeepsTheMetadatasNames()
    {
        var errors = Service("""{ "Guest": { "properties": { "guestName": { "required": true } } } }""")
            .ValidateModel(new Dictionary<string, object?> { ["guestName"] = "" }, "Guest");

        var error = Assert.Single(errors);
        Assert.Equal(new[] { "guestName" }, error.PropertyNames);
        Assert.Equal("guestName is required", error.ErrorMessage);
    }

    [Fact]
    public void WithNoneTheMetadataUsesTheModelsNames()
    {
        var service = Service("""{ "Booking": { "properties": { "GuestName": { "required": true } } } }""", NamingConvention.None);

        var error = Assert.Single(service.ValidateModel(new Booking { GuestName = "", RoomNumber = "12" }));

        Assert.Equal("required_GuestName", error.Key);
        Assert.Equal(new[] { "GuestName" }, error.PropertyNames);
    }

    [Fact]
    public void ACustomConventionTranslatesOtherNames()
    {
        // snake_case metadata over PascalCase CLR properties.
        static string ToPascal(string snake) => string.Concat(snake.Split('_').Select(w => char.ToUpperInvariant(w[0]) + w.Substring(1)));
        static string ToSnake(string pascal) => string.Concat(pascal.Select((c, i) => char.IsUpper(c) ? (i > 0 ? "_" : "") + char.ToLowerInvariant(c) : c.ToString()));
        var snakeCase = new NamingConvention("snake_case", ToPascal, ToSnake);
        var service = Service("""{ "Booking": { "properties": { "guest_name": { "required": true } } } }""", snakeCase);

        Assert.Empty(service.ValidateModel(new Booking { GuestName = "Ann", RoomNumber = "12" }));
        var error = Assert.Single(service.ValidateModel(new Booking { GuestName = "", RoomNumber = "12" }));
        Assert.Equal("required_guest_name", error.Key);
        Assert.Equal(new[] { "GuestName" }, error.PropertyNames);
        Assert.Equal(new[] { "guest_name" }, error.MetadataPropertyNames);
    }
}
