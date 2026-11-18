using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace IdeaBlade.Validation.Expressions
{
    /// <summary>
    /// A function callable from expressions. Arguments are expression values (string, double, bool, null,
    /// <see cref="DateTime"/>, lists, dictionaries or CLR objects).
    /// </summary>
    public delegate object? ExpressionFunction(params object?[] args);

    /// <summary>A host namespace exposed to expressions (e.g. <c>Math</c>). Only listed members are reachable.</summary>
    public sealed class SafeNamespace
    {
        public SafeNamespace(string name, IReadOnlyDictionary<string, object?> members, ExpressionFunction? call = null)
        {
            Name = name;
            Members = members;
            Call = call;
        }

        public string Name { get; }
        public IReadOnlyDictionary<string, object?> Members { get; }
        public ExpressionFunction? Call { get; }
    }

    /// <summary>A JavaScript-style regular expression (pattern + flags) backed by a .NET <see cref="Regex"/>.</summary>
    public sealed class JsRegExp
    {
        /// <summary>Match timeout applied to every expression regex (ReDoS protection).</summary>
        public static readonly TimeSpan MatchTimeout = TimeSpan.FromSeconds(1);

        private JsRegExp(string source, string flags, Regex regex)
        {
            Source = source;
            Flags = flags;
            Regex = regex;
        }

        public string Source { get; }
        public string Flags { get; }
        public bool Global => Flags.IndexOf('g') >= 0;
        public Regex Regex { get; }

        /// <summary>Creates a regex from a JavaScript pattern and flags (g, i, m, s, u, y).</summary>
        public static JsRegExp Create(string pattern, string flags)
        {
            var options = RegexOptions.None;
            if (flags.IndexOf('i') >= 0) options |= RegexOptions.IgnoreCase;
            if (flags.IndexOf('m') >= 0) options |= RegexOptions.Multiline;
            Regex regex;
            if (flags.IndexOf('s') < 0)
            {
                // ECMAScript mode gives JS semantics for \d, \w, \s; it can't be combined with Singleline.
                try { regex = new Regex(pattern, options | RegexOptions.ECMAScript, MatchTimeout); }
                catch (ArgumentException) { regex = new Regex(pattern, options | RegexOptions.CultureInvariant, MatchTimeout); }
            }
            else
            {
                regex = new Regex(pattern, options | RegexOptions.Singleline | RegexOptions.CultureInvariant, MatchTimeout);
            }
            return new JsRegExp(pattern, flags, regex);
        }

        public override string ToString() => "/" + Source + "/" + Flags;
    }

    /// <summary>Reference to a method read as a property but not called (e.g. <c>'a'.toUpperCase</c>).</summary>
    internal sealed class MethodReference
    {
        public MethodReference(object receiver, string name) { Receiver = receiver; Name = name; }
        public object Receiver { get; }
        public string Name { get; }
    }

    /// <summary>JavaScript value semantics over CLR values. Used by the expression interpreter and validators.</summary>
    public static class JsRuntime
    {
        private static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        private static readonly ConcurrentDictionary<(Type, string), MemberInfo?> MemberCache = new ConcurrentDictionary<(Type, string), MemberInfo?>();

        /// <summary>Converts a CLR value into the value space used by expressions.</summary>
        public static object? Normalize(object? value)
        {
            switch (value)
            {
                case null: return null;
                case Undefined _: return value;
                case string _: return value;
                case bool _: return value;
                case double _: return value;
                case char c: return c.ToString();
                case int i: return (double)i;
                case long l: return (double)l;
                case decimal m: return (double)m;
                case float f: return (double)f;
                case short s: return (double)s;
                case byte b: return (double)b;
                case uint ui: return (double)ui;
                case ulong ul: return (double)ul;
                case ushort us: return (double)us;
                case sbyte sb: return (double)sb;
                case DateTime _: return value;
                case DateTimeOffset dto: return dto.UtcDateTime;
#if NET6_0_OR_GREATER
                case DateOnly d: return d.ToDateTime(TimeOnly.MinValue, DateTimeKind.Local);
#endif
                case Guid g: return g.ToString();
                case Enum e: return e.ToString();
                case JsonElement el: return NormalizeJson(el);
                case JsonValue jv: return NormalizeJson(jv.GetValue<JsonElement>());
                default: return value;
            }
        }

        private static object? NormalizeJson(JsonElement el)
        {
            switch (el.ValueKind)
            {
                case JsonValueKind.String: return el.GetString();
                case JsonValueKind.Number: return el.GetDouble();
                case JsonValueKind.True: return true;
                case JsonValueKind.False: return false;
                case JsonValueKind.Null: return null;
                case JsonValueKind.Undefined: return Undefined.Value;
                default: return el; // object / array
            }
        }

        /// <summary>Converts an expression value back to a CLR value (undefined → null).</summary>
        public static object? Export(object? value) => value is Undefined ? null : value;

        public static bool IsNullish(object? v) => v == null || v is Undefined;

        public static bool IsArrayLike(object? v)
        {
            if (v == null || v is string || v is IDictionary || v is JsRegExp) return false;
            if (v is JsonElement el) return el.ValueKind == JsonValueKind.Array;
            if (v is JsonObject) return false;
            if (v is JsonArray) return true;
            if (IsGenericDictionary(v)) return false;
            return v is IEnumerable;
        }

        private static bool IsGenericDictionary(object v) =>
            v is IDictionary<string, object?> || v is IReadOnlyDictionary<string, object?> || v is IDictionary<string, object>;

        /// <summary>Materializes an array-like value as a list of normalized values.</summary>
        public static List<object?> ToList(object? v)
        {
            if (v is List<object?> list) return list;
            if (v is JsonElement el && el.ValueKind == JsonValueKind.Array) return el.EnumerateArray().Select(e => Normalize(e)).ToList();
            if (v is IEnumerable enumerable && !(v is string)) return enumerable.Cast<object?>().Select(Normalize).ToList();
            return new List<object?>();
        }

        public static bool IsCallable(object? v) => v is Delegate || v is ExpressionClosure || (v is SafeNamespace ns && ns.Call != null);

        public static bool Truthy(object? v)
        {
            switch (v)
            {
                case null: return false;
                case Undefined _: return false;
                case bool b: return b;
                case double d: return !(d == 0 || double.IsNaN(d));
                case string s: return s.Length > 0;
                default:
                    var n = Normalize(v);
                    return ReferenceEquals(n, v) || Truthy(n);
            }
        }

        public static string TypeOf(object? v)
        {
            v = Normalize(v);
            switch (v)
            {
                case Undefined _: return "undefined";
                case null: return "object";
                case bool _: return "boolean";
                case double _: return "number";
                case string _: return "string";
                case SafeNamespace ns: return ns.Call != null ? "function" : "object";
                case Delegate _:
                case ExpressionClosure _:
                case MethodReference _: return "function";
                default: return "object";
            }
        }

        public static double ToEpochMilliseconds(DateTime dt)
        {
            var utc = dt.Kind == DateTimeKind.Utc ? dt : DateTime.SpecifyKind(dt, DateTimeKind.Local).ToUniversalTime();
            return (utc - Epoch).TotalMilliseconds;
        }

        public static DateTime FromEpochMilliseconds(double ms) => Epoch.AddMilliseconds(ms).ToLocalTime();

        public static double ToNumber(object? v)
        {
            v = Normalize(v);
            switch (v)
            {
                case Undefined _: return double.NaN;
                case null: return 0;
                case bool b: return b ? 1 : 0;
                case double d: return d;
                case string s: return StringToNumber(s);
                case DateTime dt: return ToEpochMilliseconds(dt);
                default:
                    if (IsArrayLike(v))
                    {
                        var list = ToList(v);
                        if (list.Count == 0) return 0;
                        if (list.Count == 1) return ToNumber(list[0]);
                    }
                    return double.NaN;
            }
        }

        public static double StringToNumber(string s)
        {
            s = s.Trim();
            if (s.Length == 0) return 0;
            if (s.Length > 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X'))
            {
                try { return Convert.ToInt64(s.Substring(2), 16); } catch (Exception) { return double.NaN; }
            }
            if (s == "Infinity" || s == "+Infinity") return double.PositiveInfinity;
            if (s == "-Infinity") return double.NegativeInfinity;
            foreach (var c in s)
            {
                if (!(char.IsDigit(c) || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-')) return double.NaN;
            }
            return double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : double.NaN;
        }

        /// <summary>JavaScript <c>Number.prototype.toString()</c> formatting.</summary>
        public static string NumberToString(double d)
        {
            if (double.IsNaN(d)) return "NaN";
            if (double.IsPositiveInfinity(d)) return "Infinity";
            if (double.IsNegativeInfinity(d)) return "-Infinity";
            if (d == 0) return "0";
            if (Math.Abs(d) < 1e21 && d == Math.Floor(d)) return d.ToString("0", CultureInfo.InvariantCulture);
            var r = d.ToString("R", CultureInfo.InvariantCulture);
            return r.Replace("E+", "e+").Replace("E-", "e-");
        }

        public static string ToJsString(object? v)
        {
            v = Normalize(v);
            switch (v)
            {
                case Undefined _: return "undefined";
                case null: return "null";
                case bool b: return b ? "true" : "false";
                case double d: return NumberToString(d);
                case string s: return s;
                case DateTime dt: return DateToString(dt);
                case JsRegExp re: return re.ToString();
                default:
                    if (IsArrayLike(v)) return string.Join(",", ToList(v).Select(e => IsNullish(e) ? "" : ToJsString(e)));
                    if (IsCallable(v)) return "function () { [native code] }";
                    return "[object Object]";
            }
        }

        internal static string DateToString(DateTime dt)
        {
            var local = dt.Kind == DateTimeKind.Utc ? dt.ToLocalTime() : dt;
            return local.ToString("ddd MMM dd yyyy HH:mm:ss", CultureInfo.InvariantCulture);
        }

        internal static string ToIsoString(DateTime dt)
        {
            var utc = dt.Kind == DateTimeKind.Utc ? dt : DateTime.SpecifyKind(dt, DateTimeKind.Local).ToUniversalTime();
            return utc.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
        }

        /// <summary>ToPrimitive: dates become numbers (hint number) or strings (hint default/string).</summary>
        private static object? ToPrimitive(object? v, bool hintNumber)
        {
            v = Normalize(v);
            if (v == null || v is Undefined || v is bool || v is double || v is string) return v;
            if (v is DateTime dt) return hintNumber ? (object)ToEpochMilliseconds(dt) : ToJsString(dt);
            return ToJsString(v);
        }

        /// <summary>JavaScript <c>===</c>.</summary>
        public static bool StrictEquals(object? a, object? b)
        {
            a = Normalize(a);
            b = Normalize(b);
            if (a is Undefined || b is Undefined) return a is Undefined && b is Undefined;
            if (a == null || b == null) return a == null && b == null;
            if (a is double da && b is double db) return da == db;
            if (a is string sa && b is string sb) return string.Equals(sa, sb, StringComparison.Ordinal);
            if (a is bool ba && b is bool bb) return ba == bb;
            if (a is DateTime || b is DateTime) return false; // distinct Date objects are never === in JS
            return ReferenceEquals(a, b) || (a is JsonElement ja && b is JsonElement jb && JsonElementEquals(ja, jb));
        }

        private static bool JsonElementEquals(JsonElement a, JsonElement b) => a.ValueKind == b.ValueKind && a.GetRawText() == b.GetRawText();

        /// <summary>SameValueZero (used by <c>Array.prototype.includes</c>).</summary>
        public static bool SameValueZero(object? a, object? b)
        {
            a = Normalize(a);
            b = Normalize(b);
            if (a is double da && b is double db && double.IsNaN(da) && double.IsNaN(db)) return true;
            return StrictEquals(a, b);
        }

        /// <summary>JavaScript <c>==</c>.</summary>
        public static bool LooseEquals(object? a, object? b)
        {
            a = Normalize(a);
            b = Normalize(b);
            if (IsNullish(a) || IsNullish(b)) return IsNullish(a) && IsNullish(b);
            if (a!.GetType() == b!.GetType() || (a is double && b is double)) return StrictEquals(a, b);
            if (a is bool) return LooseEquals(ToNumber(a), b);
            if (b is bool) return LooseEquals(a, ToNumber(b));
            if (a is double && b is string) return ToNumber(b) == (double)a;
            if (a is string && b is double) return ToNumber(a) == (double)b;
            var pa = a is double || a is string ? a : ToPrimitive(a, false);
            var pb = b is double || b is string ? b : ToPrimitive(b, false);
            if (ReferenceEquals(pa, a) && ReferenceEquals(pb, b)) return StrictEquals(a, b);
            return LooseEquals(pa, pb);
        }

        /// <summary>JavaScript relational comparison. Returns null when the operands are not comparable (NaN).</summary>
        public static int? Compare(object? a, object? b)
        {
            var pa = ToPrimitive(a, true);
            var pb = ToPrimitive(b, true);
            if (pa is string sa && pb is string sb) return Math.Sign(string.CompareOrdinal(sa, sb));
            var na = ToNumber(pa);
            var nb = ToNumber(pb);
            if (double.IsNaN(na) || double.IsNaN(nb)) return null;
            return na.CompareTo(nb);
        }

        /// <summary>JavaScript <c>+</c>.</summary>
        public static object Add(object? a, object? b)
        {
            var pa = ToPrimitive(a, false);
            var pb = ToPrimitive(b, false);
            if (pa is string || pb is string) return ToJsString(pa) + ToJsString(pb);
            return ToNumber(pa) + ToNumber(pb);
        }

        /// <summary>Reads a property the way JavaScript would, with case-insensitive fallback for CLR/JSON objects.</summary>
        public static object? GetProperty(object? obj, string key)
        {
            obj = Normalize(obj);
            switch (obj)
            {
                case string s:
                    if (key == "length") return (double)s.Length;
                    if (int.TryParse(key, NumberStyles.None, CultureInfo.InvariantCulture, out var si)) return si < s.Length ? s[si].ToString() : (object)Undefined.Value;
                    return Builtins.IsAllowedMethod(s, key) ? new MethodReference(s, key) : (object)Undefined.Value;
                case double _:
                case bool _:
                case DateTime _:
                case JsRegExp _:
                    if (obj is JsRegExp re)
                    {
                        if (key == "source") return re.Source;
                        if (key == "flags") return re.Flags;
                        if (key == "global") return re.Global;
                    }
                    return Builtins.IsAllowedMethod(obj, key) ? new MethodReference(obj, key) : (object)Undefined.Value;
                case JsonElement el:
                    if (el.ValueKind == JsonValueKind.Object)
                    {
                        if (el.TryGetProperty(key, out var p)) return Normalize(p);
                        foreach (var prop in el.EnumerateObject())
                        {
                            if (string.Equals(prop.Name, key, StringComparison.OrdinalIgnoreCase)) return Normalize(prop.Value);
                        }
                        return Undefined.Value;
                    }
                    break;
                case JsonObject jo:
                    if (jo.TryGetPropertyValue(key, out var node)) return NormalizeNode(node);
                    foreach (var kvp in jo)
                    {
                        if (string.Equals(kvp.Key, key, StringComparison.OrdinalIgnoreCase)) return NormalizeNode(kvp.Value);
                    }
                    return Undefined.Value;
            }

            if (IsArrayLike(obj))
            {
                if (key == "length")
                {
                    if (obj is ICollection c) return (double)c.Count;
                    return (double)ToList(obj).Count;
                }
                if (int.TryParse(key, NumberStyles.None, CultureInfo.InvariantCulture, out var index))
                {
                    if (obj is IList list) return index < list.Count ? Normalize(list[index]) : Undefined.Value;
                    var items = ToList(obj);
                    return index < items.Count ? items[index] : Undefined.Value;
                }
                return Builtins.IsAllowedMethod(obj, key) ? new MethodReference(obj!, key) : (object)Undefined.Value;
            }

            if (obj is IDictionary<string, object?> dict) return LookupDictionary(dict, key);
            if (obj is IReadOnlyDictionary<string, object?> rod) return LookupReadOnlyDictionary(rod, key);
            if (obj is IDictionary<string, object> dict2) return LookupDictionary2(dict2, key);
            if (obj is IDictionary nonGeneric)
            {
                if (nonGeneric.Contains(key)) return Normalize(nonGeneric[key]);
                foreach (DictionaryEntry e in nonGeneric)
                {
                    if (e.Key is string k && string.Equals(k, key, StringComparison.OrdinalIgnoreCase)) return Normalize(e.Value);
                }
                return Undefined.Value;
            }
            if (obj is Delegate || obj is ExpressionClosure || obj is MethodReference) return Undefined.Value;
            if (obj == null) return Undefined.Value;

            var member = MemberCache.GetOrAdd((obj.GetType(), key), FindMember);
            switch (member)
            {
                case PropertyInfo pi: return Normalize(pi.GetValue(obj));
                case FieldInfo fi: return Normalize(fi.GetValue(obj));
                default: return Undefined.Value;
            }
        }

        private static object? NormalizeNode(JsonNode? node)
        {
            switch (node)
            {
                case null: return null;
                case JsonValue v: return Normalize(v);
                default: return node;
            }
        }

        private static object? LookupDictionary(IDictionary<string, object?> dict, string key)
        {
            if (dict.TryGetValue(key, out var v)) return Normalize(v);
            foreach (var kvp in dict)
            {
                if (string.Equals(kvp.Key, key, StringComparison.OrdinalIgnoreCase)) return Normalize(kvp.Value);
            }
            return Undefined.Value;
        }

        private static object? LookupDictionary2(IDictionary<string, object> dict, string key)
        {
            if (dict.TryGetValue(key, out var v)) return Normalize(v);
            foreach (var kvp in dict)
            {
                if (string.Equals(kvp.Key, key, StringComparison.OrdinalIgnoreCase)) return Normalize(kvp.Value);
            }
            return Undefined.Value;
        }

        private static object? LookupReadOnlyDictionary(IReadOnlyDictionary<string, object?> dict, string key)
        {
            if (dict.TryGetValue(key, out var v)) return Normalize(v);
            foreach (var kvp in dict)
            {
                if (string.Equals(kvp.Key, key, StringComparison.OrdinalIgnoreCase)) return Normalize(kvp.Value);
            }
            return Undefined.Value;
        }

        private static MemberInfo? FindMember((Type type, string name) k)
        {
            const BindingFlags flags = BindingFlags.Public | BindingFlags.Instance;
            var props = k.type.GetProperties(flags).Where(p => p.GetIndexParameters().Length == 0 && p.CanRead).ToArray();
            MemberInfo? m = props.FirstOrDefault(p => p.Name == k.name)
                ?? props.FirstOrDefault(p => string.Equals(p.Name, k.name, StringComparison.OrdinalIgnoreCase));
            if (m != null) return m;
            var fields = k.type.GetFields(flags);
            return fields.FirstOrDefault(f => f.Name == k.name)
                ?? fields.FirstOrDefault(f => string.Equals(f.Name, k.name, StringComparison.OrdinalIgnoreCase));
        }

        /// <summary>Own enumerable property names, camelCased for CLR objects.</summary>
        public static List<string> Keys(object? obj)
        {
            obj = Normalize(obj);
            switch (obj)
            {
                case null:
                case Undefined _:
                    return new List<string>();
                case string s:
                    return Enumerable.Range(0, s.Length).Select(i => i.ToString(CultureInfo.InvariantCulture)).ToList();
                case JsonElement el when el.ValueKind == JsonValueKind.Object:
                    return el.EnumerateObject().Select(p => p.Name).ToList();
                case JsonObject jo:
                    return jo.Select(p => p.Key).ToList();
                case IDictionary<string, object?> d: return d.Keys.ToList();
                case IReadOnlyDictionary<string, object?> rd: return rd.Keys.ToList();
                case IDictionary nd: return nd.Keys.Cast<object>().Select(k => k.ToString() ?? "").ToList();
            }
            if (IsArrayLike(obj)) return Enumerable.Range(0, ToList(obj).Count).Select(i => i.ToString(CultureInfo.InvariantCulture)).ToList();
            if (obj is double || obj is bool || obj is DateTime || IsCallable(obj)) return new List<string>();
            return obj!.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .Where(p => p.GetIndexParameters().Length == 0 && p.CanRead)
                .Select(p => ToCamelCase(p.Name)).ToList();
        }

        internal static string ToCamelCase(string s) =>
            string.IsNullOrEmpty(s) || char.IsLower(s[0]) ? s : char.ToLowerInvariant(s[0]) + s.Substring(1);

        /// <summary>Converts a JSON element into plain CLR values (Dictionary, List, double/long, string, bool, null).</summary>
        public static object? FromJson(JsonElement el)
        {
            switch (el.ValueKind)
            {
                case JsonValueKind.Object:
                    var dict = new Dictionary<string, object?>(StringComparer.Ordinal);
                    foreach (var p in el.EnumerateObject()) dict[p.Name] = FromJson(p.Value);
                    return dict;
                case JsonValueKind.Array:
                    return el.EnumerateArray().Select(FromJson).ToList();
                case JsonValueKind.String: return el.GetString();
                case JsonValueKind.Number:
                    if (el.TryGetInt32(out var i)) return i;
                    if (el.TryGetInt64(out var l)) return l;
                    return el.GetDouble();
                case JsonValueKind.True: return true;
                case JsonValueKind.False: return false;
                default: return null;
            }
        }
    }
}
