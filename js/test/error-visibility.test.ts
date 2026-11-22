// ErrorVisibility: which errors to show, so a new model is not all red before the user has done anything.
import { DataProperty, DataType, EntityManager, EntityType, MetadataStore } from 'breeze-client';
import { describe, expect, it } from 'vitest';

import { breezeIsNew } from '../src/breeze/index.js';
import { ErrorVisibility, createValidationService } from '../src/index.js';
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

const service = createValidationService({ metadata });
const validate = (booking: Booking) => service.validateModelSync(booking, 'Booking');
const newBooking = (): Booking => ({ name: '', city: '', startDate: '', endDate: '' });
const shownMessages = (visibility: ErrorVisibility, booking: Booking, propertyName?: string) =>
  visibility
    .shown(booking, validate(booking))
    .filter((e) => propertyName === undefined || e.isFor(propertyName))
    .map((e) => e.errorMessage);

describe('ErrorVisibility', () => {
  it("hides a new model's first errors, also before its first validation", () => {
    const visibility = new ErrorVisibility();
    const booking = newBooking();
    expect(shownMessages(visibility, booking)).toEqual([]);

    visibility.observe(booking, validate(booking));
    expect(validate(booking).length).toBe(2);
    expect(shownMessages(visibility, booking)).toEqual([]);
  });

  it('shows every error of a model that is not new', () => {
    const visibility = new ErrorVisibility({ isNew: () => false });
    const booking = newBooking();
    visibility.observe(booking, validate(booking));

    expect(shownMessages(visibility, booking)).toEqual(['Name is required', 'City is required']);
  });

  it('shows a first error once a property it is about has been touched', () => {
    const visibility = new ErrorVisibility();
    const booking = newBooking();
    visibility.observe(booking, validate(booking));

    visibility.markTouched(booking, 'name');

    expect(visibility.isTouched(booking, 'name')).toBe(true);
    expect(shownMessages(visibility, booking)).toEqual(['Name is required']);
  });

  it('shows an error that appears after the first validation at once, on every property it is about', () => {
    const visibility = new ErrorVisibility();
    const booking = newBooking();
    visibility.observe(booking, validate(booking));

    booking.startDate = '2026-02-01';
    booking.endDate = '2026-01-01';
    visibility.observe(booking, validate(booking));

    expect(shownMessages(visibility, booking, 'startDate')).toEqual(['Start must be before end']);
    expect(shownMessages(visibility, booking, 'endDate')).toEqual(['Start must be before end']);
    expect(shownMessages(visibility, booking, 'name')).toEqual([]);
  });

  it('shows a first error that went away and came back', () => {
    const visibility = new ErrorVisibility();
    const booking = newBooking();
    visibility.observe(booking, validate(booking));

    booking.city = 'Seattle';
    visibility.observe(booking, validate(booking));
    booking.city = '';
    visibility.observe(booking, validate(booking));

    expect(shownMessages(visibility, booking)).toEqual(['City is required']);
  });

  it('shows every error after revealAll, and gives a model first validated afterwards a baseline of its own', () => {
    const visibility = new ErrorVisibility();
    const first = newBooking();
    visibility.observe(first, validate(first));

    visibility.revealAll();
    const second = newBooking();
    visibility.observe(second, validate(second));

    expect(shownMessages(visibility, first)).toEqual(['Name is required', 'City is required']);
    expect(shownMessages(visibility, second)).toEqual([]);
  });

  it('carries the state over to a copy that replaced the model', () => {
    const visibility = new ErrorVisibility();
    const booking = newBooking();
    visibility.observe(booking, validate(booking));
    visibility.markTouched(booking, 'name');

    const copy = { ...booking, startDate: '2026-01-01' };
    // Looked up before the transfer, as a render does: still carried over.
    expect(visibility.isShown(copy, validate(copy)[0])).toBe(false);
    visibility.transfer(booking, copy);
    visibility.observe(copy, validate(copy));

    expect(shownMessages(visibility, copy)).toEqual(['Name is required']);
  });

  it('forgets everything on reset', () => {
    const visibility = new ErrorVisibility();
    const booking = newBooking();
    visibility.observe(booking, validate(booking));
    visibility.markTouched(booking, 'name');

    visibility.reset();

    expect(visibility.isTouched(booking, 'name')).toBe(false);
    expect(shownMessages(visibility, booking)).toEqual([]);
  });

  it('takes the baselines from entity store results, skipping those still waiting for async rules', () => {
    const visibility = new ErrorVisibility();
    const booking = newBooking();
    const entities = [{ entity: booking, entityType: 'Booking' }];
    visibility.observeEntities({ entities, validationErrors: [], pending: true });
    visibility.observeEntities({ entities, validationErrors: validate(booking), pending: false });

    expect(shownMessages(visibility, booking)).toEqual([]);
  });

  it('notifies changes', () => {
    const visibility = new ErrorVisibility();
    const booking = newBooking();
    let notified = 0;
    visibility.changes$.subscribe(() => notified++);
    const before = visibility.version;

    visibility.observe(booking, validate(booking));
    visibility.markTouched(booking, 'name');
    visibility.markTouched(booking, 'name');
    visibility.revealAll();

    expect(notified).toBe(3);
    expect(visibility.version).toBe(before + 3);
  });

  it("always shows errors that aren't the framework's", () => {
    const visibility = new ErrorVisibility();
    const booking = newBooking();
    visibility.observe(booking, validate(booking));

    expect(visibility.isShown(booking, { required: true } as unknown as ValidationError)).toBe(true);
  });
});

describe('breezeIsNew', () => {
  it('counts added entities as new, and loaded ones and anything else accordingly', () => {
    const store = new MetadataStore();
    const type = new EntityType({ shortName: 'Customer', namespace: 'Test' });
    type.addProperty(new DataProperty({ name: 'id', dataType: DataType.Int32, isPartOfKey: true }));
    store.addEntityType(type);
    const manager = new EntityManager({ metadataStore: store });

    const added = manager.createEntity('Customer', { id: 1 });
    const loaded = manager.createEntity('Customer', { id: 2 });
    loaded.entityAspect.acceptChanges();

    expect(breezeIsNew(added)).toBe(true);
    expect(breezeIsNew(loaded)).toBe(false);
    expect(breezeIsNew({ name: 'a view model' })).toBe(true);
  });
});
