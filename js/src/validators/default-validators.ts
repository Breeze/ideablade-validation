/**
 * Generic validators usable in any application. Register them with `defaultValidators`.
 * Message templates can be overridden per usage with `context.messageTemplate`.
 */
import type { ValidationContextBase, ValidatorFunctionContext } from '../core/context.js';
import { SyncValidator, type ValidatorFactory, withMessage } from '../core/validator.js';
import { formatBound, resolveBound, toComparable } from './range-bounds.js';

type Ctx = Partial<ValidationContextBase> | undefined;

function isEmpty(value: unknown): boolean {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0);
}

/** `required` — fails for null, undefined, '' and empty arrays. With `context.trim: true` whitespace-only strings fail too. */
export class RequiredValidator extends SyncValidator {
  static readonly messageTemplate = '%displayName% is required';

  constructor(group?: string, context?: Ctx, name = 'required') {
    super(
      name,
      group,
      (value, ctx) => {
        if (Array.isArray(value)) {
          return value.length > 0;
        }
        if (typeof value === 'string') {
          return (ctx.trim ? value.trim() : value) !== '';
        }
        return value != null;
      },
      withMessage(context, RequiredValidator.messageTemplate),
    );
  }

  static create(group?: string, context?: Ctx): RequiredValidator {
    return new RequiredValidator(group, context);
  }
}

/** `minLength` — strings (or arrays) must have at least `context.minLength` characters (items). Empty values pass. */
export class MinLengthValidator extends SyncValidator {
  static readonly messageTemplate = '%displayName% must be at least %minLength% characters';

  constructor(group?: string, context?: Ctx) {
    super(
      'minLength',
      group,
      (value, ctx) => {
        if (isEmpty(value)) {
          return true;
        }
        return (typeof value === 'string' || Array.isArray(value)) && value.length >= Number(ctx.minLength);
      },
      withMessage(context, MinLengthValidator.messageTemplate),
    );
  }

  static create(group?: string, context?: Ctx): MinLengthValidator {
    return new MinLengthValidator(group, context);
  }
}

/** `maxLength` — strings (or arrays) must have at most `context.maxLength` characters (items). Empty values pass. */
export class MaxLengthValidator extends SyncValidator {
  static readonly messageTemplate = '%displayName% must be at most %maxLength% characters';

  constructor(group?: string, context?: Ctx) {
    super(
      'maxLength',
      group,
      (value, ctx) => {
        if (isEmpty(value)) {
          return true;
        }
        return (typeof value === 'string' || Array.isArray(value)) && value.length <= Number(ctx.maxLength);
      },
      withMessage(context, MaxLengthValidator.messageTemplate),
    );
  }

  static create(group?: string, context?: Ctx): MaxLengthValidator {
    return new MaxLengthValidator(group, context);
  }
}

/** Converts `context.expression` (RegExp, `"/src/flags"` or a plain pattern string + `context.flags`) to a RegExp. */
export function toRegExp(expression: unknown, flags?: string): RegExp {
  if (expression instanceof RegExp) {
    return expression;
  }
  if (typeof expression !== 'string') {
    throw new Error('Regular expression validator requires context.expression');
  }
  const literal = /^\/(.*)\/([a-z]*)$/s.exec(expression);
  return literal ? new RegExp(literal[1], literal[2]) : new RegExp(expression, flags);
}

/**
 * Regular expression validator. Registered as `pattern` for use from JSON metadata:
 * `{ "name": "pattern", "context": { "expression": "^[A-Z]{3}$", "flags": "i" } }`. Empty values pass;
 * non-string values are converted with `String()`.
 */
export class RegExpValidator extends SyncValidator {
  static readonly messageTemplate = "%displayName% '%value%' does not match the required format";

  constructor(name: string, group?: string, context?: Ctx) {
    const regex = context?.expression !== undefined ? toRegExp(context.expression, context.flags) : undefined;
    super(
      name,
      group,
      (value, ctx) => {
        if (isEmpty(value)) {
          return true;
        }
        const re = regex ?? toRegExp(ctx.expression, ctx.flags);
        re.lastIndex = 0;
        return re.test(typeof value === 'string' ? value : String(value));
      },
      withMessage(context, RegExpValidator.messageTemplate),
    );
  }

  static create(name: string, group?: string, context?: Ctx): RegExpValidator {
    return new RegExpValidator(name, group, context);
  }
}

function regExpFactory(name: string, expression: RegExp, messageTemplate: string): ValidatorFactory {
  return {
    name,
    fn: (group, context) =>
      new RegExpValidator(name, group, { ...context, expression, messageTemplate: context?.messageTemplate || messageTemplate }),
  };
}

// eslint-disable-next-line no-control-regex
export const EMAIL_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~ -￯-]+@[a-z0-9 -￯](?:[a-z0-9 -￯-]{0,61}[a-z0-9 -￯])?(?:\.[a-z0-9 -￯](?:[a-z0-9 -￯-]{0,61}[a-z0-9 -￯])?)+$/i;
export const US_ZIP_PATTERN = /^\d{5}(-\d{4})?$/;
/** 10-digit US phone number; punctuation and spaces allowed. */
export const US_PHONE_PATTERN = /^\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}$/;
export const CURRENCY_PATTERN = /^[+-]?\$?[0-9]{1,3}(?:,?[0-9]{3})*(?:\.[0-9]{1,2})?$/;
/** US Social Security number, with or without dashes. */
export const SSN_PATTERN = /^(\d{3}-\d{2}-\d{4}|\d{9})$/;
/** US Federal Employer Identification Number, `##-#######`. */
export const FEIN_PATTERN = /^\d{2}-\d{7}$/;

export const makeEmailValidator = regExpFactory('email', EMAIL_PATTERN, '%displayName% is not a valid email address').fn;
export const makeZipCodeValidator = regExpFactory('zipCode', US_ZIP_PATTERN, '%displayName% is not a valid U.S. zip code').fn;
export const makePhoneValidator = regExpFactory('phone', US_PHONE_PATTERN, '%displayName% must be a 10-digit phone number').fn;
export const makeSocialSecurityNumberValidator = regExpFactory('social', SSN_PATTERN, '%displayName% must be a valid Social Security number').fn;
export const makeFeinValidator = regExpFactory('fein', FEIN_PATTERN, "%displayName% must have the format '##-#######'").fn;

/** `currency` — numbers pass; strings must look like an amount (`1,234.56`, `-12`, `$5.00`). */
export class CurrencyValidator extends SyncValidator {
  static readonly messageTemplate = '%displayName% must be a valid currency amount';

  constructor(group?: string, context?: Ctx) {
    super(
      'currency',
      group,
      (value) => {
        if (isEmpty(value)) {
          return true;
        }
        if (typeof value === 'number') {
          return Number.isFinite(value);
        }
        return typeof value === 'string' && CURRENCY_PATTERN.test(value.trim());
      },
      withMessage(context, CurrencyValidator.messageTemplate),
    );
  }

  static create(group?: string, context?: Ctx): CurrencyValidator {
    return new CurrencyValidator(group, context);
  }
}

/**
 * `numeric` — the value must be a number or a numeric string.
 * Context: `allowDecimals` (default false), `allowLeadingZeros` (default false), `allowNegative` (default false).
 */
export class NumericValidator extends SyncValidator {
  constructor(group?: string, context?: Ctx, name = 'numeric') {
    const allowDecimals = !!context?.allowDecimals;
    const allowLeadingZeros = !!context?.allowLeadingZeros;
    const allowNegative = !!context?.allowNegative;
    const sign = allowNegative ? '-?' : '';
    const whole = allowLeadingZeros ? '[0-9]+' : '(?:0|[1-9][0-9]*)';
    const pattern = new RegExp(`^${sign}${whole}${allowDecimals ? '(?:\\.[0-9]+)?' : ''}$`);
    const defaultMessage = allowLeadingZeros
      ? '%displayName% must be a numeric value with optional leading zeros'
      : allowDecimals
        ? '%displayName% must be a number'
        : '%displayName% must be a whole number';
    super(
      name,
      group,
      (value) => {
        if (isEmpty(value)) {
          return true;
        }
        if (typeof value === 'number') {
          return Number.isFinite(value) && (allowDecimals || Number.isInteger(value)) && (allowNegative || value >= 0);
        }
        return typeof value === 'string' && pattern.test(value.trim());
      },
      withMessage(context, defaultMessage),
    );
  }

  static create(group?: string, context?: Ctx): NumericValidator {
    return new NumericValidator(group, context);
  }
}

/** `integer` — whole numbers (negative allowed). */
export const makeIntegerValidator = (group?: string, context?: Ctx) =>
  new NumericValidator(group, { allowNegative: true, ...context, allowDecimals: false, messageTemplate: context?.messageTemplate || '%displayName% must be an integer' }, 'integer');

/**
 * `range` (also `numericRange`, `dateRange`) — value must be between `context.minValue` and `context.maxValue`
 * (inclusive; either may be omitted). Bounds may be numbers, dates or relative expressions such as
 * `now-18y`, `today`, `year+1` — see {@link resolveBound}. Set `exclusive: true` for exclusive bounds.
 * Messages can use %minValue%, %maxValue% and the formatted %minValueText%, %maxValueText%.
 */
export class RangeValidator extends SyncValidator {
  static readonly messageTemplate = '%displayName% must be between %minValueText% and %maxValueText%';
  static readonly minMessageTemplate = '%displayName% must be at least %minValueText%';
  static readonly maxMessageTemplate = '%displayName% must be at most %maxValueText%';

  constructor(name = 'range', group?: string, context?: Ctx) {
    const template =
      context?.minValue == null && context?.maxValue != null
        ? RangeValidator.maxMessageTemplate
        : context?.maxValue == null && context?.minValue != null
          ? RangeValidator.minMessageTemplate
          : RangeValidator.messageTemplate;
    super(name, group, (value, ctx) => RangeValidator.check(value, ctx), withMessage(context, template));
  }

  private static check(value: unknown, ctx: ValidatorFunctionContext): boolean {
    if (isEmpty(value)) {
      return true;
    }
    const min = resolveBound(ctx.minValue);
    const max = resolveBound(ctx.maxValue);
    ctx.minValueText = formatBound(min);
    ctx.maxValueText = formatBound(max);

    const like = min ?? max;
    const v = toComparable(value, like);
    if (v === undefined) {
      return false;
    }
    const lo = min === undefined ? undefined : toComparable(min, like);
    const hi = max === undefined ? undefined : toComparable(max, like);
    if (ctx.exclusive) {
      return (lo === undefined || v > lo) && (hi === undefined || v < hi);
    }
    return (lo === undefined || v >= lo) && (hi === undefined || v <= hi);
  }

  static create(group?: string, context?: Ctx): RangeValidator {
    return new RangeValidator('range', group, context);
  }
}

/** `date` — the value must be a valid Date (or a parseable date string when `context.allowString` is true). */
export class DateValidator extends SyncValidator {
  static readonly messageTemplate = '%displayName% must be a valid date';

  constructor(group?: string, context?: Ctx) {
    super(
      'date',
      group,
      (value, ctx) => {
        if (isEmpty(value)) {
          return true;
        }
        if (value instanceof Date) {
          return !Number.isNaN(value.getTime());
        }
        return !!ctx.allowString && typeof value === 'string' && !Number.isNaN(Date.parse(value));
      },
      withMessage(context, DateValidator.messageTemplate),
    );
  }

  static create(group?: string, context?: Ctx): DateValidator {
    return new DateValidator(group, context);
  }
}

/**
 * `compare` — compares the value with another property of the model: `{ "other": "startDate", "op": ">=" }`.
 * Operators: `==`, `!=`, `<`, `<=`, `>`, `>=`. Dates are compared by time. Empty values pass.
 */
export class CompareValidator extends SyncValidator {
  static readonly messageTemplate = '%displayName% is invalid';

  constructor(group?: string, context?: Ctx) {
    super(
      'compare',
      group,
      (value, ctx) => {
        if (isEmpty(value)) {
          return true;
        }
        const raw = ctx.model?.[ctx.other];
        const a = value instanceof Date ? value.getTime() : value;
        const b = raw instanceof Date ? raw.getTime() : raw;
        switch (ctx.op) {
          case '==':
          case '===':
            return a === b;
          case '!=':
          case '!==':
            return a !== b;
          case '<':
            return a < b;
          case '<=':
            return a <= b;
          case '>':
            return a > b;
          case '>=':
            return a >= b;
          default:
            throw new Error(`compare validator: unknown operator '${ctx.op}'`);
        }
      },
      withMessage(context, CompareValidator.messageTemplate),
    );
  }

  static create(group?: string, context?: Ctx): CompareValidator {
    return new CompareValidator(group, context);
  }
}

function matchesEntry(entry: unknown, value: unknown): boolean {
  if (typeof entry === 'string') {
    const literal = /^\/(.*)\/([a-z]*)$/s.exec(entry);
    if (literal) {
      return new RegExp(literal[1], literal[2]).test(String(value));
    }
  }
  // eslint-disable-next-line eqeqeq
  return entry == value || String(entry) === String(value);
}

/** `invalidValues` — the value must not equal any of `context.values` (entries of the form `/regex/flags` are patterns). */
export class InvalidValuesValidator extends SyncValidator {
  static readonly messageTemplate = "'%value%' is not a valid value for %displayName%";

  constructor(group?: string, context?: Ctx) {
    super(
      'invalidValues',
      group,
      (value, ctx) => isEmpty(value) || !((ctx.values ?? []) as unknown[]).some((v) => matchesEntry(v, value)),
      withMessage(context, InvalidValuesValidator.messageTemplate),
    );
  }

  static create(group?: string, context?: Ctx): InvalidValuesValidator {
    return new InvalidValuesValidator(group, context);
  }
}

/** `validValues` — the value must equal one of `context.values` (entries of the form `/regex/flags` are patterns). */
export class ValidValuesValidator extends SyncValidator {
  static readonly messageTemplate = "'%value%' is not a valid value for %displayName%";

  constructor(group?: string, context?: Ctx) {
    super(
      'validValues',
      group,
      (value, ctx) => isEmpty(value) || ((ctx.values ?? []) as unknown[]).some((v) => matchesEntry(v, value)),
      withMessage(context, ValidValuesValidator.messageTemplate),
    );
  }

  static create(group?: string, context?: Ctx): ValidValuesValidator {
    return new ValidValuesValidator(group, context);
  }
}

/**
 * `expression` — evaluates `context.expression` with the safe expression evaluator; truthy means valid.
 * Variables: `value`, `model`, `context`, `isClient`, `isServer`, `store(entityType)` (when an entity store is
 * available) and any registered expression scope. Unlike other validators it also runs for empty values unless
 * `context.skipEmpty` is true (model-level expressions receive the model as value).
 */
export class ExpressionValidator extends SyncValidator {
  static readonly messageTemplate = '%displayName% is invalid';

  constructor(group?: string, context?: Ctx) {
    super(
      'expression',
      group,
      (value, ctx) => {
        if (ctx.skipEmpty && isEmpty(value)) {
          return true;
        }
        const evaluator = ctx.expressionEvaluator;
        if (!evaluator) {
          throw new Error('expression validator: no expression evaluator in context');
        }
        return !!evaluator.evaluate(String(ctx.expression), {
          ...ctx.expressionScope,
          value,
          model: ctx.model,
          context: ctx,
          isClient: ctx.isClient,
          isServer: ctx.isServer,
        });
      },
      withMessage(context, ExpressionValidator.messageTemplate),
    );
  }

  static create(group?: string, context?: Ctx): ExpressionValidator {
    return new ExpressionValidator(group, context);
  }
}

/**
 * `unique` (sync) — no other entity of the same type in the store may have the same property value.
 * Requires a store (`store(entityType)`), e.g. when validating an entity store or passing `options.store`.
 * Context: `ignoreCase` (default false).
 */
export class UniqueValidator extends SyncValidator {
  static readonly messageTemplate = '%displayName% must be unique';

  constructor(group?: string, context?: Ctx) {
    super(
      'unique',
      group,
      (value, ctx) => {
        if (isEmpty(value) || !ctx.propertyName) {
          return true;
        }
        const store = ctx.expressionScope?.store as ((type: string) => readonly unknown[]) | undefined;
        if (!store) {
          return true;
        }
        const norm = (v: unknown) => (ctx.ignoreCase && typeof v === 'string' ? v.toLowerCase() : v);
        const target = norm(value);
        return !store(ctx.modelType).some(
          (other) => other !== ctx.model && other !== ctx.originalModel && norm((other as Record<string, unknown>)?.[ctx.propertyName!]) === target,
        );
      },
      withMessage(context, UniqueValidator.messageTemplate),
    );
  }

  static create(group?: string, context?: Ctx): UniqueValidator {
    return new UniqueValidator(group, context);
  }
}

const range = (name: string): ValidatorFactory => ({ name, fn: (group, context) => new RangeValidator(name, group, context) });

/** All generic validators, keyed by their metadata names. */
export const defaultValidators: readonly ValidatorFactory[] = Object.freeze<ValidatorFactory[]>([
  { name: 'required', fn: RequiredValidator.create },
  { name: 'minLength', fn: MinLengthValidator.create },
  { name: 'maxLength', fn: MaxLengthValidator.create },
  { name: 'pattern', fn: (group, context) => RegExpValidator.create('pattern', group, context) },
  { name: 'email', fn: makeEmailValidator },
  { name: 'zipCode', fn: makeZipCodeValidator },
  { name: 'phone', fn: makePhoneValidator },
  { name: 'social', fn: makeSocialSecurityNumberValidator },
  { name: 'fein', fn: makeFeinValidator },
  { name: 'currency', fn: CurrencyValidator.create },
  { name: 'numeric', fn: NumericValidator.create },
  { name: 'integer', fn: makeIntegerValidator },
  range('range'),
  range('numericRange'),
  range('dateRange'),
  { name: 'date', fn: DateValidator.create },
  { name: 'compare', fn: CompareValidator.create },
  { name: 'invalidValues', fn: InvalidValuesValidator.create },
  { name: 'validValues', fn: ValidValuesValidator.create },
  { name: 'expression', fn: ExpressionValidator.create },
  { name: 'unique', fn: UniqueValidator.create },
]);
