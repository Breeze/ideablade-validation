// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { type ReactNode, useState } from 'react';
import { Subject, delay, of } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';

import { asyncValidator, createEntityStore, createValidationService } from '../src/index.js';
import { ValidationForm, ValidationProvider, useEntityStoreValidation, useFieldValidation, useValidation } from '../src/react/index.js';

afterEach(cleanup);

const metadata = {
  User: {
    properties: {
      name: { displayName: 'Name', required: true },
      login: { displayName: 'Login', validators: [{ name: 'available', async: true }] },
    },
  },
};

const makeService = () =>
  createValidationService({
    metadata,
    validators: [asyncValidator('available', (v) => of(v !== 'taken').pipe(delay(10)), '%displayName% is taken')],
  });

describe('useValidation', () => {
  it('returns sync errors immediately and async errors later', async () => {
    const service = makeService();
    const wrapper = ({ children }: { children: ReactNode }) => <ValidationProvider service={service}>{children}</ValidationProvider>;
    const { result, rerender } = renderHook(({ model }) => useValidation(model, 'User'), {
      wrapper,
      initialProps: { model: { name: '', login: 'taken' } as Record<string, string> },
    });

    expect(result.current.messagesFor('name')).toEqual(['Name is required']);
    expect(result.current.pending).toBe(true);
    expect(result.current.isValid).toBe(false);

    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.messagesFor('login')).toEqual(['Login is taken']);

    rerender({ model: { name: 'Ann', login: 'free' } });
    expect(result.current.errors).toEqual([]);
    expect(result.current.pending).toBe(true); // stale async result is ignored
    await waitFor(() => expect(result.current.isValid).toBe(true));
  });

  it('revalidates models mutated in place via revalidate() or deps', () => {
    const model = { name: '', login: '' };
    function Form() {
      const [, setTick] = useState(0);
      const { messagesFor, revalidate } = useValidation(model, 'User', { async: false });
      return (
        <div>
          <span data-testid="msg">{messagesFor('name').join(',')}</span>
          <button
            onClick={() => {
              model.name = 'Bob';
              revalidate();
              setTick((t) => t + 1);
            }}
          >
            fix
          </button>
        </div>
      );
    }
    render(
      <ValidationProvider metadata={metadata}>
        <Form />
      </ValidationProvider>,
    );
    expect(screen.getByTestId('msg').textContent).toBe('Name is required');
    act(() => screen.getByText('fix').click());
    expect(screen.getByTestId('msg').textContent).toBe('');
  });

  it('throws a helpful error without a provider', () => {
    expect(() => renderHook(() => useValidation({}, 'User'))).toThrow(/ValidationProvider/);
  });
});

describe('useEntityStoreValidation', () => {
  it('tracks entity store validation results', async () => {
    const service = makeService();
    const entities$ = new Subject<{ entityType: string; entity: unknown }[]>();
    const store = { entities$ };
    const wrapper = ({ children }: { children: ReactNode }) => <ValidationProvider service={service}>{children}</ValidationProvider>;
    const { result } = renderHook(() => useEntityStoreValidation(store, { predicate: (v) => !v.async }), { wrapper });
    expect(result.current).toBeUndefined();
    act(() => entities$.next([{ entityType: 'User', entity: { name: '' } }]));
    await waitFor(() => expect(result.current?.validationErrors).toHaveLength(1));
  });
});

describe('useValidation: the model as a whole', () => {
  const bookingMetadata = {
    Booking: {
      validators: [
        {
          name: 'expression',
          propertyNames: ['startDate', 'endDate'],
          context: { expression: 'model.startDate < model.endDate', messageTemplate: 'Start must be before end' },
        },
        { name: 'expression', context: { expression: "model.note !== 'bad'", messageTemplate: 'Not a good booking' } },
      ],
      properties: { reason: { displayName: 'Reason', validators: [{ name: 'required', condition: "model.kind === 'other'" }] } },
    },
  };

  it('reports a model-level rule on every field it names, and model-wide errors without a name', () => {
    const changes = new Subject<void>();
    const booking = { startDate: '2026-02-01', endDate: '2026-01-01', kind: 'other', reason: '', note: '' };
    // The booking's scope: a service whose entity store holds the booking.
    const store = createEntityStore({ entities: () => [{ entityType: 'Booking', entity: booking }], changes });
    const service = createValidationService({ metadata: bookingMetadata }).createScope(store);
    const wrapper = ({ children }: { children: ReactNode }) => <ValidationProvider service={service}>{children}</ValidationProvider>;
    const { result } = renderHook(() => useValidation(booking, 'Booking', { async: false }), { wrapper });

    expect(result.current.messagesFor('startDate')).toEqual(['Start must be before end']);
    expect(result.current.messagesFor('endDate')).toEqual(['Start must be before end']);
    expect(result.current.messagesFor('reason')).toEqual(['Reason is required']);
    expect(result.current.messagesFor()).toEqual([]);

    // Changed elsewhere; the service's entity store reports it.
    act(() => {
      booking.note = 'bad';
      booking.kind = '';
      changes.next();
    });
    expect(result.current.messagesFor()).toEqual(['Not a good booking']);
    expect(result.current.messagesFor('reason')).toEqual([]);
  });
});

describe('ValidationForm', () => {
  const metadata = {
    Booking: {
      validators: [
        {
          name: 'expression',
          propertyNames: ['startDate', 'endDate'],
          context: { expression: 'model.startDate < model.endDate', messageTemplate: 'Start must be before end' },
        },
        { name: 'expression', context: { expression: "model.note !== 'bad'", messageTemplate: 'Not a good booking' } },
      ],
      properties: { note: { displayName: 'Note', validators: [{ name: 'maxLength', context: { maxLength: 3 } }] } },
    },
  };

  function Field({ name }: { name?: string }) {
    const { message } = useFieldValidation(name);
    return <span data-testid={name ?? 'form'}>{message ?? ''}</span>;
  }

  it('validates the model once for its fields, finding the model type with the resolvers', () => {
    const changes = new Subject<void>();
    const booking = { kind: 'Booking', startDate: 5, endDate: 1, note: '' };
    const service = createValidationService({ metadata, modelTypeResolvers: [(m) => (m as { kind?: string })?.kind] }).createScope(
      createEntityStore({ entities: () => [{ entityType: 'Booking', entity: booking }], changes }),
    );
    render(
      <ValidationProvider service={service}>
        <ValidationForm model={booking} async={false}>
          <Field name="startDate" />
          <Field name="endDate" />
          <Field name="note" />
          <Field />
        </ValidationForm>
      </ValidationProvider>,
    );
    const text = (id: string) => screen.getByTestId(id).textContent;

    expect(text('startDate')).toBe('Start must be before end');
    expect(text('endDate')).toBe('Start must be before end');
    expect(text('note')).toBe('');
    expect(text('form')).toBe('');

    // The model changed in place; the scope's store reports it.
    act(() => {
      booking.endDate = 10;
      booking.note = 'bad';
      changes.next();
    });
    expect(text('startDate')).toBe('');
    expect(text('endDate')).toBe('');
    expect(text('form')).toBe('Not a good booking');
  });

  it('gives fields outside a form no errors', () => {
    render(<Field name="x" />);
    expect(screen.getByTestId('x').textContent).toBe('');
  });
});
