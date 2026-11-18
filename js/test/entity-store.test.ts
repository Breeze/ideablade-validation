import { Subject, firstValueFrom, skip } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { type Coalesce, type EntityInfo, createEntityStore, createValidationService, entityStoreOf } from '../src/index.js';

/** A minimal non-RxJS source: a list with change listeners, like many stores and event emitters. */
class ItemList {
  items: { name: string }[] = [];
  private listeners = new Set<() => void>();
  listenerCount = () => this.listeners.size;
  add(name: string) {
    this.items.push({ name });
    this.listeners.forEach((l) => l());
  }
  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const metadata = { Item: { properties: { name: { displayName: 'Name', required: true } } } };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const asItems = (items: { name: string }[]) => items.map((entity): EntityInfo => ({ entityType: 'Item', entity }));

function storeFor(list: ItemList) {
  let reads = 0;
  const store = createEntityStore({
    entities: () => {
      reads++;
      return asItems(list.items);
    },
    changes: (notify) => list.onChange(notify),
  });
  return { store, reads: () => reads };
}

/** Subscribes to validateEntityStore and records the number of entities of each run. */
function runs(store: Parameters<ReturnType<typeof createValidationService>['validateEntityStore']>[0], coalesce?: Coalesce, serviceCoalesce?: Coalesce) {
  const service = createValidationService({ metadata, coalesce: serviceCoalesce });
  const counts: number[] = [];
  const sub = service.validateEntityStore(store, coalesce === undefined ? {} : { coalesce }).subscribe((r) => counts.push(r.entities.length));
  return { counts, stop: () => sub.unsubscribe() };
}

describe('createEntityStore', () => {
  it('re-validates when the source signals a change', async () => {
    const list = new ItemList();
    const results$ = createValidationService({ metadata }).validateEntityStore(storeFor(list).store);

    expect((await firstValueFrom(results$)).validationErrors).toEqual([]);
    const next = firstValueFrom(results$.pipe(skip(1)));
    list.add('');
    expect((await next).validationErrors.map((e) => e.errorMessage)).toEqual(['Name is required']);
  });

  it('stops listening on unsubscribe, with a teardown function, an unsubscribable or an Observable', () => {
    const list = new ItemList();
    const sub = storeFor(list).store.changes$.subscribe();
    expect(list.listenerCount()).toBe(1);
    sub.unsubscribe();
    expect(list.listenerCount()).toBe(0);

    let unsubscribed = 0;
    createEntityStore({ entities: () => [], changes: () => ({ unsubscribe: () => unsubscribed++ }) }).changes$.subscribe().unsubscribe();
    expect(unsubscribed).toBe(1);

    const changes = new Subject<void>();
    const sub2 = createEntityStore({ entities: () => [], changes }).changes$.subscribe();
    expect(changes.observed).toBe(true);
    sub2.unsubscribe();
    expect(changes.observed).toBe(false);
  });

  it('uses getEntities for store(type) when given', () => {
    const lookup = () => [];
    expect(createEntityStore({ entities: () => [], changes: () => undefined, getEntities: lookup }).getEntities).toBe(lookup);
    expect(createEntityStore({ entities: () => [], changes: () => undefined }).getEntities).toBeUndefined();
  });
});

describe('validateEntityStore coalescing', () => {
  it('validates at once, then coalesces a burst into one run that reads the store once', async () => {
    const list = new ItemList();
    const { store, reads } = storeFor(list);
    const { counts, stop } = runs(store);
    expect(counts).toEqual([0]);

    for (let i = 0; i < 500; i++) {
      list.add(`item ${i}`);
    }
    expect(counts).toEqual([0]);
    await delay(0);
    expect(counts).toEqual([0, 500]);
    expect(reads()).toBe(2);
    stop();
  });

  it('coalesces bursts from Observable stores too', async () => {
    const entities$ = new Subject<EntityInfo[]>();
    const { counts, stop } = runs(entityStoreOf(entities$));
    for (let i = 1; i <= 100; i++) {
      entities$.next(asItems(Array.from({ length: i }, (_, n) => ({ name: `item ${n}` }))));
    }
    expect(counts).toEqual([1]);
    await delay(0);
    expect(counts).toEqual([1, 100]);
    stop();
  });

  it('a number collects the changes for that many ms after the first one, then runs once', () => {
    vi.useFakeTimers();
    try {
      const list = new ItemList();
      const { counts, stop } = runs(storeFor(list).store, 30);
      list.add('a');
      vi.advanceTimersByTime(20);
      list.add('b');
      vi.advanceTimersByTime(9);
      expect(counts).toEqual([0]);
      vi.advanceTimersByTime(1);
      expect(counts).toEqual([0, 2]);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesce: false validates on every change, per call or for the service', () => {
    for (const [perCall, forService] of [[false, undefined], [undefined, false]] as const) {
      const list = new ItemList();
      const { counts, stop } = runs(storeFor(list).store, perCall, forService);
      list.add('a');
      list.add('b');
      expect(counts).toEqual([0, 1, 2]);
      stop();
    }
  });

  it('a per-call setting overrides the service setting', () => {
    const list = new ItemList();
    const { counts, stop } = runs(storeFor(list).store, false, 1000);
    list.add('a');
    expect(counts).toEqual([0, 1]);
    stop();
  });
});
