using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using IdeaBlade.Validation.Expressions;

namespace IdeaBlade.Validation.Metadata
{
    /// <summary>Metadata describing one usage of a validator.</summary>
    public sealed class ValidatorMetadata
    {
        private readonly ValidationMetadata _owner;
        private readonly ConcurrentDictionary<bool, ValidatorBase> _validators = new ConcurrentDictionary<bool, ValidatorBase>();
        private ValidationContextBase? _context;

        internal ValidatorMetadata(ValidatorConfig config, ValidationMetadata owner, ValidatorGroupConfig? group = null)
        {
            Config = config;
            _owner = owner;
            Group = group?.Group;
            if (string.IsNullOrEmpty(config.Name)) throw new ValidationConfigurationException("Validator config lacks a name");
        }

        public ValidatorConfig Config { get; }
        public string? Id => Config.Id;
        public string Name => Config.Name;
        public string? Group { get; }
        public bool IsAsync => Config.Async;
        public string? Condition => Config.Condition;
        /// <summary>For a model-level validator: the properties its errors are about (<c>propertyNames</c> in the metadata).</summary>
        public IList<string>? PropertyNames => Config.PropertyNames;

        /// <summary>The configured validator context (from the metadata).</summary>
        public ValidationContextBase Context => _context ?? (_context = new ValidationContextBase(Config.Context));

        /// <summary>Evaluates the condition (if any). Variables: context, model, value, isClient, isServer and the expression scope.</summary>
        public bool EvalCondition(ValidationContext context, Func<ValidationContext, ValidationContext>? contextResolver = null)
        {
            var condition = Config.Condition;
            if (string.IsNullOrWhiteSpace(condition)) return true;
            var resolved = contextResolver != null ? contextResolver(context) : context;
            var model = resolved.Model;
            var value = resolved.PropertyName != null && model != null ? JsRuntime.GetProperty(model, resolved.PropertyName) : model;
            var scope = new Dictionary<string, object?>(StringComparer.Ordinal);
            if (resolved.ExpressionScope != null) foreach (var kvp in resolved.ExpressionScope) scope[kvp.Key] = kvp.Value;
            scope["context"] = resolved;
            scope["model"] = model;
            scope["value"] = value;
            scope["isClient"] = resolved.IsClient;
            scope["isServer"] = resolved.IsServer;
            try
            {
                return JsRuntime.Truthy(_owner.ExpressionEvaluator.Evaluate(condition!, scope));
            }
            catch (Exception e)
            {
                throw new ValidationConfigurationException(
                    $"Condition '{condition}' failed for validator '{Name}' and model type '{resolved.ModelType}': {e.Message}", e);
            }
        }

        /// <summary>Returns the validator instance (created once per metadata entry).</summary>
        public ValidatorBase GetValidator() => _validators.GetOrAdd(IsAsync, async =>
        {
            var factories = _owner.ValidatorFactories.Where(f => f.Name == Name).ToList();
            if (factories.Count == 0) throw new ValidationConfigurationException($"No validator factory registered with name '{Name}'.");
            // Several factories may share a name (e.g. a sync and an async 'unique' validator); pick by async-ness.
            var validator = factories.Select(f => f.Fn(Group, Context)).FirstOrDefault(v => v.IsAsync == async);
            if (validator == null)
                throw new ValidationConfigurationException($"No {(async ? "asynchronous" : "synchronous")} validator registered with name '{Name}'.");
            validator.Metadata = this;
            return validator;
        });

        internal static List<ValidatorMetadata> From(IEnumerable<ValidatorEntryConfig>? configs, ValidationMetadata owner)
        {
            var result = new List<ValidatorMetadata>();
            foreach (var config in configs ?? Enumerable.Empty<ValidatorEntryConfig>())
            {
                if (config is ValidatorGroupConfig group) result.AddRange(group.Validators.Select(v => new ValidatorMetadata(v, owner, group)));
                else if (config is ValidatorConfig v) result.Add(new ValidatorMetadata(v, owner));
            }
            return result;
        }
    }

    /// <summary>Validators that apply to every model type.</summary>
    public sealed class GlobalMetadata
    {
        internal GlobalMetadata(IEnumerable<GlobalMetadataConfig> configs, ValidationMetadata owner)
        {
            Validators = ValidatorMetadata.From(configs.SelectMany(c => c.Validators), owner);
        }

        public IReadOnlyList<ValidatorMetadata> Validators { get; }
    }

    /// <summary>
    /// Supplies the rules of model type properties that live outside the validation metadata. A property's
    /// <c>from</c> reference inherits them.
    /// </summary>
    public interface IValidationRuleSource
    {
        /// <summary>Validator factories the returned rules refer to. They are registered along with the metadata.</summary>
        IEnumerable<ValidatorFactory> Validators { get; }

        /// <summary>
        /// The rules of a property, or null when this source doesn't know the property. Return a config, possibly without
        /// validators, for every property the source knows: <c>from</c> reports a reference nobody knows as an error.
        /// </summary>
        PropertyValidationConfig? GetPropertyRules(string modelType, string propertyName);
    }

    /// <summary>A property another property inherits its rules from (<c>"from": "Customer.email"</c>).</summary>
    public sealed class PropertyReference
    {
        public PropertyReference(string modelType, string propertyName) { ModelType = modelType; PropertyName = propertyName; }
        public string ModelType { get; }
        public string PropertyName { get; }
    }

    /// <summary>Validation metadata for one property of a model.</summary>
    public sealed class PropertyMetadata
    {
        private readonly ValidationMetadata _owner;
        private IReadOnlyList<ValidatorMetadata>? _validators;
        private IReadOnlyList<PropertyValidationConfig>? _resolvedConfigs;
        private readonly object _lock = new object();
        private bool _resolving;

        internal PropertyMetadata(string propertyName, IReadOnlyList<PropertyValidationConfig> configs, ValidationMetadata owner)
        {
            PropertyName = propertyName;
            Configs = configs;
            _owner = owner;
        }

        public string PropertyName { get; }
        /// <summary>This property's own configs, without the rules inherited through <c>from</c>.</summary>
        public IReadOnlyList<PropertyValidationConfig> Configs { get; }
        public string? DisplayName => ResolvedConfigs.Select(c => c.DisplayName).LastOrDefault(v => v != null);

        /// <summary>The property whose rules this one inherits (<c>from</c>), if any.</summary>
        public PropertyReference? From
        {
            get
            {
                var from = Configs.Select(c => c.From).LastOrDefault(v => v != null);
                if (string.IsNullOrEmpty(from)) return null;
                var dot = from!.IndexOf('.');
                return dot < 0 ? new PropertyReference(from, PropertyName) : new PropertyReference(from.Substring(0, dot), from.Substring(dot + 1));
            }
        }

        /// <summary>
        /// The configs that make up this property: the inherited ones (<c>from</c>: first the rule sources, then the
        /// referenced property's metadata, recursively), followed by this property's own. Later configs win for scalar settings.
        /// </summary>
        public IReadOnlyList<PropertyValidationConfig> ResolvedConfigs
        {
            get
            {
                if (_resolvedConfigs != null) return _resolvedConfigs;
                var from = From;
                if (from == null) return _resolvedConfigs = Configs;
                lock (_lock)
                {
                    if (_resolving) throw new ValidationConfigurationException($"Property '{PropertyName}' has a circular 'from' chain through '{from.ModelType}.{from.PropertyName}'.");
                    _resolving = true;
                    try
                    {
                        var fromSources = _owner.RuleSources.Select(s => s.GetPropertyRules(from.ModelType, from.PropertyName)).Where(c => c != null).Select(c => c!).ToList();
                        var fromMetadata = _owner.GetModelMetadata(from.ModelType).GetProperty(from.PropertyName)?.ResolvedConfigs;
                        if (fromSources.Count == 0 && fromMetadata == null)
                            throw new ValidationConfigurationException($"Property '{PropertyName}' inherits from '{from.ModelType}.{from.PropertyName}', which has no metadata and no rule source knows.");
                        return _resolvedConfigs = fromSources.Concat(fromMetadata ?? Array.Empty<PropertyValidationConfig>()).Concat(Configs).ToList();
                    }
                    finally
                    {
                        _resolving = false;
                    }
                }
            }
        }

        public IReadOnlyList<ValidatorMetadata> Validators
        {
            get
            {
                if (_validators != null) return _validators;
                var configs = ResolvedConfigs;
                var validators = configs.SelectMany(c => ValidatorMetadata.From(c.Validators, _owner)).ToList();
                bool HasUngrouped(string name) => validators.Any(v => v.Name == name && v.Group == null);

                var required = configs.Select(c => c.Required).LastOrDefault(v => v != null);
                if (required == true && !HasUngrouped("required"))
                    validators.Add(new ValidatorMetadata(new ValidatorConfig("required") { Id = "REQUIRED" }, _owner));
                var minLength = configs.Select(c => c.MinLength).LastOrDefault(v => v != null);
                if (minLength != null && !HasUngrouped("minLength"))
                    validators.Add(new ValidatorMetadata(new ValidatorConfig("minLength") { Id = "MIN_LENGTH", Context = new Dictionary<string, object?> { ["minLength"] = minLength } }, _owner));
                var maxLength = configs.Select(c => c.MaxLength).LastOrDefault(v => v != null);
                if (maxLength != null && !HasUngrouped("maxLength"))
                    validators.Add(new ValidatorMetadata(new ValidatorConfig("maxLength") { Id = "MAX_LENGTH", Context = new Dictionary<string, object?> { ["maxLength"] = maxLength } }, _owner));
                return _validators = validators;
            }
        }

        /// <summary>
        /// Reads this property's value from a model. On a CLR object, the property is the one <paramref name="namingConvention"/>
        /// names (<c>stateId</c> → <c>StateId</c> by default), else the one of the metadata's name, else one that
        /// matches it case-insensitively.
        /// </summary>
        public object? GetValue(object? model, NamingConvention? namingConvention = null)
        {
            if (model == null) return null;
            if (model is IDictionary<string, object?> dict && dict.TryGetValue(PropertyName, out var direct)) return direct;
            var pi = NamingConvention.FindProperty(model.GetType(), PropertyName, namingConvention);
            if (pi != null) return pi.GetValue(model);
            return JsRuntime.Export(JsRuntime.GetProperty(model, PropertyName));
        }
    }

    /// <summary>Validation metadata for a model type.</summary>
    public sealed class ModelMetadata
    {
        private IReadOnlyList<ValidatorMetadata>? _validators;
        private IReadOnlyList<PropertyMetadata>? _properties;
        private readonly object _lock = new object();
        private bool _resolving;

        internal ModelMetadata(ValidationMetadata owner, string modelType, IReadOnlyList<ModelValidationConfig> configs)
        {
            Owner = owner;
            ModelType = modelType;
            Configs = configs;
        }

        public ValidationMetadata Owner { get; }
        public string ModelType { get; }
        public IReadOnlyList<ModelValidationConfig> Configs { get; }
        public string? Extends => Configs.Select(c => c.Extends).LastOrDefault(v => v != null);
        public string? Condition => Configs.Select(c => c.Condition).LastOrDefault(v => v != null) ?? Parent?.Condition;

        public ModelMetadata? Parent
        {
            get
            {
                var parentType = Extends;
                if (parentType == null) return null;
                if (parentType == ModelType) throw new ValidationConfigurationException($"Model type '{ModelType}' cannot extend itself.");
                return Owner.GetModelMetadata(parentType);
            }
        }

        /// <summary>Model-level validators: global validators (or the parent's), followed by this model's own.</summary>
        public IReadOnlyList<ValidatorMetadata> Validators
        {
            get
            {
                if (_validators != null) return _validators;
                lock (_lock)
                using (Guard())
                {
                    var inherited = Parent?.Validators ?? Owner.GlobalMetadata.Validators;
                    var own = Configs.SelectMany(c => ValidatorMetadata.From(c.Validators, Owner));
                    return _validators = inherited.Concat(own).ToList();
                }
            }
        }

        /// <summary>Property metadata, including inherited properties. Same-named properties are merged.</summary>
        public IReadOnlyList<PropertyMetadata> Properties
        {
            get
            {
                if (_properties != null) return _properties;
                lock (_lock)
                using (Guard())
                {
                    var byName = new List<KeyValuePair<string, List<PropertyValidationConfig>>>();
                    void Add(string name, IEnumerable<PropertyValidationConfig> configs)
                    {
                        var index = byName.FindIndex(p => p.Key == name);
                        if (index < 0) byName.Add(new KeyValuePair<string, List<PropertyValidationConfig>>(name, configs.ToList()));
                        else byName[index].Value.AddRange(configs);
                    }
                    foreach (var p in Parent?.Properties ?? Array.Empty<PropertyMetadata>()) Add(p.PropertyName, p.Configs);
                    foreach (var config in Configs)
                        foreach (var kvp in config.Properties) Add(kvp.Key, new[] { kvp.Value });
                    return _properties = byName.Select(p => new PropertyMetadata(p.Key, p.Value, Owner)).ToList();
                }
            }
        }

        private IDisposable Guard()
        {
            if (_resolving) throw new ValidationConfigurationException($"Model type '{ModelType}' has a circular 'extends' chain.");
            _resolving = true;
            return new Releaser(() => _resolving = false);
        }

        private sealed class Releaser : IDisposable
        {
            private readonly Action _release;
            public Releaser(Action release) { _release = release; }
            public void Dispose() => _release();
        }

        public PropertyMetadata? GetProperty(string propertyName) => Properties.FirstOrDefault(p => p.PropertyName == propertyName);

        public IReadOnlyList<PropertyMetadata> GetAsyncProperties() => Properties.Where(p => p.Validators.Any(v => v.IsAsync)).ToList();

        /// <summary>
        /// Evaluates the model condition used when validating an entity store.
        /// Variables: model, entities, findEntity(id, type), store(type), isClient, isServer and the expression scope.
        /// </summary>
        public bool EvalCondition(IReadOnlyList<object> entities, object model, Func<object, string> modelTypeResolver, IDictionary<string, object?>? expressionScope = null)
        {
            var condition = Condition;
            if (string.IsNullOrWhiteSpace(condition)) return true;
            ExpressionFunction findEntity = args =>
            {
                var id = args.Length > 0 ? args[0] : null;
                var type = args.Length > 1 ? JsRuntime.ToJsString(args[1]) : null;
                return entities.FirstOrDefault(e => modelTypeResolver(e) == type && JsRuntime.StrictEquals(JsRuntime.GetProperty(e, "id"), id));
            };
            var scope = new Dictionary<string, object?>(StringComparer.Ordinal) { ["findEntity"] = findEntity };
            if (expressionScope != null) foreach (var kvp in expressionScope) scope[kvp.Key] = kvp.Value;
            scope["entities"] = entities;
            scope["model"] = model;
            scope["isClient"] = false;
            scope["isServer"] = true;
            try
            {
                return JsRuntime.Truthy(Owner.ExpressionEvaluator.Evaluate(condition!, scope));
            }
            catch (Exception e)
            {
                throw new ValidationConfigurationException($"Condition '{condition}' failed for model type '{ModelType}': {e.Message}", e);
            }
        }
    }

    /// <summary>
    /// The parsed validation metadata for all model types. Several metadata maps can be supplied; definitions of the
    /// same model type are merged (validators and properties concatenated, scalar settings use the last value).
    /// </summary>
    public sealed class ValidationMetadata
    {
        private readonly object _sync = new object();
        private IReadOnlyList<ModelValidationMetadataMap> _maps = Array.Empty<ModelValidationMetadataMap>();
        private ConcurrentDictionary<string, ModelMetadata> _models = new ConcurrentDictionary<string, ModelMetadata>(StringComparer.Ordinal);
        private GlobalMetadata? _global;

        public ValidationMetadata(
            IEnumerable<ModelValidationMetadataMap>? metadata,
            IEnumerable<ValidatorFactory> validatorFactories,
            IExpressionEvaluator? expressionEvaluator = null,
            IEnumerable<IValidationRuleSource>? ruleSources = null)
        {
            RuleSources = (ruleSources ?? Enumerable.Empty<IValidationRuleSource>()).ToList();
            // The rule sources' factories; the same factory object registered twice counts once.
            ValidatorFactories = (validatorFactories ?? throw new ArgumentNullException(nameof(validatorFactories)))
                .Concat(RuleSources.SelectMany(s => s.Validators ?? Enumerable.Empty<ValidatorFactory>()))
                .Distinct()
                .ToList();
            ExpressionEvaluator = expressionEvaluator ?? new SafeExpressionEvaluator();
            SetMetadata(metadata ?? Enumerable.Empty<ModelValidationMetadataMap>(), suppressChangeEvent: true);
        }

        public IReadOnlyList<ValidatorFactory> ValidatorFactories { get; }
        public IExpressionEvaluator ExpressionEvaluator { get; }
        /// <summary>Sources of property rules outside the metadata, consulted for <c>from</c> references.</summary>
        public IReadOnlyList<IValidationRuleSource> RuleSources { get; }

        /// <summary>Raised after <see cref="SetMetadata"/> replaces the metadata.</summary>
        public event EventHandler? MetadataChanged;

        public GlobalMetadata GlobalMetadata
        {
            get
            {
                lock (_sync)
                {
                    return _global ?? (_global = new GlobalMetadata(_maps.Select(m => m.Global ?? new GlobalMetadataConfig()), this));
                }
            }
        }

        /// <summary>Model types with explicit metadata.</summary>
        public IReadOnlyList<string> ModelTypes => _maps.SelectMany(m => m.Models.Keys).Distinct().ToList();

        /// <summary>Returns metadata for a model type; types without explicit metadata get only the global validators.</summary>
        public ModelMetadata GetModelMetadata(string modelType) =>
            _models.GetOrAdd(modelType, type => new ModelMetadata(this, type, _maps.Select(m => m.Models.TryGetValue(type, out var c) ? c : null).Where(c => c != null).Select(c => c!).ToList()));

        public ModelMetadata GetModelMetadata(Type modelType) => GetModelMetadata(modelType.Name);
        public ModelMetadata GetModelMetadata<T>() => GetModelMetadata(typeof(T));

        /// <summary>Replaces the metadata.</summary>
        public void SetMetadata(IEnumerable<ModelValidationMetadataMap> metadata, bool suppressChangeEvent = false)
        {
            lock (_sync)
            {
                _maps = metadata.Where(m => m != null).ToList();
                _models = new ConcurrentDictionary<string, ModelMetadata>(StringComparer.Ordinal);
                _global = null;
            }
            if (!suppressChangeEvent) MetadataChanged?.Invoke(this, EventArgs.Empty);
        }

        /// <summary>Adds metadata maps to the existing metadata.</summary>
        public void AddMetadata(params ModelValidationMetadataMap[] metadata) => SetMetadata(_maps.Concat(metadata).ToList());
    }
}
