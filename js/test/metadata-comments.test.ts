import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { type ModelValidationMetadataMap, createValidationService, isModelTypeKey } from '../src/index.js';

/**
 * `$schema` points editors at the schema, and `$comment` explains the rules to whoever maintains them. Neither is a
 * rule: the metadata may carry them at the top and in every object, and validating ignores them.
 */
describe('$schema and $comment in the metadata', () => {
  const metadata: ModelValidationMetadataMap = {
    $schema: '../node_modules/@ideablade/validation/schema/validation-metadata.schema.json',
    $comment: ['The rules for people.', 'A second paragraph.'],
    global: { $comment: 'Every model has an id.', validators: [{ $comment: 'id', name: 'expression', context: { expression: 'model.id != null', messageTemplate: 'Missing id' } }] },
    Person: {
      $comment: 'A person.',
      validators: [{ $comment: 'Only during hiring.', group: 'hire', validators: ['required'] }],
      properties: {
        firstName: { $comment: 'As on the passport.', required: true },
      },
    },
  };

  it('are not model types', () => {
    const service = createValidationService({ metadata });

    expect(service.validationMetadata.modelTypes).toEqual(['Person']);
    expect(['global', '$schema', '$comment', 'Person'].filter(isModelTypeKey)).toEqual(['Person']);
  });

  it('change nothing about validation', () => {
    const service = createValidationService({ metadata });

    expect(service.validateModelSync({ id: 1, firstName: 'Ann' }, 'Person', { predicate: (v) => !v.group })).toEqual([]);
    expect(service.validateModelSync({ firstName: '' }, 'Person', { predicate: (v) => !v.group }).map((e) => e.errorMessage).sort()).toEqual([
      'Missing id',
      'firstName is required',
    ]);
  });

  it('are allowed by the schema wherever it allows nothing but its own keys', () => {
    const schema = JSON.parse(readFileSync(fileURLToPath(new URL('../../spec/validation-metadata.schema.json', import.meta.url)), 'utf8'));
    const strict = Object.entries(schema.$defs as Record<string, { properties?: object; additionalProperties?: unknown }>).filter(
      ([, def]) => def.properties && def.additionalProperties === false,
    );

    expect(strict.map(([name]) => name).sort()).toEqual(['global', 'group', 'model', 'property', 'validator']);
    for (const [, def] of strict) {
      expect(def.properties).toHaveProperty(['$comment']);
    }
    // At the top every other key is a model type, so $schema and $comment have to be listed.
    expect(schema.properties).toHaveProperty(['$schema']);
    expect(schema.properties).toHaveProperty(['$comment']);
  });
});
