using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using IdeaBlade.Validation.Metadata;

namespace IdeaBlade.Validation
{
    /// <summary>Base class with key/context helpers shared by all validators.</summary>
    public abstract class ValidatorBase
    {
        protected ValidatorBase(string name, string? group, ValidationContextBase? context)
        {
            Name = name;
            Group = group;
            Context = context ?? new ValidationContextBase();
        }

        public string Name { get; }
        public string? Group { get; }
        public ValidationContextBase Context { get; }
        public abstract bool IsAsync { get; }

        /// <summary>Set by the framework to the metadata the validator was created from.</summary>
        public ValidatorMetadata? Metadata { get; set; }

        protected string GetKey(ValidationContext? context)
        {
            var key = Name;
            if (!string.IsNullOrEmpty(Group)) key = $"{key}_{Group}";
            if (!string.IsNullOrEmpty(context?.PropertyName)) key = $"{key}_{context!.PropertyName}";
            return key;
        }

        protected ValidatorFunctionContext GetValidatorFunctionContext(object? value, ValidationContext? context)
        {
            var ctx = new ValidatorFunctionContext(Context);
            if (context != null)
            {
                foreach (var kvp in context) ctx[kvp.Key] = kvp.Value;
            }
            var displayName = context?.DisplayName;
            if (string.IsNullOrEmpty(displayName)) displayName = Context.DisplayName;
            if (string.IsNullOrEmpty(displayName)) displayName = context?.PropertyName;
            ctx.DisplayName = displayName;
            ctx.Value = value;
            ctx.ValidatorName = Name;
            return ctx;
        }

        protected ValidationError CreateError(ValidatorFunctionContext ctx, Exception? exception = null)
        {
            if (exception != null) ctx["exception"] = exception;
            return new ValidationError(GetKey(ctx), ctx, this);
        }

        /// <summary>Returns <paramref name="context"/> (copied) with a default message template if it has none.</summary>
        protected static ValidationContextBase WithMessage(ValidationContextBase? context, string defaultTemplate)
        {
            var ctx = new ValidationContextBase(context);
            if (string.IsNullOrEmpty(ctx.MessageTemplate)) ctx.MessageTemplate = defaultTemplate;
            return ctx;
        }
    }

    /// <summary>A synchronous validator. An exception thrown by <see cref="ValidateCore"/> counts as a failure.</summary>
    public abstract class Validator : ValidatorBase
    {
        protected Validator(string name, string? group, ValidationContextBase? context) : base(name, group, context) { }

        public sealed override bool IsAsync => false;

        /// <summary>
        /// Runs this validator and returns its errors, empty when the value is valid. By default that's one error when
        /// <see cref="ValidateCore"/> fails. A validator that reports several errors in one pass, such as
        /// <see cref="Validators.DataAnnotationsValidator"/> (one per failed attribute), overrides this.
        /// </summary>
        public virtual IReadOnlyList<ValidationError> Validate(object? value, ValidationContext? context = null)
        {
            var ctx = GetValidatorFunctionContext(value, context);
            try
            {
                return ValidateCore(value, ctx) ? Array.Empty<ValidationError>() : new[] { CreateError(ctx) };
            }
            catch (Exception e)
            {
                return new[] { CreateError(ctx, e) };
            }
        }

        /// <summary>Returns true when the value is valid.</summary>
        protected abstract bool ValidateCore(object? value, ValidatorFunctionContext context);
    }

    /// <summary>An asynchronous validator. Exceptions (other than cancellation) count as failures.</summary>
    public abstract class AsyncValidator : ValidatorBase
    {
        protected AsyncValidator(string name, string? group, ValidationContextBase? context) : base(name, group, context) { }

        public sealed override bool IsAsync => true;

        /// <summary>
        /// Runs this validator and returns its errors, empty when the value is valid. By default that's one error when
        /// <see cref="ValidateCoreAsync"/> fails. A validator that reports several errors in one pass overrides this.
        /// </summary>
        public virtual async Task<IReadOnlyList<ValidationError>> ValidateAsync(object? value, ValidationContext? context = null, CancellationToken cancellationToken = default)
        {
            var ctx = GetValidatorFunctionContext(value, context);
            try
            {
                return await ValidateCoreAsync(value, ctx, cancellationToken).ConfigureAwait(false) ? Array.Empty<ValidationError>() : new[] { CreateError(ctx) };
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception e)
            {
                return new[] { CreateError(ctx, e) };
            }
        }

        /// <summary>Returns true when the value is valid.</summary>
        protected abstract Task<bool> ValidateCoreAsync(object? value, ValidatorFunctionContext context, CancellationToken cancellationToken);
    }

    /// <summary>Creates a validator for a group and configured context.</summary>
    public delegate ValidatorBase ValidatorFactoryFunction(string? group, ValidationContextBase? context);

    /// <summary>A named validator factory. Validators are referenced by name from the metadata.</summary>
    public sealed class ValidatorFactory
    {
        public ValidatorFactory(string name, ValidatorFactoryFunction fn)
        {
            if (string.IsNullOrEmpty(name)) throw new ArgumentException("Validator factory needs a name", nameof(name));
            Name = name;
            Fn = fn ?? throw new ArgumentNullException(nameof(fn));
        }

        public string Name { get; }
        public ValidatorFactoryFunction Fn { get; }

        /// <summary>Defines a synchronous validator from a predicate (true = valid).</summary>
        public static ValidatorFactory Sync(string name, Func<object?, ValidatorFunctionContext, bool> predicate, string defaultMessageTemplate = "%displayName% is invalid") =>
            new ValidatorFactory(name, (group, context) => new DelegateValidator(name, group, predicate, context, defaultMessageTemplate));

        /// <summary>Defines an asynchronous validator from a predicate (true = valid).</summary>
        public static ValidatorFactory Async(string name, Func<object?, ValidatorFunctionContext, CancellationToken, Task<bool>> predicate, string defaultMessageTemplate = "%displayName% is invalid") =>
            new ValidatorFactory(name, (group, context) => new DelegateAsyncValidator(name, group, predicate, context, defaultMessageTemplate));

        private sealed class DelegateValidator : Validator
        {
            private readonly Func<object?, ValidatorFunctionContext, bool> _predicate;

            public DelegateValidator(string name, string? group, Func<object?, ValidatorFunctionContext, bool> predicate, ValidationContextBase? context, string template)
                : base(name, group, WithMessage(context, template))
            {
                _predicate = predicate;
            }

            protected override bool ValidateCore(object? value, ValidatorFunctionContext context) => _predicate(value, context);
        }

        private sealed class DelegateAsyncValidator : AsyncValidator
        {
            private readonly Func<object?, ValidatorFunctionContext, CancellationToken, Task<bool>> _predicate;

            public DelegateAsyncValidator(string name, string? group, Func<object?, ValidatorFunctionContext, CancellationToken, Task<bool>> predicate, ValidationContextBase? context, string template)
                : base(name, group, WithMessage(context, template))
            {
                _predicate = predicate;
            }

            protected override Task<bool> ValidateCoreAsync(object? value, ValidatorFunctionContext context, CancellationToken cancellationToken) =>
                _predicate(value, context, cancellationToken);
        }
    }

    /// <summary>Supplies additional context values for a model before it is validated (current user, services, ...).</summary>
    public interface IValidatorContextProvider
    {
        IDictionary<string, object?>? GetContext(object model, string modelType);
    }

    /// <summary>A source of entities to validate together (e.g. a save bundle).</summary>
    public interface IValidationEntityStore
    {
        IReadOnlyList<object> Entities { get; }
    }

    /// <summary>Optional fast lookup of entities by model type, used for the <c>store(entityType)</c> expression function.</summary>
    public interface IValidationEntityTypeLookup
    {
        IEnumerable<object> GetEntities(string entityType);
    }

    /// <summary>A simple list-backed <see cref="IValidationEntityStore"/>.</summary>
    public sealed class ValidationEntityStore : IValidationEntityStore
    {
        public ValidationEntityStore(IEnumerable<object> entities) { Entities = new List<object>(entities); }
        public IReadOnlyList<object> Entities { get; }
    }
}
