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

  get propertyName(): string | undefined {
    return this.context.propertyName;
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
