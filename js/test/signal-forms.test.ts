// @vitest-environment jsdom
// A view model that inherits an entity's rules (`from` + breezeRuleSource), edited with Signal Forms.
import '@angular/compiler';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form } from '@angular/forms/signals';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { DataProperty, DataType, EntityType, MetadataStore, Validator } from 'breeze-client';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { provideRuleSources, provideValidation } from '../src/angular/index.js';
import { type MetadataFormError, validateWithMetadata } from '../src/angular/signal-forms.js';
import { breezeRuleSource } from '../src/breeze/index.js';
import { asyncValidator } from '../src/index.js';

/** Like TempHire: Breeze has the name rules, from the server model's [Required] and [StringLength]. */
function makeStore(): MetadataStore {
  const store = new MetadataStore();
  const resource = new EntityType({ shortName: 'StaffingResource', namespace: 'Test' });
  resource.addProperty(new DataProperty({ name: 'id', dataType: DataType.Int32, isPartOfKey: true }));
  for (const name of ['firstName', 'middleName', 'lastName']) {
    const validators = [Validator.maxLength({ maxLength: 10 })];
    if (name !== 'middleName') {
      validators.unshift(Validator.required());
    }
    resource.addProperty(new DataProperty({ name, dataType: DataType.String, validators }));
  }
  // An async Breeze rule as well.
  resource.getProperty('lastName')!.validators.push(
    new Validator('notBlocked', async (value: unknown) => value !== 'Blocked', { messageTemplate: '%displayName% is blocked' }),
  );
  store.addEntityType(resource);
  return store;
}

const metadata = {
  ResourceName: {
    properties: {
      firstName: { from: 'StaffingResource', displayName: 'First name' },
      middleName: { from: 'StaffingResource', displayName: 'Middle name' },
      surname: { from: 'StaffingResource.lastName', displayName: 'Last name' },
      nickname: { validators: [{ name: 'notTaken', async: true }] },
    },
  },
};

interface ResourceName {
  firstName: string;
  middleName: string;
  surname: string;
  nickname: string;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(() => {
  TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
});

describe('validateWithMetadata (Signal Forms) with from + breezeRuleSource', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    const store = makeStore();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideValidation({
          metadata,
          validators: [asyncValidator('notTaken', async (v) => v !== 'taken', '%displayName% is taken')],
        }),
        provideRuleSources(() => breezeRuleSource(store)),
      ],
    });
  });

  function createForm(initial: Partial<ResourceName> = {}) {
    const model = signal<ResourceName>({ firstName: '', middleName: '', surname: '', nickname: '', ...initial });
    const nameForm = TestBed.runInInjectionContext(() =>
      form(model, (path) => validateWithMetadata(path, { modelType: 'ResourceName', debounce: 0 })),
    );
    return { model, nameForm };
  }
  const messages = (errors: readonly { message?: string }[]) => errors.map((e) => e.message);

  it('applies the entity properties’ Breeze rules to the view model fields, with the view model’s names', () => {
    const { model, nameForm } = createForm();
    expect(messages(nameForm.firstName().errors())).toEqual(["'First name' is required"]);
    expect(messages(nameForm.surname().errors())).toEqual(["'Last name' is required"]);
    expect(nameForm.middleName().errors()).toEqual([]);

    model.set({ firstName: 'Christopher', middleName: 'Maximilian', surname: 'Ng', nickname: '' });
    expect(messages(nameForm.firstName().errors())).toEqual(["'First name' must be a string with 10 characters or less"]);
    expect(nameForm.middleName().errors()).toEqual([]);
    expect(nameForm.surname().errors()).toEqual([]);
  });

  it('reports errors as ValidationErrors keyed like the rest of the framework', () => {
    const { nameForm } = createForm();
    const [error] = nameForm.firstName().errors() as unknown as MetadataFormError[];
    expect(error.kind).toBe('required_firstName');
    expect(error.validationError.propertyName).toBe('firstName');
  });

  it('runs async rules, metadata and Breeze, once the sync rules pass', async () => {
    const { model, nameForm } = createForm({ firstName: 'Ann', surname: 'Blocked', nickname: 'taken' });
    TestBed.tick();
    await delay(20);
    TestBed.tick();
    expect(messages(nameForm.surname().errors())).toEqual(['Last name is blocked']);
    expect(messages(nameForm.nickname().errors())).toEqual(['nickname is taken']);

    model.update((m) => ({ ...m, surname: 'Smith', nickname: 'annie' }));
    TestBed.tick();
    await delay(20);
    TestBed.tick();
    expect(nameForm().valid()).toBe(true);
  });
});
