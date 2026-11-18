import type { ExpressionNode, ArrowNode, BinaryNode, CallNode, MemberNode } from './ast.js';
import {
  ARRAY_METHODS,
  BOOLEAN_METHODS,
  DATE_METHODS,
  DEFAULT_GLOBALS,
  FORBIDDEN_PROPERTIES,
  NUMBER_METHODS,
  REGEXP_METHODS,
  STRING_ARG_GUARDS,
  STRING_METHODS,
  SafeNamespace,
} from './builtins.js';
import { ExpressionEvaluationError, ExpressionSyntaxError } from './errors.js';
import { parseExpression } from './parser.js';

/** Variables visible to an expression, e.g. `{ model, context, isClient, isServer }`. */
export type ExpressionScope = Readonly<Record<string, unknown>>;

/**
 * Pluggable expression evaluator used for validator `condition`s, model `condition`s and the `expression` validator.
 * The default is {@link SafeExpressionEvaluator}. Provide your own implementation to change the language
 * (e.g. a JSONLogic or CEL evaluator).
 */
export interface ExpressionEvaluator {
  evaluate(expression: string, scope: ExpressionScope): unknown;
}

export interface SafeExpressionEvaluatorOptions {
  /**
   * Additional trusted functions/values available to every expression as global identifiers.
   * Values supplied here are trusted application code and may be called from expressions.
   */
  globals?: Record<string, unknown>;
  /**
   * Method names that may be called on arbitrary (non-built-in) objects, e.g. `['getProperty']` for Breeze entities.
   * Default: none. Methods on strings, numbers, arrays, dates and regexps are governed by the built-in allow-lists.
   */
  allowedMethods?: string[];
  /** Maximum number of AST node evaluations per `evaluate` call. Protects against runaway expressions. Default 100,000. */
  maxSteps?: number;
  /** Maximum nesting of arrow-function calls (guards against self-applying functions). Default 64. */
  maxCallDepth?: number;
  /** Maximum number of parsed expressions kept in the cache. Default 1,000. */
  cacheSize?: number;
}

/** A parsed expression that can be evaluated repeatedly against different scopes. */
export interface CompiledExpression {
  readonly source: string;
  readonly ast: ExpressionNode;
  evaluate(scope: ExpressionScope): unknown;
}

const SHORT_CIRCUIT = Symbol('short-circuit');

class Closure {
  constructor(
    readonly node: ArrowNode,
    readonly env: Environment,
  ) {}
}

class Environment {
  constructor(
    private readonly vars: Readonly<Record<string, unknown>>,
    private readonly parent?: Environment,
  ) {}

  has(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.vars, name) || (!!this.parent && this.parent.has(name));
  }

  get(name: string): unknown {
    if (Object.prototype.hasOwnProperty.call(this.vars, name)) {
      return this.vars[name];
    }
    return this.parent?.get(name);
  }
}

class Interpreter {
  private steps = 0;
  private callDepth = 0;

  constructor(
    private readonly source: string,
    private readonly allowedMethods: ReadonlySet<string>,
    private readonly maxSteps: number,
    private readonly maxCallDepth: number,
  ) {}

  fail(message: string): never {
    throw new ExpressionEvaluationError(message, this.source);
  }

  run(node: ExpressionNode, env: Environment): unknown {
    const result = this.eval(node, env);
    return this.export(result);
  }

  /** Converts interpreter-internal values to plain JS values. */
  private export(value: unknown): unknown {
    if (value instanceof Closure) {
      return this.toNativeFunction(value);
    }
    return value === SHORT_CIRCUIT ? undefined : value;
  }

  private tick(): void {
    if (++this.steps > this.maxSteps) {
      this.fail(`Expression exceeded the maximum of ${this.maxSteps} evaluation steps`);
    }
  }

  private eval(node: ExpressionNode, env: Environment): unknown {
    this.tick();
    switch (node.type) {
      case 'Literal':
        return node.value;
      case 'Regex':
        return new RegExp(node.pattern, node.flags);
      case 'Identifier':
        if (!env.has(node.name)) {
          this.fail(`Unknown identifier '${node.name}'`);
        }
        return env.get(node.name);
      case 'Array':
        return node.elements.map((e) => this.export(this.eval(e, env)));
      case 'Object': {
        const obj: Record<string, unknown> = {};
        for (const p of node.properties) {
          obj[p.key] = this.export(this.eval(p.value, env));
        }
        return obj;
      }
      case 'Chain': {
        const value = this.eval(node.expression, env);
        return value === SHORT_CIRCUIT ? undefined : value;
      }
      case 'Member':
        return this.evalMember(node, env);
      case 'Call':
        return this.evalCall(node, env);
      case 'New': {
        const args = node.args.map((a) => this.export(this.eval(a, env)));
        if (node.callee === 'Date') {
          return new (Date as unknown as new (...a: unknown[]) => Date)(...args);
        }
        return this.fail(`'new ${node.callee}' is not allowed`);
      }
      case 'Unary': {
        if (node.operator === 'typeof' && node.argument.type === 'Identifier' && !env.has(node.argument.name)) {
          return 'undefined'; // like JS, typeof on an undeclared identifier does not throw
        }
        const v = this.export(this.eval(node.argument, env));
        switch (node.operator) {
          case '!':
            return !v;
          case '-':
            return -(v as number);
          case '+':
            return +(v as number);
          case 'typeof':
            return v instanceof SafeNamespace ? (v.call ? 'function' : 'object') : typeof v;
        }
        break;
      }
      case 'Binary':
        return this.evalBinary(node, env);
      case 'Logical': {
        const left = this.export(this.eval(node.left, env));
        switch (node.operator) {
          case '&&':
            return left ? this.export(this.eval(node.right, env)) : left;
          case '||':
            return left ? left : this.export(this.eval(node.right, env));
          case '??':
            return left ?? this.export(this.eval(node.right, env));
        }
        break;
      }
      case 'Conditional':
        return this.export(this.eval(node.test, env)) ? this.eval(node.consequent, env) : this.eval(node.alternate, env);
      case 'Arrow':
        return new Closure(node, env);
    }
    return this.fail(`Unsupported node type '${(node as ExpressionNode).type}'`);
  }

  private evalBinary(node: BinaryNode, env: Environment): unknown {
    const l = this.export(this.eval(node.left, env)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = this.export(this.eval(node.right, env)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    switch (node.operator) {
      case '+': return l + r;
      case '-': return l - r;
      case '*': return l * r;
      case '/': return l / r;
      case '%': return l % r;
      case '<': return l < r;
      case '<=': return l <= r;
      case '>': return l > r;
      case '>=': return l >= r;
      case '==': return l == r; // eslint-disable-line eqeqeq
      case '!=': return l != r; // eslint-disable-line eqeqeq
      case '===': return l === r;
      case '!==': return l !== r;
    }
  }

  private propertyKey(node: MemberNode, env: Environment): string {
    const raw = node.computed ? this.export(this.eval(node.property, env)) : (node.property as { value: string }).value;
    const key = typeof raw === 'symbol' ? this.fail('Symbol property keys are not allowed') : String(raw);
    if (FORBIDDEN_PROPERTIES.has(key)) {
      this.fail(`Access to property '${key}' is not allowed`);
    }
    return key;
  }

  private evalMember(node: MemberNode, env: Environment): unknown {
    const object = this.eval(node.object, env);
    if (object === SHORT_CIRCUIT) {
      return SHORT_CIRCUIT;
    }
    if (node.optional && object == null) {
      return SHORT_CIRCUIT;
    }
    const key = this.propertyKey(node, env);
    return this.readProperty(object, key);
  }

  private readProperty(object: unknown, key: string): unknown {
    if (object == null) {
      this.fail(`Cannot read property '${key}' of ${object === null ? 'null' : 'undefined'}`);
    }
    if (object instanceof SafeNamespace) {
      if (!Object.prototype.hasOwnProperty.call(object.members, key)) {
        this.fail(`'${object.name}.${key}' is not available in expressions`);
      }
      return object.members[key];
    }
    if (object instanceof Closure) {
      this.fail('Cannot read properties of an arrow function');
    }
    return (object as Record<string, unknown>)[key];
  }

  private evalCall(node: CallNode, env: Environment): unknown {
    let fn: unknown;
    let receiver: unknown;
    let methodName: string | undefined;

    if (node.callee.type === 'Member') {
      const member = node.callee;
      receiver = this.eval(member.object, env);
      if (receiver === SHORT_CIRCUIT) {
        return SHORT_CIRCUIT;
      }
      if (member.optional && receiver == null) {
        return SHORT_CIRCUIT;
      }
      methodName = this.propertyKey(member, env);
      fn = this.readProperty(receiver, methodName);
    } else {
      fn = this.eval(node.callee, env);
      if (fn === SHORT_CIRCUIT) {
        return SHORT_CIRCUIT;
      }
    }

    if (node.optional && fn == null) {
      return SHORT_CIRCUIT;
    }

    const args = node.args.map((a) => this.export(this.eval(a, env)));

    if (fn instanceof Closure) {
      return this.invokeClosure(fn, args);
    }
    if (fn instanceof SafeNamespace) {
      if (!fn.call) {
        this.fail(`'${fn.name}' is not callable`);
      }
      return fn.call(...args);
    }
    if (typeof fn !== 'function') {
      this.fail(`'${methodName ?? describeCallee(node.callee)}' is not a function`);
    }

    if (methodName === undefined) {
      // Plain identifier call: function came from the trusted scope or globals.
      return (fn as (...a: unknown[]) => unknown)(...args);
    }

    if (receiver instanceof SafeNamespace) {
      return (fn as (...a: unknown[]) => unknown).apply(undefined, args);
    }

    if (!this.isMethodAllowed(receiver, methodName)) {
      this.fail(`Calling method '${methodName}' on ${describeType(receiver)} is not allowed`);
    }
    if (typeof receiver === 'string' && STRING_ARG_GUARDS[methodName]) {
      try {
        STRING_ARG_GUARDS[methodName](args);
      } catch (e) {
        this.fail((e as Error).message);
      }
    }
    return (fn as (...a: unknown[]) => unknown).apply(receiver, args);
  }

  private isMethodAllowed(receiver: unknown, name: string): boolean {
    if (typeof receiver === 'string') {
      return STRING_METHODS.has(name);
    }
    if (typeof receiver === 'number') {
      return NUMBER_METHODS.has(name);
    }
    if (typeof receiver === 'boolean') {
      return BOOLEAN_METHODS.has(name);
    }
    if (Array.isArray(receiver)) {
      return ARRAY_METHODS.has(name);
    }
    if (receiver instanceof Date) {
      return DATE_METHODS.has(name);
    }
    if (receiver instanceof RegExp) {
      return REGEXP_METHODS.has(name);
    }
    return this.allowedMethods.has(name);
  }

  private invokeClosure(closure: Closure, args: unknown[]): unknown {
    if (this.callDepth >= this.maxCallDepth) {
      this.fail(`Expression exceeded the maximum call depth of ${this.maxCallDepth}`);
    }
    this.callDepth++;
    try {
      return this.invokeClosureCore(closure, args);
    } finally {
      this.callDepth--;
    }
  }

  private invokeClosureCore(closure: Closure, args: unknown[]): unknown {
    const vars: Record<string, unknown> = {};
    closure.node.params.forEach((p, i) => {
      vars[p] = args[i];
    });
    return this.export(this.eval(closure.node.body, new Environment(vars, closure.env)));
  }

  private toNativeFunction(closure: Closure): (...args: unknown[]) => unknown {
    return (...args: unknown[]) => this.invokeClosure(closure, args);
  }
}

function describeCallee(node: ExpressionNode): string {
  return node.type === 'Identifier' ? node.name : 'expression';
}

function describeType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value !== 'object') {
    return typeof value;
  }
  const ctor = Object.getPrototypeOf(value)?.constructor?.name;
  return ctor && ctor !== 'Object' ? `an object of type ${ctor}` : 'an object';
}

/**
 * Evaluates validation expressions without `eval`/`new Function`.
 *
 * Expressions are parsed into an AST once (cached) and interpreted. Only a side-effect-free subset
 * of JavaScript is supported: literals, property access, optional chaining, arithmetic, comparison,
 * logical operators, ternaries, arrow functions as callbacks, `new Date(...)`, and calls to
 * allow-listed functions/methods. Works under a strict Content-Security-Policy (no `unsafe-eval`).
 */
export class SafeExpressionEvaluator implements ExpressionEvaluator {
  private readonly cache = new Map<string, ExpressionNode>();
  private readonly globals: Environment;
  private readonly allowedMethods: ReadonlySet<string>;
  private readonly maxSteps: number;
  private readonly maxCallDepth: number;
  private readonly cacheSize: number;

  constructor(options: SafeExpressionEvaluatorOptions = {}) {
    this.globals = new Environment({ ...DEFAULT_GLOBALS, ...(options.globals ?? {}) });
    this.allowedMethods = new Set(options.allowedMethods ?? []);
    for (const name of this.allowedMethods) {
      if (FORBIDDEN_PROPERTIES.has(name)) {
        throw new Error(`SafeExpressionEvaluator: '${name}' cannot be an allowed method`);
      }
    }
    this.maxSteps = options.maxSteps ?? 100_000;
    this.maxCallDepth = options.maxCallDepth ?? 64;
    this.cacheSize = options.cacheSize ?? 1_000;
  }

  /** Parses (with caching) an expression. Throws {@link ExpressionSyntaxError} for invalid expressions. */
  compile(expression: string): CompiledExpression {
    let ast = this.cache.get(expression);
    if (!ast) {
      ast = parseExpression(expression);
      if (this.cache.size >= this.cacheSize) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) {
          this.cache.delete(oldest);
        }
      }
      this.cache.set(expression, ast);
    }
    const node = ast;
    return {
      source: expression,
      ast: node,
      evaluate: (scope: ExpressionScope) =>
        new Interpreter(expression, this.allowedMethods, this.maxSteps, this.maxCallDepth).run(node, new Environment(scope ?? {}, this.globals)),
    };
  }

  evaluate(expression: string, scope: ExpressionScope): unknown {
    return this.compile(expression).evaluate(scope);
  }
}

/** Result of {@link checkExpression}. */
export type ExpressionCheckResult = { valid: true } | { valid: false; error: ExpressionSyntaxError };

/**
 * Checks whether an expression is syntactically valid for the safe evaluator, without evaluating it.
 * Use this in authoring tools to reject bad rules at save time.
 */
export function checkExpression(expression: string): ExpressionCheckResult {
  try {
    parseExpression(expression);
    return { valid: true };
  } catch (e) {
    if (e instanceof ExpressionSyntaxError) {
      return { valid: false, error: e };
    }
    throw e;
  }
}
