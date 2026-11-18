import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import {
  ExpressionEvaluationError,
  ExpressionSyntaxError,
  SafeExpressionEvaluator,
  checkExpression,
} from '../src/expressions/index.js';

interface ConformanceCase {
  expr: string;
  expected?: unknown;
  error?: 'syntax' | 'evaluation';
}

const spec = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../spec/expression-conformance.json', import.meta.url)), 'utf8'),
) as { scope: Record<string, unknown>; cases: ConformanceCase[] };

describe('expression conformance (shared with .NET)', () => {
  const evaluator = new SafeExpressionEvaluator();

  for (const c of spec.cases) {
    it(`${c.error ? `rejects (${c.error})` : 'evaluates'}: ${c.expr || '<empty>'}`, () => {
      const scope = structuredClone(spec.scope);
      if (c.error === 'syntax') {
        expect(() => evaluator.evaluate(c.expr, scope)).toThrow(ExpressionSyntaxError);
        expect(checkExpression(c.expr).valid).toBe(false);
      } else if (c.error === 'evaluation') {
        expect(checkExpression(c.expr).valid).toBe(true);
        expect(() => evaluator.evaluate(c.expr, scope)).toThrow(ExpressionEvaluationError);
      } else {
        const result = evaluator.evaluate(c.expr, scope);
        expect(result ?? null).toEqual(c.expected);
      }
    });
  }

  it('does not mutate the scope for rejected mutating calls', () => {
    const scope = structuredClone(spec.scope) as { model: { tags: string[] } };
    expect(() => evaluator.evaluate("model.tags.push('x')", scope)).toThrow();
    expect(scope.model.tags).toEqual(['red', 'blue']);
  });
});

describe('SafeExpressionEvaluator', () => {
  it('calls trusted functions supplied in the scope', () => {
    const store = vi.fn((type: string) => (type === 'CustomValue' ? [{ relatedEntityId: 1, key: 'Color' }] : []));
    const evaluator = new SafeExpressionEvaluator();
    const result = evaluator.evaluate(
      "store('CustomValue').find(e => e.relatedEntityId === model.id && e.key.toLowerCase() === 'color')",
      { store, model: { id: 1 } },
    );
    expect(result).toEqual({ relatedEntityId: 1, key: 'Color' });
    expect(store).toHaveBeenCalledWith('CustomValue');
  });

  it('supports globals registered through options', () => {
    const evaluator = new SafeExpressionEvaluator({ globals: { isWeekend: (d: Date) => [0, 6].includes(d.getDay()) } });
    expect(evaluator.evaluate('isWeekend(new Date(2024, 0, 6))', {})).toBe(true);
  });

  it('blocks methods on arbitrary objects unless allow-listed', () => {
    const entity = { getProperty: (name: string) => (name === 'x' ? 42 : undefined), setDeleted: vi.fn() };
    expect(() => new SafeExpressionEvaluator().evaluate("model.getProperty('x')", { model: entity })).toThrow(
      ExpressionEvaluationError,
    );
    const allowed = new SafeExpressionEvaluator({ allowedMethods: ['getProperty'] });
    expect(allowed.evaluate("model.getProperty('x')", { model: entity })).toBe(42);
    expect(() => allowed.evaluate('model.setDeleted()', { model: entity })).toThrow(ExpressionEvaluationError);
    expect(entity.setDeleted).not.toHaveBeenCalled();
  });

  it('refuses to allow-list forbidden property names', () => {
    expect(() => new SafeExpressionEvaluator({ allowedMethods: ['constructor'] })).toThrow();
  });

  it('enforces a step budget', () => {
    const evaluator = new SafeExpressionEvaluator({ maxSteps: 1_000 });
    const items = Array.from({ length: 10_000 }, (_, i) => i);
    expect(() => evaluator.evaluate('items.map(i => i * 2).length', { items })).toThrow(/maximum of 1000/);
  });

  it('rejects deeply nested expressions at parse time', () => {
    const deep = '('.repeat(500) + '1' + ')'.repeat(500);
    expect(() => new SafeExpressionEvaluator().evaluate(deep, {})).toThrow(ExpressionSyntaxError);
  });

  it('returns arrow functions as callable native functions', () => {
    const fn = new SafeExpressionEvaluator().evaluate('x => x + 1', {}) as (x: number) => number;
    expect(fn(1)).toBe(2);
  });

  it('caches parsed expressions', () => {
    const evaluator = new SafeExpressionEvaluator();
    const a = evaluator.compile('model.a > 1');
    const b = evaluator.compile('model.a > 1');
    expect(a.ast).toBe(b.ast);
    expect(a.evaluate({ model: { a: 2 } })).toBe(true);
    expect(b.evaluate({ model: { a: 0 } })).toBe(false);
  });

  it('reports the position of syntax errors', () => {
    const result = checkExpression('model.a === ');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.position).toBe(12);
    }
  });

  it('distinguishes division from regex literals', () => {
    const evaluator = new SafeExpressionEvaluator();
    expect(evaluator.evaluate('a / 2 / 2', { a: 8 })).toBe(2);
    expect(evaluator.evaluate('(a) / 2', { a: 8 })).toBe(4);
    expect(evaluator.evaluate('/a\\/b/.test(s)', { s: 'a/b' })).toBe(true);
  });

  it('never exposes the global object', () => {
    const evaluator = new SafeExpressionEvaluator();
    for (const expr of ['globalThis', 'window', 'process', 'require', 'Function', 'Reflect', 'Proxy']) {
      expect(() => evaluator.evaluate(expr, {})).toThrow(ExpressionEvaluationError);
    }
  });
});
