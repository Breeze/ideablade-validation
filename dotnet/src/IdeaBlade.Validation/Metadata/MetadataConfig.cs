using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using IdeaBlade.Validation.Expressions;

namespace IdeaBlade.Validation.Metadata
{
    /// <summary>An entry in a <c>validators</c> list: a <see cref="ValidatorConfig"/> or a <see cref="ValidatorGroupConfig"/>.</summary>
    public abstract class ValidatorEntryConfig
    {
        internal ValidatorEntryConfig() { }
    }

    /// <summary>Configures one usage of a validator.</summary>
    public sealed class ValidatorConfig : ValidatorEntryConfig
    {
        public ValidatorConfig(string name) { Name = name; }

        /// <summary>Registered validator name.</summary>
        public string Name { get; }
        /// <summary>Optional stable identifier reported as <see cref="ValidationError.Id"/>.</summary>
        public string? Id { get; set; }
        /// <summary>Validator configuration and message template.</summary>
        public IDictionary<string, object?>? Context { get; set; }
        /// <summary>True to select the asynchronous validator registered under <see cref="Name"/>.</summary>
        public bool Async { get; set; }
        /// <summary>Expression; the validator only runs when it evaluates truthy.</summary>
        public string? Condition { get; set; }
        /// <summary>
        /// For a model-level validator: the properties its errors are about, such as <c>["startDate", "endDate"]</c>
        /// for a rule that compares them (<see cref="ValidationError.PropertyNames"/>).
        /// </summary>
        public IList<string>? PropertyNames { get; set; }

        public static implicit operator ValidatorConfig(string name) => new ValidatorConfig(name);
    }

    /// <summary>A named group of validators.</summary>
    public sealed class ValidatorGroupConfig : ValidatorEntryConfig
    {
        public ValidatorGroupConfig(string group, IEnumerable<ValidatorConfig> validators)
        {
            Group = group;
            Validators = validators.ToList();
        }

        public string Group { get; }
        public IList<ValidatorConfig> Validators { get; }
    }

    public sealed class PropertyValidationConfig
    {
        /// <summary>
        /// Inherit the rules of another model type's property: <c>"Customer"</c> for the property of the same name, or
        /// <c>"Customer.email"</c>. The property gets that property's validators and display name, from the metadata and
        /// from the registered <see cref="IValidationRuleSource"/>s; its own settings are added on top.
        /// </summary>
        public string? From { get; set; }
        public string? DisplayName { get; set; }
        /// <summary>Shorthand for the <c>required</c> validator.</summary>
        public bool? Required { get; set; }
        /// <summary>Shorthand for the <c>minLength</c> validator.</summary>
        public int? MinLength { get; set; }
        /// <summary>Shorthand for the <c>maxLength</c> validator.</summary>
        public int? MaxLength { get; set; }
        public IList<ValidatorEntryConfig> Validators { get; set; } = new List<ValidatorEntryConfig>();
    }

    public sealed class ModelValidationConfig
    {
        /// <summary>Name of another model type whose validators and properties are inherited.</summary>
        public string? Extends { get; set; }
        /// <summary>Model-level validators; they receive the whole model as value.</summary>
        public IList<ValidatorEntryConfig> Validators { get; set; } = new List<ValidatorEntryConfig>();
        public IDictionary<string, PropertyValidationConfig> Properties { get; set; } = new Dictionary<string, PropertyValidationConfig>(StringComparer.Ordinal);
        /// <summary>Expression; models for which it is falsy are skipped when validating an entity store.</summary>
        public string? Condition { get; set; }
    }

    public sealed class GlobalMetadataConfig
    {
        /// <summary>Validators applied to every model type.</summary>
        public IList<ValidatorEntryConfig> Validators { get; set; } = new List<ValidatorEntryConfig>();
    }

    /// <summary>
    /// Validation metadata keyed by model type, plus an optional <c>global</c> section. Same JSON format as the
    /// TypeScript package (see spec/validation-metadata.schema.json).
    /// </summary>
    public sealed class ModelValidationMetadataMap
    {
        public GlobalMetadataConfig? Global { get; set; }
        public IDictionary<string, ModelValidationConfig> Models { get; } = new Dictionary<string, ModelValidationConfig>(StringComparer.Ordinal);

        /// <summary>Parses metadata JSON.</summary>
        public static ModelValidationMetadataMap Parse(string json)
        {
            using (var doc = JsonDocument.Parse(json, new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true }))
            {
                return FromJson(doc.RootElement);
            }
        }

        /// <summary>Reads metadata JSON from a stream.</summary>
        public static ModelValidationMetadataMap Load(Stream stream)
        {
            using (var doc = JsonDocument.Parse(stream, new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true }))
            {
                return FromJson(doc.RootElement);
            }
        }

        /// <summary>Reads a metadata JSON file.</summary>
        public static ModelValidationMetadataMap LoadFile(string path)
        {
            using (var stream = File.OpenRead(path))
            {
                return Load(stream);
            }
        }

        public static ModelValidationMetadataMap FromJson(JsonNode node) => Parse(node.ToJsonString());

        public static ModelValidationMetadataMap FromJson(JsonElement root)
        {
            if (root.ValueKind != JsonValueKind.Object) throw new ValidationConfigurationException("Validation metadata must be a JSON object");
            var map = new ModelValidationMetadataMap();
            foreach (var prop in root.EnumerateObject())
            {
                if (prop.Name == "$schema" || prop.Name == "$comment") continue;
                if (prop.Name == "global")
                {
                    map.Global = new GlobalMetadataConfig { Validators = ReadValidators(prop.Value, "global.validators") };
                    continue;
                }
                map.Models[prop.Name] = ReadModel(prop.Value, prop.Name);
            }
            return map;
        }

        private static ModelValidationConfig ReadModel(JsonElement el, string path)
        {
            if (el.ValueKind != JsonValueKind.Object) throw new ValidationConfigurationException($"'{path}' must be an object");
            var model = new ModelValidationConfig();
            foreach (var prop in el.EnumerateObject())
            {
                switch (prop.Name)
                {
                    case "extends": model.Extends = prop.Value.GetString(); break;
                    case "condition": model.Condition = prop.Value.GetString(); break;
                    case "validators": model.Validators = ReadValidators(prop.Value, path + ".validators"); break;
                    case "properties":
                        foreach (var p in prop.Value.EnumerateObject()) model.Properties[p.Name] = ReadProperty(p.Value, path + ".properties." + p.Name);
                        break;
                }
            }
            return model;
        }

        private static PropertyValidationConfig ReadProperty(JsonElement el, string path)
        {
            if (el.ValueKind != JsonValueKind.Object) throw new ValidationConfigurationException($"'{path}' must be an object");
            var config = new PropertyValidationConfig();
            foreach (var prop in el.EnumerateObject())
            {
                switch (prop.Name)
                {
                    case "from": config.From = prop.Value.GetString(); break;
                    case "displayName": config.DisplayName = prop.Value.GetString(); break;
                    case "required": config.Required = prop.Value.ValueKind == JsonValueKind.True; break;
                    case "minLength": config.MinLength = prop.Value.ValueKind == JsonValueKind.Number ? prop.Value.GetInt32() : (int?)null; break;
                    case "maxLength": config.MaxLength = prop.Value.ValueKind == JsonValueKind.Number ? prop.Value.GetInt32() : (int?)null; break;
                    case "validators": config.Validators = ReadValidators(prop.Value, path + ".validators"); break;
                }
            }
            return config;
        }

        private static IList<ValidatorEntryConfig> ReadValidators(JsonElement el, string path)
        {
            if (el.ValueKind == JsonValueKind.Object && el.TryGetProperty("validators", out var inner)) el = inner; // { "validators": [...] } in global
            if (el.ValueKind != JsonValueKind.Array) throw new ValidationConfigurationException($"'{path}' must be an array");
            var list = new List<ValidatorEntryConfig>();
            foreach (var item in el.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.Object && item.TryGetProperty("group", out var group) && group.ValueKind == JsonValueKind.String)
                {
                    var validators = item.TryGetProperty("validators", out var v) ? ReadValidators(v, path + "." + group.GetString()).OfType<ValidatorConfig>() : Enumerable.Empty<ValidatorConfig>();
                    list.Add(new ValidatorGroupConfig(group.GetString()!, validators));
                }
                else list.Add(ReadValidator(item, path));
            }
            return list;
        }

        private static ValidatorConfig ReadValidator(JsonElement el, string path)
        {
            if (el.ValueKind == JsonValueKind.String) return new ValidatorConfig(el.GetString()!);
            if (el.ValueKind != JsonValueKind.Object || !el.TryGetProperty("name", out var name) || name.ValueKind != JsonValueKind.String)
                throw new ValidationConfigurationException($"Validator config in '{path}' lacks a name: {el.GetRawText()}");
            var config = new ValidatorConfig(name.GetString()!);
            if (el.TryGetProperty("id", out var id)) config.Id = id.GetString();
            if (el.TryGetProperty("async", out var async)) config.Async = async.ValueKind == JsonValueKind.True;
            if (el.TryGetProperty("condition", out var condition)) config.Condition = condition.GetString();
            if (el.TryGetProperty("propertyNames", out var propertyNames) && propertyNames.ValueKind == JsonValueKind.Array)
                config.PropertyNames = propertyNames.EnumerateArray().Select(n => n.GetString()!).ToList();
            if (el.TryGetProperty("context", out var context) && context.ValueKind == JsonValueKind.Object)
                config.Context = (Dictionary<string, object?>)JsRuntime.FromJson(context)!;
            return config;
        }
    }

    /// <summary>Thrown for metadata that cannot be honoured (unknown validator, failing condition, ...).</summary>
    public class ValidationConfigurationException : Exception
    {
        public ValidationConfigurationException(string message, Exception? inner = null) : base(message, inner) { }
    }
}
