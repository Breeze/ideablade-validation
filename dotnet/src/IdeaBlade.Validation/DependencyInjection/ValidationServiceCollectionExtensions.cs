using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using IdeaBlade.Validation;
using IdeaBlade.Validation.Expressions;
using IdeaBlade.Validation.Metadata;
using IdeaBlade.Validation.Validators;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Microsoft.Extensions.DependencyInjection
{
    /// <summary>Configures IdeaBlade.Validation for dependency injection.</summary>
    public sealed class ValidationBuilder
    {
        internal readonly List<Func<IServiceProvider, IEnumerable<ModelValidationMetadataMap>>> MetadataSources = new List<Func<IServiceProvider, IEnumerable<ModelValidationMetadataMap>>>();
        internal readonly List<ValidatorFactory> Validators = new List<ValidatorFactory>();
        internal readonly List<Action<ValidationServiceOptions>> OptionActions = new List<Action<ValidationServiceOptions>>();
        internal readonly List<Action<SafeExpressionEvaluatorOptions>> EvaluatorActions = new List<Action<SafeExpressionEvaluatorOptions>>();
        internal Func<IServiceProvider, IExpressionEvaluator>? EvaluatorFactory;
        internal bool IncludeDefaultValidators = true;

        internal ValidationBuilder(IServiceCollection services) { Services = services; }

        public IServiceCollection Services { get; }

        /// <summary>Adds a parsed metadata map.</summary>
        public ValidationBuilder AddMetadata(ModelValidationMetadataMap metadata)
        {
            MetadataSources.Add(_ => new[] { metadata });
            return this;
        }

        /// <summary>Adds metadata from a JSON string.</summary>
        public ValidationBuilder AddMetadataJson(string json) => AddMetadata(ModelValidationMetadataMap.Parse(json));

        /// <summary>Adds metadata from a stream (read immediately).</summary>
        public ValidationBuilder AddMetadataStream(Stream stream) => AddMetadata(ModelValidationMetadataMap.Load(stream));

        /// <summary>Adds metadata from a JSON file (read when the metadata is first resolved).</summary>
        public ValidationBuilder AddMetadataFile(string path)
        {
            MetadataSources.Add(_ => new[] { ModelValidationMetadataMap.LoadFile(path) });
            return this;
        }

        /// <summary>Adds every metadata file in a directory matching <paramref name="searchPattern"/> (read when first resolved).</summary>
        public ValidationBuilder AddMetadataDirectory(string directory, string searchPattern = "*validation.metadata.json")
        {
            MetadataSources.Add(_ => Directory.GetFiles(directory, searchPattern).OrderBy(f => f, StringComparer.Ordinal).Select(ModelValidationMetadataMap.LoadFile).ToList());
            return this;
        }

        /// <summary>Adds metadata produced from services (e.g. loaded from a database).</summary>
        public ValidationBuilder AddMetadata(Func<IServiceProvider, IEnumerable<ModelValidationMetadataMap>> factory)
        {
            MetadataSources.Add(factory);
            return this;
        }

        /// <summary>Registers validator factories (in addition to the default validators).</summary>
        public ValidationBuilder AddValidators(params ValidatorFactory[] factories)
        {
            Validators.AddRange(factories);
            return this;
        }

        /// <summary>Don't register <see cref="DefaultValidators.All"/>.</summary>
        public ValidationBuilder ExcludeDefaultValidators()
        {
            IncludeDefaultValidators = false;
            return this;
        }

        /// <summary>Registers a context provider (resolved per scope, so it may depend on scoped services such as the current user).</summary>
        public ValidationBuilder AddContextProvider<T>() where T : class, IValidatorContextProvider
        {
            Services.AddScoped<IValidatorContextProvider, T>();
            return this;
        }

        /// <summary>Makes a trusted function or value available to all expressions under <paramref name="name"/>.</summary>
        public ValidationBuilder AddExpressionFunction(string name, Delegate function)
        {
            OptionActions.Add(o => o.ExpressionScope[name] = function);
            return this;
        }

        /// <summary>Configures service options (async timeout, model type resolver, ...).</summary>
        public ValidationBuilder Configure(Action<ValidationServiceOptions> configure)
        {
            OptionActions.Add(configure);
            return this;
        }

        /// <summary>Configures the default <see cref="SafeExpressionEvaluator"/> (allowed methods, step budget, ...).</summary>
        public ValidationBuilder ConfigureExpressions(Action<SafeExpressionEvaluatorOptions> configure)
        {
            EvaluatorActions.Add(configure);
            return this;
        }

        /// <summary>Replaces the expression evaluator.</summary>
        public ValidationBuilder UseExpressionEvaluator(Func<IServiceProvider, IExpressionEvaluator> factory)
        {
            EvaluatorFactory = factory;
            return this;
        }
    }

    public static class ValidationServiceCollectionExtensions
    {
        /// <summary>
        /// Registers <see cref="ValidationMetadata"/> (singleton), <see cref="IExpressionEvaluator"/> (singleton) and
        /// <see cref="ValidationService"/> (scoped, so context providers can use scoped services).
        /// </summary>
        public static IServiceCollection AddIdeaBladeValidation(this IServiceCollection services, Action<ValidationBuilder>? configure = null)
        {
            var builder = new ValidationBuilder(services);
            configure?.Invoke(builder);

            services.TryAddSingleton<IExpressionEvaluator>(sp =>
            {
                if (builder.EvaluatorFactory != null) return builder.EvaluatorFactory(sp);
                var options = new SafeExpressionEvaluatorOptions();
                foreach (var action in builder.EvaluatorActions) action(options);
                return new SafeExpressionEvaluator(options);
            });
            services.TryAddSingleton(sp => new ValidationMetadata(
                builder.MetadataSources.SelectMany(source => source(sp)).ToList(),
                (builder.IncludeDefaultValidators ? DefaultValidators.All : Enumerable.Empty<ValidatorFactory>()).Concat(builder.Validators),
                sp.GetRequiredService<IExpressionEvaluator>()));
            services.TryAddSingleton(_ =>
            {
                var options = new ValidationServiceOptions();
                foreach (var action in builder.OptionActions) action(options);
                return options;
            });
            services.TryAddScoped(sp => new ValidationService(
                sp.GetRequiredService<ValidationMetadata>(),
                sp.GetServices<IValidatorContextProvider>(),
                sp.GetRequiredService<ValidationServiceOptions>()));
            return services;
        }
    }
}
