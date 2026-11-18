// @vitest-environment jsdom
// Breeze's own property rules on form fields: the `breeze` validator takes part when a single property is validated.
import '@angular/compiler';
import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormsModule, NgModel } from '@angular/forms';
import { By } from '@angular/platform-browser';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { DataProperty, DataType, EntityManager, EntityType, MetadataStore, Validator, type Entity } from 'breeze-client';
import { beforeAll, describe, expect, it } from 'vitest';

import { ValidationFormsDirectives, provideValidation } from '../src/angular/index.js';
import { breezeModelType, breezeValidator, installBreezeValidators } from '../src/breeze/index.js';
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
  store.addEntityType(customer);
  return new EntityManager({ metadataStore: store });
}

type Customer = Entity & { id: number; name: string; email: string };

const metadata = {
  global: { validators: ['breeze'] },
  Customer: {
    validators: [{ name: 'expression', context: { expression: 'false', messageTemplate: 'A model-level rule' } }],
    properties: { name: { displayName: 'Name' }, email: { displayName: 'E-mail', required: true } },
  },
};

describe('validating one property (propertyName)', () => {
  it("runs the property's rules and Breeze's rules for it, not other model-level rules", () => {
    const manager = makeManager();
    const service = createValidationService({ metadata, validators: [breezeValidator] });
    const c = manager.createEntity('Customer', { id: 1, name: 'Much too long', email: '' }) as Customer;

    const name = service.validateModelSync(c, 'Customer', { propertyName: 'name' });
    expect(name.map((e) => [e.key, e.propertyName, e.errorMessage])).toEqual([
      ['maxLength_name', 'name', "'Name' must be a string with 5 characters or less"],
    ]);
    const email = service.validateModelSync(c, 'Customer', { propertyName: 'email' });
    expect(email.map((e) => e.errorMessage)).toEqual(['E-mail is required']);
  });

  it("checks the value in the model it's given, without touching the entity's Breeze errors", () => {
    const manager = makeManager();
    const service = createValidationService({ metadata, validators: [breezeValidator] });
    const c = manager.createEntity('Customer', { id: 1, name: 'Ann', email: 'a@b.co' }) as Customer;
    c.entityAspect.clearValidationErrors();
    const view = Object.create(c, { name: { value: 'Much too long' } });

    expect(service.validateModelSync(view, 'Customer', { propertyName: 'name' }).map((e) => e.key)).toEqual(['maxLength_name']);
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
    expect(service.validateModelSync(c, 'Customer', { propertyName: 'name' }).map((e) => e.errorMessage)).toEqual([
      'Name must be at least 2 characters',
    ]);
  });
});

class Host {
  customer!: Customer;
}

const TestHost = Component({
  selector: 'test-host',
  imports: [FormsModule, ValidationFormsDirectives],
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
  it("show Breeze's own rules and the framework's the same way", async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideValidation({ metadata, validators: [breezeValidator], modelTypeResolvers: [breezeModelType] }),
      ],
    });
    const fixture = TestBed.createComponent(TestHost);
    fixture.componentInstance.customer = makeManager().createEntity('Customer', { id: 1, name: 'Much too long', email: '' }) as Customer;
    await fixture.whenStable();

    const errorsOf = (name: string) => {
      const control = fixture.debugElement.queryAll(By.directive(NgModel)).find((e) => e.attributes['name'] === name)!.injector.get(NgModel);
      return Object.values(control.errors ?? {}).map((e) => (e as ValidationError).errorMessage);
    };
    expect(errorsOf('name')).toEqual(["'Name' must be a string with 5 characters or less"]);
    expect(errorsOf('email')).toEqual(['E-mail is required']);

    const input = fixture.debugElement.query(By.css('input[name=name]')).nativeElement as HTMLInputElement;
    input.value = 'Ann';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(errorsOf('name')).toEqual([]);
  });
});
