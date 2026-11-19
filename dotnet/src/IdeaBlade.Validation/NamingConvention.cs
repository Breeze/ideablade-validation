using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace IdeaBlade.Validation
{
    /// <summary>
    /// Translates property names between the validation metadata and the models a platform validates, as Breeze's
    /// <c>NamingConvention</c> does between a client and a server.
    /// <para>
    /// The metadata names properties once, for every platform: <c>firstName</c>, <c>stateId</c>. JavaScript objects use
    /// those names as they are. CLR objects name them <c>FirstName</c> and <c>StateId</c>, so on .NET the default is
    /// <see cref="CamelCase"/>: camelCase metadata, PascalCase models. Another server platform would default to its own
    /// convention.
    /// </para>
    /// <para>
    /// The convention applies where a name crosses between the two: reading a property's value from a model, and the
    /// property names an error reports (<see cref="ValidationError.PropertyNames"/>) and uses in its message when the
    /// property has no display name. Everything inside the metadata stays in metadata names: error keys
    /// (<c>required_stateId</c>, the same as the client's), <c>context.propertyName</c> in expressions, <c>from</c>
    /// references and <c>propertyNames</c>.
    /// </para>
    /// </summary>
    public sealed class NamingConvention
    {
        /// <param name="name">A name for the convention, for diagnostics.</param>
        /// <param name="toModelName">Turns a metadata property name into the model's.</param>
        /// <param name="toMetadataName">Turns a model property name into the metadata's.</param>
        public NamingConvention(string name, Func<string, string> toModelName, Func<string, string> toMetadataName)
        {
            Name = name ?? throw new ArgumentNullException(nameof(name));
            _toModelName = toModelName ?? throw new ArgumentNullException(nameof(toModelName));
            _toMetadataName = toMetadataName ?? throw new ArgumentNullException(nameof(toMetadataName));
        }

        private readonly Func<string, string> _toModelName;
        private readonly Func<string, string> _toMetadataName;

        public string Name { get; }

        /// <summary>The model's name for a metadata property name: <c>stateId</c> → <c>StateId</c> with <see cref="CamelCase"/>.</summary>
        public string ToModelName(string metadataName) => string.IsNullOrEmpty(metadataName) ? metadataName : _toModelName(metadataName);

        /// <summary>The metadata's name for a model property name: <c>StateId</c> → <c>stateId</c> with <see cref="CamelCase"/>.</summary>
        public string ToMetadataName(string modelName) => string.IsNullOrEmpty(modelName) ? modelName : _toMetadataName(modelName);

        /// <summary>
        /// camelCase metadata, PascalCase models: the first letter is upper case in the model and lower case in the
        /// metadata (<c>firstName</c> ↔ <c>FirstName</c>). The default on .NET, and the same rule as Breeze's
        /// <c>camelCase</c> convention, so a name that starts with an acronym translates the same way (<c>ID</c> → <c>iD</c>).
        /// </summary>
        public static NamingConvention CamelCase { get; } = new NamingConvention(
            nameof(CamelCase),
            name => char.ToUpperInvariant(name[0]) + name.Substring(1),
            name => char.ToLowerInvariant(name[0]) + name.Substring(1));

        /// <summary>The metadata uses the models' names as they are.</summary>
        public static NamingConvention None { get; } = new NamingConvention(nameof(None), name => name, name => name);

        public override string ToString() => Name;

        /// <summary>
        /// The CLR property of <paramref name="type"/> for a metadata property name: the one the convention names, else
        /// one with the metadata's name, else one that matches it case-insensitively. Null when there is none.
        /// </summary>
        internal static PropertyInfo? FindProperty(Type type, string metadataName, NamingConvention? convention)
        {
            static bool Readable(PropertyInfo? p) => p != null && p.GetIndexParameters().Length == 0;
            var byConvention = type.GetProperty((convention ?? CamelCase).ToModelName(metadataName));
            if (Readable(byConvention)) return byConvention;
            var exact = type.GetProperty(metadataName);
            if (Readable(exact)) return exact;
            return type.GetProperties().FirstOrDefault(p => Readable(p) && string.Equals(p.Name, metadataName, StringComparison.OrdinalIgnoreCase));
        }

        /// <summary>
        /// A metadata property name as <paramref name="model"/> names it: the name of the CLR property it reads
        /// (<see cref="FindProperty"/>). A model without CLR properties of its own - a dictionary, an
        /// <c>ExpandoObject</c>, JSON - uses the metadata's names, so the name stays as it is.
        /// </summary>
        internal static string ModelPropertyName(object? model, string metadataName, NamingConvention? convention)
        {
            if (model == null || HasNoClrProperties(model)) return metadataName;
            return FindProperty(model.GetType(), metadataName, convention)?.Name ?? (convention ?? CamelCase).ToModelName(metadataName);
        }

        private static bool HasNoClrProperties(object model) =>
            model is IDictionary || model is IDictionary<string, object?> || model is JsonElement || model is JsonNode;
    }
}
