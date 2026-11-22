// @vitest-environment jsdom
// A form validates its model as a whole: rules that span fields, conditions on other fields, model-level errors.
import '@angular/compiler';
import { Component, provideZonelessChangeDetection } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { FormBuilder, FormsModule, NgModel } from '@angular/forms';
import { By } from '@angular/platform-browser';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import { FormValidators, type ValidationFormDirective, ValidationFormsDirectives, provideValidation } from '../src/angular/index.js';
import type { ValidationError } from '../src/core/validation-error.js';
import { asyncValidator } from '../src/index.js';

const metadata = {
  Booking: {
    validators: [
      {
        name: 'expression',
        id: 'START_BEFORE_END',
        propertyNames: ['startDate', 'endDate'],
        context: { expression: '!model.startDate || !model.endDate || model.startDate < model.endDate', messageTemplate: 'Start must be before end' },
      },
      { name: 'expression', id: 'GOOD_BOOKING', context: { expression: "model.note !== 'bad'", messageTemplate: 'Not a good booking' } },
    ],
    properties: {
      reason: { displayName: 'Reason', validators: [{ name: 'required', condition: "model.kind === 'other'" }] },
    },
  },
};

interface Booking {
  startDate: string;
  endDate: string;
  kind: string;
  reason: string;
  note: string;
}

class Host {
  booking: Booking = { startDate: '2026-01-05', endDate: '2026-01-01', kind: '', reason: '', note: '' };
}

const TestHost = Component({
  selector: 'test-host',
  imports: [FormsModule, ValidationFormsDirectives],
  template: `
    <form [validationModel]="booking" validationModelType="Booking" #form="validationForm">
      <input name="startDate" [(ngModel)]="booking.startDate" />
      <input name="endDate" [(ngModel)]="booking.endDate" />
      <input name="kind" [(ngModel)]="booking.kind" />
      <input name="reason" [(ngModel)]="booking.reason" />
    </form>
  `,
})(Host);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(() => {
  TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
});

describe('template-driven forms validate the model as a whole', () => {
  let fixture: ComponentFixture<Host>;

  async function render() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), provideValidation({ metadata })] });
    fixture = TestBed.createComponent(TestHost);
    await fixture.whenStable();
  }
  const errorsOf = (name: string) => {
    const control = fixture.debugElement.queryAll(By.directive(NgModel)).find((e) => e.attributes['name'] === name)!.injector.get(NgModel);
    return Object.values(control.errors ?? {}).map((e) => (e as ValidationError).errorMessage);
  };
  const type = async (name: string, value: string) => {
    const input = fixture.debugElement.query(By.css(`input[name=${name}]`)).nativeElement as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
  };
  const form = () => fixture.debugElement.query(By.css('form')).references['form'] as ValidationFormDirective;

  it('shows a model-level rule on every field it names, and re-checks them all when one changes', async () => {
    await render();
    expect(errorsOf('startDate')).toEqual(['Start must be before end']);
    expect(errorsOf('endDate')).toEqual(['Start must be before end']);

    await type('endDate', '2026-01-10');
    expect(errorsOf('endDate')).toEqual([]);
    expect(errorsOf('startDate')).toEqual([]); // not edited, re-checked

    await type('startDate', '2026-02-01');
    expect(errorsOf('endDate')).toEqual(['Start must be before end']);
  });

  it("re-checks a field whose rule's condition another field changes", async () => {
    await render();
    expect(errorsOf('reason')).toEqual([]);

    await type('kind', 'other');
    expect(errorsOf('reason')).toEqual(['Reason is required']);
  });

  it('reports errors about the model as a whole on the form, and re-validates on request', async () => {
    await render();
    fixture.componentInstance.booking.note = 'bad';
    form().revalidate();
    expect(form().modelErrors().map((e) => e.errorMessage)).toEqual(['Not a good booking']);
    expect(errorsOf('kind')).toEqual([]);

    fixture.componentInstance.booking.note = '';
    form().revalidate();
    expect(form().modelErrors()).toEqual([]);
  });
});

describe('template-driven forms: async rules across fields', () => {
  // Taken only in the acme domain: the async rule reads another field.
  const accountMetadata = {
    Account: { properties: { login: { displayName: 'Login', validators: [{ name: 'available', async: true }] } } },
  };

  class AccountHost {
    account = { login: '', domain: '' };
  }

  const TestAccountHost = Component({
    selector: 'test-account-host',
    imports: [FormsModule, ValidationFormsDirectives],
    template: `
      <form [validationModel]="account" validationModelType="Account">
        <input name="login" [(ngModel)]="account.login" />
        <input name="domain" [(ngModel)]="account.domain" />
      </form>
    `,
  })(AccountHost);

  it("runs async rules on the form's current values, and re-runs them when another field changes", async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideValidation({
          metadata: accountMetadata,
          validators: [
            asyncValidator('available', (login, { model }) => Promise.resolve(!(login === 'taken' && model.domain === 'acme')), '%displayName% is taken'),
          ],
        }),
      ],
    });
    const fixture = TestBed.createComponent(TestAccountHost);
    await fixture.whenStable();
    const control = (name: string) => fixture.debugElement.queryAll(By.directive(NgModel)).find((e) => e.attributes['name'] === name)!.injector.get(NgModel);
    const messages = (name: string) => Object.values(control(name).errors ?? {}).map((e) => (e as ValidationError).errorMessage);
    const type = async (name: string, value: string) => {
      const input = fixture.debugElement.query(By.css(`input[name=${name}]`)).nativeElement as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
      await fixture.whenStable();
    };

    await type('domain', 'acme');
    await type('login', 'taken');
    await delay(400);
    expect(messages('login')).toEqual(['Login is taken']);

    await type('domain', 'other');
    await delay(400);
    expect(control('login').valid).toBe(true);
  });
});

describe('reactive forms: validateFormGroup', () => {
  it('validates the group as a whole', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), provideValidation({ metadata })] });
    const booking: Booking = { startDate: '2026-01-05', endDate: '2026-01-10', kind: '', reason: '', note: '' };
    const group = TestBed.inject(FormBuilder).group({ ...booking });
    const validation = TestBed.inject(FormValidators).validateFormGroup(group, () => ({ entity: booking, entityType: 'Booking' }));
    const messages = (name: string) => Object.values(group.get(name)!.errors ?? {}).map((e) => (e as ValidationError).errorMessage);
    expect(messages('endDate')).toEqual([]);

    group.get('startDate')!.setValue('2026-02-01');
    expect(messages('startDate')).toEqual(['Start must be before end']);
    expect(messages('endDate')).toEqual(['Start must be before end']);

    group.get('kind')!.setValue('other');
    expect(messages('reason')).toEqual(['Reason is required']);
    validation.dispose();
  });

  it('runs async rules as an async validator, once the sync rules pass', async () => {
    const signup = {
      Signup: {
        properties: {
          login: { displayName: 'Login', required: true, validators: [{ name: 'available', async: true }] },
          name: { displayName: 'Name' },
        },
      },
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideValidation({
          metadata: signup,
          validators: [asyncValidator('available', (login) => Promise.resolve(login !== 'taken'), '%displayName% is taken')],
        }),
      ],
    });
    const model = { login: '', name: '' };
    const group = TestBed.inject(FormBuilder).group({ ...model });
    const validation = TestBed.inject(FormValidators).validateFormGroup(group, () => ({ entity: model, entityType: 'Signup' }));
    const login = group.get('login')!;
    const messages = () => Object.values(login.errors ?? {}).map((e) => (e as ValidationError).errorMessage);
    expect(messages()).toEqual(['Login is required']);

    login.setValue('taken');
    expect(login.pending).toBe(true);
    await delay(400);
    expect(messages()).toEqual(['Login is taken']);

    login.setValue('free');
    await delay(400);
    expect(login.valid).toBe(true);
    // A control without async rules is not left pending.
    expect(group.get('name')!.pending).toBe(false);
    validation.dispose();
  });

  it("runs async rules on the group's current values, and re-checks them when another control changes", async () => {
    // The login is taken only in the acme domain: the rule reads another property, which only the form has changed.
    const account = {
      Account: {
        properties: { login: { displayName: 'Login', validators: [{ name: 'available', async: true }] } },
      },
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideValidation({
          metadata: account,
          validators: [
            asyncValidator('available', (login, { model }) => Promise.resolve(!(login === 'taken' && model.domain === 'acme')), '%displayName% is taken'),
          ],
        }),
      ],
    });
    const model = { login: '', domain: '' };
    const group = TestBed.inject(FormBuilder).group({ ...model });
    const validation = TestBed.inject(FormValidators).validateFormGroup(group, () => ({ entity: model, entityType: 'Account' }));
    const login = group.get('login')!;
    const messages = () => Object.values(login.errors ?? {}).map((e) => (e as ValidationError).errorMessage);

    group.get('domain')!.setValue('acme');
    login.setValue('taken');
    await delay(400);
    expect(messages()).toEqual(['Login is taken']);

    group.get('domain')!.setValue('other');
    await delay(400);
    expect(login.valid).toBe(true);
    // The model itself is untouched: the values come from the form.
    expect(model).toEqual({ login: '', domain: '' });
    validation.dispose();
  });
});
