// @vitest-environment jsdom
// A view model that inherits an entity's rules (`from` + breezeRuleSource), edited with Signal Forms.
import '@angular/compiler';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form } from '@angular/forms/signals';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { DataProperty, DataType, EntityType, MetadataStore, Validator } from 'breeze-client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

/** Waits until `check` passes, running change detection before each try: async rules answer when they answer. */
const eventually = (check: () => void) =>
  vi.waitFor(() => {
    TestBed.tick();
    check();
  });

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
    expect(error.validationError.propertyNames).toEqual(['firstName']);
  });

  it('runs async rules, metadata and Breeze, once the sync rules pass', async () => {
    const { model, nameForm } = createForm({ firstName: 'Ann', surname: 'Blocked', nickname: 'taken' });
    await eventually(() => {
      expect(messages(nameForm.surname().errors())).toEqual(['Last name is blocked']);
      expect(messages(nameForm.nickname().errors())).toEqual(['nickname is taken']);
    });

    model.update((m) => ({ ...m, surname: 'Smith', nickname: 'annie' }));
    await eventually(() => expect(nameForm().valid()).toBe(true));
  });
});

/** Rules that read more than one field: the form validates its whole value, so every field sees the others' values. */
describe('validateWithMetadata (Signal Forms): rules across fields', () => {
  const bookingMetadata = {
    Booking: {
      validators: [
        {
          name: 'expression',
          propertyNames: ['startDate', 'endDate'],
          context: { expression: '!model.startDate || !model.endDate || model.startDate < model.endDate', messageTemplate: 'Start must be before end' },
        },
        { name: 'expression', id: 'GOOD_NOTE', context: { expression: "model.note !== 'bad'", messageTemplate: 'Not a good booking' } },
        { name: 'expression', id: 'SHORT_NOTE', context: { expression: 'model.note.length <= 5', messageTemplate: 'The note is too long' } },
      ],
      properties: {
        reason: { displayName: 'Reason', validators: [{ name: 'required', condition: "model.kind === 'other'" }] },
        // Taken only in the acme domain: the async rule reads another field.
        login: { displayName: 'Login', validators: [{ name: 'available', async: true }] },
      },
    },
  };

  interface Booking {
    startDate: string;
    endDate: string;
    kind: string;
    reason: string;
    note: string;
    login: string;
    domain: string;
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideValidation({
          metadata: bookingMetadata,
          validators: [
            asyncValidator('available', async (login, { model }) => !(login === 'taken' && model.domain === 'acme'), '%displayName% is taken'),
          ],
        }),
      ],
    });
  });

  function createForm(initial: Partial<Booking> = {}) {
    const model = signal<Booking>({ startDate: '2026-01-01', endDate: '2026-01-05', kind: '', reason: '', note: '', login: '', domain: '', ...initial });
    const bookingForm = TestBed.runInInjectionContext(() =>
      form(model, (path) => validateWithMetadata(path, { modelType: 'Booking', debounce: 0 })),
    );
    return { model, bookingForm };
  }
  const messages = (errors: readonly { message?: string }[]) => errors.map((e) => e.message);

  it('shows a rule about two fields on both, and re-checks both when one changes', () => {
    const { bookingForm } = createForm();
    expect(bookingForm.startDate().errors()).toEqual([]);

    bookingForm.startDate().value.set('2026-02-01');
    expect(messages(bookingForm.startDate().errors())).toEqual(['Start must be before end']);
    expect(messages(bookingForm.endDate().errors())).toEqual(['Start must be before end']);

    bookingForm.endDate().value.set('2026-03-01');
    expect(bookingForm.startDate().errors()).toEqual([]);
    expect(bookingForm.endDate().errors()).toEqual([]);
  });

  it("re-checks a field whose rule's condition reads another field", () => {
    const { bookingForm } = createForm();
    expect(bookingForm.reason().errors()).toEqual([]);

    bookingForm.kind().value.set('other');
    expect(messages(bookingForm.reason().errors())).toEqual(['Reason is required']);

    bookingForm.reason().value.set('Moving');
    expect(bookingForm.reason().errors()).toEqual([]);
  });

  it('reports an error about the model as a whole on the root', () => {
    const { bookingForm } = createForm({ note: 'bad' });
    expect(messages(bookingForm().errors())).toEqual(['Not a good booking']);
    expect(bookingForm.note().errors()).toEqual([]);
  });

  it('gives each model-level rule an error kind of its own', () => {
    const { bookingForm } = createForm({ note: 'bad' });
    bookingForm.note().value.set('bad, really');
    expect(bookingForm().errors().map((e) => e.kind)).toEqual(['expression_SHORT_NOTE']);
    bookingForm.note().value.set('bad');
    expect(bookingForm().errors().map((e) => e.kind)).toEqual(['expression_GOOD_NOTE']);
  });

  it("runs async rules on the form's current values, and re-runs them when another field changes", async () => {
    const { bookingForm } = createForm();

    bookingForm.domain().value.set('acme');
    bookingForm.login().value.set('taken');
    await eventually(() => expect(messages(bookingForm.login().errors())).toEqual(['Login is taken']));

    bookingForm.domain().value.set('other');
    // Valid only once the re-run has answered.
    await eventually(() => expect(bookingForm().valid()).toBe(true));
    expect(bookingForm.login().errors()).toEqual([]);
  });
});
