// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { type ReactNode, useState } from 'react';
import { Subject, delay, of } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';

import { asyncValidator, createValidationService } from '../src/index.js';
import { ValidationProvider, useEntityStoreValidation, useValidation } from '../src/react/index.js';

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
