// @vitest-environment jsdom
// ErrorVisibility in React: a ValidationForm over useState, whose model is replaced by a copy on every change.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useMemo, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ErrorVisibility, createValidationService } from '../src/index.js';
import {
  ErrorVisibilityProvider,
  ValidationForm,
  ValidationProvider,
  useErrorVisibilityVersion,
  useFieldValidation,
  useShownErrors,
  useValidationService,
} from '../src/react/index.js';

afterEach(cleanup);

const metadata = {
  Booking: {
    validators: [
      {
        name: 'expression',
        id: 'START_BEFORE_END',
        propertyNames: ['startDate', 'endDate'],
        context: { expression: '!model.startDate || !model.endDate || model.startDate < model.endDate', messageTemplate: 'Start must be before end' },
      },
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

function Field({ name, booking, onChange }: { name: keyof Booking; booking: Booking; onChange: (value: string) => void }) {
  const field = useFieldValidation(name);
  return (
    <label>
      <input aria-label={name} value={booking[name]} onChange={(e) => onChange(e.target.value)} onBlur={field.markTouched} />
      <span data-testid={`${name}-error`}>{field.message ?? ''}</span>
      <span data-testid={`${name}-all`}>{field.allErrors.length}</span>
    </label>
  );
}

function BookingForm() {
  // A new booking with an end date: changing only the start date breaks a rule on a field the user has not touched.
  const [booking, setBooking] = useState<Booking>({ name: '', city: '', startDate: '', endDate: '2026-01-01' });
  const fields: (keyof Booking)[] = ['name', 'city', 'startDate', 'endDate'];
  return (
    <ValidationForm model={booking} modelType="Booking">
      {fields.map((name) => (
        <Field key={name} name={name} booking={booking} onChange={(value) => setBooking({ ...booking, [name]: value })} />
      ))}
    </ValidationForm>
  );
}

describe('ErrorVisibility with React', () => {
  function renderForm() {
    const visibility = new ErrorVisibility();
    render(
      <ValidationProvider service={createValidationService({ metadata })}>
        <ErrorVisibilityProvider visibility={visibility}>
          <BookingForm />
        </ErrorVisibilityProvider>
      </ValidationProvider>,
    );
    return visibility;
  }
  const error = (name: string) => screen.getByTestId(`${name}-error`).textContent;

  it("hides a new model's first errors, but keeps them in allErrors", () => {
    renderForm();
    expect(error('name')).toBe('');
    expect(screen.getByTestId('name-all').textContent).toBe('1');
  });

  it('shows a field\'s first errors once the user leaves it', () => {
    renderForm();
    fireEvent.blur(screen.getByLabelText('name'));
    expect(error('name')).toBe('Name is required');
    expect(error('city')).toBe('');
  });

  it('follows the copies useState makes, and shows an error the user caused on a field they have not touched', () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('startDate'), { target: { value: '2026-02-01' } });

    expect(error('endDate')).toBe('Start must be before end');
    expect(error('startDate')).toBe('Start must be before end');
    // The copies keep the baseline: the city's first error stays hidden.
    expect(error('city')).toBe('');
  });

  it('shows everything after a save attempt', () => {
    const visibility = renderForm();
    act(() => visibility.revealAll());
    expect(error('name')).toBe('Name is required');
    expect(error('city')).toBe('City is required');
  });
});

// Errors shown outside a field: a summary of the booking's errors, next to the form that reports its validations.
function Summary({ booking }: { booking: Booking }) {
  const service = useValidationService();
  const errors = useMemo(() => service.validateModelSync(booking, 'Booking'), [service, booking]);
  const shown = useShownErrors(booking, errors);
  return <ul data-testid="summary">{shown.map((e) => <li key={e.key}>{e.errorMessage}</li>)}</ul>;
}

function VersionProbe() {
  return <span data-testid="version">{useErrorVisibilityVersion()}</span>;
}

function BookingWithSummary() {
  const [booking] = useState<Booking>({ name: '', city: '', startDate: '', endDate: '' });
  return (
    <>
      <ValidationForm model={booking} modelType="Booking">
        <Field name="name" booking={booking} onChange={() => {}} />
      </ValidationForm>
      <Summary booking={booking} />
      <VersionProbe />
    </>
  );
}

describe('useShownErrors', () => {
  const summary = () => Array.from(screen.getByTestId('summary').querySelectorAll('li'), (li) => li.textContent);

  it('re-renders errors shown outside a field on a touch and on revealAll()', () => {
    const visibility = new ErrorVisibility();
    render(
      <ValidationProvider service={createValidationService({ metadata })}>
        <ErrorVisibilityProvider visibility={visibility}>
          <BookingWithSummary />
        </ErrorVisibilityProvider>
      </ValidationProvider>,
    );
    expect(summary()).toEqual([]);
    const version = Number(screen.getByTestId('version').textContent);

    fireEvent.blur(screen.getByLabelText('name'));
    expect(summary()).toEqual(['Name is required']);
    expect(Number(screen.getByTestId('version').textContent)).toBeGreaterThan(version);

    act(() => visibility.revealAll());
    expect(summary()).toEqual(['Name is required', 'City is required']);
  });

  it('shows every error without an ErrorVisibilityProvider', () => {
    render(
      <ValidationProvider service={createValidationService({ metadata })}>
        <BookingWithSummary />
      </ValidationProvider>,
    );
    expect(summary()).toEqual(['Name is required', 'City is required']);
    expect(screen.getByTestId('version').textContent).toBe('0');
  });
});
