using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;
using IdeaBlade.Validation.Expressions;

namespace IdeaBlade.Validation
{
    /// <summary>A single validation failure.</summary>
    public class ValidationError
    {
        /// <summary>Message used when a validator has no message template.</summary>
        public const string GenericErrorMessage = "Invalid value";

        private static readonly Regex Placeholder = new Regex(@"%([\w.]+)%", RegexOptions.CultureInvariant);

        public ValidationError(string key, ValidatorFunctionContext context, ValidatorBase validator)
        {
            Key = key;
            Context = context;
            Validator = validator;
        }

        /// <summary>Key of the form <c>name[_group][_propertyName]</c>.</summary>
        public string Key { get; }
        public ValidatorFunctionContext Context { get; }
        public ValidatorBase Validator { get; }

        /// <summary>Stable identifier from the metadata (<c>id</c>), or the key if no id was configured.</summary>
        public string Id => Validator.Metadata?.Id ?? Key;
        /// <summary>
        /// The properties the error is about. For a property rule, the property. For a model-level rule, the properties it
        /// names (<c>propertyNames</c> in the metadata, or set by the validator), such as both dates of a "start before
        /// end" rule; empty when it is about the model as a whole.
        /// </summary>
        public IReadOnlyList<string> PropertyNames =>
            Context.PropertyNames is { Count: > 0 } names ? names
            : Context.PropertyName != null ? new[] { Context.PropertyName }
            : Array.Empty<string>();

        /// <summary>True when the error is about <paramref name="propertyName"/> (one of its <see cref="PropertyNames"/>).</summary>
        public bool IsFor(string propertyName) => PropertyNames.Contains(propertyName);
        public object? Model => Context.Model;
        public string? ModelType => Context.ModelType;
        public object? Value => Context.Value;
        public string ErrorMessage => GetErrorMessage();

        /// <summary>Formats the message template, optionally overriding the display name.</summary>
        public string GetErrorMessage(string? displayName = null)
        {
            var ctx = new ValidationContext(Context)
            {
                DisplayName = displayName ?? (string.IsNullOrEmpty(Context.DisplayName) ? Context.PropertyName ?? "" : Context.DisplayName),
            };
            return FormatMessage(ctx.MessageTemplate, ctx);
        }

        public override string ToString() => ErrorMessage;

        /// <summary>Replaces <c>%path.to.value%</c> placeholders with values from the context.</summary>
        public static string FormatMessage(string? template, IDictionary<string, object?> context)
        {
            if (string.IsNullOrEmpty(template)) return GenericErrorMessage;
            return Placeholder.Replace(template, m => FormatValue(GetPath(context, m.Groups[1].Value)));
        }

        internal static object? GetPath(IDictionary<string, object?> context, string path)
        {
            var segments = path.Split('.');
            context.TryGetValue(segments[0], out var current);
            foreach (var segment in segments.Skip(1))
            {
                if (JsRuntime.IsNullish(current)) return null;
                current = JsRuntime.GetProperty(current, segment);
            }
            return current is Undefined ? null : current;
        }

        private static string FormatValue(object? value)
        {
            switch (value)
            {
                case null: return "";
                case Undefined _: return "";
                case string s: return s;
                case DateTime dt: return dt.ToString(CultureInfo.CurrentCulture);
                case DateTimeOffset dto: return dto.ToString(CultureInfo.CurrentCulture);
                case IFormattable f when !(value is Enum): return JsRuntime.ToJsString(JsRuntime.Normalize(f));
                default: return value.ToString() ?? "";
            }
        }
    }

    public static class ValidationErrorExtensions
    {
        public static bool HasErrors(this IEnumerable<ValidationError>? errors) => errors != null && errors.Any();
        public static bool Success(this IEnumerable<ValidationError>? errors) => !errors.HasErrors();
    }
}
