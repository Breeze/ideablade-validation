# Expression language

Validator `condition`s, model `condition`s and the `expression` validator use a small, **side-effect-free subset of JavaScript expressions**. A safe interpreter evaluates them; `eval`/`Function` are never used, so they work under a strict Content-Security-Policy. The TypeScript and .NET implementations share one grammar and one conformance suite ([`spec/expression-conformance.json`](../spec/expression-conformance.json)).

See [security.md](security.md) for the rationale.

## Variables

| Where | Variables |
|---|---|
| Validator `condition` | `model`, `value` (the property value, or the model for model-level validators), `context` (the validator's context), `isClient`, `isServer`, plus the expression scope |
| `expression` validator | same as above |
| Model `condition` (entity store validation) | `model`, `entityInfos`, `findEntity(id, type)`, `context`, `isClient`, `isServer`, plus the expression scope |

The expression scope is made up of:

- `store(entityType)`, which returns the entities of a type. It's available when validating an entity store, when `options.store` is passed, or with `installBreezeValidators`.
- Functions/values registered globally: `expressionScope` (TS options), `provideExpressionScope` (Angular), `ExpressionScope` (.NET).
- Per-call `options.expressionScope`.

> **In TempHire:** the rules in [`validation.metadata.json`](https://github.com/Breeze/temphire.server/blob/main/TempHire.Server/Validation/validation.metadata.json) use `store(type)` across entities, `store('Address').some(a => a.staffingResourceId === model.id)`, and `new Date(...)` with `getFullYear()` for an age check. The client gets `store` from its unit of work's entity store, and the server from the store it builds for each save ([Validating a save](dotnet.md#validating-a-save)).

## Supported syntax

| Feature | Examples |
|---|---|
| Literals | `1`, `1.5`, `1_000`, `0x1F`, `'text'`, `"text"`, `` `text` `` (no `${}`), `true`, `false`, `null`, `undefined` |
| Regex literals | `/^\d{5}$/.test(value)`, `value.replace(/,/g, '')` |
| Arrays / objects | `[1, 2, 3].includes(value)`, `{ a: 1 }.a` |
| Property access | `model.address.city`, `model['first name']`, `model.tags[0]`, `model.tags.length` |
| Optional chaining | `model.address?.city`, `items.find(i => i.id === 1)?.name`, `fn?.()` |
| Arithmetic | `+ - * / %`, unary `- + !` |
| Comparison | `=== !== == != < <= > >=` (JavaScript semantics, including `==` coercion) |
| Logical | `&& || ??` |
| Conditional | `a ? b : c` |
| `typeof` | `typeof model.x === 'string'` (`typeof undeclared` → `'undefined'`) |
| Arrow functions (as callbacks) | `model.items.some(i => i.qty > 0)`, `(a, b) => a + b`. Nesting of calls is limited to 64 levels. |
| `new Date(...)` | `new Date(model.year, model.month - 1, model.day) < Date.now()` |

### Rejected at parse time

Statements and `;`, assignment (`=`, `+=`, `++`), `function`, block-bodied arrows (`x => { … }`), `this`, `new` (except `Date`), `delete`, `void`, `in`, `instanceof`, spread (`...`), `eval`, `arguments`, template interpolation, and the `__proto__` object key.

### Globals

| Global | Members |
|---|---|
| `Math` | `abs acos asin atan atan2 cbrt ceil cos exp floor hypot log log10 log2 max min pow round sign sin sqrt tan trunc` and the constants. `Math.random` is not available, so evaluation stays deterministic. |
| `Date` | `Date.now()`, `Date.parse()`, `Date.UTC()`, `new Date(...)` |
| `Number` | `Number(x)`, `isFinite isInteger isNaN isSafeInteger parseFloat parseInt MAX_SAFE_INTEGER MIN_SAFE_INTEGER EPSILON` |
| `String`, `Boolean` | conversion calls `String(x)`, `Boolean(x)` |
| `Array` | `Array.isArray` |
| `Object` | `Object.keys`, `Object.values`, `Object.entries` |
| functions | `parseInt`, `parseFloat`, `isNaN`, `isFinite`; constants `NaN`, `Infinity` |

### Callable methods

| Receiver | Methods |
|---|---|
| string | `at charAt charCodeAt codePointAt concat endsWith includes indexOf lastIndexOf localeCompare match normalize padEnd padStart replace replaceAll search slice split startsWith substring substr toLocaleLowerCase toLocaleUpperCase toLowerCase toString toUpperCase trim trimEnd trimStart valueOf` |
| array | `at concat every filter find findIndex findLast findLastIndex flat flatMap includes indexOf join lastIndexOf map reduce reduceRight slice some toReversed toSorted toString` |
| number | `toFixed toPrecision toString toLocaleString valueOf` |
| boolean | `toString valueOf` |
| Date | the `get*` methods, `toISOString toJSON toDateString toTimeString toString toUTCString toLocale*String valueOf` |
| RegExp | `test toString` |
| other objects | only the names you pass in `allowedMethods` |

Functions in the expression scope can always be called by name: `store('Order')`, `isWeekend(model.date)`.

## Customizing

```ts
import { SafeExpressionEvaluator, createValidationService } from 'ideablade-validation';

const service = createValidationService({
  metadata,
  expressionScope: { today: () => new Date(), isWeekend: (d: Date) => [0, 6].includes(d.getDay()) },
  expressionEvaluator: new SafeExpressionEvaluator({
    allowedMethods: ['getProperty'], // e.g. allow entity.getProperty('x') on Breeze entities
    maxSteps: 50_000,
  }),
});
```

To use a different language entirely (JSONLogic, CEL, …), implement `ExpressionEvaluator` (TS) or `IExpressionEvaluator` (.NET):

```ts
const jsonLogicEvaluator: ExpressionEvaluator = {
  evaluate: (expression, scope) => jsonLogic.apply(JSON.parse(expression), scope),
};
```

## Authoring tools

Check expressions when they're saved, not when they run:

```ts
import { checkExpression } from 'ideablade-validation';

const result = checkExpression(rule.condition);
if (!result.valid) {
  showError(`${result.error.reason} at position ${result.error.position}`);
}
```

## Differences from full JavaScript

- **Unknown identifiers** throw (as in JS); unknown *properties* evaluate to `undefined` (as in JS).
- **Arrow functions** can only be called or passed as callbacks; they can't be assigned or read as properties.
- **Optional chaining short-circuits the whole chain** (`a?.b.c` is `undefined` when `a` is nullish), as in JS.
- **Dates:** two `Date` objects are never `===` (on both platforms, as in JS). Use `getTime()` to compare instants. Relational operators (`<`, `>`) compare by time.
- **.NET only:** CLR numbers become `double`, enums become their names, and Guids become strings. See [dotnet.md](dotnet.md#expressions-on-the-server).
