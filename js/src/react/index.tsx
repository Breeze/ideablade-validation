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
import {
  type DependencyList,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { Observable } from 'rxjs';

import type { ErrorVisibility } from '../core/error-visibility.js';
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

const ErrorVisibilityContext = createContext<ErrorVisibility | null>(null);

/**
 * Makes an {@link ErrorVisibility} available to {@link useValidation}, {@link ValidationForm} and
 * {@link useFieldValidation} below it, usually for one screen. They then report validations and touches to it, and
 * offer the errors to show. Call `visibility.revealAll()` on a save attempt.
 *
 * @example
 * const [visibility] = useState(() => new ErrorVisibility({ isNew: breezeIsNew }));
 * return <ErrorVisibilityProvider visibility={visibility}>...</ErrorVisibilityProvider>;
 */
export function ErrorVisibilityProvider({ visibility, children }: { visibility: ErrorVisibility; children?: ReactNode }) {
  return <ErrorVisibilityContext.Provider value={visibility}>{children}</ErrorVisibilityContext.Provider>;
}

/** The {@link ErrorVisibility} of the nearest {@link ErrorVisibilityProvider}, or null. */
export function useErrorVisibility(): ErrorVisibility | null {
  return useContext(ErrorVisibilityContext);
}

const noSubscription = () => () => {};

/** Re-renders when the visibility changes, and returns its version. */
function useVisibilityVersion(visibility: ErrorVisibility | null): number {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!visibility) {
        return noSubscription();
      }
      const subscription = visibility.changes$.subscribe(notify);
      return () => subscription.unsubscribe();
    },
    [visibility],
  );
  return useSyncExternalStore(subscribe, () => visibility?.version ?? 0);
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
  /**
   * Decides which errors to show ({@link ErrorVisibility}). Default: the nearest {@link ErrorVisibilityProvider}'s.
   * Pass null for none.
   */
  visibility?: ErrorVisibility | null;
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
  /** {@link errorsFor}, without the errors an {@link ErrorVisibility} hides. Without one, the same as `errorsFor`. */
  shownErrorsFor(propertyName?: string): ValidationError[];
  /** Records that the user touched a property (edited it, or left its field), for the {@link ErrorVisibility}. */
  markTouched(propertyName: string): void;
  /** Forces re-validation (e.g. after mutating the model in place). */
  revalidate(): void;
}

const EMPTY: ValidationError[] = [];

/**
 * Validates a model with the metadata rules, the whole model at once, so a field's errors include model-level rules
 * that name it and update whenever any value changes. Sync errors are computed during render; async errors arrive later
 * (`pending` is true meanwhile). Re-validates when `model`, `modelType` or `options.deps` change, and when the
 * service's entity store changes (see {@link useValidationScope}).
 *
 * Without a `modelType`, the model type resolvers name it (such as `breezeModelType` for Breeze entities).
 *
 * With an {@link ErrorVisibility}, it reports each validation to it. A model replaced by a copy on every change, as
 * with `useState`, keeps what the visibility knows about it: what changes between renders is taken to be the same model.
 */
export function useValidation(model: unknown, modelType?: string, options: UseValidationOptions = {}): UseValidationResult {
  const service = useValidationService();
  const type = modelType ?? (model == null ? '' : service.resolveModelType(model));
  if (model != null && !type) {
    throw new Error('useValidation: pass a modelType, or register a model type resolver that recognizes the model.');
  }
  modelType = type ?? '';
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const contextVisibility = useErrorVisibility();
  const visibility = options.visibility !== undefined ? options.visibility : contextVisibility;
  const visibilityVersion = useVisibilityVersion(visibility);
  // A model replaced by a copy is the same model to the visibility. Before rendering, so the copy's errors show right.
  const previousModel = useRef(model);
  if (visibility && previousModel.current !== model) {
    visibility.transfer(previousModel.current, model);
    previousModel.current = model;
  }
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

  // Report each validation to the visibility (after rendering: it notifies its subscribers).
  useEffect(() => {
    if (visibility && model != null && !options.disabled) {
      visibility.observe(model, errors);
    }
  }, [visibility, model, errors, options.disabled]);

  return useMemo(() => {
    const errorsFor = (propertyName?: string) =>
      errors.filter((e) => (propertyName === undefined ? e.propertyNames.length === 0 : e.isFor(propertyName)));
    return {
      errors,
      isValid: errors.length === 0 && !pending,
      pending,
      errorsFor,
      messagesFor: (propertyName?: string) => errorsFor(propertyName).map((e) => e.errorMessage),
      shownErrorsFor: (propertyName?: string) => (visibility ? visibility.shown(model, errorsFor(propertyName)) : errorsFor(propertyName)),
      markTouched: (propertyName: string) => visibility?.markTouched(model, propertyName),
      revalidate,
    };
    // visibilityVersion: what the visibility shows changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errors, pending, revalidate, visibility, model, visibilityVersion]);
}

const ValidationFormContext = createContext<UseValidationResult | null>(null);

export interface ValidationFormProps extends UseValidationOptions {
  /** The model the form edits. */
  model: unknown;
  /** The model type; without it, the model type resolvers name it (such as `breezeModelType`). */
  modelType?: string;
  children?: ReactNode;
}

/**
 * Validates a model once for all the fields inside it - the counterpart of the Angular form directive. A field reads
 * the errors about its property with {@link useFieldValidation}: its rules, and model-level rules that name it, so a
 * rule spanning two fields shows on both, and a change in one re-checks the other. Errors about the model as a whole
 * are `useFieldValidation()` without a name.
 *
 * @example
 * <ValidationForm model={address}>
 *   <CityInput />   // useFieldValidation('city')
 * </ValidationForm>
 */
export function ValidationForm({ model, modelType, children, ...options }: ValidationFormProps) {
  const validation = useValidation(model, modelType, options);
  return <ValidationFormContext.Provider value={validation}>{children}</ValidationFormContext.Provider>;
}

export interface FieldValidation {
  /**
   * The errors about the property to show. With an {@link ErrorVisibility}, without those it hides; without one, all of
   * them, as {@link allErrors}.
   */
  errors: ValidationError[];
  /** Their messages. */
  messages: string[];
  /** The messages joined, or null when there are none: handy for an input's `error` or `title`. */
  message: string | null;
  /** Whether there are errors to show. */
  invalid: boolean;
  /** All the errors about the property, shown or not. */
  allErrors: ValidationError[];
  /** Records that the user touched the field (edited it, or left it), for the {@link ErrorVisibility}: `onBlur`. */
  markTouched(): void;
}

const NO_FORM: FieldValidation = { errors: EMPTY, messages: [], message: null, invalid: false, allErrors: EMPTY, markTouched: () => {} };

/**
 * The errors about `propertyName` in the nearest {@link ValidationForm}; without a name, the errors about the model as a
 * whole. Outside a `ValidationForm`, there are none.
 *
 * With an {@link ErrorVisibility}, `errors` (and `messages`, `message`, `invalid`) are those to show, and
 * `markTouched` reports a touch: call it when the field is left, as `onBlur={field.markTouched}`.
 */
export function useFieldValidation(propertyName?: string): FieldValidation {
  const form = useContext(ValidationFormContext);
  return useMemo(() => {
    if (!form) {
      return NO_FORM;
    }
    const allErrors = form.errorsFor(propertyName);
    const errors = form.shownErrorsFor(propertyName);
    const messages = errors.map((e) => e.errorMessage);
    return {
      errors,
      messages,
      message: messages.length ? messages.join(' ') : null,
      invalid: errors.length > 0,
      allErrors,
      markTouched: () => {
        if (propertyName !== undefined) {
          form.markTouched(propertyName);
        }
      },
    };
  }, [form, propertyName]);
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
 * Continuously validates an entity store, sync and async, and returns the latest result (`pending` while async
 * validators run). Without a store, it validates the entity store of the nearest provider's service - the scope's,
 * see {@link useValidationScope} - and follows it when the scope moves on to another store; every component of the
 * scope that calls it without options shares one validation. `null` validates nothing.
 *
 * Pass a stable `store` (memoize it): a new store restarts validation.
 */
export function useEntityStoreValidation(store?: EntityStore | null, options?: ValidationOptions): EntitiesValidationResult | undefined {
  const service = useValidationService();
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [result, setResult] = useState<EntitiesValidationResult | undefined>(undefined);
  useEffect(() => {
    if (store === null) {
      setResult(undefined);
      return;
    }
    const sub = service.validateEntityStore(store, optionsRef.current).subscribe(setResult);
    return () => sub.unsubscribe();
  }, [service, store]);
  return result;
}
