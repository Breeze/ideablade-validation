// @angular/forms ships partially compiled code; tests (not the library) need the JIT compiler.
import '@angular/compiler';
import { type EnvironmentInjector, Injector, createEnvironmentInjector, inject, runInInjectionContext, signal } from '@angular/core';
import { FormControl } from '@angular/forms';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';

import {
  FormValidators,
  ValidationMetadata,
  ValidationService,
  provideExpressionScope,
  provideValidation,
  provideValidationMetadata,
  provideValidatorContext,
  provideValidatorFactory,
  validationErrors,
} from '../src/angular/index.js';
import { asyncValidator, createEntityStore, syncValidator } from '../src/index.js';


class TenantService {
  readonly tenant = 'acme';
}

function createInjector(providers: Parameters<typeof createEnvironmentInjector>[0]): EnvironmentInjector {
  const root = Injector.create({ providers: [] }) as unknown as EnvironmentInjector;
  return createEnvironmentInjector(providers, root);
}

const metadata = {
  Person: {
    properties: {
      name: { displayName: 'Name', required: true },
      login: { validators: [{ name: 'available', async: true }] },
      tenantCode: { validators: ['tenantCheck', { name: 'expression', context: { expression: 'startsWithTenant(value)' } }] },
    },
  },
};

function setup() {
  return createInjector([
    { provide: TenantService, useValue: new TenantService() },
    provideValidation({ metadata, validators: [asyncValidator('available', (v) => of(v !== 'taken'), '%displayName% is taken')] }),
    provideValidationMetadata({ Extra: { properties: { x: { required: true } } } }),
    provideValidatorContext(() => {
      const tenants = inject(TenantService);
      return { contextFn: () => ({ tenant: tenants.tenant }) };
    }),
    provideValidatorFactory(() => syncValidator('tenantCheck', (v, ctx) => v == null || String(v).includes(ctx.tenant))),
    provideExpressionScope(() => {
      const { tenant } = inject(TenantService);
      return { startsWithTenant: (v: string) => v == null || v.startsWith(tenant) };
    }),
  ]);
}

describe('Angular providers', () => {
  it('provides ValidationService with defaults, metadata, factories, context and expression scope', () => {
    const injector = setup();
    const service = injector.get(ValidationService);
    expect(injector.get(ValidationMetadata)).toBe(service.validationMetadata);
    expect(service.validateModelSync({}, 'Person').map((e) => e.errorMessage)).toEqual(['Name is required']);
    expect(service.validateModelSync({}, 'Extra')).toHaveLength(1);
    expect(service.validateModelSync({ name: 'x', tenantCode: 'acme-1' }, 'Person')).toEqual([]);
    expect(service.validateModelSync({ name: 'x', tenantCode: 'other' }, 'Person').map((e) => e.key)).toEqual([
      'tenantCheck_tenantCode',
      'expression_tenantCode',
    ]);
  });

  it('validationErrors() is a signal that recomputes when the model changes', () => {
    const injector = setup();
    const person = signal<Record<string, unknown>>({ name: '' });
    const errors = runInInjectionContext(injector, () => validationErrors(person, 'Person'));
    expect(errors().length).toBe(1);
    person.set({ name: 'Ann' });
    expect(errors()).toEqual([]);
  });

  it("FormValidators use the service's entity store, so unique works in a form control", () => {
    const tags = [{ kind: 'Tag', name: 'a' }];
    const injector = createInjector([
      provideValidation({ metadata: { Tag: { properties: { name: { displayName: 'Name', validators: ['unique'] } } } } }),
    ]);
    const forms = injector.get(FormValidators);
    const model = { kind: 'Tag', name: '' };
    const store = createEntityStore({ entities: () => [model, ...tags].map((entity) => ({ entityType: 'Tag', entity })), changes: () => undefined });
    injector.get(ValidationService).setEntityStore(store);
    const control = new FormControl('a', forms.createSyncValidatorFn(() => ({ entity: model, entityType: 'Tag' }), 'name'));
    expect(Object.keys(control.errors ?? {})).toEqual(['unique_name']);
    control.setValue('c');
    expect(control.errors).toBeNull();
  });

  it('FormValidators validate a control against the metadata', async () => {
    const injector = setup();
    const forms = injector.get(FormValidators);
    const model = { name: 'Ann', login: 'free' };
    const nameControl = new FormControl('', forms.createSyncValidatorFn(() => ({ entity: model, entityType: 'Person' }), 'name'));
    expect(Object.keys(nameControl.errors ?? {})).toEqual(['required_name']);
    nameControl.setValue('Bob');
    expect(nameControl.errors).toBeNull();
    expect(model.name).toBe('Ann'); // the model is not modified by validation

    const asyncFn = forms.createAsyncValidatorFn(() => ({ entity: model, entityType: 'Person' }), 'login', undefined, undefined, 0);
    const result = await firstValueFrom(asyncFn(new FormControl('taken')) as never);
    expect(Object.keys(result ?? {})).toEqual(['available_login']);
    expect(await firstValueFrom(asyncFn(new FormControl('free')) as never)).toBeNull();
  });
});
