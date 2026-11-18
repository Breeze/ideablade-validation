using System.Text.Json;
using IdeaBlade.Validation.Expressions;
using Xunit;

namespace IdeaBlade.Validation.Tests;

/// <summary>Runs spec/expression-conformance.json, shared with the TypeScript test suite.</summary>
public class ExpressionConformanceTests
{
    private static readonly JsonDocument Spec = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "spec", "expression-conformance.json")));

    public static TheoryData<int, string> Cases()
    {
        var data = new TheoryData<int, string>();
        var i = 0;
        foreach (var c in Spec.RootElement.GetProperty("cases").EnumerateArray())
        {
            data.Add(i++, c.GetProperty("expr").GetString()!);
        }
        return data;
    }

    private static Dictionary<string, object?> Scope() =>
        (Dictionary<string, object?>)JsRuntime.FromJson(Spec.RootElement.GetProperty("scope"))!;

    [Theory]
    [MemberData(nameof(Cases))]
    public void Conformance(int index, string expr)
    {
        var c = Spec.RootElement.GetProperty("cases")[index];
        var evaluator = new SafeExpressionEvaluator();
        var scope = Scope();

        if (c.TryGetProperty("error", out var error))
        {
            if (error.GetString() == "syntax")
            {
                Assert.Throws<ExpressionSyntaxException>(() => evaluator.Evaluate(expr, scope));
                Assert.False(SafeExpressionEvaluator.TryValidate(expr, out _));
            }
            else
            {
                Assert.True(SafeExpressionEvaluator.TryValidate(expr, out var syntaxError), syntaxError?.Message);
                Assert.Throws<ExpressionEvaluationException>(() => evaluator.Evaluate(expr, scope));
            }
            return;
        }

        var result = evaluator.Evaluate(expr, scope);
        var expected = c.GetProperty("expected");
        switch (expected.ValueKind)
        {
            case JsonValueKind.Null: Assert.Null(result); break;
            case JsonValueKind.True: Assert.Equal(true, result); break;
            case JsonValueKind.False: Assert.Equal(false, result); break;
            case JsonValueKind.String: Assert.Equal(expected.GetString(), result); break;
            case JsonValueKind.Number: Assert.Equal(expected.GetDouble(), Convert.ToDouble(result), 9); break;
            default: throw new InvalidOperationException("Unsupported expected value");
        }
    }

    [Fact]
    public void CallsTrustedScopeFunctions()
    {
        var calls = new List<string>();
        Func<string, IEnumerable<object>> store = type =>
        {
            calls.Add(type);
            return new object[] { new Dictionary<string, object?> { ["relatedEntityId"] = 1, ["key"] = "Color" } };
        };
        var result = new SafeExpressionEvaluator().Evaluate(
            "store('CustomValue').find(e => e.relatedEntityId === model.id && e.key.toLowerCase() === 'color') != null",
            new Dictionary<string, object?> { ["store"] = store, ["model"] = new { Id = 1 } });
        Assert.Equal(true, result);
        Assert.Equal(new[] { "CustomValue" }, calls);
    }

    private sealed class Entity
    {
        public int Deleted;
        public string FirstName { get; set; } = "Ann";
        public object GetProperty(string name) => name == "x" ? 42 : "?";
        public void SetDeleted() => Deleted++;
    }

    [Fact]
    public void ReadsPocoPropertiesCamelCase()
    {
        Assert.Equal("Ann", new SafeExpressionEvaluator().Evaluate("model.firstName", new Dictionary<string, object?> { ["model"] = new Entity() }));
    }

    [Fact]
    public void BlocksMethodsOnObjectsUnlessAllowed()
    {
        var entity = new Entity();
        var scope = new Dictionary<string, object?> { ["model"] = entity };
        Assert.Throws<ExpressionEvaluationException>(() => new SafeExpressionEvaluator().Evaluate("model.getProperty('x')", scope));

        var options = new SafeExpressionEvaluatorOptions();
        options.AllowedMethods.Add("getProperty");
        var allowed = new SafeExpressionEvaluator(options);
        Assert.Equal(42d, allowed.Evaluate("model.getProperty('x')", scope));
        Assert.Throws<ExpressionEvaluationException>(() => allowed.Evaluate("model.setDeleted()", scope));
        Assert.Equal(0, entity.Deleted);
    }

    [Fact]
    public void RefusesForbiddenAllowedMethods()
    {
        var options = new SafeExpressionEvaluatorOptions();
        options.AllowedMethods.Add("constructor");
        Assert.Throws<ArgumentException>(() => new SafeExpressionEvaluator(options));
    }

    [Fact]
    public void EnforcesStepBudget()
    {
        var evaluator = new SafeExpressionEvaluator(new SafeExpressionEvaluatorOptions { MaxSteps = 1_000 });
        var items = Enumerable.Range(0, 10_000).ToList();
        var ex = Assert.Throws<ExpressionEvaluationException>(() => evaluator.Evaluate("items.map(i => i * 2).length", new Dictionary<string, object?> { ["items"] = items }));
        Assert.Contains("maximum of 1000", ex.Message);
    }

    [Fact]
    public void EnforcesCallDepth()
    {
        // Self-application would recurse forever; must fail cleanly instead of overflowing the stack.
        Assert.Throws<ExpressionEvaluationException>(() => new SafeExpressionEvaluator().Evaluate("(f => f(f))(f => f(f))", new Dictionary<string, object?>()));
    }

    [Fact]
    public void RejectsDeepNesting()
    {
        var deep = new string('(', 500) + "1" + new string(')', 500);
        Assert.Throws<ExpressionSyntaxException>(() => new SafeExpressionEvaluator().Evaluate(deep, new Dictionary<string, object?>()));
    }

    [Fact]
    public void ReturnsArrowFunctionsAsCallable()
    {
        var fn = Assert.IsType<ExpressionFunction>(new SafeExpressionEvaluator().Evaluate("x => x + 1", new Dictionary<string, object?>()));
        Assert.Equal(2d, fn(1d));
    }

    [Fact]
    public void ReportsSyntaxErrorPosition()
    {
        Assert.False(SafeExpressionEvaluator.TryValidate("model.a === ", out var error));
        Assert.Equal(12, error!.Position);
    }

    [Fact]
    public void DistinguishesDivisionFromRegex()
    {
        var e = new SafeExpressionEvaluator();
        Assert.Equal(2d, e.Evaluate("a / 2 / 2", new Dictionary<string, object?> { ["a"] = 8 }));
        Assert.Equal(true, e.Evaluate("/a\\/b/.test(s)", new Dictionary<string, object?> { ["s"] = "a/b" }));
    }

    [Fact]
    public void ReadsJsonElementsAndNumbersOfAnyClrType()
    {
        var json = JsonDocument.Parse("{\"amount\": 12.5, \"name\": \"X\"}").RootElement;
        var e = new SafeExpressionEvaluator();
        Assert.Equal(true, e.Evaluate("model.amount > 12 && model.name === 'X'", new Dictionary<string, object?> { ["model"] = json }));
        Assert.Equal(true, e.Evaluate("model.price === 12.5 && model.count === 3", new Dictionary<string, object?> { ["model"] = new { Price = 12.5m, Count = 3L } }));
    }

    [Fact]
    public void NeverExposesHostGlobals()
    {
        var e = new SafeExpressionEvaluator();
        foreach (var expr in new[] { "globalThis", "window", "process", "require", "Function", "Reflect", "Proxy", "System" })
        {
            Assert.Throws<ExpressionEvaluationException>(() => e.Evaluate(expr, new Dictionary<string, object?>()));
        }
    }
}
