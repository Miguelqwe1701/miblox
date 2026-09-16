import {
  BINARY_PRECEDENCE,
  UNARY_PRECEDENCE,
  type BinaryOp,
  type Block,
  type Expr,
  type Stat,
  type TableEntry,
  type UnaryOp,
} from "./ast.js";
import { LuauSyntaxError, tokenize, type Token } from "./lexer.js";

/** Recursive-descent parser producing the AST the interpreter walks. */
export class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(
    source: string,
    private readonly chunkName = "chunk",
  ) {
    this.tokens = tokenize(source, chunkName);
  }

  private get current(): Token {
    return this.tokens[this.pos];
  }

  private peek(offset = 1): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private advance(): Token {
    return this.tokens[this.pos++];
  }

  private check(value: string): boolean {
    const t = this.current;
    return (t.type === "symbol" || t.type === "keyword") && t.value === value;
  }

  private accept(value: string): boolean {
    if (!this.check(value)) return false;
    this.pos++;
    return true;
  }

  private expect(value: string, context?: string): Token {
    if (!this.check(value)) {
      this.error(
        `'${value}' expected${context ? ` (to close ${context})` : ""} near '${this.current.value}'`,
      );
    }
    return this.advance();
  }

  private expectName(): string {
    if (this.current.type !== "name") {
      this.error(`<name> expected near '${this.current.value}'`);
    }
    return this.advance().value;
  }

  private error(message: string): never {
    throw new LuauSyntaxError(message, this.current.line, this.current.column, this.chunkName);
  }

  parse(): Block {
    const block = this.parseBlock();
    if (this.current.type !== "eof") {
      this.error(`'<eof>' expected near '${this.current.value}'`);
    }
    return block;
  }

  private blockEnds(): boolean {
    const t = this.current;
    if (t.type === "eof") return true;
    if (t.type !== "keyword") return false;
    return t.value === "end" || t.value === "else" || t.value === "elseif" || t.value === "until";
  }

  private parseBlock(): Block {
    const stats: Stat[] = [];
    while (!this.blockEnds()) {
      if (this.accept(";")) continue;
      if (this.check("return")) {
        stats.push(this.parseReturn());
        this.accept(";");
        break; // `return` must be the last statement in its block.
      }
      stats.push(this.parseStatement());
    }
    return { stats };
  }

  private parseReturn(): Stat {
    const line = this.current.line;
    this.advance();
    const values = this.blockEnds() || this.check(";") ? [] : this.parseExprList();
    return { kind: "Return", values, line };
  }

  private parseStatement(): Stat {
    const t = this.current;
    const line = t.line;
    if (t.type === "keyword") {
      switch (t.value) {
        case "local": return this.parseLocal();
        case "if": return this.parseIf();
        case "while": return this.parseWhile();
        case "for": return this.parseFor();
        case "repeat": return this.parseRepeat();
        case "do": {
          this.advance();
          const body = this.parseBlock();
          this.expect("end", "'do'");
          return { kind: "Do", body, line };
        }
        case "function": return this.parseFunctionDecl();
        case "break":
          this.advance();
          return { kind: "Break", line };
        case "continue":
          // Luau's `continue` is contextual; treat a following '=' or '.' as a
          // plain identifier so scripts using it as a name still parse.
          if (this.peek().type === "symbol" && ["=", ".", ":", "[", "("].includes(this.peek().value)) {
            break;
          }
          this.advance();
          return { kind: "Continue", line };
        case "type":
        case "export":
          return this.parseTypeAlias();
      }
    }
    return this.parseExprStatement();
  }

  /** `type X = ...` / `export type X = ...`. Erased, so only the name is kept. */
  private parseTypeAlias(): Stat {
    const line = this.current.line;
    if (this.check("export")) {
      // `export` only introduces a type alias; otherwise it is an identifier.
      if (!(this.peek().type === "keyword" && this.peek().value === "type")) {
        return this.parseExprStatement();
      }
      this.advance();
    }
    // `type` used as a plain variable name, e.g. `type = 5`.
    if (this.peek().type !== "name") return this.parseExprStatement();
    this.advance();
    const name = this.expectName();
    if (this.check("<")) this.skipTypeParams();
    this.expect("=");
    this.skipTypeExpr();
    return { kind: "TypeAlias", name, line };
  }

  private parseLocal(): Stat {
    const line = this.current.line;
    this.advance();
    if (this.accept("function")) {
      const name = this.expectName();
      const fn = this.parseFunctionBody(name, line);
      return { kind: "LocalFunction", name, fn, line };
    }
    const names: string[] = [];
    do {
      names.push(this.expectName());
      if (this.accept(":")) this.skipTypeExpr();
    } while (this.accept(","));
    const values = this.accept("=") ? this.parseExprList() : [];
    return { kind: "Local", names, values, line };
  }

  private parseIf(): Stat {
    const line = this.current.line;
    this.advance();
    const clauses: Array<{ cond: Expr; body: Block }> = [];
    const cond = this.parseExpr();
    this.expect("then");
    clauses.push({ cond, body: this.parseBlock() });
    let orelse: Block | null = null;
    for (;;) {
      if (this.accept("elseif")) {
        const c = this.parseExpr();
        this.expect("then");
        clauses.push({ cond: c, body: this.parseBlock() });
        continue;
      }
      if (this.accept("else")) {
        orelse = this.parseBlock();
      }
      break;
    }
    this.expect("end", "'if'");
    return { kind: "If", clauses, orelse, line };
  }

  private parseWhile(): Stat {
    const line = this.current.line;
    this.advance();
    const cond = this.parseExpr();
    this.expect("do");
    const body = this.parseBlock();
    this.expect("end", "'while'");
    return { kind: "While", cond, body, line };
  }

  private parseRepeat(): Stat {
    const line = this.current.line;
    this.advance();
    const body = this.parseBlock();
    this.expect("until");
    const cond = this.parseExpr();
    return { kind: "Repeat", body, cond, line };
  }

  private parseFor(): Stat {
    const line = this.current.line;
    this.advance();
    const first = this.expectName();
    if (this.accept(":")) this.skipTypeExpr();

    if (this.accept("=")) {
      const start = this.parseExpr();
      this.expect(",");
      const limit = this.parseExpr();
      const step = this.accept(",") ? this.parseExpr() : null;
      this.expect("do");
      const body = this.parseBlock();
      this.expect("end", "'for'");
      return { kind: "NumericFor", name: first, start, limit, step, body, line };
    }

    const names = [first];
    while (this.accept(",")) {
      names.push(this.expectName());
      if (this.accept(":")) this.skipTypeExpr();
    }
    this.expect("in");
    const exprs = this.parseExprList();
    this.expect("do");
    const body = this.parseBlock();
    this.expect("end", "'for'");
    return { kind: "GenericFor", names, exprs, body, line };
  }

  private parseFunctionDecl(): Stat {
    const line = this.current.line;
    this.advance();
    let target: Expr = { kind: "Name", name: this.expectName(), line };
    let nameParts = (target as { name: string }).name;
    let isMethod = false;
    for (;;) {
      if (this.accept(".")) {
        const key = this.expectName();
        nameParts += `.${key}`;
        target = { kind: "Index", object: target, index: { kind: "String", value: key, line }, line };
        continue;
      }
      if (this.accept(":")) {
        const key = this.expectName();
        nameParts += `:${key}`;
        target = { kind: "Index", object: target, index: { kind: "String", value: key, line }, line };
        isMethod = true;
      }
      break;
    }
    const fn = this.parseFunctionBody(nameParts, line, isMethod);
    return { kind: "FunctionDecl", target, fn, line };
  }

  /** Parses `(params) body end`, inserting `self` for method definitions. */
  private parseFunctionBody(name: string, line: number, isMethod = false): Expr {
    if (this.check("<")) this.skipTypeParams();
    this.expect("(");
    const params: string[] = isMethod ? ["self"] : [];
    let isVararg = false;
    if (!this.check(")")) {
      do {
        if (this.accept("...")) {
          if (this.accept(":")) this.skipTypeExpr();
          isVararg = true;
          break;
        }
        params.push(this.expectName());
        if (this.accept(":")) this.skipTypeExpr();
      } while (this.accept(","));
    }
    this.expect(")");
    if (this.accept(":")) this.skipTypeExpr(); // return type
    const body = this.parseBlock();
    this.expect("end", `'function' at line ${line}`);
    return { kind: "Function", params, isVararg, body, name, line };
  }

  private parseExprStatement(): Stat {
    const line = this.current.line;
    const first = this.parseSuffixedExpr();

    const compound = ["+=", "-=", "*=", "/=", "//=", "%=", "^=", "..="];
    for (const op of compound) {
      if (this.check(op)) {
        this.advance();
        this.assertAssignable(first);
        const value = this.parseExpr();
        return {
          kind: "CompoundAssign",
          target: first,
          op: op.slice(0, -1) as BinaryOp,
          value,
          line,
        };
      }
    }

    if (this.check("=") || this.check(",")) {
      const targets = [first];
      while (this.accept(",")) targets.push(this.parseSuffixedExpr());
      this.expect("=");
      for (const t of targets) this.assertAssignable(t);
      const values = this.parseExprList();
      return { kind: "Assign", targets, values, line };
    }

    if (first.kind !== "Call" && first.kind !== "MethodCall") {
      this.error("syntax error: statement is not a call or an assignment");
    }
    return { kind: "ExprStat", expr: first, line };
  }

  private assertAssignable(expr: Expr): void {
    if (expr.kind !== "Name" && expr.kind !== "Index") {
      this.error("cannot assign to this expression");
    }
  }

  private parseExprList(): Expr[] {
    const exprs = [this.parseExpr()];
    while (this.accept(",")) exprs.push(this.parseExpr());
    return exprs;
  }

  parseExpr(limit = 0): Expr {
    let left: Expr;
    const line = this.current.line;

    const unaryOp = this.currentUnaryOp();
    if (unaryOp) {
      this.advance();
      const operand = this.parseExpr(UNARY_PRECEDENCE);
      left = { kind: "Unary", op: unaryOp, operand, line };
    } else {
      left = this.parseSimpleExpr();
    }

    for (;;) {
      const op = this.currentBinaryOp();
      if (!op) break;
      const [leftBp, rightBp] = BINARY_PRECEDENCE[op];
      if (leftBp <= limit) break;
      const opLine = this.current.line;
      this.advance();
      const right = this.parseExpr(rightBp);
      left = { kind: "Binary", op, left, right, line: opLine };
    }
    return left;
  }

  private currentUnaryOp(): UnaryOp | null {
    const t = this.current;
    if (t.type === "symbol" && (t.value === "-" || t.value === "#")) return t.value;
    if (t.type === "keyword" && t.value === "not") return "not";
    return null;
  }

  private currentBinaryOp(): BinaryOp | null {
    const t = this.current;
    if (t.type === "symbol" && t.value in BINARY_PRECEDENCE) return t.value as BinaryOp;
    if (t.type === "keyword" && (t.value === "and" || t.value === "or")) return t.value;
    return null;
  }

  private parseSimpleExpr(): Expr {
    const t = this.current;
    const line = t.line;
    switch (t.type) {
      case "number":
        this.advance();
        return { kind: "Number", value: t.literal as number, line };
      case "string":
        this.advance();
        return { kind: "String", value: t.literal as string, line };
      case "interpStart":
        return this.parseInterpolatedString();
      case "keyword":
        if (t.value === "nil") {
          this.advance();
          return { kind: "Nil", line };
        }
        if (t.value === "true") {
          this.advance();
          return { kind: "True", line };
        }
        if (t.value === "false") {
          this.advance();
          return { kind: "False", line };
        }
        if (t.value === "function") {
          this.advance();
          return this.parseFunctionBody("anonymous", line);
        }
        if (t.value === "if") return this.parseIfElseExpr();
        break;
      case "symbol":
        if (t.value === "...") {
          this.advance();
          return { kind: "Vararg", line };
        }
        if (t.value === "{") return this.parseTable();
        break;
    }
    return this.parseSuffixedExpr();
  }

  /** Luau's `if c then a else b` used as an expression. */
  private parseIfElseExpr(): Expr {
    const line = this.current.line;
    this.advance();
    const cond = this.parseExpr();
    this.expect("then");
    const then = this.parseExpr();
    let elseExpr: Expr;
    if (this.check("elseif")) {
      elseExpr = this.parseIfElseExpr();
    } else {
      this.expect("else");
      elseExpr = this.parseExpr();
    }
    return { kind: "IfElseExpr", cond, then, else: elseExpr, line };
  }

  private parseInterpolatedString(): Expr {
    const line = this.current.line;
    const parts: Array<string | Expr> = [];
    const first = this.advance();
    if (first.literal) parts.push(first.literal as string);
    for (;;) {
      parts.push(this.parseExpr());
      const t = this.current;
      if (t.type === "interpMid") {
        this.advance();
        if (t.literal) parts.push(t.literal as string);
        continue;
      }
      if (t.type === "interpEnd") {
        this.advance();
        if (t.literal) parts.push(t.literal as string);
        break;
      }
      this.error(`unfinished interpolated string near '${t.value}'`);
    }
    return { kind: "Interp", parts, line };
  }

  private parsePrimaryExpr(): Expr {
    const t = this.current;
    const line = t.line;
    if (t.type === "name") {
      this.advance();
      return { kind: "Name", name: t.value, line };
    }
    // Contextual keywords are valid identifiers outside their own syntax.
    if (t.type === "keyword" && (t.value === "continue" || t.value === "type" || t.value === "export")) {
      this.advance();
      return { kind: "Name", name: t.value, line };
    }
    if (this.accept("(")) {
      const inner = this.parseExpr();
      this.expect(")");
      // Parentheses truncate a multi-value expression to exactly one value.
      if (inner.kind === "Call" || inner.kind === "MethodCall" || inner.kind === "Vararg") {
        return { kind: "Paren", expr: inner, line };
      }
      return inner;
    }
    this.error(`unexpected symbol near '${t.value}'`);
  }

  private parseSuffixedExpr(): Expr {
    let expr = this.parsePrimaryExpr();
    for (;;) {
      const line = this.current.line;
      if (this.accept(".")) {
        const key = this.expectName();
        expr = { kind: "Index", object: expr, index: { kind: "String", value: key, line }, line };
        continue;
      }
      if (this.accept("[")) {
        const index = this.parseExpr();
        this.expect("]");
        expr = { kind: "Index", object: expr, index, line };
        continue;
      }
      if (this.check(":") && this.peek().type === "name") {
        this.advance();
        const method = this.expectName();
        expr = { kind: "MethodCall", object: expr, method, args: this.parseCallArgs(), line };
        continue;
      }
      if (this.check("(") || this.check("{") || this.current.type === "string") {
        expr = { kind: "Call", callee: expr, args: this.parseCallArgs(), line };
        continue;
      }
      if (this.accept("::")) {
        this.skipTypeExpr(); // `expr :: Type` is a runtime no-op.
        continue;
      }
      return expr;
    }
  }

  private parseCallArgs(): Expr[] {
    const t = this.current;
    // `f "str"` and `f {table}` are sugar for a single argument.
    if (t.type === "string") {
      this.advance();
      return [{ kind: "String", value: t.literal as string, line: t.line }];
    }
    if (this.check("{")) return [this.parseTable()];
    this.expect("(");
    if (this.accept(")")) return [];
    const args = this.parseExprList();
    this.expect(")");
    return args;
  }

  private parseTable(): Expr {
    const line = this.current.line;
    this.expect("{");
    const entries: TableEntry[] = [];
    while (!this.check("}")) {
      if (this.accept("[")) {
        const key = this.parseExpr();
        this.expect("]");
        this.expect("=");
        entries.push({ type: "record", key, value: this.parseExpr() });
      } else if (
        this.current.type === "name" &&
        this.peek().type === "symbol" &&
        this.peek().value === "="
      ) {
        const key = this.expectName();
        this.advance();
        entries.push({
          type: "record",
          key: { kind: "String", value: key, line },
          value: this.parseExpr(),
        });
      } else {
        entries.push({ type: "array", value: this.parseExpr() });
      }
      if (!this.accept(",") && !this.accept(";")) break;
    }
    this.expect("}", "'{'");
    return { kind: "Table", entries, line };
  }

  // -- type syntax, skipped rather than represented ------------------------

  private skipTypeParams(): void {
    this.expect("<");
    let depth = 1;
    while (depth > 0) {
      if (this.current.type === "eof") this.error("unfinished type parameter list");
      if (this.check(">=")) {
        // `type Foo<T>= ...` with no space lexes as one `>=` token. Closing the
        // list consumes the `>`, so replace it with the `=` the parser expects.
        depth--;
        this.tokens[this.pos] = { ...this.current, value: "=" };
        if (depth === 0) return;
        continue;
      }
      if (this.check("<")) depth++;
      else if (this.check(">")) depth--;
      this.advance();
    }
  }

  /**
   * Consumes a type expression. Types never contain statements, so tracking
   * bracket depth and stopping at a delimiter is enough to skip one exactly.
   */
  private skipTypeExpr(): void {
    let depth = 0;
    for (;;) {
      const t = this.current;
      if (t.type === "eof") return;
      if (t.type === "symbol") {
        if (t.value === "(" || t.value === "{" || t.value === "[" || t.value === "<") {
          depth++;
          this.advance();
          continue;
        }
        if (t.value === ")" || t.value === "}" || t.value === "]" || t.value === ">") {
          if (depth === 0) return;
          depth--;
          this.advance();
          continue;
        }
        if (depth === 0 && (t.value === "," || t.value === ";" || t.value === "=")) return;
        this.advance();
        continue;
      }
      if (t.type === "keyword") {
        // A keyword at depth 0 ends the type, except those that appear in one.
        if (depth === 0 && t.value !== "nil" && t.value !== "function" && t.value !== "typeof") {
          return;
        }
        this.advance();
        continue;
      }
      this.advance();
    }
  }
}

export function parse(source: string, chunkName = "chunk"): Block {
  return new Parser(source, chunkName).parse();
}
