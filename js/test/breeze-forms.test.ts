// @vitest-environment jsdom
// Breeze entities in forms: Breeze's own rules on fields, and entities changed in code.
import '@angular/compiler';
import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormsModule, NgModel } from '@angular/forms';
import { By } from '@angular/platform-browser';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { DataProperty, DataType, EntityManager, EntityType, MetadataStore, Validator, type Entity } from 'breeze-client';
import { beforeAll, describe, expect, it } from 'vitest';

import { ValidationFormsDirectives, provideValidation, provideValidationScope } from '../src/angular/index.js';
import { breezeEntityStore, breezeModelType, breezeValidator, installBreezeValidators } from '../src/breeze/index.js';
import { createValidationService } from '../src/index.js';
import type { ValidationError } from '../src/core/validation-error.js';

function makeManager(): EntityManager {
  const store = new MetadataStore();
  const customer = new EntityType({ shortName: 'Customer', namespace: 'Test' });
  customer.addProperty(new DataProperty({ name: 'id', dataType: DataType.Int32, isPartOfKey: true }));
  customer.addProperty(
    new DataProperty({ name: 'name', dataType: DataType.String, validators: [Validator.maxLength({ maxLength: 5 })] }),
  );
  customer.addProperty(new DataProperty({ name: 'email', dataType: DataType.String }));
  customer.addProperty(new DataProperty({ name: 'vip', dataType: DataType.Boolean }));
  store.addEntityType(customer);
  return new EntityManager({ metadataStore: store });
}

type Customer = Entity & { id: number; name: string; email: string; vip: boolean };

const metadata = {
  global: { validators: ['breeze'] },
  Customer: {
    properties: {
      name: { displayName: 'Name' },
      // A rule that depends on a property no field shows.
      email: { displayName: 'E-mail', validators: [{ name: 'required', condition: 'model.vip' }] },
    },
  },
};

describe('breeze on a form view of an entity', () => {
  it("checks the view's values, without touching the entity's Breeze errors", () => {
    const manager = makeManager();
    const service = createValidationService({ metadata, validators: [breezeValidator] });
    const c = manager.createEntity('Customer', { id: 1, name: 'Ann', email: 'a@b.co' }) as Customer;
    c.entityAspect.clearValidationErrors();
    const view = Object.create(c, { name: { value: 'Much too long' } });

    const errors = service.validateModelSync(view, 'Customer', { context: { originalModel: c } });
    expect(errors.map((e) => [e.key, e.propertyNames, e.errorMessage])).toEqual([
      ['maxLength_name', ['name'], "'Name' must be a string with 5 characters or less"],
    ]);
    expect(c.entityAspect.getValidationErrors()).toEqual([]);
  });

  it("doesn't report a rule installed into Breeze twice", () => {
    const manager = makeManager();
    const service = createValidationService({
      metadata: { ...metadata, Customer: { properties: { name: { displayName: 'Name', minLength: 2 } } } },
      validators: [breezeValidator],
    });
    installBreezeValidators(manager.metadataStore, service);
    const c = manager.createEntity('Customer', { id: 1, name: 'A' }) as Customer;
    const view = Object.create(c);
    expect(service.validateModelSync(view, 'Customer', { context: { originalModel: c } }).map((e) => e.errorMessage)).toEqual([
      'Name must be at least 2 characters',
    ]);
  });
});

class Host {
  customer!: Customer;
}

let manager: EntityManager;

const TestHost = Component({
  selector: 'test-host',
  imports: [FormsModule, ValidationFormsDirectives],
  // The component's scope: its own validation service, with the manager's entities as its store.
  providers: [provideValidationScope(() => breezeEntityStore(manager))],
  template: `
    <form [validationModel]="customer">
      <input name="name" [(ngModel)]="customer.name" />
      <input name="email" [(ngModel)]="customer.email" />
    </form>
  `,
})(Host);

beforeAll(() => {
  TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
});

describe('template-driven forms over Breeze entities', () => {
  async function render(values: Partial<Customer>) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideValidation({
          metadata,
          validators: [breezeValidator],
          modelTypeResolvers: [breezeModelType],
        }),
      ],
    });
    manager = makeManager();
    const fixture = TestBed.createComponent(TestHost);
    const customer = manager.createEntity('Customer', { id: 1, email: '', ...values }) as Customer;
    fixture.componentInstance.customer = customer;
    await fixture.whenStable();
    const errorsOf = (name: string) => {
      const control = fixture.debugElement.queryAll(By.directive(NgModel)).find((e) => e.attributes['name'] === name)!.injector.get(NgModel);
      return Object.values(control.errors ?? {}).map((e) => (e as ValidationError).errorMessage);
    };
    return { fixture, customer, errorsOf };
  }

  it("show Breeze's own rules and the framework's the same way", async () => {
    const { fixture, errorsOf } = await render({ name: 'Much too long' });
    expect(errorsOf('name')).toEqual(["'Name' must be a string with 5 characters or less"]);

    const input = fixture.debugElement.query(By.css('input[name=name]')).nativeElement as HTMLInputElement;
    input.value = 'Ann';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(errorsOf('name')).toEqual([]);
  });

  it('re-validate every field when the entity is changed in code', async () => {
    const { fixture, customer, errorsOf } = await render({ name: 'Ann' });
    expect(errorsOf('email')).toEqual([]);

    customer.vip = true; // no field shows vip; the service's entity store (the EntityManager) reports the change
    await fixture.whenStable();
    expect(errorsOf('email')).toEqual(['E-mail is required']);
  });
});
