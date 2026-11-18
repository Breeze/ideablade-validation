import type { ValidationContext, ValidatorFunctionContext } from './context.js';
import type { Validator } from './validator.js';

/** Message used when a validator has no message template. */
export const GENERIC_ERROR_MESSAGE = 'Invalid value';

/** Replaces `%path.to.value%` placeholders in a template with values from the context. */
export function formatMessage(template: string | undefined, context: Record<string, unknown>): string {
  if (!template) {
    return GENERIC_ERROR_MESSAGE;
  }
  return template.replace(/%([\w.]+)%/g, (_match, path: string) => {
    const value = getPath(context, path);
    return value == null ? '' : String(value);
  });
}

/** Reads a dotted path (`a.b.c`) from an object. Returns undefined for missing segments. */
export function getPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const segment of path.split('.')) {
    if (current == null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** A single validation failure. */
export class ValidationError {
  constructor(
    /** Key of the form `name[_group][_propertyName]`; unique per validator usage on a model. */
    readonly key: string,
    readonly context: ValidatorFunctionContext,
    readonly validator: Validator,
  ) {}

  /** Stable identifier from the metadata (`id`), or the key if no id was configured. */
  get id(): string {
    return this.validator.metadata?.id ?? this.key;
  }

  /**
   * The properties the error is about. For a property rule, the property. For a model-level rule, the properties it
   * names (`propertyNames` in the metadata, or set by the validator), such as both dates of a "start before end"
   * rule; empty when it is about the model as a whole.
   */
  get propertyNames(): readonly string[] {
    const names = this.context.propertyNames;
    if (names?.length) {
      return names;
    }
    return this.context.propertyName ? [this.context.propertyName] : [];
  }

  /** True when the error is about `propertyName` (one of its {@link propertyNames}). */
  isFor(propertyName: string): boolean {
    return this.propertyNames.includes(propertyName);
  }

  get model(): unknown {
    return this.context.model;
  }

  get modelType(): string {
    return this.context.modelType;
  }

  /** The value that failed validation. */
  get value(): unknown {
    return this.context.value;
  }

  get errorMessage(): string {
    return this.getErrorMessage();
  }

  /** Formats the message template, optionally overriding the display name. */
  getErrorMessage(displayName?: string): string {
    const ctx: ValidationContext = {
      ...this.context,
      displayName: displayName || this.context.displayName || this.context.propertyName || '',
    };
    return formatMessage(ctx.messageTemplate, ctx);
  }

  toString(): string {
    return this.errorMessage;
  }
}
