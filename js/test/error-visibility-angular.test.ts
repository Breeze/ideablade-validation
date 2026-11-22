// @vitest-environment jsdom
// ErrorVisibility in the Angular integrations: template-driven forms, reactive forms and Signal Forms.
import '@angular/compiler';
import { Component, computed, provideZonelessChangeDetection, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { FormBuilder, FormsModule } from '@angular/forms';
import { form } from '@angular/forms/signals';
import { By } from '@angular/platform-browser';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ErrorVisibility,
  FormValidators,
  ValidationFieldDirective,
  type ValidationFormDirective,
  ValidationFormsDirectives,
  injectErrorVisibility,
  provideErrorVisibility,
  provideValidation,
  validationErrors,
} from '../src/angular/index.js';
import { shownErrors, validateWithMetadata } from '../src/angular/signal-forms.js';
import type { ValidationError } from '../src/core/validation-error.js';

const metadata = {
  Booking: {
    validators: [
      {
        name: 'expression',
        id: 'START_BEFORE_END',
        propertyNames: ['startDate', 'endDate'],
        context: { expression: '!model.startDate || !model.endDate || model.startDate < model.endDate', messageTemplate: 'Start must be before end' },
      },
      { name: 'expression', id: 'NOT_BAD', context: { expression: "model.name !== 'bad'", messageTemplate: 'Not a good booking' } },
    ],
    properties: {
      name: { displayName: 'Name', required: true },
      city: { displayName: 'City', required: true },
    },
  },
};

interface Booking {
  name: string;
  city: string;
  startDate: string;
  endDate: string;
}

// A new booking with an end date: changing only the start date breaks a rule on a field the user has not touched.
const newBooking = (): Booking => ({ name: '', city: '', startDate: '', endDate: '2026-01-01' });
const messagesOf = (errors: readonly { errorMessage?: string; message?: string }[]) => errors.map((e) => e.errorMessage ?? e.message);

beforeAll(() => {
  TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
});

class Host {
  booking = newBooking();
}

const TestHost = Component({
  selector: 'test-host',
  imports: [FormsModule, ValidationFormsDirectives],
  providers: [provideErrorVisibility()],
  template: `
    <form [validationModel]="booking" validationModelType="Booking" #form="validationForm">
      <input name="name" [(ngModel)]="booking.name" />
      <input name="city" [(ngModel)]="booking.city" />
      <input name="startDate" [(ngModel)]="booking.startDate" />
      <input name="endDate" [(ngModel)]="booking.endDate" />
    </form>
  `,
})(Host);

describe('ErrorVisibility with template-driven forms', () => {
  let fixture: ComponentFixture<Host>;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [TestHost], providers: [provideZonelessChangeDetection(), provideValidation({ metadata })] });
    fixture = TestBed.createComponent(TestHost);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  const field = (name: string) =>
    fixture.debugElement.query(By.css(`input[name="${name}"]`)).injector.get(ValidationFieldDirective);
  const input = (name: string) => fixture.debugElement.query(By.css(`input[name="${name}"]`)).nativeElement as HTMLInputElement;
  const type = async (name: string, value: string) => {
    input(name).value = value;
    input(name).dispatchEvent(new Event('input'));
    await fixture.whenStable();
  };
  const visibility = () => fixture.debugElement.injector.get(ErrorVisibility);
  const form = () => fixture.debugElement.query(By.css('form')).references['form'] as ValidationFormDirective;

  it("hides a new model's first errors, while the form stays invalid", () => {
    expect(messagesOf(field('name').errors())).toEqual(['Name is required']);
    expect(field('name').shownErrors()).toEqual([]);
    expect(field('name').hasShownErrors()).toBe(false);
    expect(form().errors().length).toBe(2);
  });

  it('shows a field\'s first errors once the user leaves it', async () => {
    input('name').dispatchEvent(new Event('blur'));
    await fixture.whenStable();

    expect(messagesOf(field('name').shownErrors())).toEqual(['Name is required']);
    expect(field('city').shownErrors()).toEqual([]);
  });

  it('shows an error the user caused at once, also on a field they have not touched', async () => {
    await type('startDate', '2026-02-01');
    // The end date was not touched, but the error is new: it shows there too.
    expect(messagesOf(field('endDate').shownErrors())).toEqual(['Start must be before end']);
    expect(messagesOf(field('startDate').shownErrors())).toEqual(['Start must be before end']);

    await type('name', 'bad');
    expect(messagesOf(form().shownModelErrors())).toEqual(['Not a good booking']);
    expect(field('city').shownErrors()).toEqual([]);
  });

  it('shows everything after a save attempt', async () => {
    visibility().revealAll();
    await fixture.whenStable();

    expect(messagesOf(field('name').shownErrors())).toEqual(['Name is required']);
    expect(messagesOf(field('city').shownErrors())).toEqual(['City is required']);
  });
});

class SwitchingHost {
  // A saved booking first, as when a screen shows an existing record before the user adds one.
  booking: Booking & { saved?: boolean } = { name: 'Ann', city: 'Seattle', startDate: '', endDate: '', saved: true };
}

const TestSwitchingHost = Component({
  selector: 'test-switching-host',
  imports: [FormsModule, ValidationFormsDirectives],
  providers: [provideErrorVisibility({ isNew: (model) => !(model as { saved?: boolean }).saved })],
  template: `
    <form [validationModel]="booking" validationModelType="Booking">
      <input name="name" [(ngModel)]="booking.name" />
      <input name="city" [(ngModel)]="booking.city" />
    </form>
  `,
})(SwitchingHost);

describe('ErrorVisibility when a template-driven form switches to a new model', () => {
  it("takes the new model's first errors from the model, not from the controls still showing the old one", async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [TestSwitchingHost], providers: [provideZonelessChangeDetection(), provideValidation({ metadata })] });
    const fixture = TestBed.createComponent(TestSwitchingHost);
    fixture.detectChanges();
    await fixture.whenStable();
    const field = (name: string) => fixture.debugElement.query(By.css(`input[name="${name}"]`)).injector.get(ValidationFieldDirective);

    // The controls still hold Ann's values when the form first validates the new booking.
    fixture.componentInstance.booking = newBooking();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(messagesOf(field('name').errors())).toEqual(['Name is required']);
    expect(field('name').shownErrors()).toEqual([]);
    expect(field('city').shownErrors()).toEqual([]);
  });
});

describe('ErrorVisibility with reactive forms', () => {
  it('reports touches and validations, and gives the errors to show', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), provideValidation({ metadata })] });
    const booking = newBooking();
    const visibility = new ErrorVisibility();
    const group = TestBed.inject(FormBuilder).group({ ...booking });
    const validation = TestBed.inject(FormValidators).validateFormGroup(group, () => ({ entity: booking, entityType: 'Booking' }), undefined, undefined, visibility);

    expect(group.get('name')!.invalid).toBe(true);
    expect(validation.shownErrorsAbout('name')).toEqual([]);

    group.get('name')!.markAsTouched();
    expect(messagesOf(validation.shownErrorsAbout('name') as ValidationError[])).toEqual(['Name is required']);

    // Only the form's start date changes (the model is untouched): the new error shows on the end date too.
    group.get('startDate')!.setValue('2026-02-01');
    expect(messagesOf(validation.shownErrorsAbout('endDate') as ValidationError[])).toEqual(['Start must be before end']);
    expect(validation.shownErrorsAbout('city')).toEqual([]);
    validation.dispose();
  });
});

describe('ErrorVisibility with Signal Forms', () => {
  it('follows the copies Signal Forms makes, and reads its touches', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), provideValidation({ metadata }), provideErrorVisibility()] });
    const model = signal<Booking>(newBooking());
    const bookingForm = TestBed.runInInjectionContext(() => form(model, (path) => validateWithMetadata(path, { modelType: 'Booking' })));
    const visibility = TestBed.inject(ErrorVisibility);
    const shown = (errors: Parameters<typeof shownErrors>[0]) => messagesOf(shownErrors(errors));

    expect(shown(bookingForm.name().errors())).toEqual([]);
    expect(bookingForm.name().invalid()).toBe(true);

    bookingForm.name().markAsTouched();
    expect(shown(bookingForm.name().errors())).toEqual(['Name is required']);

    // Each edit replaces the model with a copy; the city's first error stays hidden.
    bookingForm.startDate().value.set('2026-02-01');
    expect(shown(bookingForm.endDate().errors())).toEqual(['Start must be before end']);
    expect(shown(bookingForm.city().errors())).toEqual([]);

    visibility.revealAll();
    expect(shown(bookingForm.city().errors())).toEqual(['City is required']);
  });
});

// Errors shown outside a field: a summary of the booking's errors, filtered in a computed and in the template.
class SummaryHost {
  booking = newBooking();
  readonly visibility = injectErrorVisibility();
  readonly errors = validationErrors(() => this.booking, 'Booking');
  readonly shownErrors = computed(() => this.visibility.shown(this.booking, this.errors()));
}

const TestSummaryHost = Component({
  selector: 'test-summary-host',
  imports: [FormsModule, ValidationFormsDirectives],
  providers: [provideErrorVisibility()],
  template: `
    <form [validationModel]="booking" validationModelType="Booking">
      <input name="name" [(ngModel)]="booking.name" validationAriaInvalid />
      <input name="city" [(ngModel)]="booking.city" />
    </form>
    <ul>
      @for (e of visibility.shown(booking, errors()); track e.key) { <li>{{ e.errorMessage }}</li> }
    </ul>
  `,
})(SummaryHost);

describe('injectErrorVisibility', () => {
  let fixture: ComponentFixture<SummaryHost>;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [TestSummaryHost], providers: [provideZonelessChangeDetection(), provideValidation({ metadata })] });
    fixture = TestBed.createComponent(TestSummaryHost);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  const listed = () => Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('li'), (li) => li.textContent?.trim());
  const input = (name: string) => fixture.debugElement.query(By.css(`input[name="${name}"]`)).nativeElement as HTMLInputElement;

  it('updates errors shown outside a field, in a computed and a template, on a touch and on revealAll()', async () => {
    expect(fixture.componentInstance.shownErrors()).toEqual([]);
    expect(listed()).toEqual([]);

    input('name').dispatchEvent(new Event('blur'));
    await fixture.whenStable();
    expect(messagesOf(fixture.componentInstance.shownErrors())).toEqual(['Name is required']);
    expect(listed()).toEqual(['Name is required']);

    fixture.debugElement.injector.get(ErrorVisibility).revealAll();
    await fixture.whenStable();
    expect(messagesOf(fixture.componentInstance.shownErrors())).toEqual(['Name is required', 'City is required']);
    expect(listed()).toEqual(['Name is required', 'City is required']);
  });

  it('sets aria-invalid on a field with validationAriaInvalid while it has errors to show', async () => {
    expect(input('name').hasAttribute('aria-invalid')).toBe(false);

    input('name').dispatchEvent(new Event('blur'));
    await fixture.whenStable();
    expect(input('name').getAttribute('aria-invalid')).toBe('true');
    expect(input('city').hasAttribute('aria-invalid')).toBe(false);

    input('name').value = 'Ann';
    input('name').dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(input('name').hasAttribute('aria-invalid')).toBe(false);
  });

  it('shows every error without a provided visibility', () => {
    const wrapper = TestBed.runInInjectionContext(() => injectErrorVisibility());
    const errors = [{ key: 'a', propertyNames: [] }] as unknown as ValidationError[];
    expect(wrapper.visibility).toBeNull();
    expect(wrapper.shown({}, errors)).toEqual(errors);
    expect(wrapper.version()).toBe(0);
  });
});
