using IdeaBlade.Validation.Metadata;
using IdeaBlade.Validation.Validators;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace IdeaBlade.Validation.Tests;

public class Person
{
    public int? Id { get; set; } = 1;
    public string? FirstName { get; set; } = "Ann";
    public string? Email { get; set; } = "ann@example.com";
    public int Age { get; set; } = 40;
    public string Country { get; set; } = "US";
    public string? Phone { get; set; } = "555-123-4567";
}

public class Employee : Person
{
    public string? EmployeeNo { get; set; }
    public DateTime StartDate { get; set; } = new DateTime(2024, 1, 1);
    public DateTime? EndDate { get; set; }
}

public class ValidationServiceTests
{
    private static readonly string SamplePath = Path.Combine(AppContext.BaseDirectory, "TestData", "sample.validation.metadata.json");

    private static ValidationService CreateService(ModelValidationMetadataMap? map = null, IEnumerable<ValidatorFactory>? validators = null,
        IEnumerable<IValidatorContextProvider>? providers = null, ValidationServiceOptions? options = null)
    {
        var metadata = new ValidationMetadata(new[] { map ?? ModelValidationMetadataMap.LoadFile(SamplePath) }, DefaultValidators.All.Concat(validators ?? Array.Empty<ValidatorFactory>()));
        return new ValidationService(metadata, providers, options);
    }

    [Fact]
    public void LoadsSampleMetadataFile()
    {
        var map = ModelValidationMetadataMap.LoadFile(SamplePath);
        Assert.NotNull(map.Global);
        Assert.Equal(new[] { "Person", "Employee" }, map.Models.Keys);
        Assert.Equal("Person", map.Models["Employee"].Extends);
        var group = Assert.IsType<ValidatorGroupConfig>(map.Models["Employee"].Properties["employeeNo"].Validators.Single());
        Assert.Equal("hire", group.Group);
    }

    [Fact]
    public void ValidModelHasNoErrors() => Assert.Empty(CreateService().ValidateModel(new Person()));

    [Fact]
    public void RunsShorthandValidatorsAndFormatsMessages()
    {
        var errors = CreateService().ValidateModel(new Person { FirstName = "" });
        var error = Assert.Single(errors);
        Assert.Equal("First name is required", error.ErrorMessage);
        Assert.Equal("required_firstName", error.Key);
        Assert.Equal("REQUIRED", error.Id);
        Assert.Equal(new[] { "FirstName" }, error.PropertyNames);
        Assert.Equal(new[] { "firstName" }, error.MetadataPropertyNames);
    }

    [Fact]
    public void MaxLengthMessageUsesContext()
    {
        var error = Assert.Single(CreateService().ValidateModel(new Person { FirstName = "Bartholomew-Jones" }));
        Assert.Equal("First name must be at most 10 characters", error.ErrorMessage);
    }

    [Fact]
    public void GlobalValidatorsRunForUnknownTypes()
    {
        var error = Assert.Single(CreateService().ValidateModel(new Dictionary<string, object?>(), "Unknown"));
        Assert.Equal("HAS_ID", error.Id);
    }

    [Fact]
    public void HonoursConditions()
    {
        var service = CreateService();
        Assert.Empty(service.ValidateModel(new Person { Country = "CA", Phone = "x" }));
        Assert.Equal("phone_phone", Assert.Single(service.ValidateModel(new Person { Phone = "x" })).Key);
    }

    [Fact]
    public void InheritsThroughExtendsWithoutDuplicatingGlobals()
    {
        var errors = CreateService().ValidateModel(new Employee { Id = null, FirstName = "", StartDate = new DateTime(2024, 2, 1), EndDate = new DateTime(2023, 2, 1) });
        Assert.Equal(new[] { "Employee # is required", "End must follow start", "First name is required", "Missing id" }, errors.Select(e => e.ErrorMessage).OrderBy(m => m, StringComparer.Ordinal));
    }

    [Fact]
    public void FiltersByGroup()
    {
        var service = CreateService();
        var employee = new Employee();
        Assert.Single(service.ValidateModel(employee));
        Assert.Equal("required_hire_employeeNo", Assert.Single(service.ValidateModel(employee, new ValidationOptions { Predicate = (v, p) => v.Group == "hire" })).Key);
        Assert.Empty(service.ValidateModel(employee, new ValidationOptions { Predicate = (v, p) => v.Group == null }));
    }

    [Fact]
    public void UnknownValidatorIsConfigurationError()
    {
        var service = CreateService(ModelValidationMetadataMap.Parse("{\"X\": {\"validators\": [\"nope\"]}}"));
        Assert.Throws<ValidationConfigurationException>(() => service.ValidateModel(new object(), "X"));
    }

    [Fact]
    public void FailingConditionIsConfigurationError()
    {
        var service = CreateService(ModelValidationMetadataMap.Parse("{\"X\": {\"validators\": [{\"name\": \"required\", \"condition\": \"model.a.b\"}]}}"));
        var ex = Assert.Throws<ValidationConfigurationException>(() => service.ValidateModel(new Dictionary<string, object?>(), "X"));
        Assert.Contains("Condition 'model.a.b' failed", ex.Message);
    }

    [Fact]
    public void CircularExtendsIsConfigurationError()
    {
        var service = CreateService(ModelValidationMetadataMap.Parse("{\"A\": {\"extends\": \"B\"}, \"B\": {\"extends\": \"A\"}}"));
        Assert.Throws<ValidationConfigurationException>(() => service.ValidateModel(new object(), "A"));
    }

    [Fact]
    public void MergesMultipleMaps()
    {
        var metadata = new ValidationMetadata(new[]
        {
            ModelValidationMetadataMap.Parse("{\"X\": {\"properties\": {\"a\": {\"required\": true}}}}"),
            ModelValidationMetadataMap.Parse("{\"X\": {\"properties\": {\"a\": {\"displayName\": \"A\"}, \"b\": {\"required\": true}}}}"),
        }, DefaultValidators.All);
        var errors = new ValidationService(metadata).ValidateModel(new Dictionary<string, object?>(), "X");
        Assert.Equal(new[] { "A is required", "b is required" }, errors.Select(e => e.ErrorMessage));
    }

    [Fact]
    public void ExceptionsBecomeValidationErrors()
    {
        var service = CreateService(ModelValidationMetadataMap.Parse("{\"X\": {\"validators\": [\"boom\"]}}"),
            new[] { ValidatorFactory.Sync("boom", (v, c) => throw new InvalidOperationException("kaboom")) });
        var error = Assert.Single(service.ValidateModel(new object(), "X"));
        Assert.Equal("kaboom", error.Context.Exception!.Message);
    }

    private sealed class TenantProvider : IValidatorContextProvider
    {
        public IDictionary<string, object?> GetContext(object model, string modelType) => new Dictionary<string, object?> { ["tenant"] = "acme" };
    }

    [Fact]
    public void MergesContextProvidersAndOptions()
    {
        var service = CreateService(ModelValidationMetadataMap.Parse("{\"X\": {\"properties\": {\"a\": {\"validators\": [\"ctx\"]}}}}"),
            new[] { ValidatorFactory.Sync("ctx", (v, c) => c.GetValue<string>("tenant") == "acme" && c.GetValue<string>("user") == "bob") },
            new[] { new TenantProvider() });
        Assert.Empty(service.ValidateModel(new Dictionary<string, object?> { ["a"] = 1 }, "X", new ValidationOptions { Context = new Dictionary<string, object?> { ["user"] = "bob" } }));
    }

    [Fact]
    public void ExpressionScopeFunctionsAreAvailable()
    {
        var options = new ValidationServiceOptions();
        options.ExpressionScope["isKnown"] = new Func<string, bool>(v => v == "A");
        var service = CreateService(ModelValidationMetadataMap.Parse("{\"X\": {\"properties\": {\"code\": {\"validators\": [{\"name\": \"expression\", \"context\": {\"expression\": \"isKnown(value)\"}}]}}}}"), options: options);
        Assert.Empty(service.ValidateModel(new Dictionary<string, object?> { ["code"] = "A" }, "X"));
        Assert.Single(service.ValidateModel(new Dictionary<string, object?> { ["code"] = "B" }, "X"));
    }

    [Fact]
    public async Task RunsAsyncValidators()
    {
        var calls = 0;
        var service = CreateService(ModelValidationMetadataMap.Parse("{\"User\": {\"properties\": {\"login\": {\"required\": true, \"validators\": [{\"name\": \"available\", \"async\": true}]}}}}"),
            new[] { ValidatorFactory.Async("available", async (v, c, ct) => { calls++; await Task.Delay(5, ct); return (string?)v != "taken"; }, "%displayName% is taken") });
        var errors = await service.ValidateModelAsync(new Dictionary<string, object?> { ["login"] = "taken" }, "User", cancellationToken: TestContext.Current.CancellationToken);
        Assert.Equal("login is taken", Assert.Single(errors).ErrorMessage);
        Assert.Equal(1, calls);
        Assert.True(service.HasAsyncValidators("User"));
    }

    [Fact]
    public async Task AsyncFailuresBecomeErrors()
    {
        var service = CreateService(ModelValidationMetadataMap.Parse("{\"X\": {\"properties\": {\"a\": {\"validators\": [{\"name\": \"p\", \"async\": true}]}}}}"),
            new[] { ValidatorFactory.Async("p", (v, c, ct) => (string?)v == "bad" ? Task.FromException<bool>(new Exception("down")) : Task.FromResult(true)) });
        Assert.Empty(await service.ValidateModelAsync(new Dictionary<string, object?> { ["a"] = "ok" }, "X", cancellationToken: TestContext.Current.CancellationToken));
        Assert.Single(await service.ValidateModelAsync(new Dictionary<string, object?> { ["a"] = "bad" }, "X", cancellationToken: TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task TimesOutSlowAsyncValidators()
    {
        var timedOut = 0;
        var options = new ValidationServiceOptions { AsyncTimeout = TimeSpan.FromMilliseconds(20), OnAsyncTimeout = (m, t, d) => timedOut++ };
        var service = CreateService(ModelValidationMetadataMap.Parse("{\"X\": {\"properties\": {\"a\": {\"validators\": [{\"name\": \"slow\", \"async\": true}]}}}}"),
            new[] { ValidatorFactory.Async("slow", async (v, c, ct) => { await Task.Delay(2000, ct); return false; }) }, options: options);
        Assert.Empty(await service.ValidateModelAsync(new Dictionary<string, object?> { ["a"] = 1 }, "X", cancellationToken: TestContext.Current.CancellationToken));
        Assert.Equal(1, timedOut);
    }

    [Fact]
    public async Task ValidateModelAsyncRunsSyncAndAsyncAndKeepsSyncErrorsOnTimeout()
    {
        var map = ModelValidationMetadataMap.Parse("{\"X\": {\"properties\": {\"a\": {\"required\": true, \"validators\": [{\"name\": \"slow\", \"async\": true}]}}}}");
        var fast = CreateService(map, new[] { ValidatorFactory.Async("slow", (v, c, ct) => Task.FromResult(!Equals(v, "taken")), "%displayName% is taken") });
        var ct = TestContext.Current.CancellationToken;
        Assert.Equal(new[] { "required_a" }, (await fast.ValidateModelAsync(new Dictionary<string, object?> { ["a"] = "" }, "X", cancellationToken: ct)).Select(e => e.Key));
        Assert.Equal(new[] { "slow_a" }, (await fast.ValidateModelAsync(new Dictionary<string, object?> { ["a"] = "taken" }, "X", cancellationToken: ct)).Select(e => e.Key));

        var slow = CreateService(map,
            new[] { ValidatorFactory.Async("slow", async (v, c, t) => { await Task.Delay(2000, t); return false; }) },
            options: new ValidationServiceOptions { AsyncTimeout = TimeSpan.FromMilliseconds(20) });
        Assert.Equal(new[] { "required_a" }, (await slow.ValidateModelAsync(new Dictionary<string, object?> { ["a"] = "" }, "X", cancellationToken: ct)).Select(e => e.Key));
    }

    public class Order { public int Id { get; set; } public string? Number { get; set; } public bool IsArchived { get; set; } }
    public class OrderLine { public int Id { get; set; } public int OrderId { get; set; } }

    [Fact]
    public async Task ValidatesEntitiesWithStoreAndFindEntity()
    {
        var map = ModelValidationMetadataMap.Parse(@"{
          ""Order"": {
            ""condition"": ""!model.isArchived"",
            ""properties"": { ""number"": { ""required"": true, ""validators"": [""unique""] } },
            ""validators"": [{ ""name"": ""expression"", ""context"": { ""expression"": ""store('OrderLine').some(l => l.orderId === model.id)"", ""messageTemplate"": ""Order %model.number% has no lines"" } }]
          },
          ""OrderLine"": { ""condition"": ""findEntity(model.orderId, 'Order') != null"" }
        }");
        var service = CreateService(map);
        var entities = new object[]
        {
            new Order { Id = 1, Number = "A" },
            new Order { Id = 2, Number = "A" },
            new Order { Id = 3, Number = "", IsArchived = true },
            new OrderLine { Id = 10, OrderId = 1 },
        };
        var errors = await service.ValidateEntitiesAsync(entities, cancellationToken: TestContext.Current.CancellationToken);
        Assert.Equal(new[] { "Number must be unique", "Number must be unique", "Order A has no lines" }, errors.Select(e => e.ErrorMessage).OrderBy(m => m, StringComparer.Ordinal));
    }

    [Fact]
    public void RegistersWithDependencyInjection()
    {
        var services = new ServiceCollection();
        services.AddIdeaBladeValidation(v => v
            .AddMetadataFile(SamplePath)
            .AddMetadataJson("{\"Widget\": {\"properties\": {\"code\": {\"validators\": [\"isSku\"]}}}}")
            .AddValidators(ValidatorFactory.Sync("isSku", (value, ctx) => value is string s && s.StartsWith("SKU", StringComparison.Ordinal)))
            .AddExpressionFunction("double", new Func<double, double>(x => x * 2))
            .AddContextProvider<TenantProvider>()
            .Configure(o => o.AsyncTimeout = TimeSpan.FromSeconds(5)));
        using var provider = services.BuildServiceProvider();
        using var scope = provider.CreateScope();
        var service = scope.ServiceProvider.GetRequiredService<ValidationService>();
        Assert.Single(service.ValidateModel(new Person { FirstName = null }));
        Assert.Equal(new[] { "isSku_code" }, service.ValidateModel(new Dictionary<string, object?> { ["id"] = 1, ["code"] = "X" }, "Widget").Select(e => e.Key));
        Assert.Same(scope.ServiceProvider.GetRequiredService<ValidationMetadata>(), provider.GetRequiredService<ValidationMetadata>());
    }
}

public class DefaultValidatorTests
{
    private static readonly ValidationService Service = new ValidationService(new ValidationMetadata(new[]
    {
        ModelValidationMetadataMap.Parse(@"{
          ""T"": { ""properties"": {
            ""ssn"": { ""validators"": [""social""] },
            ""fein"": { ""validators"": [""fein""] },
            ""zip"": { ""validators"": [""zipCode""] },
            ""email"": { ""validators"": [""email""] },
            ""amount"": { ""validators"": [""currency""] },
            ""count"": { ""validators"": [""numeric""] },
            ""code"": { ""validators"": [{ ""name"": ""numeric"", ""context"": { ""allowLeadingZeros"": true } }] },
            ""price"": { ""validators"": [{ ""name"": ""numeric"", ""context"": { ""allowDecimals"": true } }] },
            ""int"": { ""validators"": [""integer""] },
            ""dob"": { ""validators"": [{ ""name"": ""dateRange"", ""context"": { ""minValue"": ""now-150y"", ""maxValue"": ""today"" } }] },
            ""when"": { ""validators"": [""date""] },
            ""end"": { ""validators"": [{ ""name"": ""compare"", ""context"": { ""other"": ""start"", ""op"": "">="" } }] },
            ""state"": { ""validators"": [{ ""name"": ""invalidValues"", ""context"": { ""values"": [""XX"", ""/^Z/""] } }] },
            ""color"": { ""validators"": [{ ""name"": ""validValues"", ""context"": { ""values"": [""red"", ""green""] } }] },
            ""sku"": { ""validators"": [{ ""name"": ""pattern"", ""context"": { ""expression"": ""^[A-Z]{3}-\\d+$"" } }] },
            ""tags"": { ""required"": true, ""minLength"": 1 }
          } }
        }"),
    }, DefaultValidators.All));

    private static IEnumerable<string?> Fails(string property, object? value)
    {
        var model = new Dictionary<string, object?> { ["tags"] = new List<string> { "a" }, [property] = value };
        return Service.ValidateModel(model, "T").Select(e => e.PropertyNames.FirstOrDefault());
    }

    public static TheoryData<string, object?, bool> Cases => new TheoryData<string, object?, bool>
    {
        { "ssn", "123-45-6789", true },
        { "ssn", "123456789", true },
        { "ssn", "123-45-6789x", false },
        { "ssn", "x123456789", false },
        { "fein", "12-3456789", true },
        { "fein", "123456789", false },
        { "zip", "94612", true },
        { "zip", "94612-1234", true },
        { "zip", "9461", false },
        { "email", "a.b+c@example.co.uk", true },
        { "email", "not-an-email", false },
        { "amount", "1,234.56", true },
        { "amount", 12.5m, true },
        { "amount", "12.345", false },
        { "count", "0", true },
        { "count", "10", true },
        { "count", "010", false },
        { "count", "1abc", false },
        { "count", 1.5, false },
        { "code", "007", true },
        { "price", "3.14", true },
        { "price", 3.14, true },
        { "int", -3, true },
        { "int", "2.5", false },
        { "dob", new DateTime(2000, 1, 1), true },
        { "dob", DateTime.Now.AddDays(2), false },
        { "when", "not a date", false },
        { "when", new DateTime(2020, 1, 1), true },
        { "state", "CA", true },
        { "state", "XX", false },
        { "state", "ZZ", false },
        { "color", "red", true },
        { "color", "blue", false },
        { "sku", "ABC-12", true },
        { "sku", "abc-12", false },
    };

    [Theory]
    [MemberData(nameof(Cases))]
    public void Validates(string property, object? value, bool valid)
    {
        Assert.Equal(valid ? Array.Empty<string>() : new[] { property }, Fails(property, value));
    }

    [Fact]
    public void CompareUsesOtherProperty()
    {
        var model = new Dictionary<string, object?> { ["tags"] = new List<string> { "a" }, ["start"] = 5, ["end"] = 4 };
        Assert.Equal(new[] { "end" }, Service.ValidateModel(model, "T").Select(e => e.PropertyNames.Single()));
        model["start"] = new DateTime(2020, 1, 1);
        model["end"] = new DateTime(2021, 1, 1);
        Assert.Empty(Service.ValidateModel(model, "T"));
    }

    [Fact]
    public void RequiredHandlesEmptyCollections()
    {
        var model = new Dictionary<string, object?> { ["tags"] = new List<string>() };
        Assert.Equal(new[] { "tags" }, Service.ValidateModel(model, "T").Select(e => e.PropertyNames.Single()));
    }

    [Fact]
    public void RangeFormatsBounds()
    {
        var service = new ValidationService(new ValidationMetadata(new[] { ModelValidationMetadataMap.Parse("{\"T\": {\"properties\": {\"n\": {\"displayName\": \"N\", \"validators\": [{\"name\": \"range\", \"context\": {\"minValue\": 1, \"maxValue\": 5}}]}}}}") }, DefaultValidators.All));
        Assert.Equal("N must be between 1 and 5", Assert.Single(service.ValidateModel(new Dictionary<string, object?> { ["n"] = 9 }, "T")).ErrorMessage);
    }

    [Fact]
    public void ResolvesRelativeBounds()
    {
        var now = new DateTime(2024, 6, 15, 12, 30, 0);
        Assert.Equal(5d, RangeBounds.Resolve(5, now));
        Assert.Equal(5d, RangeBounds.Resolve("5", now));
        Assert.Equal(2024d, RangeBounds.Resolve("year", now));
        Assert.Equal(2025d, RangeBounds.Resolve("year+1", now));
        Assert.Equal(2024d - 150, RangeBounds.Resolve("year-200", now));
        Assert.Equal(2006, ((DateTime)RangeBounds.Resolve("now-18y", now)!).Year);
        Assert.Equal(2004, ((DateTime)RangeBounds.Resolve("Now-20", now)!).Year);
        Assert.Equal(new DateTime(2024, 6, 16), RangeBounds.Resolve("today+1d", now));
        Assert.Equal(8, ((DateTime)RangeBounds.Resolve("now+2M", now)!).Month);
        Assert.Equal(0, ((DateTime)RangeBounds.Resolve("now-30m", now)!).Minute);
    }
}
