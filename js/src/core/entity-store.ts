import { Observable, isObservable } from 'rxjs';

import type { EntityInfo, StoreQuery } from './context.js';
// EntityStore and ValidationServiceOptions are referenced by {@link}s in the doc comments.
import type { EntityStore, NotifyingEntityStore, ValidationServiceOptions } from './validation-service.js';

/** Stops listening for changes: a function, an object with `unsubscribe()` (RxJS, many event APIs), or nothing. */
export type ChangeTeardown = (() => void) | { unsubscribe(): void } | void;

export interface CreateEntityStoreOptions {
  /** Returns the current entities. The service reads them once at the start and once per (coalesced) change. */
  entities: () => readonly EntityInfo[];
  /**
   * Tells the store when the source changed. Either a function that starts listening, calls `notify` on every change
   * and returns how to stop, or an Observable that emits on every change. What it emits is ignored.
   *
   * Don't batch the notifications yourself: the validation service coalesces bursts of changes (see
   * {@link ValidationServiceOptions.coalesce}).
   *
   * @example notify => { manager.on('change', notify); return () => manager.off('change', notify); }
   * @example notify => effect(() => { items.value; notify(); })   // Preact signals: effect() returns its disposer
   */
  changes: ((notify: () => void) => ChangeTeardown) | Observable<unknown>;
  /** Optional fast lookup for `store(type)`. By default `store(type)` filters the latest {@link entities} snapshot. */
  getEntities?: StoreQuery;
}

/**
 * Creates an {@link EntityStore} from a source that signals changes with events, callbacks or signals instead of
 * Observables.
 *
 * @example
 * const store = createEntityStore({
 *   entities: () => cart.items.map((entity) => ({ entityType: 'CartItem', entity })),
 *   changes: (notify) => cart.subscribe(notify),   // returns an unsubscribe function
 * });
 * validationService.validateEntityStore(store).subscribe(...);
 */
export function createEntityStore(options: CreateEntityStoreOptions): NotifyingEntityStore {
  const { entities, changes, getEntities } = options;
  const changes$ = isObservable(changes)
    ? changes
    : new Observable<void>((subscriber) => {
        const teardown = changes(() => subscriber.next());
        return () => (typeof teardown === 'function' ? teardown() : teardown?.unsubscribe());
      });
  return { changes$, entities, ...(getEntities ? { getEntities } : {}) };
}
