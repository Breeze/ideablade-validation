import { DataProperty, DataType, EntityManager, EntityType, MetadataStore, Validator, type Entity } from 'breeze-client';
import { filter, firstValueFrom, skip } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { breezeEntityStore, breezeValidator, installBreezeValidators } from '../src/breeze/index.js';
import { createValidationService } from '../src/index.js';

function makeManager(): EntityManager {
  const store = new MetadataStore();
  const customer = new EntityType({ shortName: 'Customer', namespace: 'Test' });
  customer.addProperty(new DataProperty({ name: 'id', dataType: DataType.Int32, isPartOfKey: true }));
  customer.addProperty(
    new DataProperty({ name: 'name', dataType: DataType.String, validators: [Validator.maxLength({ maxLength: 5 })] }),
  );
  customer.addProperty(new DataProperty({ name: 'email', dataType: DataType.String }));
  customer.addProperty(new DataProperty({ name: 'archived', dataType: DataType.Boolean }));
  store.addEntityType(customer);
  return new EntityManager({ metadataStore: store });
}

type Customer = Entity & { id: number; name: string; email: string | null; archived: boolean };

const metadata = {
  global: { validators: ['breeze'] },
  Customer: {
    validators: [{ name: 'expression', context: { expression: '!model.archived', messageTemplate: 'Archived customers cannot be edited' } }],
    properties: { email: { displayName: 'E-mail', required: true, validators: ['email'] } },
  },
};

describe('breezeValidator (Breeze → framework)', () => {
  it('reports Breeze validation errors through the validation service', () => {
    const manager = makeManager();
    const service = createValidationService({ metadata, validators: [breezeValidator] });
    const c = manager.createEntity('Customer', { id: 1, name: 'Too long name', email: 'a@b.co' }) as Customer;
    const errors = service.validateModelSync(c, 'Customer');
    expect(errors).toHaveLength(1);
    expect(errors[0].propertyName).toBe('name');
    expect(errors[0].errorMessage).toMatch(/5/);
  });
});

describe('installBreezeValidators (framework → Breeze)', () => {
  it('makes Breeze run the metadata rules per property and per entity', () => {
    const manager = makeManager();
    const service = createValidationService({ metadata, validators: [breezeValidator] });
    const uninstall = installBreezeValidators(manager.metadataStore, service);

    const c = manager.createEntity('Customer', { id: 1, name: 'Ann', email: 'nope' }) as Customer;
    expect(c.entityAspect.validateEntity()).toBe(false);
    const breezeErrors = c.entityAspect.getValidationErrors();
    expect(breezeErrors.map((e) => [e.propertyName ?? null, e.errorMessage])).toEqual([
      ['email', 'E-mail is not a valid email address'],
    ]);

    // Property change re-validates through Breeze
    c.email = 'ann@example.com';
    expect(c.entityAspect.getValidationErrors()).toHaveLength(0);

    c.archived = true;
    expect(c.entityAspect.validateEntity()).toBe(false);
    expect(c.entityAspect.getValidationErrors().map((e) => e.errorMessage)).toEqual(['Archived customers cannot be edited']);

    uninstall();
    // Breeze keeps errors of validators it no longer runs; clear them after uninstalling.
    c.entityAspect.clearValidationErrors();
    expect(c.entityAspect.validateEntity()).toBe(true);
  });
});

describe('breezeEntityStore', () => {
  it('validates the entities of a manager and re-validates on change', async () => {
    const manager = makeManager();
    const service = createValidationService({ metadata: { Customer: metadata.Customer } });
    const c = manager.createEntity('Customer', { id: 1, name: 'Ann', email: null }) as Customer;

    const results$ = service.validateEntityStore(breezeEntityStore(manager));
    const first = await firstValueFrom(results$);
    expect(first.validationErrors.map((e) => e.key)).toEqual(['required_email']);

    const next = firstValueFrom(results$.pipe(skip(1), filter((r) => r.validationErrors.length === 0)));
    c.email = 'ann@example.com';
    expect((await next).entities).toHaveLength(1);
  });
});
