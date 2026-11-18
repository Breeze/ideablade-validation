/**
 * Allow-lists for the safe expression interpreter.
 *
 * Anything not listed here cannot be called from an expression. Only side-effect-free
 * methods are listed (no Array.prototype.push/sort/splice, no Date setters, ...).
 */

/** A host namespace exposed to expressions (e.g. `Math`, `Date`). Only listed members are reachable. */
export class SafeNamespace {
  constructor(
    readonly name: string,
    readonly members: Readonly<Record<string, unknown>>,
    readonly call?: (...args: unknown[]) => unknown,
  ) {}
}

const MAX_STRING_LENGTH = 100_000;

function capLength(n: unknown): unknown {
  if (typeof n === 'number' && n > MAX_STRING_LENGTH) {
    throw new RangeError(`Length ${n} exceeds maximum of ${MAX_STRING_LENGTH}`);
  }
  return n;
}

export const STRING_METHODS = new Set([
  'at', 'charAt', 'charCodeAt', 'codePointAt', 'concat', 'endsWith', 'includes', 'indexOf',
  'lastIndexOf', 'localeCompare', 'match', 'normalize', 'padEnd', 'padStart', 'replace', 'replaceAll',
  'search', 'slice', 'split', 'startsWith', 'substring', 'substr', 'toLocaleLowerCase',
  'toLocaleUpperCase', 'toLowerCase', 'toString', 'toUpperCase', 'trim', 'trimEnd', 'trimStart', 'valueOf',
]);

export const ARRAY_METHODS = new Set([
  'at', 'concat', 'every', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex', 'flat', 'flatMap',
  'includes', 'indexOf', 'join', 'lastIndexOf', 'map', 'reduce', 'reduceRight', 'slice', 'some',
  'toReversed', 'toSorted', 'toString',
]);

export const NUMBER_METHODS = new Set(['toFixed', 'toPrecision', 'toString', 'toLocaleString', 'valueOf']);

export const BOOLEAN_METHODS = new Set(['toString', 'valueOf']);

export const DATE_METHODS = new Set([
  'getDate', 'getDay', 'getFullYear', 'getHours', 'getMilliseconds', 'getMinutes', 'getMonth',
  'getSeconds', 'getTime', 'getTimezoneOffset', 'getUTCDate', 'getUTCDay', 'getUTCFullYear',
  'getUTCHours', 'getUTCMilliseconds', 'getUTCMinutes', 'getUTCMonth', 'getUTCSeconds', 'toDateString',
  'toISOString', 'toJSON', 'toLocaleDateString', 'toLocaleString', 'toLocaleTimeString', 'toString',
  'toTimeString', 'toUTCString', 'valueOf',
]);

export const REGEXP_METHODS = new Set(['test', 'toString']);

/** Property names that can never be read, on any object. Blocks prototype-chain escapes. */
export const FORBIDDEN_PROPERTIES = new Set([
  '__proto__', 'prototype', 'constructor', '__defineGetter__', '__defineSetter__',
  '__lookupGetter__', '__lookupSetter__', 'caller', 'callee', 'arguments',
]);

/** Guards for string methods whose arguments could allocate huge strings. */
export const STRING_ARG_GUARDS: Record<string, (args: unknown[]) => void> = {
  padStart: (args) => void capLength(args[0]),
  padEnd: (args) => void capLength(args[0]),
};

const mathMembers: Record<string, unknown> = {};
for (const name of [
  'abs', 'acos', 'asin', 'atan', 'atan2', 'cbrt', 'ceil', 'cos', 'exp', 'floor', 'hypot', 'log',
  'log10', 'log2', 'max', 'min', 'pow', 'round', 'sign', 'sin', 'sqrt', 'tan', 'trunc',
  'E', 'LN10', 'LN2', 'LOG10E', 'LOG2E', 'PI', 'SQRT1_2', 'SQRT2',
] as const) {
  mathMembers[name] = Math[name];
}

/** Global identifiers available to every expression, in addition to the caller-supplied scope. */
export const DEFAULT_GLOBALS: Readonly<Record<string, unknown>> = Object.freeze({
  Math: new SafeNamespace('Math', mathMembers),
  Date: new SafeNamespace('Date', { now: Date.now, parse: Date.parse, UTC: Date.UTC }),
  Number: new SafeNamespace(
    'Number',
    {
      isFinite: Number.isFinite,
      isInteger: Number.isInteger,
      isNaN: Number.isNaN,
      isSafeInteger: Number.isSafeInteger,
      parseFloat: Number.parseFloat,
      parseInt: Number.parseInt,
      MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
      MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
      EPSILON: Number.EPSILON,
    },
    (v) => Number(v),
  ),
  String: new SafeNamespace('String', {}, (v) => String(v)),
  Boolean: new SafeNamespace('Boolean', {}, (v) => Boolean(v)),
  Array: new SafeNamespace('Array', { isArray: Array.isArray }),
  Object: new SafeNamespace('Object', {
    keys: (o: object) => Object.keys(o ?? {}),
    values: (o: object) => Object.values(o ?? {}),
    entries: (o: object) => Object.entries(o ?? {}),
  }),
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  NaN,
  Infinity,
});
