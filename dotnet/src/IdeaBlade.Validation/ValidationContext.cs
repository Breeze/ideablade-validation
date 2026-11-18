using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using IdeaBlade.Validation.Expressions;
using IdeaBlade.Validation.Metadata;

namespace IdeaBlade.Validation
{
    /// <summary>
    /// Context a validator is configured with (from metadata or code). A case-insensitive dictionary,
    /// so <c>messageTemplate</c> and <c>MessageTemplate</c> are the same key; keys are stored camelCased.
    /// </summary>
    public class ValidationContextBase : Dictionary<string, object?>
    {
        public ValidationContextBase() : base(StringComparer.OrdinalIgnoreCase) { }

        public ValidationContextBase(IEnumerable<KeyValuePair<string, object?>>? context) : base(StringComparer.OrdinalIgnoreCase)
        {
            if (context == null) return;
            foreach (var kvp in context) this[Extensions.ToCamelCase(kvp.Key)] = kvp.Value;
        }

        /// <summary>Message template with %path% placeholders, e.g. <c>%displayName% is required</c>.</summary>
        public string? MessageTemplate { get => GetValue<string>(nameof(MessageTemplate)); set => SetValue(nameof(MessageTemplate), value); }

        public string? DisplayName { get => GetValue<string>(nameof(DisplayName)); set => SetValue(nameof(DisplayName), value); }

        public object? GetValue(string name) => TryGetValue(name, out var value) ? value : null;

        /// <summary>Gets a value converted to <typeparamref name="T"/> (numbers, strings, booleans, JSON elements are converted).</summary>
        public T GetValue<T>(string name) => TryGetValue(name, out var value) ? Extensions.ConvertTo<T>(value) : default!;

        /// <summary>Gets an array value (a single value is returned as a one-element array).</summary>
        public T[]? GetValues<T>(string name)
        {
            if (!TryGetValue(name, out var value) || value == null) return null;
            if (JsRuntime.IsArrayLike(value)) return JsRuntime.ToList(value).Select(Extensions.ConvertTo<T>).ToArray();
            return new[] { Extensions.ConvertTo<T>(value) };
        }

        public void SetValue<T>(string name, T value) => this[Extensions.ToCamelCase(name)] = value;
    }

    /// <summary>Context available when a validator runs against a model.</summary>
    public class ValidationContext : ValidationContextBase
    {
        public ValidationContext() { }
        public ValidationContext(IEnumerable<KeyValuePair<string, object?>>? context) : base(context) { }

        public object? Model { get => GetValue(nameof(Model)); set => SetValue(nameof(Model), value); }
        public string? ModelType { get => GetValue<string>(nameof(ModelType)) ?? Model?.GetType().Name; set => SetValue(nameof(ModelType), value); }
        public string? PropertyName { get => GetValue<string>(nameof(PropertyName)); set => SetValue(nameof(PropertyName), value); }
        public ModelMetadata? Metadata { get => GetValue(nameof(Metadata)) as ModelMetadata; set => SetValue(nameof(Metadata), value); }
        public bool IsClient { get => GetValue<bool>(nameof(IsClient)); set => SetValue(nameof(IsClient), value); }
        public bool IsServer { get => GetValue<bool>(nameof(IsServer)); set => SetValue(nameof(IsServer), value); }

        /// <summary>Evaluator used for conditions and the <c>expression</c> validator.</summary>
        public IExpressionEvaluator? ExpressionEvaluator { get => GetValue(nameof(ExpressionEvaluator)) as IExpressionEvaluator; set => SetValue(nameof(ExpressionEvaluator), value); }

        /// <summary>Extra trusted functions/values visible to expressions (e.g. <c>store</c>, <c>findEntity</c>).</summary>
        public IDictionary<string, object?>? ExpressionScope { get => GetValue(nameof(ExpressionScope)) as IDictionary<string, object?>; set => SetValue(nameof(ExpressionScope), value); }

        /// <summary>The <c>store(entityType)</c> lookup, when an entity store is available.</summary>
        public Func<string, IEnumerable<object>>? Store { get => GetValue(nameof(Store)) as Func<string, IEnumerable<object>>; set => SetValue(nameof(Store), value); }
    }

    /// <summary>Context passed to a validator function: the validation context plus the value under validation.</summary>
    public class ValidatorFunctionContext : ValidationContext
    {
        public ValidatorFunctionContext() { }
        public ValidatorFunctionContext(IEnumerable<KeyValuePair<string, object?>>? context) : base(context) { }

        public object? Value { get => GetValue(nameof(Value)); set => SetValue(nameof(Value), value); }
        public string? ValidatorName { get => GetValue<string>(nameof(ValidatorName)); set => SetValue(nameof(ValidatorName), value); }

        /// <summary>The exception thrown by the validator, if it failed with an exception.</summary>
        public Exception? Exception => GetValue("exception") as Exception;
    }

    internal static class Extensions
    {
        public static string ToCamelCase(string str) => JsRuntime.ToCamelCase(str);

        public static T ConvertTo<T>(object? value) => (T)ConvertTo(value, typeof(T))!;

        public static object? ConvertTo(object? value, Type type)
        {
            if (value is JsonElement el) value = JsRuntime.FromJson(el);
            if (value == null || value is Undefined) return type.IsValueType && Nullable.GetUnderlyingType(type) == null ? Activator.CreateInstance(type) : null;
            if (type.IsInstanceOfType(value)) return value;
            var underlying = Nullable.GetUnderlyingType(type) ?? type;
            if (underlying == typeof(string)) return value is string s ? s : JsRuntime.ToJsString(value);
            if (underlying == typeof(bool)) return JsRuntime.Truthy(value);
            if (underlying == typeof(DateTime)) return value is DateTime dt ? dt : Builtins.ParseDate(JsRuntime.ToJsString(value)) ?? throw new FormatException($"'{value}' is not a date");
            if (underlying.IsEnum) return Enum.Parse(underlying, JsRuntime.ToJsString(value), true);
            if (underlying == typeof(object)) return value;
            if (value is IConvertible) return Convert.ChangeType(value is string str ? (object)JsRuntime.StringToNumber(str) : value, underlying, CultureInfo.InvariantCulture);
            throw new InvalidCastException($"Cannot convert {value.GetType().Name} to {type.Name}");
        }

        /// <summary>Resolves the model type name of an object (unwrapping EF / Castle proxy types).</summary>
        public static string DefaultModelTypeName(object model)
        {
            var type = model.GetType();
            var ns = type.Namespace;
            if ((ns == "System.Data.Entity.DynamicProxies" || ns == "Castle.Proxies") && type.BaseType != null) type = type.BaseType;
            return type.Name;
        }
    }
}
