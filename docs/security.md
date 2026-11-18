# Security: why expressions don't use `eval`

Validation metadata contains expressions: validator `condition`s, model `condition`s and the `expression` validator. The obvious way to run a JavaScript expression stored as a string is to compile it with `eval` or the `Function` constructor, or on a server with an embedded JavaScript engine. This document explains why `@ideablade/validation` and `IdeaBlade.Validation` don't do that, and what they do instead.

## The problem with `eval`

```ts
// The tempting implementation
const fn = Function(`"use strict"; return (model, context) => ${condition}`)();
```

This is safe only while every expression is written by a developer and shipped with the code. Validation rules are metadata, and metadata tends to move into places where other people edit it: an admin screen, a form designer, a database table. Once that happens:

| Risk | Severity |
|---|---|
| **Expressions are authored data, not code.** Anyone who can edit a rule, or write to the table it's stored in, can run arbitrary JavaScript in every user's browser. That's equivalent to stored XSS, with access to the session, tokens and any cached data. | High |
| **String interpolation builds code.** Generated rules such as `` `e.key === '${key}'` `` put a configurable value straight into an expression. A value containing `'` breaks out of the string literal. That's classic code injection, even when the author only meant to type a label. | High |
| **`"use strict"` is not a sandbox.** Strict mode doesn't limit what code can reach: `globalThis`, `fetch`, `document.cookie`, `localStorage`, `constructor.constructor('…')()` and so on are all available. | — |
| **The CSP needs `'unsafe-eval'`.** `Function` is blocked by a strict Content-Security-Policy, so every app using it has to weaken its CSP for the whole page. | Medium |
| **An embedded server engine without limits.** A full JavaScript engine with no timeout, recursion, statement or memory limit lets one expression such as `while(true){}` hang a request thread, so any rule author can cause a DoS. | Medium |
| **Swallowed errors.** Treating a failing condition as `true` (or `false`) hides broken or malicious rules. | Low |

## What the framework does instead

Both libraries ship a **safe expression evaluator**:

1. A **parser** turns the expression into an AST. Parsing accepts only a side-effect-free JavaScript subset: literals, property access, `?.`, `??`, arithmetic, comparison, logical operators, ternaries, arrow functions as callbacks, array and object literals, regex literals, and `new Date(...)`. The parser rejects statements, assignment, `++`/`--`, `function`, `this`, `new` for anything but `Date`, template interpolation, spread, `delete`, `in` and `instanceof`.
2. An **interpreter** walks the AST. It never generates code, so it works under a strict CSP with no `'unsafe-eval'`.
3. **Allow-lists** control what can be called:
   - Only listed methods work on strings, arrays, numbers, booleans, dates and regexps. Mutating methods such as `push`, `sort`, `splice` and the Date setters are excluded.
   - Only listed members of `Math`, `Date`, `Number`, `String`, `Boolean`, `Array` and `Object` are exposed.
   - `globalThis`, `window`, `Function`, `Reflect`, `process` and `require` are simply not in scope.
   - Methods on application objects (for example a Breeze entity's `getProperty`) can't be called unless you list them in `allowedMethods`.
4. **Prototype escapes are blocked.** Reading `constructor`, `__proto__` or `prototype` fails, and so does any computed key that evaluates to one of them (for example `model['constr' + 'uctor']`).
5. **Resource limits** apply:
   - a parse depth limit (200);
   - a per-evaluation step budget (100,000 nodes by default);
   - a call-depth limit (64) for arrow functions, so self-applying functions fail cleanly instead of overflowing the stack;
   - a cap on string-allocating arguments (`padStart`/`padEnd`), with `repeat` excluded;
   - on .NET, regular expressions also get a match timeout.
6. **Application functions** reach expressions explicitly, through `expressionScope`. Examples are `store(entityType)`, `findEntity(id, type)` and your own helpers. Expressions can call only those functions.
7. **Errors are not swallowed.** A condition that fails to parse or evaluate throws a `ValidationConfigurationError`.
8. **The same grammar runs on client and server.** One conformance suite (`spec/expression-conformance.json`) is run by both the TypeScript and the .NET tests, so a rule behaves the same in the browser and on the server.

### What's still the application's responsibility

- **Regular expressions (ReDoS).** Patterns in metadata (`pattern` validator, regex literals) can still be slow on crafted input. Patterns are data and can't be fully sandboxed in the browser. On .NET they get a match timeout. Treat regexes from untrusted authors with care.
- **Who can author rules.** Expressions can't run arbitrary code, but they can still read anything in scope: the model, the context, `store(...)` results. Don't put secrets in the validation context.
- **Validate at save time.** Call `checkExpression(expr)` (TS) or `ExpressionParser.Parse(expr)` (.NET) in authoring tools, such as a rule or form designer. Then broken rules are rejected when they're saved, not discovered at runtime.
- **Don't build expressions by concatenation.** If generated rules must embed a value, pass it as data in the validator `context` and reference it: `e.key.toLowerCase() === context.customValueKey`. Don't splice it into the expression text.

## Alternatives that were considered

| Option | Verdict |
|---|---|
| `Function` with a `with`/Proxy "sandbox" | Rejected. These sandboxes are routinely escaped and still need `'unsafe-eval'`. |
| **JSONLogic** / **CEL** / **JSONata** | Safe and well specified, but less readable for developers used to JavaScript, and you depend on the fidelity of a .NET port. The `ExpressionEvaluator` / `IExpressionEvaluator` interfaces let you plug one in if you prefer. |
| `expr-eval`, `jsep` + custom interpreter, `filtrex` | Close to what we built, but none covers arrow-function callbacks or optional chaining with JS semantics, and none has a matching .NET implementation. |
| A JavaScript engine such as Jint on the server, with `TimeoutInterval`, `MaxStatements` and `LimitRecursion` | Viable for the server only, and it gives up client/server parity. If you need full JS on the server, implement `IExpressionEvaluator` with a constrained engine (see [dotnet.md](dotnet.md)). |
| Iframe / Web Worker sandbox | Asynchronous by nature, which validation can't be, and heavy. Rejected. |

## Expressions written for plain JavaScript

Most JavaScript boolean expressions run unchanged if they use the supported subset. Things to look for:

- `function` expressions or block-bodied arrows (`x => { return … }`). Rewrite them as expression arrows.
- Method calls on application objects (for example `model.getSomething()`). Either pass a function through `expressionScope`, or add the method name to `allowedMethods`.
- Use of browser globals (`window`, `moment`, `_`). Expose what's needed through `expressionScope`.
