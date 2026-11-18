/**
 * React integration: a provider and hooks.
 *
 * @example
 * const service = createValidationService({ metadata, validators: [breezeValidator] });
 * root.render(<ValidationProvider service={service}><App /></ValidationProvider>);
 *
 * function CustomerForm({ customer }) {
 *   const { errorsFor, isValid, pending } = useValidation(customer, 'Customer');
 *   ...
 * }
 */
import { type DependencyList, type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Observable } from 'rxjs';

import type { ValidationError } from '../core/validation-error.js';
import type { EntitiesValidationResult, EntityStore, ValidationOptions, ValidationService } from '../core/validation-service.js';
import { type CreateValidationServiceOptions, createValidationService } from '../index.js';

const ValidationServiceContext = createContext<ValidationService | null>(null);

export type ValidationProviderProps =
  | { service: ValidationService; children?: ReactNode }
  | ({ service?: undefined; children?: ReactNode } & CreateValidationServiceOptions);

/**
 * Makes a {@link ValidationService} available to the hooks. Pass an existing `service`, or the options for
 * {@link createValidationService} (the service is then created once, on first render).
 */
export function ValidationProvider(props: ValidationProviderProps) {
  const { children, service: given, ...options } = props as { service?: ValidationService; children?: ReactNode } & CreateValidationServiceOptions;
  const [created] = useState(() => given ?? createValidationService(options));
  return <ValidationServiceContext.Provider value={given ?? created}>{children}</ValidationServiceContext.Provider>;
}

/**
 * A {@link ValidationService} for the scope of a unit of work: the nearest provider's metadata and options, and its own
 * entity store. Provide it to the components of that scope:
 *
 * @example
 * const scoped = useValidationScope(store);
 * return <ValidationProvider service={scoped}>...</ValidationProvider>;
 */
export function useValidationScope(entityStore: EntityStore | undefined): ValidationService {
  const parent = useValidationService();
  return useMemo(() => parent.createScope(entityStore), [parent, entityStore]);
}

/** Returns the {@link ValidationService} from the nearest {@link ValidationProvider}. */
export function useValidationService(): ValidationService {
  const service = useContext(ValidationServiceContext);
  if (!service) {
    throw new Error('useValidationService must be used inside a <ValidationProvider>.');
  }
  return service;
}

export interface UseValidationOptions extends ValidationOptions {
  /** Run asynchronous validators. Default true. */
  async?: boolean;
  /**
   * Extra dependencies that trigger re-validation. Needed when the model is mutated in place
   * (e.g. Breeze entities): pass a change counter or the relevant property values.
   */
  deps?: DependencyList;
  /** Skip validation entirely (e.g. while the model is loading). */
  disabled?: boolean;
}

export interface UseValidationResult {
  /** All current errors (sync, plus async once they arrive). */
  errors: ValidationError[];
  isValid: boolean;
  /** True while async validators are running. */
  pending: boolean;
  /**
   * Errors about one property: its rules, and model-level rules that name it (`propertyNames`). Without a name, the
   * errors about the model as a whole (model-level rules that name no properties).
   */
  errorsFor(propertyName?: string): ValidationError[];
  /** Messages for one property, convenient for rendering. */
  messagesFor(propertyName?: string): string[];
  /** Forces re-validation (e.g. after mutating the model in place). */
  revalidate(): void;
}

const EMPTY: ValidationError[] = [];

/**
 * Validates a model with the metadata rules, the whole model at once, so a field's errors include model-level rules
 * that name it and update whenever any value changes. Sync errors are computed during render; async errors arrive later
 * (`pending` is true meanwhile). Re-validates when `model`, `modelType` or `options.deps` change, and when the
 * service's entity store changes (`ValidationProvider`'s `entityStore`).
 */
export function useValidation(model: unknown, modelType: string, options: UseValidationOptions = {}): UseValidationResult {
  const service = useValidationService();
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [version, setVersion] = useState(0);
  const revalidate = useCallback(() => setVersion((v) => v + 1), []);
  const deps = [service, model, modelType, version, options.disabled, ...(options.deps ?? [])];

  // Changes made outside the component, such as an entity changed in place: the service's entity store reports them.
  useEffect(() => {
    const subscription = service.entityStoreChanged$.subscribe(revalidate);
    return () => subscription.unsubscribe();
  }, [service, revalidate]);

  const syncErrors = useMemo(
    () => (options.disabled || model == null ? EMPTY : service.validateModelSync(model, modelType, optionsRef.current)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    deps,
  );

  const runAsync = !options.disabled && model != null && (options.async ?? true) && service.hasAsyncValidators(modelType, options.predicate);
  const [asyncState, setAsyncState] = useState<{ errors: ValidationError[]; pending: boolean; token: unknown }>({ errors: EMPTY, pending: false, token: null });
  const token = useMemo(() => ({}), deps); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!runAsync) {
      return;
    }
    setAsyncState({ errors: EMPTY, pending: true, token });
    const sub = service.validateModelAsync(model, modelType, optionsRef.current).subscribe((errors) => setAsyncState({ errors, pending: false, token }));
    return () => sub.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, runAsync]);

  // Ignore async results that belong to a previous model/version.
  const current = runAsync && asyncState.token === token;
  const pending = runAsync && (!current || asyncState.pending);
  // validateModelAsync returns all errors (sync and async); until it completes, show the sync ones.
  const errors = runAsync && !pending ? asyncState.errors : syncErrors;

  return useMemo(() => {
    const errorsFor = (propertyName?: string) =>
      errors.filter((e) => (propertyName === undefined ? e.propertyNames.length === 0 : e.isFor(propertyName)));
    return {
      errors,
      isValid: errors.length === 0 && !pending,
      pending,
      errorsFor,
      messagesFor: (propertyName?: string) => errorsFor(propertyName).map((e) => e.errorMessage),
      revalidate,
    };
  }, [errors, pending, revalidate]);
}

/**
 * Subscribes to an observable and returns its latest value. The observable is re-subscribed when
 * `deps` change (memoize it yourself or pass deps).
 */
export function useObservable<T>(factory: () => Observable<T>, initialValue: T, deps: DependencyList): T {
  const [value, setValue] = useState<T>(initialValue);
  useEffect(() => {
    const sub = factory().subscribe(setValue);
    return () => sub.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}

/**
 * Continuously validates an entity store (e.g. `breezeEntityStore(manager)`); returns the latest result.
 * Pass a stable `store` (memoize it) — a new store restarts validation.
 */
export function useEntityStoreValidation(store: EntityStore | null | undefined, options?: ValidationOptions): EntitiesValidationResult | undefined {
  const service = useValidationService();
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [result, setResult] = useState<EntitiesValidationResult | undefined>(undefined);
  useEffect(() => {
    if (!store) {
      setResult(undefined);
      return;
    }
    const sub = service.validateEntityStore(store, optionsRef.current).subscribe(setResult);
    return () => sub.unsubscribe();
  }, [service, store]);
  return result;
}
