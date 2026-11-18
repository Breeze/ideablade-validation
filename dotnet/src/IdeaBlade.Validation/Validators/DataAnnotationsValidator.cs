using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using DataAnnotations = System.ComponentModel.DataAnnotations;

namespace IdeaBlade.Validation.Validators
{
    /// <summary>
    /// A model-level validator that runs the model's data annotations (<c>[Required]</c>, <c>[StringLength]</c>, any
    /// <see cref="DataAnnotations.ValidationAttribute"/>, and <see cref="DataAnnotations.IValidatableObject"/>) and reports
    /// each failure as a framework <see cref="ValidationError"/>, so they surface like every other rule.
    ///
    /// <para>
    /// It is the server's counterpart of the client's <c>breeze</c> validator: Breeze builds its client-side rules from
    /// these annotations, so registering this one under the name <c>breeze</c> (<c>AddDataAnnotations("breeze")</c>)
    /// lets one metadata entry, <c>{ "global": { "validators": ["breeze"] } }</c>, run the same rules on both sides.
    /// </para>
    /// <para>
    /// An error's key follows the framework's convention, named after the attribute (<c>required_City</c>,
    /// <c>stringLength_Zipcode</c>); its property is the CLR property, and its message is the annotation's own, which
    /// names the property by its <c>[Display]</c> name or, without one, as it's named in the model.
    /// </para>
    /// </summary>
    public sealed class DataAnnotationsValidator : Validator
    {
        public DataAnnotationsValidator(string name, string? group, ValidationContextBase? context) : base(name, group, context) { }

        /// <summary>A factory for this validator under <paramref name="name"/>.</summary>
        public static ValidatorFactory Factory(string name = "dataAnnotations") =>
            new ValidatorFactory(name, (group, context) => new DataAnnotationsValidator(name, group, context));

        public override IReadOnlyList<ValidationError> ValidateAll(object? value, ValidationContext? context = null)
        {
            if (value == null) return Array.Empty<ValidationError>();
            var errors = new List<ValidationError>();
            var services = new Dictionary<object, object?>();

            foreach (var property in value.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance))
            {
                if (property.GetIndexParameters().Length > 0) continue;
                var attributes = property.GetCustomAttributes<DataAnnotations.ValidationAttribute>(true).ToList();
                if (attributes.Count == 0) continue;

                var propertyValue = property.GetValue(value);
                var annotationContext = new DataAnnotations.ValidationContext(value, null, services)
                {
                    MemberName = property.Name,
                    DisplayName = property.GetCustomAttribute<DataAnnotations.DisplayAttribute>()?.GetName() ?? property.Name,
                };
                foreach (var attribute in attributes)
                {
                    var result = attribute.GetValidationResult(propertyValue, annotationContext);
                    if (result != DataAnnotations.ValidationResult.Success && result != null)
                    {
                        errors.Add(Error(KeyName(attribute), property.Name, propertyValue, result.ErrorMessage, context));
                    }
                }
            }

            if (value is DataAnnotations.IValidatableObject validatable)
            {
                foreach (var result in validatable.Validate(new DataAnnotations.ValidationContext(value, null, services)))
                {
                    var propertyName = result.MemberNames?.FirstOrDefault();
                    var propertyValue = propertyName == null ? value : value.GetType().GetProperty(propertyName)?.GetValue(value);
                    errors.Add(Error("validatableObject", propertyName, propertyValue, result.ErrorMessage, context));
                }
            }
            return errors;
        }

        protected override bool ValidateCore(object? value, ValidatorFunctionContext context) => ValidateAll(value, context).Count == 0;

        private ValidationError Error(string name, string? propertyName, object? value, string? message, ValidationContext? context)
        {
            var ctx = GetValidatorFunctionContext(value, context);
            ctx.PropertyName = propertyName;
            ctx.DisplayName = propertyName;
            // The annotation has already formatted the message.
            ctx.MessageTemplate = string.IsNullOrEmpty(message) ? ValidationError.GenericErrorMessage : message;
            var key = string.Join("_", new[] { name, Group, propertyName }.Where(s => !string.IsNullOrEmpty(s)));
            return new ValidationError(key, ctx, this);
        }

        /// <summary><c>RequiredAttribute</c> → <c>required</c>, <c>StringLengthAttribute</c> → <c>stringLength</c>.</summary>
        private static string KeyName(DataAnnotations.ValidationAttribute attribute)
        {
            var name = attribute.GetType().Name;
            if (name.EndsWith("Attribute", StringComparison.Ordinal)) name = name.Substring(0, name.Length - "Attribute".Length);
            return name.Length == 0 ? "dataAnnotation" : char.ToLowerInvariant(name[0]) + name.Substring(1);
        }
    }
}
