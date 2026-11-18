import { DataProperty, DataType, EntityManager, EntityType, MetadataStore, Validator, type Entity } from 'breeze-client';
import { filter, firstValueFrom, skip, toArray } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { breezeEntityStore, breezeValidator, installBreezeValidators } from '../src/breeze/index.js';
import { asyncValidator, createValidationService } from '../src/index.js';

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

describe('breeze validator with Breeze 3 async validators', () => {
  function makeAsyncManager() {
    const manager = makeManager();
    const customer = manager.metadataStore.getEntityType('Customer') as EntityType;
    const syncRuns = { count: 0 };
    customer.getProperty('archived')!.validators.push(new Validator('counted', () => (syncRuns.count++, true)));
    const taken = new Validator(
      'loginTaken',
      async (value: unknown) => {
        await new Promise((r) => setTimeout(r, 5));
        return value !== 'taken@example.com';
      },
      { messageTemplate: '%displayName% is already taken' },
    );
    customer.getProperty('email')!.validators.push(taken);
    return { manager, syncRuns };
  }

  // One entry covers both: Breeze's sync validators, and its async ones in validateModelAsync / validate.
  const breezeOnly = { global: { validators: ['breeze'] } };

  it('validateModelSync reports Breeze sync errors; validateModelAsync reports sync and async errors', async () => {
    const { manager } = makeAsyncManager();
    const service = createValidationService({ metadata: breezeOnly, validators: [breezeValidator] });
    const c = manager.createEntity('Customer', { id: 1, name: 'Too long name', email: 'taken@example.com' }) as Customer;

    expect(service.hasAsyncValidators('Customer')).toBe(true);
    expect(service.validateModelSync(c, 'Customer').map((e) => e.key)).toEqual(['maxLength:name']);

    const all = await firstValueFrom(service.validateModelAsync(c, 'Customer'));
    expect(all.map((e) => [e.key, e.propertyName, e.errorMessage])).toEqual([
      ['maxLength:name', 'name', "'name' must be a string with 5 characters or less"],
      ['loginTaken:email', 'email', 'email is already taken'],
    ]);

    c.name = 'Ann';
    c.email = 'free@example.com';
    expect(await firstValueFrom(service.validateModelAsync(c, 'Customer'))).toEqual([]);
  });

  it('runs Breeze sync validators once in validateModelAsync', async () => {
    const { manager, syncRuns } = makeAsyncManager();
    const service = createValidationService({ metadata: breezeOnly, validators: [breezeValidator] });
    const c = manager.createEntity('Customer', { id: 1, name: 'Ann', email: 'a@b.co' }) as Customer;
    syncRuns.count = 0;
    await firstValueFrom(service.validateModelAsync(c, 'Customer'));
    expect(syncRuns.count).toBe(1);
  });

  it('validate() shows Breeze sync errors first, then all errors', async () => {
    const { manager } = makeAsyncManager();
    const service = createValidationService({ metadata: breezeOnly, validators: [breezeValidator] });
    const c = manager.createEntity('Customer', { id: 1, name: 'Too long name', email: 'taken@example.com' }) as Customer;

    const results = await firstValueFrom(service.validate(c, 'Customer').pipe(toArray()));
    expect(results.map((r) => [r.pending, r.errors.map((e) => e.key)])).toEqual([
      [true, ['maxLength:name']],
      [false, ['maxLength:name', 'loginTaken:email']],
    ]);
  });

  it('ignores non-entities', async () => {
    const service = createValidationService({ metadata: breezeOnly, validators: [breezeValidator] });
    expect(await firstValueFrom(service.validateModelAsync({ id: 1 }, 'Customer'))).toEqual([]);
  });
});

describe('breeze validator together with installBreezeValidators', () => {
  it('does not report metadata rules twice', () => {
    const manager = makeManager();
    const service = createValidationService({ metadata, validators: [breezeValidator] });
    installBreezeValidators(manager.metadataStore, service);
    const c = manager.createEntity('Customer', { id: 1, name: 'Too long name', email: 'nope' }) as Customer;

    const keys = service.validateModelSync(c, 'Customer').map((e) => e.key);
    expect(keys.sort()).toEqual(['email_email', 'maxLength:name']);
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

  it('runs async metadata rules from validateEntityAsync without repeating the sync ones', async () => {
    const manager = makeManager();
    const service = createValidationService({
      metadata: { Customer: { properties: { email: { required: true, validators: [{ name: 'free', async: true }] } } } },
      validators: [asyncValidator('free', async (v: string) => v !== 'taken@example.com', '%displayName% is taken')],
    });
    installBreezeValidators(manager.metadataStore, service);

    const c = manager.createEntity('Customer', { id: 1, name: 'Ann', email: '' }) as Customer;
    expect(await c.entityAspect.validateEntityAsync()).toBe(false);
    expect(c.entityAspect.getValidationErrors().map((e) => e.errorMessage)).toEqual(['email is required']);

    c.email = 'taken@example.com';
    expect(await c.entityAspect.validateEntityAsync()).toBe(false);
    expect(c.entityAspect.getValidationErrors().map((e) => e.errorMessage)).toEqual(['email is taken']);
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
