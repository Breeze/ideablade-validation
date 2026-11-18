// Core
export * from './core/context.js';
export * from './core/metadata-config.js';
export * from './core/metadata.js';
export * from './core/validation-error.js';
export * from './core/validation-service.js';
export * from './core/validator.js';

// Validators
export * from './validators/default-validators.js';
export { resolveBound } from './validators/range-bounds.js';

// Expressions
export * from './expressions/index.js';

import { ValidationMetadata, type ValidationMetadataOptions } from './core/metadata.js';
import { ValidationService, type ValidationServiceOptions } from './core/validation-service.js';
import { defaultValidators } from './validators/default-validators.js';

export interface CreateValidationServiceOptions extends ValidationMetadataOptions, ValidationServiceOptions {
  /** Register {@link defaultValidators} in addition to `validators`. Default true. */
  includeDefaultValidators?: boolean;
}

/** Creates a {@link ValidationService} (and its {@link ValidationMetadata}) without any framework. */
export function createValidationService(options: CreateValidationServiceOptions = {}): ValidationService {
  const { includeDefaultValidators = true, validators = [], ...rest } = options;
  const metadata = new ValidationMetadata({
    ...rest,
    validators: includeDefaultValidators ? [...defaultValidators, ...validators] : validators,
  });
  return new ValidationService(metadata, rest);
}
