/** Thrown when an expression cannot be parsed or uses unsupported syntax. */
export class ExpressionSyntaxError extends Error {
  override readonly name = 'ExpressionSyntaxError';

  constructor(
    readonly reason: string,
    readonly expression: string,
    readonly position: number,
  ) {
    super(`${reason} (at position ${position} in expression: ${expression})`);
  }
}

/** Thrown when evaluating a syntactically valid expression fails (unknown identifier, disallowed call, step budget exceeded...). */
export class ExpressionEvaluationError extends Error {
  override readonly name = 'ExpressionEvaluationError';

  constructor(
    readonly reason: string,
    readonly expression: string,
  ) {
    super(`${reason} (in expression: ${expression})`);
  }
}
