/**
 * Evaluates a small arithmetic subset of JavaScript: number literals,
 * identifiers bound in `values`, `+ - * /`, unary minus, parentheses, and
 * `Math.round/floor/ceil/abs/min/max`. Anything else, or any unbound
 * identifier, yields undefined. Nothing is ever passed to `eval`.
 */
export function evaluateArithmetic(expression: string, values: ReadonlyMap<string, number>): number | undefined {
  const tokens = tokenize(expression);
  if (!tokens) return undefined;
  const parser = new Parser(tokens, values);
  const result = parser.parseExpression();
  return result !== undefined && parser.done() && Number.isFinite(result) ? result : undefined;
}

type Token = { kind: 'number'; value: number } | { kind: 'name'; value: string } | { kind: 'op'; value: string };

const MATH_FUNCTIONS: Readonly<Record<string, (...args: number[]) => number>> = {
  'Math.round': Math.round,
  'Math.floor': Math.floor,
  'Math.ceil': Math.ceil,
  'Math.abs': Math.abs,
  'Math.min': Math.min,
  'Math.max': Math.max,
};

function tokenize(expression: string): Token[] | undefined {
  const tokens: Token[] = [];
  const pattern = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)|([-+*/(),]))/y;
  let index = 0;
  while (index < expression.length) {
    if (expression.slice(index).trim() === '') break;
    pattern.lastIndex = index;
    const match = pattern.exec(expression);
    if (!match) return undefined;
    if (match[1] !== undefined) tokens.push({ kind: 'number', value: Number(match[1]) });
    else if (match[2] !== undefined) tokens.push({ kind: 'name', value: match[2] });
    else tokens.push({ kind: 'op', value: match[3] ?? '' });
    index = pattern.lastIndex;
  }
  return tokens;
}

class Parser {
  #index = 0;
  readonly #tokens: readonly Token[];
  readonly #values: ReadonlyMap<string, number>;

  constructor(tokens: readonly Token[], values: ReadonlyMap<string, number>) {
    this.#tokens = tokens;
    this.#values = values;
  }

  done(): boolean {
    return this.#index === this.#tokens.length;
  }

  parseExpression(): number | undefined {
    let left = this.#parseTerm();
    while (left !== undefined && this.#peekOp('+', '-')) {
      const op = this.#next()?.value;
      const right = this.#parseTerm();
      if (right === undefined) return undefined;
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  #parseTerm(): number | undefined {
    let left = this.#parseUnary();
    while (left !== undefined && this.#peekOp('*', '/')) {
      const op = this.#next()?.value;
      const right = this.#parseUnary();
      if (right === undefined) return undefined;
      left = op === '*' ? left * right : left / right;
    }
    return left;
  }

  #parseUnary(): number | undefined {
    if (this.#peekOp('-')) {
      this.#next();
      const value = this.#parseUnary();
      return value === undefined ? undefined : -value;
    }
    return this.#parsePrimary();
  }

  #parsePrimary(): number | undefined {
    const token = this.#next();
    if (!token) return undefined;
    if (token.kind === 'number') return token.value;
    if (token.kind === 'op') {
      if (token.value !== '(') return undefined;
      const value = this.parseExpression();
      return this.#expectOp(')') ? value : undefined;
    }
    const fn = MATH_FUNCTIONS[token.value];
    if (fn && this.#peekOp('(')) {
      this.#next();
      const args: number[] = [];
      do {
        const arg = this.parseExpression();
        if (arg === undefined) return undefined;
        args.push(arg);
      } while (this.#peekOp(',') && this.#next());
      return this.#expectOp(')') ? fn(...args) : undefined;
    }
    return this.#values.get(token.value);
  }

  #peekOp(...ops: string[]): boolean {
    const token = this.#tokens[this.#index];
    return token?.kind === 'op' && ops.includes(token.value);
  }

  #expectOp(op: string): boolean {
    if (!this.#peekOp(op)) return false;
    this.#next();
    return true;
  }

  #next(): Token | undefined {
    const token = this.#tokens[this.#index];
    if (token) this.#index += 1;
    return token;
  }
}
