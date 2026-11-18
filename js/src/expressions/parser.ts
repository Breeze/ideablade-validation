import type {
  ArrowNode,
  BinaryOperator,
  ExpressionNode,
  MemberNode,
  CallNode,
  UnaryOperator,
} from './ast.js';
import { ExpressionSyntaxError } from './errors.js';

type TokenType = 'num' | 'str' | 'ident' | 'punct' | 'regex' | 'eof';

interface Token {
  type: TokenType;
  value: string;
  /** Parsed literal value for num/str tokens */
  literal?: string | number;
  flags?: string;
  pos: number;
}

const PUNCTUATORS = [
  '===', '!==', '...',
  '=>', '?.', '??', '==', '!=', '<=', '>=', '&&', '||',
  '(', ')', '[', ']', '{', '}', ',', '.', '?', ':', '!', '+', '-', '*', '/', '%', '<', '>', '=',
];

const KEYWORDS_AS_LITERALS: Record<string, string | number | boolean | null | undefined> = {
  true: true,
  false: false,
  null: null,
  undefined: undefined,
};

/** Reserved words that are rejected to make it obvious that statements/side effects are not supported. */
const FORBIDDEN_WORDS = new Set([
  'function', 'class', 'var', 'let', 'const', 'return', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'break', 'continue', 'throw', 'try', 'catch', 'finally', 'delete', 'void',
  'this', 'super', 'import', 'export', 'yield', 'await', 'async', 'with', 'debugger', 'in',
  'instanceof', 'eval', 'arguments',
]);

/** Constructors allowed with `new`. */
export const NEW_ALLOWED = new Set(['Date']);

const MAX_DEPTH = 200;

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch);
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

class Lexer {
  private pos = 0;
  private lastSignificant: Token | undefined;

  constructor(private readonly src: string) {}

  tokenize(): Token[] {
    const tokens: Token[] = [];
    for (;;) {
      const token = this.next();
      tokens.push(token);
      this.lastSignificant = token;
      if (token.type === 'eof') {
        return tokens;
      }
    }
  }

  private error(message: string, pos = this.pos): never {
    throw new ExpressionSyntaxError(message, this.src, pos);
  }

  /** A `/` starts a regex literal unless the previous token ends an operand. */
  private regexAllowed(): boolean {
    const t = this.lastSignificant;
    if (!t) {
      return true;
    }
    if (t.type === 'num' || t.type === 'str' || t.type === 'regex') {
      return false;
    }
    if (t.type === 'ident') {
      return t.value === 'typeof';
    }
    return !(t.value === ')' || t.value === ']' || t.value === '}');
  }

  private next(): Token {
    const src = this.src;
    while (this.pos < src.length && /\s/.test(src[this.pos])) {
      this.pos++;
    }
    const start = this.pos;
    if (this.pos >= src.length) {
      return { type: 'eof', value: '', pos: start };
    }
    const ch = src[this.pos];

    // Numbers
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[this.pos + 1] ?? ''))) {
      return this.readNumber();
    }

    // Strings
    if (ch === '"' || ch === "'" || ch === '`') {
      return this.readString(ch);
    }

    // Identifiers / keywords
    if (isIdentStart(ch)) {
      while (this.pos < src.length && isIdentPart(src[this.pos])) {
        this.pos++;
      }
      return { type: 'ident', value: src.slice(start, this.pos), pos: start };
    }

    // Regex literal
    if (ch === '/' && this.regexAllowed()) {
      return this.readRegex();
    }

    for (const p of PUNCTUATORS) {
      if (src.startsWith(p, this.pos)) {
        // `?.` followed by a digit is the conditional operator followed by a number (e.g. `a?.5:1`)
        if (p === '?.' && /[0-9]/.test(src[this.pos + 2] ?? '')) {
          continue;
        }
        this.pos += p.length;
        return { type: 'punct', value: p, pos: start };
      }
    }

    return this.error(`Unexpected character '${ch}'`);
  }

  private readNumber(): Token {
    const src = this.src;
    const start = this.pos;
    if (src[this.pos] === '0' && /[xXbBoO]/.test(src[this.pos + 1] ?? '')) {
      this.pos += 2;
      while (this.pos < src.length && /[0-9a-fA-F_]/.test(src[this.pos])) {
        this.pos++;
      }
    } else {
      while (this.pos < src.length && /[0-9_]/.test(src[this.pos])) {
        this.pos++;
      }
      if (src[this.pos] === '.') {
        this.pos++;
        while (this.pos < src.length && /[0-9_]/.test(src[this.pos])) {
          this.pos++;
        }
      }
      if (/[eE]/.test(src[this.pos] ?? '')) {
        this.pos++;
        if (/[+-]/.test(src[this.pos] ?? '')) {
          this.pos++;
        }
        while (this.pos < src.length && /[0-9]/.test(src[this.pos])) {
          this.pos++;
        }
      }
    }
    const text = src.slice(start, this.pos).replace(/_/g, '');
    const value = Number(text);
    if (Number.isNaN(value) || isIdentPart(src[this.pos] ?? '')) {
      this.error(`Invalid number literal '${src.slice(start, this.pos + 1)}'`, start);
    }
    return { type: 'num', value: text, literal: value, pos: start };
  }

  private readString(quote: string): Token {
    const src = this.src;
    const start = this.pos;
    this.pos++;
    let out = '';
    while (this.pos < src.length) {
      const ch = src[this.pos];
      if (ch === quote) {
        this.pos++;
        return { type: 'str', value: src.slice(start, this.pos), literal: out, pos: start };
      }
      if (quote === '`' && ch === '$' && src[this.pos + 1] === '{') {
        this.error('Template literal interpolation (${...}) is not supported; use string concatenation', this.pos);
      }
      if (ch === '\\') {
        const esc = src[this.pos + 1];
        this.pos += 2;
        switch (esc) {
          case 'n': out += '\n'; break;
          case 't': out += '\t'; break;
          case 'r': out += '\r'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'v': out += '\v'; break;
          case '0': out += '\0'; break;
          case 'u': {
            const hex = src.slice(this.pos, this.pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              this.error('Invalid unicode escape', this.pos);
            }
            out += String.fromCharCode(parseInt(hex, 16));
            this.pos += 4;
            break;
          }
          case 'x': {
            const hex = src.slice(this.pos, this.pos + 2);
            if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
              this.error('Invalid hex escape', this.pos);
            }
            out += String.fromCharCode(parseInt(hex, 16));
            this.pos += 2;
            break;
          }
          case undefined:
            this.error('Unterminated string literal', start);
          // eslint-disable-next-line no-fallthrough
          default:
            out += esc;
        }
        continue;
      }
      if ((ch === '\n' || ch === '\r') && quote !== '`') {
        this.error('Unterminated string literal', start);
      }
      out += ch;
      this.pos++;
    }
    return this.error('Unterminated string literal', start);
  }

  private readRegex(): Token {
    const src = this.src;
    const start = this.pos;
    this.pos++;
    let inClass = false;
    let pattern = '';
    while (this.pos < src.length) {
      const ch = src[this.pos];
      if (ch === '\\') {
        pattern += ch + (src[this.pos + 1] ?? '');
        this.pos += 2;
        continue;
      }
      if (ch === '\n') {
        break;
      }
      if (ch === '[') {
        inClass = true;
      } else if (ch === ']') {
        inClass = false;
      } else if (ch === '/' && !inClass) {
        this.pos++;
        let flags = '';
        while (this.pos < src.length && /[a-z]/.test(src[this.pos])) {
          flags += src[this.pos++];
        }
        if (!/^[gimsuy]*$/.test(flags) || new Set(flags).size !== flags.length) {
          this.error(`Invalid regular expression flags '${flags}'`, start);
        }
        try {
          new RegExp(pattern, flags);
        } catch (e) {
          this.error(`Invalid regular expression: ${(e as Error).message}`, start);
        }
        return { type: 'regex', value: pattern, flags, pos: start };
      }
      pattern += ch;
      this.pos++;
    }
    return this.error('Unterminated regular expression literal', start);
  }
}

/**
 * Recursive-descent parser for the expression language.
 *
 * Precedence (lowest to highest):
 *   arrow / conditional  ?:
 *   ??
 *   ||
 *   &&
 *   == != === !==
 *   < <= > >=
 *   + -
 *   * / %
 *   unary ! - + typeof
 *   postfix  . ?. [] () new
 */
class Parser {
  private tokens: Token[];
  private index = 0;
  private depth = 0;

  constructor(private readonly src: string) {
    this.tokens = new Lexer(src).tokenize();
  }

  parse(): ExpressionNode {
    if (this.peek().type === 'eof') {
      this.error('Expression is empty');
    }
    const node = this.parseExpression();
    if (this.peek().type !== 'eof') {
      this.error(`Unexpected token '${this.peek().value}'`);
    }
    return node;
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)];
  }

  private advance(): Token {
    return this.tokens[this.index++];
  }

  private isPunct(value: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.type === 'punct' && t.value === value;
  }

  private eatPunct(value: string): boolean {
    if (this.isPunct(value)) {
      this.index++;
      return true;
    }
    return false;
  }

  private expectPunct(value: string): void {
    if (!this.eatPunct(value)) {
      const t = this.peek();
      this.error(t.type === 'eof' ? `Expected '${value}' but reached end of expression` : `Expected '${value}' but found '${t.value}'`);
    }
  }

  private error(message: string, pos = this.peek().pos): never {
    throw new ExpressionSyntaxError(message, this.src, pos);
  }

  private enter(): void {
    if (++this.depth > MAX_DEPTH) {
      this.error('Expression is nested too deeply');
    }
  }

  private leave(): void {
    this.depth--;
  }

  private parseExpression(): ExpressionNode {
    this.enter();
    try {
      const t = this.peek();
      if (t.type === 'punct' && t.value === '=') {
        this.error("Assignment is not allowed; did you mean '==='?");
      }
      if (this.isArrowAhead()) {
        return this.parseArrow();
      }
      return this.parseConditional();
    } finally {
      this.leave();
    }
  }

  private isArrowAhead(): boolean {
    const t = this.peek();
    if (t.type === 'ident' && this.isPunct('=>', 1)) {
      return true;
    }
    if (!this.isPunct('(')) {
      return false;
    }
    // Scan to the matching ')' and check for '=>'
    let depth = 0;
    for (let i = this.index; i < this.tokens.length; i++) {
      const tok = this.tokens[i];
      if (tok.type === 'punct' && tok.value === '(') {
        depth++;
      } else if (tok.type === 'punct' && tok.value === ')') {
        depth--;
        if (depth === 0) {
          const next = this.tokens[i + 1];
          return !!next && next.type === 'punct' && next.value === '=>';
        }
      } else if (tok.type === 'eof') {
        return false;
      }
    }
    return false;
  }

  private parseArrow(): ArrowNode {
    const params: string[] = [];
    if (this.peek().type === 'ident') {
      params.push(this.parseBindingName());
    } else {
      this.expectPunct('(');
      if (!this.isPunct(')')) {
        do {
          params.push(this.parseBindingName());
        } while (this.eatPunct(','));
      }
      this.expectPunct(')');
    }
    this.expectPunct('=>');
    if (this.isPunct('{')) {
      this.error('Arrow function block bodies are not supported; use an expression body');
    }
    const body = this.parseExpression();
    return { type: 'Arrow', params, body };
  }

  private parseBindingName(): string {
    const t = this.advance();
    if (t.type !== 'ident' || t.value in KEYWORDS_AS_LITERALS || FORBIDDEN_WORDS.has(t.value) || t.value === 'typeof' || t.value === 'new') {
      this.error(`Invalid parameter name '${t.value}'`, t.pos);
    }
    return t.value;
  }

  private parseConditional(): ExpressionNode {
    const test = this.parseNullish();
    if (this.eatPunct('?')) {
      const consequent = this.parseExpression();
      this.expectPunct(':');
      const alternate = this.parseExpression();
      return { type: 'Conditional', test, consequent, alternate };
    }
    return test;
  }

  private parseNullish(): ExpressionNode {
    let left = this.parseOr();
    while (this.eatPunct('??')) {
      const right = this.parseOr();
      left = { type: 'Logical', operator: '??', left, right };
    }
    return left;
  }

  private parseOr(): ExpressionNode {
    let left = this.parseAnd();
    while (this.eatPunct('||')) {
      const right = this.parseAnd();
      left = { type: 'Logical', operator: '||', left, right };
    }
    return left;
  }

  private parseAnd(): ExpressionNode {
    let left = this.parseEquality();
    while (this.eatPunct('&&')) {
      const right = this.parseEquality();
      left = { type: 'Logical', operator: '&&', left, right };
    }
    return left;
  }

  private parseBinaryLevel(operators: string[], next: () => ExpressionNode): ExpressionNode {
    let left = next();
    for (;;) {
      const t = this.peek();
      if (t.type === 'punct' && operators.includes(t.value)) {
        this.index++;
        const right = next();
        left = { type: 'Binary', operator: t.value as BinaryOperator, left, right };
      } else {
        return left;
      }
    }
  }

  private parseEquality(): ExpressionNode {
    return this.parseBinaryLevel(['===', '!==', '==', '!='], () => this.parseRelational());
  }

  private parseRelational(): ExpressionNode {
    return this.parseBinaryLevel(['<', '<=', '>', '>='], () => this.parseAdditive());
  }

  private parseAdditive(): ExpressionNode {
    return this.parseBinaryLevel(['+', '-'], () => this.parseMultiplicative());
  }

  private parseMultiplicative(): ExpressionNode {
    return this.parseBinaryLevel(['*', '/', '%'], () => this.parseUnary());
  }

  private parseUnary(): ExpressionNode {
    this.enter();
    try {
      const t = this.peek();
      if (t.type === 'punct' && (t.value === '!' || t.value === '-' || t.value === '+')) {
        this.index++;
        return { type: 'Unary', operator: t.value as UnaryOperator, argument: this.parseUnary() };
      }
      if (t.type === 'ident' && t.value === 'typeof') {
        this.index++;
        return { type: 'Unary', operator: 'typeof', argument: this.parseUnary() };
      }
      return this.parsePostfix();
    } finally {
      this.leave();
    }
  }

  private parsePostfix(): ExpressionNode {
    let node = this.parsePrimary();
    let isChain = false;
    for (;;) {
      if (this.isPunct('.')) {
        this.index++;
        node = this.memberByName(node, false);
      } else if (this.isPunct('?.')) {
        this.index++;
        isChain = true;
        if (this.eatPunct('(')) {
          node = { type: 'Call', callee: node, args: this.parseArguments(), optional: true } as CallNode;
        } else if (this.eatPunct('[')) {
          const property = this.parseExpression();
          this.expectPunct(']');
          node = { type: 'Member', object: node, property, computed: true, optional: true } as MemberNode;
        } else {
          node = this.memberByName(node, true);
        }
      } else if (this.eatPunct('[')) {
        const property = this.parseExpression();
        this.expectPunct(']');
        node = { type: 'Member', object: node, property, computed: true, optional: false };
      } else if (this.eatPunct('(')) {
        node = { type: 'Call', callee: node, args: this.parseArguments(), optional: false };
      } else {
        break;
      }
    }
    return isChain ? { type: 'Chain', expression: node } : node;
  }

  private memberByName(object: ExpressionNode, optional: boolean): MemberNode {
    const t = this.advance();
    if (t.type !== 'ident') {
      this.error(`Expected property name but found '${t.value}'`, t.pos);
    }
    return { type: 'Member', object, property: { type: 'Literal', value: t.value }, computed: false, optional };
  }

  /** Parses arguments after the opening '(' up to and including ')' */
  private parseArguments(): ExpressionNode[] {
    const args: ExpressionNode[] = [];
    if (this.eatPunct(')')) {
      return args;
    }
    do {
      if (this.isPunct(')')) {
        break; // trailing comma
      }
      if (this.isPunct('...')) {
        this.error('Spread arguments are not supported');
      }
      args.push(this.parseExpression());
    } while (this.eatPunct(','));
    this.expectPunct(')');
    return args;
  }

  private parsePrimary(): ExpressionNode {
    const t = this.advance();
    switch (t.type) {
      case 'num':
      case 'str':
        return { type: 'Literal', value: t.literal };
      case 'regex':
        return { type: 'Regex', pattern: t.value, flags: t.flags ?? '' };
      case 'ident': {
        if (t.value in KEYWORDS_AS_LITERALS) {
          return { type: 'Literal', value: KEYWORDS_AS_LITERALS[t.value] };
        }
        if (t.value === 'new') {
          const ctor = this.advance();
          if (ctor.type !== 'ident' || !NEW_ALLOWED.has(ctor.value)) {
            this.error(`'new' is only supported for: ${[...NEW_ALLOWED].join(', ')}`, ctor.pos);
          }
          const args = this.eatPunct('(') ? this.parseArguments() : [];
          return { type: 'New', callee: ctor.value, args };
        }
        if (FORBIDDEN_WORDS.has(t.value)) {
          this.error(`'${t.value}' is not supported in validation expressions`, t.pos);
        }
        return { type: 'Identifier', name: t.value };
      }
      case 'punct': {
        if (t.value === '(') {
          const expr = this.parseExpression();
          this.expectPunct(')');
          return expr;
        }
        if (t.value === '[') {
          const elements: ExpressionNode[] = [];
          while (!this.isPunct(']')) {
            if (this.isPunct('...')) {
              this.error('Spread elements are not supported');
            }
            elements.push(this.parseExpression());
            if (!this.eatPunct(',')) {
              break;
            }
          }
          this.expectPunct(']');
          return { type: 'Array', elements };
        }
        if (t.value === '{') {
          const properties: { key: string; value: ExpressionNode }[] = [];
          while (!this.isPunct('}')) {
            const keyTok = this.advance();
            let key: string;
            if (keyTok.type === 'ident' || keyTok.type === 'str' || keyTok.type === 'num') {
              key = String(keyTok.literal ?? keyTok.value);
            } else {
              this.error(`Invalid object key '${keyTok.value}'`, keyTok.pos);
            }
            if (key === '__proto__') {
              this.error("Object key '__proto__' is not allowed", keyTok.pos);
            }
            let value: ExpressionNode;
            if (this.eatPunct(':')) {
              value = this.parseExpression();
            } else if (keyTok.type === 'ident') {
              value = { type: 'Identifier', name: key }; // shorthand { a }
            } else {
              this.error("Expected ':'");
            }
            properties.push({ key, value });
            if (!this.eatPunct(',')) {
              break;
            }
          }
          this.expectPunct('}');
          return { type: 'Object', properties };
        }
        if (t.value === '=') {
          this.error("Assignment is not allowed; did you mean '==='?", t.pos);
        }
        return this.error(`Unexpected token '${t.value}'`, t.pos);
      }
      case 'eof':
        return this.error('Unexpected end of expression', t.pos);
    }
  }
}

/** Parses an expression into an AST. Throws {@link ExpressionSyntaxError} on invalid or unsupported syntax. */
export function parseExpression(source: string): ExpressionNode {
  if (typeof source !== 'string') {
    throw new ExpressionSyntaxError('Expression must be a string', String(source), 0);
  }
  return new Parser(source).parse();
}
