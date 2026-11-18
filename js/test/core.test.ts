import { BehaviorSubject, Subject, delay, firstValueFrom, lastValueFrom, of, skip, take, toArray } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import {
  type EntityInfo,
  type ModelValidationMetadataMap,
  type ValidatorFactory,
  ValidationConfigurationError,
  asyncValidator,
  createValidationService,
  entityStoreOf,
  resolveBound,
  syncValidator,
} from '../src/index.js';

const metadata: ModelValidationMetadataMap = {
  global: { validators: [{ name: 'expression', id: 'HAS_ID', context: { expression: 'model.id != null', messageTemplate: 'Missing id' } }] },
  Person: {
    properties: {
      firstName: { displayName: 'First name', required: true, maxLength: 10 },
      email: { displayName: 'E-mail', validators: ['email'] },
      age: { validators: [{ name: 'range', context: { minValue: 0, maxValue: 130 } }] },
      phone: { validators: [{ name: 'phone', condition: 'model.country === "US"' }] },
    },
  },
  Employee: {
    extends: 'Person',
    validators: [
      {
        name: 'expression',
        context: { expression: 'model.endDate == null || model.endDate > model.startDate', messageTemplate: 'End must follow start' },
      },
    ],
    properties: {
      employeeNo: { displayName: 'Employee #', validators: [{ group: 'hire', validators: ['required'] }] },
    },
  },
};

const validPerson = { id: 1, firstName: 'Ann', email: 'ann@example.com', age: 40, country: 'US', phone: '555-123-4567' };

describe('ValidationService (sync)', () => {
  const service = createValidationService({ metadata });

  it('returns no errors for a valid model', () => {
    expect(service.validateModelSync(validPerson, 'Person')).toEqual([]);
  });

  it('runs property shorthand validators and formats messages', () => {
    const errors = service.validateModelSync({ ...validPerson, firstName: '' }, 'Person');
    expect(errors.map((e) => e.errorMessage)).toEqual(['First name is required']);
    expect(errors[0].key).toBe('required_firstName');
    expect(errors[0].id).toBe('REQUIRED');
    expect(errors[0].propertyName).toBe('firstName');
  });

  it('runs global validators for every model type, including unknown types', () => {
    expect(service.validateModelSync({}, 'Unknown').map((e) => e.id)).toEqual(['HAS_ID']);
  });

  it('honours validator conditions', () => {
    expect(service.validateModelSync({ ...validPerson, country: 'CA', phone: 'x' }, 'Person')).toEqual([]);
    expect(service.validateModelSync({ ...validPerson, phone: 'x' }, 'Person').map((e) => e.key)).toEqual(['phone_phone']);
  });

  it('inherits validators and properties through extends without duplicating global validators', () => {
    const errors = service.validateModelSync({ firstName: '', startDate: new Date(2024, 1, 1), endDate: new Date(2023, 1, 1) }, 'Employee');
    expect(errors.map((e) => e.errorMessage).sort()).toEqual(['Employee # is required', 'End must follow start', 'First name is required', 'Missing id']);
  });

  it('filters by group with a predicate', () => {
    const employee = { ...validPerson, startDate: new Date() };
    expect(service.validateModelSync(employee, 'Employee')).toHaveLength(1); // grouped validators run by default
    const hireOnly = service.validateModelSync(employee, 'Employee', { predicate: (v) => v.group === 'hire' });
    expect(hireOnly.map((e) => e.key)).toEqual(['required_hire_employeeNo']);
    const noGroups = service.validateModelSync(employee, 'Employee', { predicate: (v) => !v.group });
    expect(noGroups).toEqual([]);
  });

  it('throws a configuration error for unknown validators', () => {
    const s = createValidationService({ metadata: { X: { validators: ['nope'] } } });
    expect(() => s.validateModelSync({}, 'X')).toThrow(ValidationConfigurationError);
  });

  it('throws a configuration error for failing conditions', () => {
    const s = createValidationService({ metadata: { X: { validators: [{ name: 'required', condition: 'model.a.b' }] } } });
    expect(() => s.validateModelSync({}, 'X')).toThrow(/Condition 'model.a.b' failed/);
  });

  it('merges multiple metadata maps for the same model type', () => {
    const s = createValidationService({
      metadata: [{ X: { properties: { a: { required: true } } } }, [{ X: { properties: { a: { displayName: 'A' }, b: { required: true } } } }]],
    });
    expect(s.validateModelSync({}, 'X').map((e) => e.errorMessage)).toEqual(['A is required', 'b is required']);
  });

  it('turns exceptions in validators into validation errors', () => {
    const s = createValidationService({
      metadata: { X: { validators: ['boom'] } },
      validators: [syncValidator('boom', () => { throw new Error('kaboom'); })],
    });
    const [error] = s.validateModelSync({}, 'X');
    expect((error.context as unknown as { exception: Error }).exception.message).toBe('kaboom');
  });

  it('merges context from context providers and options', () => {
    const fn = vi.fn((_v: unknown, ctx: { tenant: string; user: string }) => ctx.tenant === 'acme' && ctx.user === 'bob');
    const s = createValidationService({
      metadata: { X: { properties: { a: { validators: ['ctx'] } } } },
      validators: [syncValidator('ctx', fn as never)],
      contextProviders: [{ contextFn: () => ({ tenant: 'acme' }) }],
    });
    expect(s.validateModelSync({ a: 1 }, 'X', { context: { user: 'bob' } })).toEqual([]);
  });

  it('exposes expression scope functions to conditions and expressions', () => {
    const s = createValidationService({
      metadata: { X: { properties: { code: { validators: [{ name: 'expression', context: { expression: 'isKnown(value)' } }] } } } },
      expressionScope: { isKnown: (v: string) => v === 'A' },
    });
    expect(s.validateModelSync({ code: 'A' }, 'X')).toEqual([]);
    expect(s.validateModelSync({ code: 'B' }, 'X')).toHaveLength(1);
  });

  it('notifies modelValidated$', () => {
    const seen: number[] = [];
    const sub = service.modelValidated$.subscribe((e) => seen.push(e.validationErrors.length));
    service.validateModelSync({ ...validPerson, firstName: '' }, 'Person');
    sub.unsubscribe();
    expect(seen).toEqual([1]);
  });
});

describe('ValidationService (async)', () => {
  const lookup = vi.fn((value: string) => of(value !== 'taken').pipe(delay(5)));
  const service = createValidationService({
    metadata: { User: { properties: { login: { required: true, validators: [{ name: 'available', async: true }] } } } },
    validators: [asyncValidator('available', lookup, '%displayName% is taken')],
  });

  it('runs async validators once per subscription', async () => {
    lookup.mockClear();
    const errors = await firstValueFrom(service.validateModelAsync({ login: 'taken' }, 'User'));
    expect(errors.map((e) => e.errorMessage)).toEqual(['login is taken']);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('validateModelAsync runs sync and async validators', async () => {
    expect((await firstValueFrom(service.validateModelAsync({ login: '' }, 'User'))).map((e) => e.errorMessage)).toEqual(['login is required']);
  });

  it('runs every validator once in validate() and validateModelAsync()', async () => {
    const sync = vi.fn((v: string) => v !== 'x');
    const slow = vi.fn((v: string) => of(v !== 'y').pipe(delay(1)));
    const s = createValidationService({
      metadata: { X: { properties: { a: { validators: ['s', { name: 'a', async: true }] } } } },
      validators: [syncValidator('s', sync), asyncValidator('a', slow)],
    });
    await lastValueFrom(s.validate({ a: 'x' }, 'X'));
    await firstValueFrom(s.validateModelAsync({ a: 'x' }, 'X'));
    expect(sync).toHaveBeenCalledTimes(2);
    expect(slow).toHaveBeenCalledTimes(2);
  });

  it('uses validateAsync of a sync validator instead of validate in the async path', async () => {
    const calls: string[] = [];
    const both: ValidatorFactory = {
      name: 'both',
      fn: (group, context) => {
        // The sync check fails, the full async check passes, so the result shows which one ran.
        const v = syncValidator('both', () => (calls.push('sync'), false), 'sync check').fn(group, context);
        v.validateAsync = () => (calls.push('async'), of(null).pipe(delay(1)));
        return v;
      },
    };
    const s = createValidationService({ metadata: { X: { validators: ['both'] } }, validators: [both] });
    expect(s.hasAsyncValidators('X')).toBe(true);

    expect(s.validateModelSync({}, 'X')).toHaveLength(1);
    expect(calls.splice(0)).toEqual(['sync']);

    expect(await firstValueFrom(s.validateModelAsync({}, 'X'))).toEqual([]);
    expect(calls.splice(0)).toEqual(['async']);

    // validate() shows the sync result while the async check runs
    const states = await lastValueFrom(s.validate({}, 'X').pipe(toArray()));
    expect(states.map((st) => [st.pending, st.errors.length])).toEqual([
      [true, 1],
      [false, 0],
    ]);
    expect(calls.splice(0)).toEqual(['sync', 'async']);
  });

  it('emits an empty array when there are no async validators', async () => {
    expect(await firstValueFrom(service.validateModelAsync({}, 'Other'))).toEqual([]);
  });

  it('validate() emits sync errors first and then the combined result', async () => {
    const states = await lastValueFrom(service.validate({ login: 'taken' }, 'User').pipe(toArray()));
    expect(states.map((s) => [s.pending, s.errors.length])).toEqual([
      [true, 0],
      [false, 1],
    ]);
  });

  it('accepts promises and treats rejections as failures', async () => {
    const s = createValidationService({
      metadata: { X: { properties: { a: { validators: [{ name: 'p', async: true }], b: undefined } as never } } },
      validators: [asyncValidator('p', (v) => (v === 'bad' ? Promise.reject(new Error('down')) : Promise.resolve(true)))],
    });
    expect(await firstValueFrom(s.validateModelAsync({ a: 'ok' }, 'X'))).toEqual([]);
    expect(await firstValueFrom(s.validateModelAsync({ a: 'bad' }, 'X'))).toHaveLength(1);
  });

  it('times out slow async validators and continues without errors', async () => {
    const onAsyncTimeout = vi.fn();
    const s = createValidationService({
      metadata: { X: { properties: { a: { validators: [{ name: 'slow', async: true }] } } } },
      validators: [asyncValidator('slow', () => of(false).pipe(delay(200)))],
      asyncTimeout: 20,
      onAsyncTimeout,
    });
    expect(await firstValueFrom(s.validateModelAsync({ a: 1 }, 'X'))).toEqual([]);
    expect(onAsyncTimeout).toHaveBeenCalledOnce();
  });

  it('emits the sync errors when async validators time out', async () => {
    const s = createValidationService({
      metadata: { X: { properties: { a: { required: true, validators: [{ name: 'slow', async: true }] } } } },
      validators: [asyncValidator('slow', () => of(false).pipe(delay(200)))],
      asyncTimeout: 20,
    });
    expect((await firstValueFrom(s.validateModelAsync({ a: '' }, 'X'))).map((e) => e.key)).toEqual(['required_a']);
  });
});

describe('ValidationService (entity store)', () => {
  const md: ModelValidationMetadataMap = {
    Order: {
      condition: '!model.isArchived',
      properties: { number: { required: true, validators: ['unique'] } },
      validators: [
        {
          name: 'expression',
          context: { expression: "store('OrderLine').some(l => l.orderId === model.id)", messageTemplate: 'Order %model.number% has no lines' },
        },
      ],
    },
    OrderLine: { condition: 'findEntity(model.orderId, "Order") != null' },
  };

  it('validates all entities and exposes store() and findEntity()', async () => {
    const service = createValidationService({ metadata: md });
    const entities: EntityInfo[] = [
      { entityType: 'Order', entity: { id: 1, number: 'A' } },
      { entityType: 'Order', entity: { id: 2, number: 'A' } },
      { entityType: 'Order', entity: { id: 3, number: '', isArchived: true } },
      { entityType: 'OrderLine', entity: { id: 10, orderId: 1 } },
    ];
    const result = await firstValueFrom(service.validateEntityStoreOneTime(entityStoreOf(entities)));
    expect(result.validationErrors.map((e) => e.errorMessage).sort()).toEqual([
      'Order A has no lines',
      'number must be unique',
      'number must be unique',
    ]);
  });

  it('re-validates when entities change, metadata changes or revalidate() is called', async () => {
    const service = createValidationService({ metadata: md });
    const entities$ = new BehaviorSubject<EntityInfo[]>([{ entityType: 'Order', entity: { id: 1, number: '' } }]);
    const results$ = service.validateEntityStore({ entities$ }).pipe(take(4), toArray());
    const done = lastValueFrom(results$);
    entities$.next([{ entityType: 'Order', entity: { id: 1, number: 'X' } }, { entityType: 'OrderLine', entity: { orderId: 1 } }]);
    service.validationMetadata.setMetadata([]);
    service.revalidate();
    const results = await done;
    expect(results.map((r) => r.validationErrors.length)).toEqual([2, 0, 0, 0]);
  });

  it('re-validates when options.event$ emits', async () => {
    const service = createValidationService({ metadata: md });
    const event$ = new Subject<void>();
    const order = { id: 1, number: '' };
    const done = firstValueFrom(service.validateEntityStore(entityStoreOf([{ entityType: 'Order', entity: order }]), { event$ }).pipe(skip(1)));
    order.number = 'fixed';
    event$.next();
    expect((await done).validationErrors.map((e) => e.key)).toEqual(['expression']);
  });
});

describe('default validators', () => {
  const service = createValidationService({
    metadata: {
      T: {
        properties: {
          ssn: { validators: ['social'] },
          fein: { validators: ['fein'] },
          zip: { validators: ['zipCode'] },
          email: { validators: ['email'] },
          amount: { validators: ['currency'] },
          count: { validators: ['numeric'] },
          code: { validators: [{ name: 'numeric', context: { allowLeadingZeros: true } }] },
          price: { validators: [{ name: 'numeric', context: { allowDecimals: true } }] },
          int: { validators: ['integer'] },
          dob: { validators: [{ name: 'dateRange', context: { minValue: 'now-150y', maxValue: 'today' } }] },
          when: { validators: ['date'] },
          end: { validators: [{ name: 'compare', context: { other: 'start', op: '>=' } }] },
          state: { validators: [{ name: 'invalidValues', context: { values: ['XX', '/^Z/'] } }] },
          color: { validators: [{ name: 'validValues', context: { values: ['red', 'green'] } }] },
          sku: { validators: [{ name: 'pattern', context: { expression: '^[A-Z]{3}-\\d+$' } }] },
          tags: { required: true, minLength: 1 },
        },
      },
    },
  });
  const keys = (model: Record<string, unknown>) => service.validateModelSync({ tags: ['a'], ...model }, 'T').map((e) => e.propertyName);

  it.each([
    ['ssn', '123-45-6789', true],
    ['ssn', '123456789', true],
    ['ssn', '123-45-6789x', false], // the original alternation regex accepted this
    ['ssn', 'x123456789', false],
    ['fein', '12-3456789', true],
    ['fein', '123456789', false],
    ['zip', '94612', true],
    ['zip', '94612-1234', true],
    ['zip', '9461', false],
    ['email', 'a.b+c@example.co.uk', true],
    ['email', 'not-an-email', false],
    ['amount', '1,234.56', true],
    ['amount', 12.5, true],
    ['amount', '12.345', false],
    ['count', '0', true],
    ['count', '10', true],
    ['count', '010', false],
    ['count', '1abc', false], // the original alternation regex accepted this
    ['count', 1.5, false],
    ['code', '007', true],
    ['price', '3.14', true],
    ['price', 3.14, true],
    ['int', -3, true],
    ['int', '2.5', false],
    ['dob', new Date(2000, 0, 1), true],
    ['dob', new Date(Date.now() + 86_400_000 * 2), false],
    ['when', new Date('invalid'), false],
    ['state', 'CA', true],
    ['state', 'XX', false],
    ['state', 'ZZ', false],
    ['color', 'red', true],
    ['color', 'blue', false],
    ['sku', 'ABC-12', true],
    ['sku', 'abc-12', false],
  ])('%s = %j → valid: %s', (property, value, valid) => {
    expect(keys({ [property]: value })).toEqual(valid ? [] : [property]);
  });

  it('compare uses the other property', () => {
    expect(keys({ start: 5, end: 4 })).toEqual(['end']);
    expect(keys({ start: new Date(2020, 0, 1), end: new Date(2021, 0, 1) })).toEqual([]);
  });

  it('required and minLength handle arrays', () => {
    expect(keys({ tags: [] })).toEqual(['tags']);
  });

  it('range formats bounds in messages', () => {
    const s = createValidationService({ metadata: { T: { properties: { n: { displayName: 'N', validators: [{ name: 'range', context: { minValue: 1, maxValue: 5 } }] } } } } });
    expect(s.validateModelSync({ n: 9 }, 'T')[0].errorMessage).toBe('N must be between 1 and 5');
  });
});

describe('resolveBound', () => {
  const now = new Date(2024, 5, 15, 12, 30);
  it.each([
    [5, 5],
    ['5', 5],
    ['year', 2024],
    ['year+1', 2025],
    ['year-200', 2024 - 150],
  ])('%j → %j', (input, expected) => {
    expect(resolveBound(input, now)).toBe(expected);
  });

  it('resolves relative dates', () => {
    expect((resolveBound('now-18y', now) as Date).getFullYear()).toBe(2006);
    expect((resolveBound('Now-20', now) as Date).getFullYear()).toBe(2004);
    expect((resolveBound('today+1d', now) as Date).toISOString()).toBe(new Date(2024, 5, 16).toISOString());
    expect((resolveBound('now+2M', now) as Date).getMonth()).toBe(7);
    expect((resolveBound('now-30m', now) as Date).getMinutes()).toBe(0);
    expect((resolveBound('2024-01-31', now) as Date).getUTCDate()).toBe(31);
  });
});
