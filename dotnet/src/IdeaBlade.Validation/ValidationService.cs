using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using IdeaBlade.Validation.Expressions;
using IdeaBlade.Validation.Metadata;

namespace IdeaBlade.Validation
{
    /// <summary>Decides whether a validator runs. Receives the property metadata for property validators.</summary>
    public delegate bool ValidatorPredicate(ValidatorMetadata validator, PropertyMetadata? property = null);

    /// <summary>Per-call validation options.</summary>
    public sealed class ValidationOptions
    {
        /// <summary>Controls which validators run.</summary>
        public ValidatorPredicate? Predicate { get; set; }
        /// <summary>Values merged into every validator's context.</summary>
        public IDictionary<string, object?>? Context { get; set; }
        /// <summary>Substitutes the context used to evaluate validator conditions.</summary>
        public Func<ValidationContext, ValidationContext>? ConditionContextResolver { get; set; }
        /// <summary>Implementation of the <c>store(entityType)</c> expression function for this call.</summary>
        public Func<string, IEnumerable<object>>? Store { get; set; }
        /// <summary>Additional trusted functions/values visible to expressions for this call.</summary>
        public IDictionary<string, object?>? ExpressionScope { get; set; }
    }

    /// <summary>Service-wide options.</summary>
    public sealed class ValidationServiceOptions
    {
        /// <summary>Trusted functions/values visible to all expressions.</summary>
        public IDictionary<string, object?> ExpressionScope { get; } = new Dictionary<string, object?>(StringComparer.Ordinal);

        /// <summary>
        /// Maximum time to wait for the asynchronous validators of one model. On timeout validation continues as if they
        /// reported no errors and <see cref="OnAsyncTimeout"/> is called. Default 60 seconds; <see cref="TimeSpan.Zero"/> disables.
        /// </summary>
        public TimeSpan AsyncTimeout { get; set; } = TimeSpan.FromSeconds(60);

        public Action<object, string, TimeSpan>? OnAsyncTimeout { get; set; }

        /// <summary>
        /// Called when one validation of a model reports two or more errors with the same key. Errors are told apart by
        /// their key, so all but one of them may be hidden on the client. The metadata's own rules are checked before they
        /// run (<see cref="ModelMetadata.CheckErrorKeys"/>); this catches the rest, such as a validator that names its
        /// errors itself (the data annotations) reporting a key a metadata rule reports too, or rules with conditions that
        /// apply together. Default: a <see cref="Trace.TraceWarning(string)"/>, once per model type and key.
        /// </summary>
        public Action<DuplicateErrorKeyInfo>? OnDuplicateErrorKey { get; set; }

        /// <summary>Maps a model instance to its model type name. Default: CLR type name (EF/Castle proxies unwrapped).</summary>
        public Func<object, string> ModelTypeResolver { get; set; } = Extensions.DefaultModelTypeName;

        /// <summary>
        /// Translates property names between the metadata and the models. Default: <see cref="NamingConvention.CamelCase"/>,
        /// camelCase metadata over PascalCase CLR properties.
        /// </summary>
        public NamingConvention NamingConvention { get; set; } = NamingConvention.CamelCase;
    }

    /// <summary>Errors about one model that share a key, reported by <see cref="ValidationServiceOptions.OnDuplicateErrorKey"/>.</summary>
    public sealed class DuplicateErrorKeyInfo
    {
        public DuplicateErrorKeyInfo(object model, string modelType, string key, IReadOnlyList<ValidationError> errors)
        {
            Model = model;
            ModelType = modelType;
            Key = key;
            Errors = errors;
        }

        public object Model { get; }
        public string ModelType { get; }
        public string Key { get; }
        /// <summary>The errors with that key, two or more.</summary>
        public IReadOnlyList<ValidationError> Errors { get; }
    }

    /// <summary>Event data for <see cref="ValidationService.ModelValidated"/>.</summary>
    public sealed class ModelValidatedEventArgs : EventArgs
    {
        public ModelValidatedEventArgs(object model, string modelType, IReadOnlyList<ValidationError> errors)
        {
            Model = model;
            ModelType = modelType;
            Errors = errors;
        }

        public object Model { get; }
        public string ModelType { get; }
        public IReadOnlyList<ValidationError> Errors { get; }
    }

    /// <summary>
    /// Runs the validators described by <see cref="ValidationMetadata"/> against models (server side:
    /// <c>isClient</c> = false, <c>isServer</c> = true).
    /// </summary>
    public class ValidationService
    {
        private static readonly IReadOnlyList<ValidationError> NoErrors = Array.Empty<ValidationError>();
        private readonly IReadOnlyList<IValidatorContextProvider> _contextProviders;
        private readonly ValidationServiceOptions _options;

        public ValidationService(ValidationMetadata metadata, IEnumerable<IValidatorContextProvider>? contextProviders = null, ValidationServiceOptions? options = null)
        {
            ValidationMetadata = metadata ?? throw new ArgumentNullException(nameof(metadata));
            _contextProviders = (contextProviders ?? Enumerable.Empty<IValidatorContextProvider>()).ToList();
            _options = options ?? new ValidationServiceOptions();
        }

        public ValidationMetadata ValidationMetadata { get; }

        /// <summary>Raised after each model validation.</summary>
        public event EventHandler<ModelValidatedEventArgs>? ModelValidated;

        public string GetModelType(object model) => _options.ModelTypeResolver(model);

        /// <summary>Runs the synchronous validators for a model. Returns an empty list when valid.</summary>
        public IReadOnlyList<ValidationError> ValidateModel(object model, ValidationOptions? options = null) =>
            ValidateModel(model, GetModelType(model), options);

        /// <summary>Runs the synchronous validators for a model of the given model type. Returns an empty list when valid.</summary>
        public IReadOnlyList<ValidationError> ValidateModel(object model, string modelType, ValidationOptions? options = null)
        {
            var errors = new List<ValidationError>();
            foreach (var item in Plan(false, model, modelType, options))
            {
                errors.AddRange(((Validator)item.Validator).Validate(item.Value, item.Context));
            }
            Completed(model, modelType, errors);
            return errors;
        }

        /// <summary>
        /// Runs all validators (synchronous and asynchronous) for a model. Async validators run concurrently and are
        /// subject to <see cref="ValidationServiceOptions.AsyncTimeout"/>.
        /// </summary>
        public Task<IReadOnlyList<ValidationError>> ValidateModelAsync(object model, ValidationOptions? options = null, CancellationToken cancellationToken = default) =>
            ValidateModelAsync(model, GetModelType(model), options, cancellationToken);

        public async Task<IReadOnlyList<ValidationError>> ValidateModelAsync(object model, string modelType, ValidationOptions? options = null, CancellationToken cancellationToken = default)
        {
            var errors = new List<ValidationError>();
            foreach (var item in Plan(false, model, modelType, options))
            {
                errors.AddRange(((Validator)item.Validator).Validate(item.Value, item.Context));
            }

            var asyncItems = Plan(true, model, modelType, options).ToList();
            if (asyncItems.Count > 0)
            {
                using (var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken))
                {
                    var tasks = asyncItems.Select(item => ((AsyncValidator)item.Validator).ValidateAsync(item.Value, item.Context, cts.Token)).ToList();
                    var all = Task.WhenAll(tasks);
                    if (_options.AsyncTimeout > TimeSpan.Zero)
                    {
                        var completed = await Task.WhenAny(all, Task.Delay(_options.AsyncTimeout, cts.Token)).ConfigureAwait(false);
                        if (completed != all)
                        {
                            cancellationToken.ThrowIfCancellationRequested();
                            cts.Cancel();
                            _options.OnAsyncTimeout?.Invoke(model, modelType, _options.AsyncTimeout);
                            ObserveFaults(all);
                            Completed(model, modelType, errors);
                            return errors;
                        }
                        cts.Cancel(); // stop the delay
                    }
                    var results = await all.ConfigureAwait(false);
                    errors.AddRange(results.SelectMany(e => e));
                }
            }
            Completed(model, modelType, errors);
            return errors;
        }

        private void Completed(object model, string modelType, IReadOnlyList<ValidationError> errors)
        {
            ReportDuplicateKeys(model, modelType, errors);
            ModelValidated?.Invoke(this, new ModelValidatedEventArgs(model, modelType, errors));
        }

        private void ReportDuplicateKeys(object model, string modelType, IReadOnlyList<ValidationError> errors)
        {
            if (errors.Count < 2) return;
            foreach (var same in errors.GroupBy(e => e.Key, StringComparer.Ordinal).Where(g => g.Count() > 1))
            {
                var info = new DuplicateErrorKeyInfo(model, modelType, same.Key, same.ToList());
                if (_options.OnDuplicateErrorKey != null) _options.OnDuplicateErrorKey(info);
                else WarnOnce(info);
            }
        }

        /// <summary>Model types and keys already warned about, so a model validated on every save warns once.</summary>
        private static readonly ConcurrentDictionary<string, bool> Warned = new ConcurrentDictionary<string, bool>(StringComparer.Ordinal);

        private static void WarnOnce(DuplicateErrorKeyInfo info)
        {
            if (!Warned.TryAdd(info.ModelType + " " + info.Key, true)) return;
            var messages = string.Join(", ", info.Errors.Select(e => "\"" + e.ErrorMessage + "\""));
            Trace.TraceWarning(
                $"IdeaBlade.Validation: {info.Errors.Count} errors about one '{info.ModelType}' share the key '{info.Key}' ({messages}). " +
                "Errors are told apart by key, so all but one may be hidden on the client. Give the rules different ids or groups, " +
                "or check which validator reports the key twice. See \"Error keys\" in docs/metadata.md.");
        }

        private static void ObserveFaults(Task task) => task.ContinueWith(t => { _ = t.Exception; }, TaskContinuationOptions.OnlyOnFaulted);

        /// <summary>
        /// Validates all entities of a store (e.g. a save bundle). Entities whose model condition is falsy are skipped.
        /// Expressions can use <c>store(entityType)</c> and, in model conditions, <c>findEntity(id, type)</c>.
        /// </summary>
        public async Task<IReadOnlyList<ValidationError>> ValidateEntitiesAsync(IValidationEntityStore store, ValidationOptions? options = null, CancellationToken cancellationToken = default)
        {
            if (store == null) throw new ArgumentNullException(nameof(store));
            var entities = store.Entities;
            if (entities.Count == 0) return NoErrors;

            var opts = new ValidationOptions
            {
                Predicate = options?.Predicate,
                Context = options?.Context,
                ConditionContextResolver = options?.ConditionContextResolver,
                ExpressionScope = options?.ExpressionScope,
                Store = options?.Store ?? (store is IValidationEntityTypeLookup lookup
                    ? (Func<string, IEnumerable<object>>)lookup.GetEntities
                    : type => entities.Where(e => GetModelType(e) == type)),
            };
            var scope = BuildExpressionScope(opts);
            var toValidate = entities.Where(e => ValidationMetadata.GetModelMetadata(GetModelType(e)).EvalCondition(entities, e, GetModelType, scope)).ToList();
            var results = await Task.WhenAll(toValidate.Select(e => ValidateModelAsync(e, GetModelType(e), opts, cancellationToken))).ConfigureAwait(false);
            return results.SelectMany(r => r).ToList();
        }

        /// <summary>Convenience overload validating a list of entities together.</summary>
        public Task<IReadOnlyList<ValidationError>> ValidateEntitiesAsync(IEnumerable<object> entities, ValidationOptions? options = null, CancellationToken cancellationToken = default) =>
            ValidateEntitiesAsync(new ValidationEntityStore(entities), options, cancellationToken);

        /// <summary>True if the model type has asynchronous validators.</summary>
        public bool HasAsyncValidators(string modelType, ValidatorPredicate? predicate = null)
        {
            var p = predicate ?? ((v, prop) => true);
            var metadata = ValidationMetadata.GetModelMetadata(modelType);
            metadata.CheckErrorKeys();
            return metadata.Validators.Any(v => v.IsAsync && p(v)) || metadata.Properties.Any(prop => prop.Validators.Any(v => v.IsAsync && p(v, prop)));
        }

        private Dictionary<string, object?> BuildExpressionScope(ValidationOptions? options)
        {
            var scope = new Dictionary<string, object?>(_options.ExpressionScope, StringComparer.Ordinal);
            if (options?.Store != null)
            {
                var storeFn = options.Store;
                scope["store"] = new ExpressionFunction(args => storeFn(args.Length > 0 ? JsRuntime.ToJsString(args[0]) : "").ToList());
            }
            if (options?.ExpressionScope != null) foreach (var kvp in options.ExpressionScope) scope[kvp.Key] = kvp.Value;
            return scope;
        }

        private sealed class PlannedValidation
        {
            public PlannedValidation(ValidatorBase validator, object? value, ValidationContext context)
            {
                Validator = validator;
                Value = value;
                Context = context;
            }

            public ValidatorBase Validator { get; }
            public object? Value { get; }
            public ValidationContext Context { get; }
        }

        private IEnumerable<PlannedValidation> Plan(bool isAsync, object model, string modelType, ValidationOptions? options)
        {
            var metadata = ValidationMetadata.GetModelMetadata(modelType);
            metadata.CheckErrorKeys();
            var predicate = options?.Predicate ?? ((v, p) => true);
            var resolver = options?.ConditionContextResolver;

            var baseContext = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
            if (options?.Context != null) foreach (var kvp in options.Context) baseContext[kvp.Key] = kvp.Value;
            foreach (var provider in _contextProviders)
            {
                var provided = provider.GetContext(model, modelType);
                if (provided != null) foreach (var kvp in provided) baseContext[kvp.Key] = kvp.Value;
            }
            var scope = BuildExpressionScope(options);

            ValidationContext CreateContext(ValidatorMetadata validator, PropertyMetadata? property)
            {
                var ctx = new ValidationContext(baseContext)
                {
                    Model = model,
                    ModelType = modelType,
                    Metadata = metadata,
                    IsClient = false,
                    IsServer = true,
                    ExpressionEvaluator = ValidationMetadata.ExpressionEvaluator,
                    ExpressionScope = scope,
                    Store = options?.Store,
                    NamingConvention = _options.NamingConvention,
                };
                if (property != null)
                {
                    ctx.PropertyName = property.PropertyName;
                    ctx.DisplayName = property.DisplayName;
                }
                else if (validator.PropertyNames is { Count: > 0 } propertyNames)
                {
                    ctx.PropertyNames = propertyNames.ToList();
                }
                foreach (var kvp in validator.Context) ctx[kvp.Key] = kvp.Value;
                return ctx;
            }

            var planned = new List<PlannedValidation>();
            foreach (var validator in metadata.Validators)
            {
                if (validator.IsAsync != isAsync || !predicate(validator)) continue;
                var ctx = CreateContext(validator, null);
                if (validator.EvalCondition(ctx, resolver)) planned.Add(new PlannedValidation(validator.GetValidator(), model, ctx));
            }
            foreach (var property in metadata.Properties)
            {
                foreach (var validator in property.Validators)
                {
                    if (validator.IsAsync != isAsync || !predicate(validator, property)) continue;
                    var ctx = CreateContext(validator, property);
                    if (validator.EvalCondition(ctx, resolver)) planned.Add(new PlannedValidation(validator.GetValidator(), property.GetValue(model, _options.NamingConvention), ctx));
                }
            }
            return planned;
        }
    }
}
