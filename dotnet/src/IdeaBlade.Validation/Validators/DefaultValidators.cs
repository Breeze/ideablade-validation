using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using IdeaBlade.Validation.Expressions;

namespace IdeaBlade.Validation.Validators
{
    internal static class ValueHelpers
    {
        public static bool IsEmpty(object? value)
        {
            if (value == null || value is Undefined) return true;
            if (value is string s) return s.Length == 0;
            if (value is ICollection c) return c.Count == 0;
            return false;
        }

        public static bool IsNumber(object? value) =>
            value is double || value is float || value is decimal || value is int || value is long || value is short ||
            value is byte || value is uint || value is ulong || value is ushort || value is sbyte;

        public static int? Length(object? value)
        {
            if (value is string s) return s.Length;
            if (value is ICollection c) return c.Count;
            if (JsRuntime.IsArrayLike(value)) return JsRuntime.ToList(value).Count;
            return null;
        }

        public static bool MatchesEntry(object? entry, object? value)
        {
            if (entry is string s)
            {
                var literal = Regex.Match(s, @"^/(.*)/([a-z]*)$", RegexOptions.Singleline);
                if (literal.Success) return JsRegExp.Create(literal.Groups[1].Value, literal.Groups[2].Value).Regex.IsMatch(JsRuntime.ToJsString(value));
            }
            return JsRuntime.LooseEquals(entry, value) || JsRuntime.ToJsString(entry) == JsRuntime.ToJsString(value);
        }
    }

    /// <summary><c>required</c> — fails for null, '' and empty collections; with <c>trim: true</c> whitespace-only strings fail too.</summary>
    public class RequiredValidator : Validator
    {
        public const string DefaultMessageTemplate = "%displayName% is required";

        public RequiredValidator(string? group, ValidationContextBase? context, string name = "required")
            : base(name, group, WithMessage(context, DefaultMessageTemplate)) { }

        public static RequiredValidator Create(string? group, ValidationContextBase? context) => new RequiredValidator(group, context);

        protected override bool ValidateCore(object? value, ValidatorFunctionContext context)
        {
            if (value is string s) return (context.GetValue<bool>("trim") ? s.Trim() : s).Length > 0;
            if (value is ICollection c) return c.Count > 0;
            if (JsRuntime.IsArrayLike(value)) return JsRuntime.ToList(value).Count > 0;
            return value != null;
        }
    }

    /// <summary><c>minLength</c> — strings/collections must have at least <c>minLength</c> characters/items. Empty values pass.</summary>
    public class MinLengthValidator : Validator
    {
        public const string DefaultMessageTemplate = "%displayName% must be at least %minLength% characters";

        public MinLengthValidator(string? group, ValidationContextBase? context) : base("minLength", group, WithMessage(context, DefaultMessageTemplate)) { }

        public static MinLengthValidator Create(string? group, ValidationContextBase? context) => new MinLengthValidator(group, context);

        protected override bool ValidateCore(object? value, ValidatorFunctionContext context)
        {
            if (ValueHelpers.IsEmpty(value)) return true;
            var length = ValueHelpers.Length(value);
            return length.HasValue && length.Value >= context.GetValue<double>("minLength");
        }
    }

    /// <summary><c>maxLength</c> — strings/collections must have at most <c>maxLength</c> characters/items. Empty values pass.</summary>
    public class MaxLengthValidator : Validator
    {
        public const string DefaultMessageTemplate = "%displayName% must be at most %maxLength% characters";

        public MaxLengthValidator(string? group, ValidationContextBase? context) : base("maxLength", group, WithMessage(context, DefaultMessageTemplate)) { }

        public static MaxLengthValidator Create(string? group, ValidationContextBase? context) => new MaxLengthValidator(group, context);

        protected override bool ValidateCore(object? value, ValidatorFunctionContext context)
        {
            if (ValueHelpers.IsEmpty(value)) return true;
            var length = ValueHelpers.Length(value);
            return length.HasValue && length.Value <= context.GetValue<double>("maxLength");
        }
    }

    /// <summary>
    /// Regular expression validator (registered as <c>pattern</c>). <c>expression</c> may be a
    /// <see cref="Regex"/>, a <c>"/source/flags"</c> literal or a pattern string (+ <c>flags</c>). Empty values pass.
    /// </summary>
    public class RegExpValidator : Validator
    {
        public const string DefaultMessageTemplate = "%displayName% '%value%' does not match the required format";
        private readonly Regex? _regex;

        public RegExpValidator(string name, string? group, ValidationContextBase? context) : base(name, group, WithMessage(context, DefaultMessageTemplate))
        {
            var expression = Context.GetValue("expression");
            if (expression != null) _regex = ToRegex(expression, Context.GetValue<string>("flags"));
        }

        public static RegExpValidator Create(string name, string? group, ValidationContextBase? context) => new RegExpValidator(name, group, context);

        /// <summary>Converts a configured expression to a .NET regex with JavaScript semantics.</summary>
        public static Regex ToRegex(object expression, string? flags = null)
        {
            switch (expression)
            {
                case Regex r: return r;
                case JsRegExp jr: return jr.Regex;
                case string s:
                    var literal = Regex.Match(s, @"^/(.*)/([a-z]*)$", RegexOptions.Singleline);
                    return literal.Success ? JsRegExp.Create(literal.Groups[1].Value, literal.Groups[2].Value).Regex : JsRegExp.Create(s, flags ?? "").Regex;
                default: throw new ArgumentException("Regular expression validator requires context.expression");
            }
        }

        protected override bool ValidateCore(object? value, ValidatorFunctionContext context)
        {
            if (ValueHelpers.IsEmpty(value)) return true;
            var regex = _regex ?? ToRegex(context.GetValue("expression") ?? throw new ArgumentException("Regular expression validator requires context.expression"), context.GetValue<string>("flags"));
            return regex.IsMatch(value as string ?? JsRuntime.ToJsString(value));
        }
    }

    /// <summary><c>currency</c> — numbers pass; strings must look like an amount (1,234.56, -12, $5.00).</summary>
    public class CurrencyValidator : Validator
    {
        public const string DefaultMessageTemplate = "%displayName% must be a valid currency amount";

        public CurrencyValidator(string? group, ValidationContextBase? context) : base("currency", group, WithMessage(context, DefaultMessageTemplate)) { }

        public static CurrencyValidator Create(string? group, ValidationContextBase? context) => new CurrencyValidator(group, context);

        protected override bool ValidateCore(object? value, ValidatorFunctionContext context)
        {
            if (ValueHelpers.IsEmpty(value)) return true;
            if (ValueHelpers.IsNumber(value)) { var d = Convert.ToDouble(value, System.Globalization.CultureInfo.InvariantCulture); return !double.IsNaN(d) && !double.IsInfinity(d); }
            return value is string s && DefaultValidators.CurrencyPattern.IsMatch(s.Trim());
        }
    }

    /// <summary><c>numeric</c> — a number or numeric string. Context: allowDecimals, allowLeadingZeros, allowNegative (all default false).</summary>
    public class NumericValidator : Validator
    {
        private readonly Regex _pattern;
        private readonly bool _allowDecimals;
        private readonly bool _allowNegative;

        public NumericValidator(string? group, ValidationContextBase? context, string name = "numeric")
            : base(name, group, WithMessage(context, DefaultMessage(context)))
        {
            _allowDecimals = Context.GetValue<bool>("allowDecimals");
            _allowNegative = Context.GetValue<bool>("allowNegative");
            var whole = Context.GetValue<bool>("allowLeadingZeros") ? "[0-9]+" : "(?:0|[1-9][0-9]*)";
            _pattern = new Regex("^" + (_allowNegative ? "-?" : "") + whole + (_allowDecimals ? @"(?:\.[0-9]+)?" : "") + "$", RegexOptions.ECMAScript);
        }

        private static string DefaultMessage(ValidationContextBase? context)
        {
            if (context != null && context.GetValue<bool>("allowLeadingZeros")) return "%displayName% must be a numeric value with optional leading zeros";
            return context != null && context.GetValue<bool>("allowDecimals") ? "%displayName% must be a number" : "%displayName% must be a whole number";
        }

        public static NumericValidator Create(string? group, ValidationContextBase? context) => new NumericValidator(group, context);

        /// <summary><c>integer</c> — whole numbers, negative allowed.</summary>
        public static NumericValidator CreateInteger(string? group, ValidationContextBase? context)
        {
            var ctx = new ValidationContextBase { ["allowNegative"] = true };
            if (context != null) foreach (var kvp in context) ctx[kvp.Key] = kvp.Value;
            ctx["allowDecimals"] = false;
            if (string.IsNullOrEmpty(ctx.MessageTemplate)) ctx.MessageTemplate = "%displayName% must be an integer";
            return new NumericValidator(group, ctx, "integer");
        }

        protected override bool ValidateCore(object? value, ValidatorFunctionContext context)
        {
            if (ValueHelpers.IsEmpty(value)) return true;
            if (ValueHelpers.IsNumber(value))
            {
                var d = Convert.ToDouble(value, System.Globalization.CultureInfo.InvariantCulture);
                return !double.IsNaN(d) && !double.IsInfinity(d) && (_allowDecimals || Math.Floor(d) == d) && (_allowNegative || d >= 0);
            }
            return value is string s && _pattern.IsMatch(s.Trim());
        }
    }

    /// <summary>
    /// <c>range</c> (also <c>numericRange</c>, <c>dateRange</c>) — value must be between <c>minValue</c> and <c>maxValue</c>
    /// (inclusive; either may be omitted; <c>exclusive: true</c> for exclusive bounds). See <see cref="RangeBounds"/>.
    /// Messages can use %minValueText% / %maxValueText%.
    /// </summary>
    public class RangeValidator : Validator
    {
        public const string DefaultMessageTemplate = "%displayName% must be between %minValueText% and %maxValueText%";
        public const string MinMessageTemplate = "%displayName% must be at least %minValueText%";
        public const string MaxMessageTemplate = "%displayName% must be at most %maxValueText%";

        public RangeValidator(string name, string? group, ValidationContextBase? context) : base(name, group, WithMessage(context, Template(context))) { }

        private static string Template(ValidationContextBase? context)
        {
            var min = context?.GetValue("minValue");
            var max = context?.GetValue("maxValue");
            if (min == null && max != null) return MaxMessageTemplate;
            if (max == null && min != null) return MinMessageTemplate;
            return DefaultMessageTemplate;
        }

        public static RangeValidator Create(string? group, ValidationContextBase? context) => new RangeValidator("range", group, context);

        protected override bool ValidateCore(object? value, ValidatorFunctionContext context)
        {
            if (ValueHelpers.IsEmpty(value)) return true;
            var min = RangeBounds.Resolve(context.GetValue("minValue"));
            var max = RangeBounds.Resolve(context.GetValue("maxValue"));
            context["minValueText"] = RangeBounds.Format(min);
            context["maxValueText"] = RangeBounds.Format(max);

            var like = min ?? max;
            var v = RangeBounds.ToComparable(value, like);
            if (v == null) return false;
            var lo = min == null ? null : RangeBounds.ToComparable(min, like);
            var hi = max == null ? null : RangeBounds.ToComparable(max, like);
            if (context.GetValue<bool>("exclusive")) return (lo == null || v > lo) && (hi == null || v < hi);
            return (lo == null || v >= lo) && (hi == null || v <= hi);
        }
    }

    /// <summary><c>date</c> — must be a DateTime/DateTimeOffset (or a parseable string when <c>allowString</c> is true).</summary>
    public class DateValidator : Validator
    {
        public const string DefaultMessageTemplate = "%displayName% must be a valid date";

        public DateValidator(string? group, ValidationContextBase? context) : base("date", group, WithMessage(context, DefaultMessageTemplate)) { }

        public static DateValidator Create(string? group, ValidationContextBase? context) => new DateValidator(group, context);

        protected override bool ValidateCore(object? value, ValidatorFunctionContext context)
        {
            if (ValueHelpers.IsEmpty(value)) return true;
            if (value is DateTime || value is DateTimeOffset) return true;
#if NET6_0_OR_GREATER
            if (value is DateOnly) return true;
#endif
            return context.GetValue<bool>("allowString") && value is string s && Builtins.ParseDate(s) != null;
        }
    }

    /// <summary><c>compare</c> — compares the value with another property: <c>{ "other": "startDate", "op": "&gt;=" }</c>.</summary>
    public class CompareValidator : Validator
    {
        public const string DefaultMessageTemplate = "%displayName% is invalid";

        public CompareValidator(string? group, ValidationContextBase? context) : base("compare", group, WithMessage(context, DefaultMessageTemplate)) { }

        public static CompareValidator Create(string? group, ValidationContextBase? context) => new CompareValidator(group, context);

        protected override bool ValidateCore(object? value, ValidatorFunctionContext context)
        {
            if (ValueHelpers.IsEmpty(value)) return true;
            var other = context.GetValue<string>("other");
            var otherValue = context.Model == null || other == null ? null : JsRuntime.GetProperty(context.Model, other);
            var a = JsRuntime.Normalize(value);
            var b = JsRuntime.Normalize(otherValue);
            if (a is DateTime da) a = JsRuntime.ToEpochMilliseconds(da);
            if (b is DateTime db) b = JsRuntime.ToEpochMilliseconds(db);
            var op = context.GetValue<string>("op");
            switch (op)
            {
                case "==":
                case "===": return JsRuntime.StrictEquals(a, b);
                case "!=":
                case "!==": return !JsRuntime.StrictEquals(a, b);
            }
            var cmp = JsRuntime.Compare(a, b);
            switch (op)
            {
                case "<": return cmp < 0;
                case "<=": return cmp <= 0;
                case ">": return cmp > 0;
                case ">=": return cmp >= 0;
                default: throw new ArgumentException($"compare validator: unknown operator '{op}'");
            }
        }
    }

    /// <summary><c>invalidValues</c> — the value must not equal any of <c>values</c> (<c>/regex/flags</c> entries are patterns).</summary>
    public class InvalidValuesValidator : Validator
    {
        public const string DefaultMessageTemplate = "'%value%' is not a valid value for %displayName%";

        public InvalidValuesValidator(string? group, ValidationContextBase? context) : base("invalidValues", group, WithMessage(context, DefaultMessageTemplate)) { }

        public static InvalidValuesValidator Create(string? group, ValidationContextBase? context) => new InvalidValuesValidator(group, context);

        protected override bool ValidateCore(object? value, ValidatorFunctionContext context) =>
            ValueHelpers.IsEmpty(value) || !(context.GetValues<object>("values") ?? Array.Empty<object>()).Any(v => ValueHelpers.MatchesEntry(v, value));
    }

    /// <summary><c>validValues</c> — the value must equal one of <c>values</c> (<c>/regex/flags</c> entries are patterns).</summary>
    public class ValidValuesValidator : Validator
    {
        public const string DefaultMessageTemplate = "'%value%' is not a valid value for %displayName%";

        public ValidValuesValidator(string? group, ValidationContextBase? context) : base("validValues", group, WithMessage(context, DefaultMessageTemplate)) { }

        public static ValidValuesValidator Create(string? group, ValidationContextBase? context) => new ValidValuesValidator(group, context);

        protected override bool ValidateCore(object? value, ValidatorFunctionContext context) =>
            ValueHelpers.IsEmpty(value) || (context.GetValues<object>("values") ?? Array.Empty<object>()).Any(v => ValueHelpers.MatchesEntry(v, value));
    }

    /// <summary>
    /// <c>expression</c> — evaluates <c>expression</c>; truthy means valid. Variables: value, model, context, isClient,
    /// isServer, store(entityType) and the registered expression scope. Runs for empty values unless <c>skipEmpty</c>.
    /// </summary>
    public class ExpressionValidator : Validator
    {
        public const string DefaultMessageTemplate = "%displayName% is invalid";

        public ExpressionValidator(string? group, ValidationContextBase? context) : base("expression", group, WithMessage(context, DefaultMessageTemplate)) { }

        public static ExpressionValidator Create(string? group, ValidationContextBase? context) => new ExpressionValidator(group, context);

        protected override bool ValidateCore(object? value, ValidatorFunctionContext context)
        {
            if (context.GetValue<bool>("skipEmpty") && ValueHelpers.IsEmpty(value)) return true;
            var evaluator = context.ExpressionEvaluator ?? throw new InvalidOperationException("expression validator: no expression evaluator in context");
            var scope = new Dictionary<string, object?>(StringComparer.Ordinal);
            if (context.ExpressionScope != null) foreach (var kvp in context.ExpressionScope) scope[kvp.Key] = kvp.Value;
            scope["value"] = value;
            scope["model"] = context.Model;
            scope["context"] = context;
            scope["isClient"] = context.IsClient;
            scope["isServer"] = context.IsServer;
            return JsRuntime.Truthy(evaluator.Evaluate(context.GetValue<string>("expression") ?? "", scope));
        }
    }

    /// <summary>
    /// <c>unique</c> (sync) — no other entity of the same type in the store may have the same property value.
    /// Requires a store (entity validation or <see cref="ValidationOptions.Store"/>). Context: <c>ignoreCase</c>.
    /// </summary>
    public class UniqueValidator : Validator
    {
        public const string DefaultMessageTemplate = "%displayName% must be unique";

        public UniqueValidator(string? group, ValidationContextBase? context) : base("unique", group, WithMessage(context, DefaultMessageTemplate)) { }

        public static UniqueValidator Create(string? group, ValidationContextBase? context) => new UniqueValidator(group, context);

        protected override bool ValidateCore(object? value, ValidatorFunctionContext context)
        {
            var propertyName = context.PropertyName;
            var store = context.Store;
            if (ValueHelpers.IsEmpty(value) || propertyName == null || store == null || context.ModelType == null) return true;
            var ignoreCase = context.GetValue<bool>("ignoreCase");
            object? Norm(object? v)
            {
                v = JsRuntime.Normalize(v);
                return ignoreCase && v is string s ? s.ToLowerInvariant() : v;
            }
            var target = Norm(value);
            return !store(context.ModelType).Any(other => !ReferenceEquals(other, context.Model) && JsRuntime.StrictEquals(Norm(JsRuntime.GetProperty(other, propertyName)), target));
        }
    }

    /// <summary>The generic validators, keyed by their metadata names (same names as the TypeScript package).</summary>
    public static class DefaultValidators
    {
        public static readonly Regex EmailPattern = new Regex(@"^[a-z0-9.!#$%&'*+/=?^_`{|}~ -￯-]+@[a-z0-9 -￯](?:[a-z0-9 -￯-]{0,61}[a-z0-9 -￯])?(?:\.[a-z0-9 -￯](?:[a-z0-9 -￯-]{0,61}[a-z0-9 -￯])?)+$", RegexOptions.ECMAScript | RegexOptions.IgnoreCase);
        public static readonly Regex UsZipPattern = new Regex(@"^\d{5}(-\d{4})?$", RegexOptions.ECMAScript);
        public static readonly Regex UsPhonePattern = new Regex(@"^\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}$", RegexOptions.ECMAScript);
        public static readonly Regex CurrencyPattern = new Regex(@"^[+-]?\$?[0-9]{1,3}(?:,?[0-9]{3})*(?:\.[0-9]{1,2})?$", RegexOptions.ECMAScript);
        public static readonly Regex SsnPattern = new Regex(@"^(\d{3}-\d{2}-\d{4}|\d{9})$", RegexOptions.ECMAScript);
        public static readonly Regex FeinPattern = new Regex(@"^\d{2}-\d{7}$", RegexOptions.ECMAScript);

        private static ValidatorFactory RegExp(string name, Regex expression, string messageTemplate) =>
            new ValidatorFactory(name, (group, context) =>
            {
                var ctx = new ValidationContextBase(context) { ["expression"] = expression };
                if (string.IsNullOrEmpty(ctx.MessageTemplate)) ctx.MessageTemplate = messageTemplate;
                return new RegExpValidator(name, group, ctx);
            });

        private static ValidatorFactory Range(string name) => new ValidatorFactory(name, (group, context) => new RangeValidator(name, group, context));

        /// <summary>All generic validators.</summary>
        public static IReadOnlyList<ValidatorFactory> All { get; } = new List<ValidatorFactory>
        {
            new ValidatorFactory("required", RequiredValidator.Create),
            new ValidatorFactory("minLength", MinLengthValidator.Create),
            new ValidatorFactory("maxLength", MaxLengthValidator.Create),
            new ValidatorFactory("pattern", (g, c) => RegExpValidator.Create("pattern", g, c)),
            RegExp("email", EmailPattern, "%displayName% is not a valid email address"),
            RegExp("zipCode", UsZipPattern, "%displayName% is not a valid U.S. zip code"),
            RegExp("phone", UsPhonePattern, "%displayName% must be a 10-digit phone number"),
            RegExp("social", SsnPattern, "%displayName% must be a valid Social Security number"),
            RegExp("fein", FeinPattern, "%displayName% must have the format '##-#######'"),
            new ValidatorFactory("currency", CurrencyValidator.Create),
            new ValidatorFactory("numeric", NumericValidator.Create),
            new ValidatorFactory("integer", NumericValidator.CreateInteger),
            Range("range"),
            Range("numericRange"),
            Range("dateRange"),
            new ValidatorFactory("date", DateValidator.Create),
            new ValidatorFactory("compare", CompareValidator.Create),
            new ValidatorFactory("invalidValues", InvalidValuesValidator.Create),
            new ValidatorFactory("validValues", ValidValuesValidator.Create),
            new ValidatorFactory("expression", ExpressionValidator.Create),
            new ValidatorFactory("unique", UniqueValidator.Create),
        };
    }
}
