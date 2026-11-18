/**
 * AST for the validation expression language: a side-effect-free subset of JavaScript expressions.
 * See docs/expressions.md for the full grammar.
 */
export type ExpressionNode =
  | LiteralNode
  | RegexNode
  | IdentifierNode
  | ArrayNode
  | ObjectNode
  | MemberNode
  | CallNode
  | NewNode
  | UnaryNode
  | BinaryNode
  | LogicalNode
  | ConditionalNode
  | ArrowNode
  | ChainNode;

export interface LiteralNode {
  type: 'Literal';
  value: string | number | boolean | null | undefined;
}

export interface RegexNode {
  type: 'Regex';
  pattern: string;
  flags: string;
}

export interface IdentifierNode {
  type: 'Identifier';
  name: string;
}

export interface ArrayNode {
  type: 'Array';
  elements: ExpressionNode[];
}

export interface ObjectNode {
  type: 'Object';
  properties: { key: string; value: ExpressionNode }[];
}

export interface MemberNode {
  type: 'Member';
  object: ExpressionNode;
  property: ExpressionNode;
  computed: boolean;
  optional: boolean;
}

export interface CallNode {
  type: 'Call';
  callee: ExpressionNode;
  args: ExpressionNode[];
  optional: boolean;
}

export interface NewNode {
  type: 'New';
  callee: string;
  args: ExpressionNode[];
}

export type UnaryOperator = '!' | '-' | '+' | 'typeof';

export interface UnaryNode {
  type: 'Unary';
  operator: UnaryOperator;
  argument: ExpressionNode;
}

export type BinaryOperator =
  | '+' | '-' | '*' | '/' | '%'
  | '<' | '<=' | '>' | '>='
  | '==' | '!=' | '===' | '!==';

export interface BinaryNode {
  type: 'Binary';
  operator: BinaryOperator;
  left: ExpressionNode;
  right: ExpressionNode;
}

export type LogicalOperator = '&&' | '||' | '??';

export interface LogicalNode {
  type: 'Logical';
  operator: LogicalOperator;
  left: ExpressionNode;
  right: ExpressionNode;
}

export interface ConditionalNode {
  type: 'Conditional';
  test: ExpressionNode;
  consequent: ExpressionNode;
  alternate: ExpressionNode;
}

export interface ArrowNode {
  type: 'Arrow';
  params: string[];
  body: ExpressionNode;
}

/** Wraps an optional chain (`a?.b.c`) so that a nullish short-circuit yields `undefined` for the whole chain. */
export interface ChainNode {
  type: 'Chain';
  expression: ExpressionNode;
}
