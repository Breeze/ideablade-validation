using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace IdeaBlade.Validation.Expressions
{
    internal interface ICallInvoker
    {
        object? Invoke(object? fn, object?[] args);
    }

    /// <summary>Allow-lists and implementations of built-in methods and globals. Mirrors js/src/expressions/builtins.ts.</summary>
    internal static class Builtins
    {
        private const int MaxStringLength = 100_000;

        public static readonly HashSet<string> StringMethods = new HashSet<string>(StringComparer.Ordinal)
        {
            "at", "charAt", "charCodeAt", "codePointAt", "concat", "endsWith", "includes", "indexOf",
            "lastIndexOf", "localeCompare", "match", "normalize", "padEnd", "padStart", "replace", "replaceAll",
            "search", "slice", "split", "startsWith", "substring", "substr", "toLocaleLowerCase",
            "toLocaleUpperCase", "toLowerCase", "toString", "toUpperCase", "trim", "trimEnd", "trimStart", "valueOf",
        };

        public static readonly HashSet<string> ArrayMethods = new HashSet<string>(StringComparer.Ordinal)
        {
            "at", "concat", "every", "filter", "find", "findIndex", "findLast", "findLastIndex", "flat", "flatMap",
            "includes", "indexOf", "join", "lastIndexOf", "map", "reduce", "reduceRight", "slice", "some",
            "toReversed", "toSorted", "toString",
        };

        public static readonly HashSet<string> NumberMethods = new HashSet<string>(StringComparer.Ordinal) { "toFixed", "toPrecision", "toString", "toLocaleString", "valueOf" };
        public static readonly HashSet<string> BooleanMethods = new HashSet<string>(StringComparer.Ordinal) { "toString", "valueOf" };

        public static readonly HashSet<string> DateMethods = new HashSet<string>(StringComparer.Ordinal)
        {
            "getDate", "getDay", "getFullYear", "getHours", "getMilliseconds", "getMinutes", "getMonth",
            "getSeconds", "getTime", "getTimezoneOffset", "getUTCDate", "getUTCDay", "getUTCFullYear",
            "getUTCHours", "getUTCMilliseconds", "getUTCMinutes", "getUTCMonth", "getUTCSeconds", "toDateString",
            "toISOString", "toJSON", "toLocaleDateString", "toLocaleString", "toLocaleTimeString", "toString",
            "toTimeString", "toUTCString", "valueOf",
        };

        public static readonly HashSet<string> RegExpMethods = new HashSet<string>(StringComparer.Ordinal) { "test", "toString" };

        /// <summary>Property names that can never be read, on any object.</summary>
        public static readonly HashSet<string> ForbiddenProperties = new HashSet<string>(StringComparer.Ordinal)
        {
            "__proto__", "prototype", "constructor", "__defineGetter__", "__defineSetter__",
            "__lookupGetter__", "__lookupSetter__", "caller", "callee", "arguments",
        };

        public static bool IsAllowedMethod(object? receiver, string name)
        {
            switch (receiver)
            {
                case string _: return StringMethods.Contains(name);
                case double _: return NumberMethods.Contains(name);
                case bool _: return BooleanMethods.Contains(name);
                case DateTime _: return DateMethods.Contains(name);
                case JsRegExp _: return RegExpMethods.Contains(name);
            }
            return JsRuntime.IsArrayLike(receiver) && ArrayMethods.Contains(name);
        }

        private static object? Arg(object?[] args, int i) => i < args.Length ? args[i] : Undefined.Value;

        private static int ToInt(object? v, int defaultValue)
        {
            if (JsRuntime.IsNullish(v) && !(v == null)) return defaultValue;
            if (v is Undefined) return defaultValue;
            var d = JsRuntime.ToNumber(v);
            if (double.IsNaN(d)) return 0;
            if (double.IsPositiveInfinity(d)) return int.MaxValue;
            if (double.IsNegativeInfinity(d)) return int.MinValue;
            return (int)Math.Truncate(Math.Max(int.MinValue, Math.Min(int.MaxValue, d)));
        }

        private static int RelativeIndex(object? v, int length, int defaultValue)
        {
            var i = ToInt(v, defaultValue);
            if (i < 0) i = Math.Max(0, length + i);
            return Math.Min(i, length);
        }

        public static object? CallMethod(ICallInvoker invoker, object receiver, string name, object?[] args)
        {
            switch (receiver)
            {
                case string s: return CallString(invoker, s, name, args);
                case double d: return CallNumber(d, name, args);
                case bool b: return name == "valueOf" ? (object)b : (b ? "true" : "false");
                case DateTime dt: return CallDate(dt, name);
                case JsRegExp re:
                    if (name == "test") return re.Regex.IsMatch(JsRuntime.ToJsString(Arg(args, 0)));
                    return re.ToString();
            }
            return CallArray(invoker, JsRuntime.ToList(receiver), name, args);
        }

        private static object? CallString(ICallInvoker invoker, string s, string name, object?[] args)
        {
            string StrArg(int i) => JsRuntime.ToJsString(Arg(args, i));
            switch (name)
            {
                case "at":
                    {
                        var i = ToInt(Arg(args, 0), 0);
                        if (i < 0) i += s.Length;
                        return i >= 0 && i < s.Length ? s[i].ToString() : (object)Undefined.Value;
                    }
                case "charAt":
                    {
                        var i = ToInt(Arg(args, 0), 0);
                        return i >= 0 && i < s.Length ? s[i].ToString() : "";
                    }
                case "charCodeAt":
                case "codePointAt":
                    {
                        var i = ToInt(Arg(args, 0), 0);
                        if (i < 0 || i >= s.Length) return name == "charCodeAt" ? double.NaN : (object)Undefined.Value;
                        return name == "codePointAt" ? (double)char.ConvertToUtf32(s, i) : (double)s[i];
                    }
                case "concat": return s + string.Concat(args.Select(JsRuntime.ToJsString));
                case "endsWith":
                    {
                        var end = Arg(args, 1) is Undefined ? s.Length : Math.Max(0, Math.Min(s.Length, ToInt(Arg(args, 1), s.Length)));
                        return s.Substring(0, end).EndsWith(StrArg(0), StringComparison.Ordinal);
                    }
                case "startsWith":
                    {
                        var pos = Math.Max(0, Math.Min(s.Length, ToInt(Arg(args, 1), 0)));
                        return s.Substring(pos).StartsWith(StrArg(0), StringComparison.Ordinal);
                    }
                case "includes":
                    {
                        var pos = Math.Max(0, Math.Min(s.Length, ToInt(Arg(args, 1), 0)));
                        return s.IndexOf(StrArg(0), pos, StringComparison.Ordinal) >= 0;
                    }
                case "indexOf":
                    {
                        var pos = Math.Max(0, Math.Min(s.Length, ToInt(Arg(args, 1), 0)));
                        return (double)s.IndexOf(StrArg(0), pos, StringComparison.Ordinal);
                    }
                case "lastIndexOf": return (double)s.LastIndexOf(StrArg(0), StringComparison.Ordinal);
                case "localeCompare": return (double)Math.Sign(string.Compare(s, StrArg(0), StringComparison.CurrentCulture));
                case "normalize": return s.Normalize();
                case "padStart":
                case "padEnd":
                    {
                        var target = ToInt(Arg(args, 0), 0);
                        if (target > MaxStringLength) throw new ExpressionRuntimeException($"Length {target} exceeds maximum of {MaxStringLength}");
                        var fill = Arg(args, 1) is Undefined ? " " : StrArg(1);
                        if (target <= s.Length || fill.Length == 0) return s;
                        var sb = new StringBuilder();
                        while (sb.Length < target - s.Length) sb.Append(fill);
                        var pad = sb.ToString().Substring(0, target - s.Length);
                        return name == "padStart" ? pad + s : s + pad;
                    }
                case "slice":
                    {
                        var start = RelativeIndex(Arg(args, 0), s.Length, 0);
                        var end = Arg(args, 1) is Undefined ? s.Length : RelativeIndex(Arg(args, 1), s.Length, s.Length);
                        return end > start ? s.Substring(start, end - start) : "";
                    }
                case "substring":
                    {
                        var a = Math.Max(0, Math.Min(s.Length, ToInt(Arg(args, 0), 0)));
                        var b = Arg(args, 1) is Undefined ? s.Length : Math.Max(0, Math.Min(s.Length, ToInt(Arg(args, 1), s.Length)));
                        var lo = Math.Min(a, b);
                        return s.Substring(lo, Math.Max(a, b) - lo);
                    }
                case "substr":
                    {
                        var start = RelativeIndex(Arg(args, 0), s.Length, 0);
                        var len = Arg(args, 1) is Undefined ? s.Length - start : Math.Max(0, Math.Min(s.Length - start, ToInt(Arg(args, 1), 0)));
                        return s.Substring(start, len);
                    }
                case "toLowerCase": return s.ToLowerInvariant();
                case "toUpperCase": return s.ToUpperInvariant();
                case "toLocaleLowerCase": return s.ToLower(CultureInfo.CurrentCulture);
                case "toLocaleUpperCase": return s.ToUpper(CultureInfo.CurrentCulture);
                case "toString":
                case "valueOf": return s;
                case "trim": return s.Trim();
                case "trimStart": return s.TrimStart();
                case "trimEnd": return s.TrimEnd();
                case "split":
                    {
                        var sep = Arg(args, 0);
                        var limit = Arg(args, 1) is Undefined ? int.MaxValue : ToInt(Arg(args, 1), int.MaxValue);
                        IEnumerable<string> parts;
                        if (sep is Undefined) parts = new[] { s };
                        else if (sep is JsRegExp re) parts = re.Regex.Split(s);
                        else
                        {
                            var str = JsRuntime.ToJsString(sep);
                            parts = str.Length == 0 ? s.Select(c => c.ToString()) : s.Split(new[] { str }, StringSplitOptions.None);
                        }
                        return parts.Take(limit).Cast<object?>().ToList();
                    }
                case "search":
                    {
                        var re = AsRegExp(Arg(args, 0));
                        var m = re.Regex.Match(s);
                        return m.Success ? (double)m.Index : -1d;
                    }
                case "match":
                    {
                        var re = AsRegExp(Arg(args, 0));
                        if (re.Global)
                        {
                            var all = re.Regex.Matches(s).Cast<Match>().Select(m => (object?)m.Value).ToList();
                            return all.Count == 0 ? null : all;
                        }
                        var match = re.Regex.Match(s);
                        if (!match.Success) return null;
                        return match.Groups.Cast<Group>().Select(g => g.Success ? (object?)g.Value : Undefined.Value).ToList();
                    }
                case "replace":
                case "replaceAll":
                    return Replace(invoker, s, Arg(args, 0), Arg(args, 1), name == "replaceAll");
            }
            throw new ExpressionRuntimeException($"Calling method '{name}' on string is not allowed");
        }

        private static JsRegExp AsRegExp(object? v) => v is JsRegExp re ? re : JsRegExp.Create(Regex.Escape(JsRuntime.ToJsString(v)), "");

        private static string Replace(ICallInvoker invoker, string s, object? pattern, object? replacement, bool all)
        {
            string Evaluate(Match m)
            {
                if (JsRuntime.IsCallable(replacement))
                {
                    var callArgs = new List<object?> { m.Value };
                    callArgs.AddRange(m.Groups.Cast<Group>().Skip(1).Select(g => g.Success ? (object?)g.Value : Undefined.Value));
                    callArgs.Add((double)m.Index);
                    callArgs.Add(s);
                    return JsRuntime.ToJsString(invoker.Invoke(replacement, callArgs.ToArray()));
                }
                return ExpandReplacement(JsRuntime.ToJsString(replacement), m);
            }

            if (pattern is JsRegExp re)
            {
                if (all && !re.Global) throw new ExpressionRuntimeException("replaceAll must be called with a global RegExp");
                return re.Global ? re.Regex.Replace(s, Evaluate) : re.Regex.Replace(s, Evaluate, 1);
            }
            var literal = new Regex(Regex.Escape(JsRuntime.ToJsString(pattern)), RegexOptions.None, JsRegExp.MatchTimeout);
            return all ? literal.Replace(s, Evaluate) : literal.Replace(s, Evaluate, 1);
        }

        private static string ExpandReplacement(string replacement, Match m)
        {
            if (replacement.IndexOf('$') < 0) return replacement;
            var sb = new StringBuilder();
            for (var i = 0; i < replacement.Length; i++)
            {
                var c = replacement[i];
                if (c != '$' || i + 1 >= replacement.Length) { sb.Append(c); continue; }
                var n = replacement[i + 1];
                if (n == '$') { sb.Append('$'); i++; }
                else if (n == '&') { sb.Append(m.Value); i++; }
                else if (char.IsDigit(n))
                {
                    var group = n - '0';
                    if (group > 0 && group < m.Groups.Count) { sb.Append(m.Groups[group].Value); i++; }
                    else sb.Append(c);
                }
                else sb.Append(c);
            }
            return sb.ToString();
        }

        private static object? CallNumber(double d, string name, object?[] args)
        {
            switch (name)
            {
                case "toFixed":
                    {
                        var digits = Math.Max(0, Math.Min(100, ToInt(Arg(args, 0), 0)));
                        return d.ToString("F" + digits.ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);
                    }
                case "toPrecision":
                    {
                        if (Arg(args, 0) is Undefined) return JsRuntime.NumberToString(d);
                        var p = Math.Max(1, Math.Min(100, ToInt(Arg(args, 0), 1)));
                        return d.ToString("G" + p.ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);
                    }
                case "toString":
                    {
                        var radix = Arg(args, 0) is Undefined ? 10 : ToInt(Arg(args, 0), 10);
                        if (radix == 10 || d != Math.Floor(d)) return JsRuntime.NumberToString(d);
                        if (radix != 2 && radix != 8 && radix != 16) throw new ExpressionRuntimeException("toString radix must be 2, 8, 10 or 16");
                        return Convert.ToString((long)d, radix);
                    }
                case "toLocaleString": return d.ToString("N", CultureInfo.CurrentCulture);
                default: return d;
            }
        }

        private static object? CallDate(DateTime dt, string name)
        {
            var local = dt.Kind == DateTimeKind.Utc ? dt.ToLocalTime() : dt;
            var utc = dt.Kind == DateTimeKind.Utc ? dt : DateTime.SpecifyKind(dt, DateTimeKind.Local).ToUniversalTime();
            switch (name)
            {
                case "getDate": return (double)local.Day;
                case "getDay": return (double)(int)local.DayOfWeek;
                case "getFullYear": return (double)local.Year;
                case "getHours": return (double)local.Hour;
                case "getMilliseconds": return (double)local.Millisecond;
                case "getMinutes": return (double)local.Minute;
                case "getMonth": return (double)(local.Month - 1);
                case "getSeconds": return (double)local.Second;
                case "getTime":
                case "valueOf": return JsRuntime.ToEpochMilliseconds(dt);
                case "getTimezoneOffset": return -(local - utc).TotalMinutes;
                case "getUTCDate": return (double)utc.Day;
                case "getUTCDay": return (double)(int)utc.DayOfWeek;
                case "getUTCFullYear": return (double)utc.Year;
                case "getUTCHours": return (double)utc.Hour;
                case "getUTCMilliseconds": return (double)utc.Millisecond;
                case "getUTCMinutes": return (double)utc.Minute;
                case "getUTCMonth": return (double)(utc.Month - 1);
                case "getUTCSeconds": return (double)utc.Second;
                case "toISOString":
                case "toJSON": return JsRuntime.ToIsoString(dt);
                case "toDateString": return local.ToString("ddd MMM dd yyyy", CultureInfo.InvariantCulture);
                case "toTimeString": return local.ToString("HH:mm:ss", CultureInfo.InvariantCulture);
                case "toUTCString": return utc.ToString("r", CultureInfo.InvariantCulture);
                case "toLocaleDateString": return local.ToString("d", CultureInfo.CurrentCulture);
                case "toLocaleTimeString": return local.ToString("T", CultureInfo.CurrentCulture);
                case "toLocaleString": return local.ToString(CultureInfo.CurrentCulture);
                default: return JsRuntime.DateToString(dt);
            }
        }

        private static object? CallArray(ICallInvoker invoker, List<object?> items, string name, object?[] args)
        {
            var fn = Arg(args, 0);
            object? Call(object? f, object? item, int index) => invoker.Invoke(f, new[] { item, (double)index, items });
            switch (name)
            {
                case "at":
                    {
                        var i = ToInt(fn, 0);
                        if (i < 0) i += items.Count;
                        return i >= 0 && i < items.Count ? items[i] : Undefined.Value;
                    }
                case "concat":
                    {
                        var result = new List<object?>(items);
                        foreach (var a in args)
                        {
                            if (JsRuntime.IsArrayLike(a)) result.AddRange(JsRuntime.ToList(a));
                            else result.Add(a);
                        }
                        return result;
                    }
                case "every":
                    for (var i = 0; i < items.Count; i++) if (!JsRuntime.Truthy(Call(fn, items[i], i))) return false;
                    return true;
                case "some":
                    for (var i = 0; i < items.Count; i++) if (JsRuntime.Truthy(Call(fn, items[i], i))) return true;
                    return false;
                case "filter":
                    {
                        var result = new List<object?>();
                        for (var i = 0; i < items.Count; i++) if (JsRuntime.Truthy(Call(fn, items[i], i))) result.Add(items[i]);
                        return result;
                    }
                case "find":
                    for (var i = 0; i < items.Count; i++) if (JsRuntime.Truthy(Call(fn, items[i], i))) return items[i];
                    return Undefined.Value;
                case "findIndex":
                    for (var i = 0; i < items.Count; i++) if (JsRuntime.Truthy(Call(fn, items[i], i))) return (double)i;
                    return -1d;
                case "findLast":
                    for (var i = items.Count - 1; i >= 0; i--) if (JsRuntime.Truthy(Call(fn, items[i], i))) return items[i];
                    return Undefined.Value;
                case "findLastIndex":
                    for (var i = items.Count - 1; i >= 0; i--) if (JsRuntime.Truthy(Call(fn, items[i], i))) return (double)i;
                    return -1d;
                case "map":
                    return items.Select((item, i) => Call(fn, item, i)).ToList();
                case "flatMap":
                    return items.SelectMany((item, i) =>
                    {
                        var r = Call(fn, item, i);
                        return JsRuntime.IsArrayLike(r) ? JsRuntime.ToList(r) : new List<object?> { r };
                    }).ToList();
                case "flat":
                    {
                        var depth = fn is Undefined ? 1 : ToInt(fn, 1);
                        return Flatten(items, depth);
                    }
                case "includes":
                    return items.Any(i => JsRuntime.SameValueZero(i, fn));
                case "indexOf":
                    return (double)items.FindIndex(i => JsRuntime.StrictEquals(i, fn));
                case "lastIndexOf":
                    return (double)items.FindLastIndex(i => JsRuntime.StrictEquals(i, fn));
                case "join":
                    {
                        var sep = fn is Undefined ? "," : JsRuntime.ToJsString(fn);
                        return string.Join(sep, items.Select(i => JsRuntime.IsNullish(i) ? "" : JsRuntime.ToJsString(i)));
                    }
                case "reduce":
                case "reduceRight":
                    {
                        var order = Enumerable.Range(0, items.Count);
                        if (name == "reduceRight") order = order.Reverse();
                        var indices = order.ToList();
                        object? acc;
                        var start = 0;
                        if (args.Length >= 2) acc = args[1];
                        else
                        {
                            if (indices.Count == 0) throw new ExpressionRuntimeException("Reduce of empty array with no initial value");
                            acc = items[indices[0]];
                            start = 1;
                        }
                        for (var k = start; k < indices.Count; k++)
                        {
                            acc = invoker.Invoke(fn, new[] { acc, items[indices[k]], (double)indices[k], items });
                        }
                        return acc;
                    }
                case "slice":
                    {
                        var start = RelativeIndex(Arg(args, 0), items.Count, 0);
                        var end = Arg(args, 1) is Undefined ? items.Count : RelativeIndex(Arg(args, 1), items.Count, items.Count);
                        return end > start ? items.GetRange(start, end - start) : new List<object?>();
                    }
                case "toReversed":
                    {
                        var result = new List<object?>(items);
                        result.Reverse();
                        return result;
                    }
                case "toSorted":
                    {
                        Comparison<object?> cmp;
                        if (fn is Undefined) cmp = (a, b) => string.CompareOrdinal(JsRuntime.ToJsString(a), JsRuntime.ToJsString(b));
                        else cmp = (a, b) =>
                        {
                            var n = JsRuntime.ToNumber(invoker.Invoke(fn, new[] { a, b }));
                            return double.IsNaN(n) ? 0 : Math.Sign(n);
                        };
                        // Stable sort like JS
                        return items.Select((item, i) => (item, i))
                            .OrderBy(x => x, Comparer<(object? item, int i)>.Create((x, y) => { var c = cmp(x.item, y.item); return c != 0 ? c : x.i.CompareTo(y.i); }))
                            .Select(x => x.item).ToList();
                    }
                case "toString":
                    return JsRuntime.ToJsString(items);
            }
            throw new ExpressionRuntimeException($"Calling method '{name}' on an array is not allowed");
        }

        private static List<object?> Flatten(IEnumerable<object?> items, int depth)
        {
            var result = new List<object?>();
            foreach (var item in items)
            {
                if (depth > 0 && JsRuntime.IsArrayLike(item)) result.AddRange(Flatten(JsRuntime.ToList(item), depth - 1));
                else result.Add(item);
            }
            return result;
        }

        // ---------------------------------------------------------------- globals

        private static ExpressionFunction Fn1(Func<double, double> f) => args => f(JsRuntime.ToNumber(Arg(args, 0)));

        private static double JsRound(double x) => Math.Floor(x + 0.5);

        public static double ParseInt(object? value, object? radixValue)
        {
            var s = JsRuntime.ToJsString(value).Trim();
            var radix = radixValue is Undefined || radixValue == null ? 0 : ToInt(radixValue, 0);
            var sign = 1;
            if (s.StartsWith("-", StringComparison.Ordinal)) { sign = -1; s = s.Substring(1); }
            else if (s.StartsWith("+", StringComparison.Ordinal)) s = s.Substring(1);
            if ((radix == 0 || radix == 16) && s.Length > 1 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) { s = s.Substring(2); radix = 16; }
            if (radix == 0) radix = 10;
            if (radix < 2 || radix > 36) return double.NaN;
            double result = 0;
            var any = false;
            foreach (var c in s)
            {
                int digit;
                if (c >= '0' && c <= '9') digit = c - '0';
                else if (c >= 'a' && c <= 'z') digit = c - 'a' + 10;
                else if (c >= 'A' && c <= 'Z') digit = c - 'A' + 10;
                else break;
                if (digit >= radix) break;
                result = result * radix + digit;
                any = true;
            }
            return any ? sign * result : double.NaN;
        }

        private static readonly Regex FloatPrefix = new Regex(@"^[+-]?(Infinity|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)", RegexOptions.CultureInvariant);

        public static double ParseFloat(object? value)
        {
            var s = JsRuntime.ToJsString(value).Trim();
            var m = FloatPrefix.Match(s);
            if (!m.Success) return double.NaN;
            var text = m.Value;
            if (text.EndsWith("Infinity", StringComparison.Ordinal)) return text.StartsWith("-", StringComparison.Ordinal) ? double.NegativeInfinity : double.PositiveInfinity;
            return double.Parse(text, NumberStyles.Float, CultureInfo.InvariantCulture);
        }

        private static double DateUtc(object?[] args)
        {
            var parts = Enumerable.Range(0, 7).Select(i => i < args.Length ? JsRuntime.ToNumber(args[i]) : (i == 2 ? 1 : 0)).ToArray();
            if (parts.Any(double.IsNaN)) return double.NaN;
            return JsRuntime.ToEpochMilliseconds(BuildDate(parts, DateTimeKind.Utc));
        }

        internal static DateTime BuildDate(double[] p, DateTimeKind kind)
        {
            var year = (int)p[0];
            if (year >= 0 && year <= 99) year += 1900;
            var dt = new DateTime(year, 1, 1, 0, 0, 0, kind)
                .AddMonths((int)p[1])
                .AddDays(p[2] - 1)
                .AddHours(p[3])
                .AddMinutes(p[4])
                .AddSeconds(p[5])
                .AddMilliseconds(p[6]);
            return dt;
        }

        /// <summary>Implements <c>new Date(...)</c>.</summary>
        public static DateTime NewDate(object?[] args)
        {
            if (args.Length == 0) return DateTime.Now;
            if (args.Length == 1)
            {
                var a = JsRuntime.Normalize(args[0]);
                if (a is DateTime d) return d;
                if (a is string s) return ParseDate(s) ?? throw new ExpressionRuntimeException($"Invalid date '{s}'");
                var ms = JsRuntime.ToNumber(a);
                if (double.IsNaN(ms)) throw new ExpressionRuntimeException("Invalid date");
                return JsRuntime.FromEpochMilliseconds(ms);
            }
            var parts = Enumerable.Range(0, 7).Select(i => i < args.Length ? JsRuntime.ToNumber(args[i]) : (i == 2 ? 1 : 0)).ToArray();
            if (parts.Any(double.IsNaN)) throw new ExpressionRuntimeException("Invalid date");
            return BuildDate(parts, DateTimeKind.Local);
        }

        /// <summary>Parses a date string the way <c>Date.parse</c> does for common formats. Date-only ISO strings are UTC.</summary>
        public static DateTime? ParseDate(string s)
        {
            s = s.Trim();
            if (Regex.IsMatch(s, @"^\d{4}-\d{2}-\d{2}$") &&
                DateTime.TryParseExact(s, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var dateOnly))
                return dateOnly;
            if (DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AllowWhiteSpaces, out var dto))
            {
                var hasOffset = Regex.IsMatch(s, @"(Z|[+-]\d{2}:?\d{2})$", RegexOptions.IgnoreCase);
                return hasOffset ? dto.UtcDateTime : DateTime.SpecifyKind(dto.DateTime, DateTimeKind.Local);
            }
            return null;
        }

        private static Dictionary<string, object?> MathMembers()
        {
            var m = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["abs"] = Fn1(Math.Abs),
                ["acos"] = Fn1(Math.Acos),
                ["asin"] = Fn1(Math.Asin),
                ["atan"] = Fn1(Math.Atan),
                ["atan2"] = new ExpressionFunction(a => Math.Atan2(JsRuntime.ToNumber(Arg(a, 0)), JsRuntime.ToNumber(Arg(a, 1)))),
                ["cbrt"] = Fn1(x => x < 0 ? -Math.Pow(-x, 1.0 / 3) : Math.Pow(x, 1.0 / 3)),
                ["ceil"] = Fn1(Math.Ceiling),
                ["cos"] = Fn1(Math.Cos),
                ["exp"] = Fn1(Math.Exp),
                ["floor"] = Fn1(Math.Floor),
                ["hypot"] = new ExpressionFunction(a => Math.Sqrt(a.Select(JsRuntime.ToNumber).Sum(x => x * x))),
                ["log"] = Fn1(Math.Log),
                ["log10"] = Fn1(Math.Log10),
                ["log2"] = Fn1(x => Math.Log(x, 2)),
                ["max"] = new ExpressionFunction(a => a.Length == 0 ? double.NegativeInfinity : a.Select(JsRuntime.ToNumber).Aggregate(double.NegativeInfinity, (x, y) => double.IsNaN(x) || double.IsNaN(y) ? double.NaN : Math.Max(x, y))),
                ["min"] = new ExpressionFunction(a => a.Length == 0 ? double.PositiveInfinity : a.Select(JsRuntime.ToNumber).Aggregate(double.PositiveInfinity, (x, y) => double.IsNaN(x) || double.IsNaN(y) ? double.NaN : Math.Min(x, y))),
                ["pow"] = new ExpressionFunction(a => Math.Pow(JsRuntime.ToNumber(Arg(a, 0)), JsRuntime.ToNumber(Arg(a, 1)))),
                ["round"] = Fn1(JsRound),
                ["sign"] = Fn1(x => double.IsNaN(x) ? double.NaN : Math.Sign(x)),
                ["sin"] = Fn1(Math.Sin),
                ["sqrt"] = Fn1(Math.Sqrt),
                ["tan"] = Fn1(Math.Tan),
                ["trunc"] = Fn1(Math.Truncate),
                ["E"] = Math.E,
                ["LN10"] = Math.Log(10),
                ["LN2"] = Math.Log(2),
                ["LOG10E"] = 1 / Math.Log(10),
                ["LOG2E"] = 1 / Math.Log(2),
                ["PI"] = Math.PI,
                ["SQRT1_2"] = Math.Sqrt(0.5),
                ["SQRT2"] = Math.Sqrt(2),
            };
            return m;
        }

        private static bool IsInteger(double d) => !double.IsNaN(d) && !double.IsInfinity(d) && Math.Floor(d) == d;

        /// <summary>Global identifiers available to every expression.</summary>
        public static readonly IReadOnlyDictionary<string, object?> DefaultGlobals = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["Math"] = new SafeNamespace("Math", MathMembers()),
            ["Date"] = new SafeNamespace("Date", new Dictionary<string, object?>
            {
                ["now"] = new ExpressionFunction(_ => JsRuntime.ToEpochMilliseconds(DateTime.UtcNow)),
                ["parse"] = new ExpressionFunction(a => ParseDate(JsRuntime.ToJsString(Arg(a, 0))) is DateTime d ? JsRuntime.ToEpochMilliseconds(d) : double.NaN),
                ["UTC"] = new ExpressionFunction(a => DateUtc(a)),
            }),
            ["Number"] = new SafeNamespace("Number", new Dictionary<string, object?>
            {
                ["isFinite"] = new ExpressionFunction(a => Arg(a, 0) is double d && !double.IsNaN(d) && !double.IsInfinity(d)),
                ["isInteger"] = new ExpressionFunction(a => Arg(a, 0) is double d && IsInteger(d)),
                ["isNaN"] = new ExpressionFunction(a => Arg(a, 0) is double d && double.IsNaN(d)),
                ["isSafeInteger"] = new ExpressionFunction(a => Arg(a, 0) is double d && IsInteger(d) && Math.Abs(d) <= 9007199254740991),
                ["parseFloat"] = new ExpressionFunction(a => ParseFloat(Arg(a, 0))),
                ["parseInt"] = new ExpressionFunction(a => ParseInt(Arg(a, 0), Arg(a, 1))),
                ["MAX_SAFE_INTEGER"] = 9007199254740991d,
                ["MIN_SAFE_INTEGER"] = -9007199254740991d,
                ["EPSILON"] = Math.Pow(2, -52),
            }, a => a.Length == 0 ? 0d : JsRuntime.ToNumber(a[0])),
            ["String"] = new SafeNamespace("String", new Dictionary<string, object?>(), a => a.Length == 0 ? "" : JsRuntime.ToJsString(a[0])),
            ["Boolean"] = new SafeNamespace("Boolean", new Dictionary<string, object?>(), a => a.Length != 0 && JsRuntime.Truthy(a[0])),
            ["Array"] = new SafeNamespace("Array", new Dictionary<string, object?>
            {
                ["isArray"] = new ExpressionFunction(a => JsRuntime.IsArrayLike(Arg(a, 0))),
            }),
            ["Object"] = new SafeNamespace("Object", new Dictionary<string, object?>
            {
                ["keys"] = new ExpressionFunction(a => JsRuntime.Keys(Arg(a, 0)).Cast<object?>().ToList()),
                ["values"] = new ExpressionFunction(a => JsRuntime.Keys(Arg(a, 0)).Select(k => JsRuntime.GetProperty(Arg(a, 0), k)).ToList()),
                ["entries"] = new ExpressionFunction(a => JsRuntime.Keys(Arg(a, 0)).Select(k => (object?)new List<object?> { k, JsRuntime.GetProperty(Arg(a, 0), k) }).ToList()),
            }),
            ["parseInt"] = new ExpressionFunction(a => ParseInt(Arg(a, 0), Arg(a, 1))),
            ["parseFloat"] = new ExpressionFunction(a => ParseFloat(Arg(a, 0))),
            ["isNaN"] = new ExpressionFunction(a => double.IsNaN(JsRuntime.ToNumber(Arg(a, 0)))),
            ["isFinite"] = new ExpressionFunction(a => { var d = JsRuntime.ToNumber(Arg(a, 0)); return !double.IsNaN(d) && !double.IsInfinity(d); }),
            ["NaN"] = double.NaN,
            ["Infinity"] = double.PositiveInfinity,
        };
    }

    /// <summary>Internal runtime failure inside a built-in; converted to <see cref="ExpressionEvaluationException"/> by the interpreter.</summary>
    internal sealed class ExpressionRuntimeException : Exception
    {
        public ExpressionRuntimeException(string message) : base(message) { }
    }
}
