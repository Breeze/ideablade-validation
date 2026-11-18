using System;
using System.Globalization;
using System.Text.RegularExpressions;
using IdeaBlade.Validation.Expressions;

namespace IdeaBlade.Validation.Validators
{
    /// <summary>
    /// Resolves range bounds used by the range validators. Same rules as js/src/validators/range-bounds.ts:
    /// numbers / numeric strings; dates and parseable date strings; relative dates <c>now</c>, <c>today</c>,
    /// <c>now-18y</c>, <c>today+30d</c> (units y, M, w, d, h, m; no unit = years); relative years <c>year</c>, <c>year+1</c>.
    /// </summary>
    public static class RangeBounds
    {
        private static readonly Regex Relative = new Regex(@"^\s*(now|today)\s*(?:([+-])\s*(\d+)\s*([yMwdhm])?)?\s*$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        private static readonly Regex RelativeYear = new Regex(@"^\s*year\s*(?:([+-])\s*(\d+))?\s*$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        private const int MaxYears = 150;

        /// <summary>Returns a double, a <see cref="DateTime"/>, a string (unresolvable) or null.</summary>
        public static object? Resolve(object? bound, DateTime? now = null)
        {
            bound = JsRuntime.Normalize(bound);
            if (bound == null || bound is Undefined || (bound is string e && e.Length == 0)) return null;
            if (bound is double || bound is DateTime) return bound;
            if (!(bound is string s)) return null;
            var current = now ?? DateTime.Now;
            var trimmed = s.Trim();
            if (trimmed.Length > 0 && !double.IsNaN(JsRuntime.StringToNumber(trimmed))) return JsRuntime.StringToNumber(trimmed);

            var year = RelativeYear.Match(trimmed);
            if (year.Success)
            {
                var offset = year.Groups[2].Success ? Math.Min(int.Parse(year.Groups[2].Value, CultureInfo.InvariantCulture), MaxYears) : 0;
                return (double)(current.Year + (year.Groups[1].Value == "-" ? -offset : offset));
            }

            var rel = Relative.Match(trimmed);
            if (rel.Success)
            {
                var date = string.Equals(rel.Groups[1].Value, "today", StringComparison.OrdinalIgnoreCase) ? current.Date : current;
                if (rel.Groups[2].Success)
                {
                    var sign = rel.Groups[2].Value == "-" ? -1 : 1;
                    var unit = rel.Groups[4].Success ? rel.Groups[4].Value : "y";
                    var amount = int.Parse(rel.Groups[3].Value, CultureInfo.InvariantCulture);
                    if (unit == "y") amount = Math.Min(amount, MaxYears);
                    date = Add(date, sign * amount, unit);
                }
                return date;
            }

            return Builtins.ParseDate(trimmed) is DateTime parsed ? (object)parsed : trimmed;
        }

        private static DateTime Add(DateTime date, int amount, string unit)
        {
            switch (unit)
            {
                case "y": case "Y": return date.AddYears(amount);
                case "M": return date.AddMonths(amount);
                case "w": case "W": return date.AddDays(amount * 7);
                case "d": case "D": return date.AddDays(amount);
                case "h": case "H": return date.AddHours(amount);
                case "m": return date.AddMinutes(amount);
                default: return date;
            }
        }

        /// <summary>Converts a value to a number comparable with the bound (dates → epoch ms).</summary>
        public static double? ToComparable(object? value, object? likeBound)
        {
            value = JsRuntime.Normalize(value);
            if (likeBound is DateTime)
            {
                DateTime? d = value switch
                {
                    DateTime dt => dt,
                    string s => Builtins.ParseDate(s),
                    double ms => JsRuntime.FromEpochMilliseconds(ms),
                    _ => null,
                };
                return d.HasValue ? JsRuntime.ToEpochMilliseconds(d.Value) : (double?)null;
            }
            switch (value)
            {
                case DateTime dt: return JsRuntime.ToEpochMilliseconds(dt);
                case string s:
                    {
                        if (s.Trim().Length == 0) return null;
                        var n = JsRuntime.StringToNumber(s.Replace(",", "").Trim());
                        return double.IsNaN(n) ? (double?)null : n;
                    }
                case double d: return double.IsNaN(d) ? (double?)null : d;
                default: return null;
            }
        }

        /// <summary>Formats a resolved bound for messages.</summary>
        public static string Format(object? bound) => bound switch
        {
            null => "",
            DateTime dt => dt.ToString("d", CultureInfo.CurrentCulture),
            double d => JsRuntime.NumberToString(d),
            _ => bound.ToString() ?? "",
        };
    }
}
