import { type Observable, Subject, type Subscription } from 'rxjs';

import type { ValidationError } from './validation-error.js';
import type { EntitiesValidationResult } from './validation-service.js';

export interface ErrorVisibilityOptions {
  /**
   * Whether a model is new, so the errors it starts with are hidden until the user gets to them. Default: every model
   * is. Models that are not new show all their errors: if loaded data breaks a rule, the user should see it. For Breeze
   * entities, pass `breezeIsNew` from `@ideablade/validation/breeze`: only added entities are new.
   */
  isNew?: (model: object) => boolean;
}

/** What is known about one model. */
interface ModelState {
  /** Keys of the errors the model started with that are still hidden. Undefined until its first validation. */
  baseline?: Set<string>;
  /** The properties the user has touched: edited, or left. */
  touched: Set<string>;
  /** The {@link ErrorVisibility.revealAll} generation the state belongs to. */
  generation: number;
}

/**
 * Decides which validation errors to show, so a new model is not all red before the user has done anything.
 *
 * Validation itself does not change: every rule runs, forms are as valid or invalid as before, and saving still checks
 * everything. This only answers "show this error?" ({@link isShown}):
 *
 * - Models that are not new ({@link ErrorVisibilityOptions.isNew}) show all their errors.
 * - A new model's first validation sets its *baseline*: the errors it starts with, such as empty required fields. They
 *   are hidden.
 * - A baseline error shows once one of the properties it is about (`propertyNames`) has been touched.
 * - Any error that is not in the baseline shows at once, on every property it is about: something the user did caused
 *   it. That covers rules across properties, conditions, and rules about the model as a whole.
 * - A baseline error that goes away leaves the baseline, so it shows if it comes back.
 * - {@link revealAll}, on a save attempt, shows every error the models have then. Models first validated afterwards
 *   start with a baseline of their own.
 *
 * The form integrations feed it: they report each validation ({@link observe}) and each touch ({@link markTouched}), and
 * offer the errors to show next to all of them. Models are told apart by identity. A form that replaces its model with
 * a copy on every change (Signal Forms, immutable React state) carries the state over with {@link transfer}.
 */
export class ErrorVisibility {
  private models = new WeakMap<object, ModelState>();
  private generation = 0;
  private changeCount = 0;
  private readonly changes = new Subject<void>();
  private readonly isNew: (model: object) => boolean;

  /** Emits after every change that can change what {@link isShown} answers. */
  readonly changes$: Observable<void> = this.changes.asObservable();

  constructor(options: ErrorVisibilityOptions = {}) {
    this.isNew = options.isNew ?? (() => true);
  }

  /** A number that changes with every emission of {@link changes$}: for frameworks that compare snapshots. */
  get version(): number {
    return this.changeCount;
  }

  /**
   * Reports a validation of `model` with the errors about it. The first one sets the model's baseline; later ones drop
   * the baseline errors that went away. Report the errors of the model itself, not of a form's view of it: a form
   * that has just switched to another model may still show the old one's values.
   */
  observe(model: unknown, errors: readonly ValidationError[]): void {
    if (!isObject(model)) {
      return;
    }
    const state = this.stateOf(model);
    const keys = new Set(errors.map((e) => e.key));
    if (!state.baseline) {
      state.baseline = keys;
      this.changed();
      return;
    }
    let changed = false;
    for (const key of state.baseline) {
      if (!keys.has(key)) {
        state.baseline.delete(key);
        changed = true;
      }
    }
    if (changed) {
      this.changed();
    }
  }

  /**
   * Reports a result of entity store validation: each entity's errors, as {@link observe}. Results whose async rules
   * are still running are skipped; the complete one follows.
   */
  observeEntities(result: EntitiesValidationResult): void {
    if (result.pending) {
      return;
    }
    for (const { entity } of result.entities) {
      if (isObject(entity)) {
        this.observe(
          entity,
          result.validationErrors.filter((e) => e.model === entity),
        );
      }
    }
  }

  /** Reports every result of continuous entity store validation (`validateEntityStore()`). */
  watch(results: Observable<EntitiesValidationResult>): Subscription {
    return results.subscribe((result) => this.observeEntities(result));
  }

  /** Records that the user touched a property of a model: edited it, or left its field. */
  markTouched(model: unknown, propertyName: string): void {
    if (!isObject(model)) {
      return;
    }
    const state = this.stateOf(model);
    if (!state.touched.has(propertyName)) {
      state.touched.add(propertyName);
      this.changed();
    }
  }

  /** Whether the user has touched a property of a model. */
  isTouched(model: unknown, propertyName: string): boolean {
    return isObject(model) && !!this.models.get(model)?.touched.has(propertyName);
  }

  /**
   * Carries what is known about `from` over to `to`, for a form that replaced its model with a copy. Does nothing if
   * `to` has been validated or touched already.
   */
  transfer(from: unknown, to: unknown): void {
    if (!isObject(from) || !isObject(to) || from === to) {
      return;
    }
    // A state that only a lookup created (never validated, nothing touched) does not count.
    const existing = this.models.get(to);
    if (existing && (existing.baseline || existing.touched.size > 0)) {
      return;
    }
    const state = this.models.get(from);
    if (state) {
      this.models.set(to, state);
    }
  }

  /**
   * Shows every error the models have now, as after a save attempt: it empties their baselines. A model first validated
   * afterwards starts with a baseline of its own.
   */
  revealAll(): void {
    this.generation++;
    this.changed();
  }

  /** Forgets everything: baselines, touches and save attempts. */
  reset(): void {
    this.models = new WeakMap();
    this.changed();
  }

  /** Whether to show `error`, an error about `model`. */
  isShown(model: unknown, error: ValidationError): boolean {
    if (!isObject(model) || !isValidationError(error) || !this.isNew(model)) {
      return true;
    }
    const state = this.stateOf(model);
    if (error.propertyNames.some((name) => state.touched.has(name))) {
      return true;
    }
    // A new model that has not been validated yet: everything it has now is its baseline.
    return !!state.baseline && !state.baseline.has(error.key);
  }

  /** The errors of `errors`, about `model`, to show. */
  shown<T extends ValidationError>(model: unknown, errors: readonly T[]): T[] {
    return errors.filter((error) => this.isShown(model, error));
  }

  /** The model's state, created on first use, with its baseline emptied if {@link revealAll} has run since. */
  private stateOf(model: object): ModelState {
    let state = this.models.get(model);
    if (!state) {
      state = { touched: new Set(), generation: this.generation };
      this.models.set(model, state);
    } else if (state.generation !== this.generation) {
      state.generation = this.generation;
      state.baseline = new Set();
    }
    return state;
  }

  private changed(): void {
    this.changeCount++;
    this.changes.next();
  }
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/** Errors that are not the framework's, such as another validator's, carry no key or properties: always shown. */
function isValidationError(value: unknown): value is ValidationError {
  const error = value as ValidationError | null;
  return typeof error?.key === 'string' && Array.isArray(error.propertyNames);
}
