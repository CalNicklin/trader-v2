// Safe expression evaluator for trading signal rules.
// Supports: >, <, >=, <=, ==, !=, AND, OR, parentheses.
// Variables resolve against a context object. Unknown vars -> null -> false.
// No eval(), no Function(). Recursive descent parser.

export type ExprContext = Record<string, number | null | undefined>;

type Token =
	| { type: "NUM"; value: number }
	| { type: "VAR"; value: string }
	| { type: "OP"; value: string }
	| { type: "LOGIC"; value: "AND" | "OR" }
	| { type: "LPAREN" }
	| { type: "RPAREN" };

const TOKEN_RE = /\s*(>=|<=|==|!=|>|<|\(|\))|([A-Za-z_][A-Za-z0-9_]*)|(-?\d+(?:\.\d+)?)\s*/g;

export function tokenize(expr: string): Token[] {
	const tokens: Token[] = [];
	TOKEN_RE.lastIndex = 0;
	let lastIndex = 0;

	for (;;) {
		const match = TOKEN_RE.exec(expr);
		if (match === null) break;

		if (match.index > lastIndex) {
			const gap = expr.slice(lastIndex, match.index).trim();
			if (gap) throw new Error(`Unexpected: "${gap}"`);
		}
		lastIndex = TOKEN_RE.lastIndex;

		const [, op, word, num] = match;
		if (op === "(") tokens.push({ type: "LPAREN" });
		else if (op === ")") tokens.push({ type: "RPAREN" });
		else if (op) tokens.push({ type: "OP", value: op });
		else if (word === "AND" || word === "OR") tokens.push({ type: "LOGIC", value: word });
		else if (word) tokens.push({ type: "VAR", value: word });
		else if (num !== undefined) tokens.push({ type: "NUM", value: Number.parseFloat(num) });
	}

	const trailing = expr.slice(lastIndex).trim();
	if (trailing) throw new Error(`Unexpected trailing: "${trailing}"`);
	return tokens;
}

class Parser {
	private pos = 0;
	constructor(
		private tokens: Token[],
		private ctx: ExprContext,
	) {}

	eval(): boolean {
		const result = this.orExpr();
		if (this.pos < this.tokens.length) {
			throw new Error(`Unexpected token at position ${this.pos}`);
		}
		return result;
	}

	private orExpr(): boolean {
		let left = this.andExpr();
		while (
			this.peek()?.type === "LOGIC" &&
			(this.peek() as Token & { value: string }).value === "OR"
		) {
			this.advance();
			const right = this.andExpr();
			left = left || right;
		}
		return left;
	}

	private andExpr(): boolean {
		let left = this.comparison();
		while (
			this.peek()?.type === "LOGIC" &&
			(this.peek() as Token & { value: string }).value === "AND"
		) {
			this.advance();
			const right = this.comparison();
			left = left && right;
		}
		return left;
	}

	private comparison(): boolean {
		const left = this.value();
		const next = this.peek();
		if (next?.type !== "OP") {
			return left !== null && left !== 0;
		}
		const op = this.advance() as Token & { type: "OP"; value: string };
		const right = this.value();

		if (left === null || right === null) return false;

		switch (op.value) {
			case ">":
				return left > right;
			case "<":
				return left < right;
			case ">=":
				return left >= right;
			case "<=":
				return left <= right;
			case "==":
				return left === right;
			case "!=":
				return left !== right;
			default:
				throw new Error(`Unknown operator: ${op.value}`);
		}
	}

	private value(): number | null {
		const tok = this.peek();
		if (!tok) throw new Error("Unexpected end of expression");

		if (tok.type === "NUM") {
			this.advance();
			return tok.value;
		}
		if (tok.type === "VAR") {
			this.advance();
			const val = this.ctx[tok.value];
			return val === undefined || val === null ? null : val;
		}
		if (tok.type === "LPAREN") {
			this.advance();
			const result = this.orExpr();
			const closing = this.advance();
			if (closing?.type !== "RPAREN") throw new Error("Expected closing parenthesis");
			return result ? 1 : 0;
		}
		throw new Error(`Unexpected token: ${JSON.stringify(tok)}`);
	}

	private peek(): Token | undefined {
		return this.tokens[this.pos];
	}

	private advance(): Token {
		return this.tokens[this.pos++]!;
	}
}

/** Evaluate a signal expression against market data. Returns false on any error. */
export function evalExpr(expr: string, ctx: ExprContext): boolean {
	try {
		const tokens = tokenize(expr);
		if (tokens.length === 0) return false;
		return new Parser(tokens, ctx).eval();
	} catch {
		return false;
	}
}
