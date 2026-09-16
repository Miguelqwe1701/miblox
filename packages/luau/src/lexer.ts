/**
 * Luau lexer. Covers Lua 5.1 syntax plus the Luau additions this engine uses:
 * compound assignment, `continue`, string interpolation and type annotations.
 */

export type TokenType =
  | "name"
  | "number"
  | "string"
  | "interpStart"
  | "interpMid"
  | "interpEnd"
  | "keyword"
  | "symbol"
  | "eof";

export interface Token {
  type: TokenType;
  value: string;
  /** Parsed numeric or unescaped string value, when applicable. */
  literal?: number | string;
  line: number;
  column: number;
}

export const KEYWORDS = new Set([
  "and", "break", "do", "else", "elseif", "end", "false", "for", "function",
  "if", "in", "local", "nil", "not", "or", "repeat", "return", "then", "true",
  "until", "while", "continue", "export", "type",
]);

/** Longest-first, so `...` wins over `..` and `..=` over `..`. */
const SYMBOLS = [
  "...", "..=", "//=",
  "==", "~=", "<=", ">=", "..", "::", "->",
  "+=", "-=", "*=", "/=", "%=", "^=", "//",
  "+", "-", "*", "/", "%", "^", "#", "<", ">", "=", "(", ")", "{", "}",
  "[", "]", ";", ":", ",", ".", "?", "|", "&",
];

export class LuauSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
    readonly chunkName = "?",
  ) {
    super(`${chunkName}:${line}: ${message}`);
    this.name = "LuauSyntaxError";
  }
}

export class Lexer {
  private pos = 0;
  private line = 1;
  private lineStart = 0;
  /** Depth of nested `{}` inside an interpolated string, to find its end. */
  private interpStack: number[] = [];

  constructor(
    private readonly src: string,
    private readonly chunkName = "chunk",
  ) {}

  private get column(): number {
    return this.pos - this.lineStart + 1;
  }

  private error(msg: string): never {
    throw new LuauSyntaxError(msg, this.line, this.column, this.chunkName);
  }

  private peek(offset = 0): string {
    return this.src[this.pos + offset] ?? "";
  }

  private newline(): void {
    this.line++;
    this.lineStart = this.pos;
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];
    for (;;) {
      const token = this.next();
      tokens.push(token);
      if (token.type === "eof") break;
    }
    return tokens;
  }

  private skipTrivia(): void {
    for (;;) {
      const c = this.peek();
      if (c === "\n") {
        this.pos++;
        this.newline();
      } else if (c === " " || c === "\t" || c === "\r") {
        this.pos++;
      } else if (c === "-" && this.peek(1) === "-") {
        this.pos += 2;
        const long = this.tryLongBracket();
        if (long === null) {
          while (this.pos < this.src.length && this.peek() !== "\n") this.pos++;
        }
      } else {
        return;
      }
    }
  }

  /** Reads a `[[...]]` / `[=[...]=]` block, or returns null if not one. */
  private tryLongBracket(): string | null {
    if (this.peek() !== "[") return null;
    let level = 0;
    while (this.peek(1 + level) === "=") level++;
    if (this.peek(1 + level) !== "[") return null;
    this.pos += 2 + level;
    // A newline immediately after the opening bracket is dropped.
    if (this.peek() === "\r") this.pos++;
    if (this.peek() === "\n") {
      this.pos++;
      this.newline();
    }
    const close = `]${"=".repeat(level)}]`;
    const end = this.src.indexOf(close, this.pos);
    if (end === -1) this.error("unfinished long string or comment");
    const body = this.src.slice(this.pos, end);
    for (const ch of body) if (ch === "\n") this.line++;
    this.pos = end + close.length;
    return body;
  }

  private next(): Token {
    this.skipTrivia();
    const line = this.line;
    const column = this.column;
    if (this.pos >= this.src.length) {
      return { type: "eof", value: "<eof>", line, column };
    }

    const c = this.peek();

    // Closing brace of an interpolation hole resumes the string.
    if (c === "}" && this.interpStack.length > 0) {
      const depth = this.interpStack[this.interpStack.length - 1];
      if (depth === 0) {
        this.interpStack.pop();
        this.pos++;
        return this.readInterpolatedChunk(line, column, false);
      }
      this.interpStack[this.interpStack.length - 1] = depth - 1;
    } else if (c === "{" && this.interpStack.length > 0) {
      this.interpStack[this.interpStack.length - 1]++;
    }

    if (isNameStart(c)) {
      const start = this.pos;
      while (isNamePart(this.peek())) this.pos++;
      const value = this.src.slice(start, this.pos);
      return {
        type: KEYWORDS.has(value) ? "keyword" : "name",
        value,
        line,
        column,
      };
    }

    if (isDigit(c) || (c === "." && isDigit(this.peek(1)))) {
      return this.readNumber(line, column);
    }

    if (c === '"' || c === "'") return this.readString(c, line, column);

    if (c === "`") {
      this.pos++;
      return this.readInterpolatedChunk(line, column, true);
    }

    if (c === "[") {
      const long = this.tryLongBracket();
      if (long !== null) {
        return { type: "string", value: long, literal: long, line, column };
      }
    }

    for (const sym of SYMBOLS) {
      if (this.src.startsWith(sym, this.pos)) {
        this.pos += sym.length;
        return { type: "symbol", value: sym, line, column };
      }
    }

    this.error(`unexpected character '${c}'`);
  }

  /**
   * Reads one run of literal text inside a backtick string, stopping at either
   * a `{` hole or the closing backtick.
   */
  private readInterpolatedChunk(line: number, column: number, isStart: boolean): Token {
    let out = "";
    for (;;) {
      if (this.pos >= this.src.length) this.error("unfinished interpolated string");
      const c = this.peek();
      if (c === "`") {
        this.pos++;
        return {
          type: isStart ? "string" : "interpEnd",
          value: out,
          literal: out,
          line,
          column,
        };
      }
      if (c === "{") {
        this.pos++;
        this.interpStack.push(0);
        return {
          type: isStart ? "interpStart" : "interpMid",
          value: out,
          literal: out,
          line,
          column,
        };
      }
      if (c === "\\") {
        out += this.readEscape();
        continue;
      }
      if (c === "\n") this.error("unfinished interpolated string");
      out += c;
      this.pos++;
    }
  }

  private readString(quote: string, line: number, column: number): Token {
    this.pos++;
    let out = "";
    for (;;) {
      if (this.pos >= this.src.length) this.error("unfinished string");
      const c = this.peek();
      if (c === quote) {
        this.pos++;
        return { type: "string", value: out, literal: out, line, column };
      }
      if (c === "\n") this.error("unfinished string");
      if (c === "\\") {
        out += this.readEscape();
        continue;
      }
      out += c;
      this.pos++;
    }
  }

  private readEscape(): string {
    this.pos++; // consume backslash
    const c = this.peek();
    this.pos++;
    switch (c) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "a": return "\x07";
      case "b": return "\b";
      case "f": return "\f";
      case "v": return "\v";
      case "\\": return "\\";
      case '"': return '"';
      case "'": return "'";
      case "`": return "`";
      case "{": return "{";
      case "}": return "}";
      case "\n":
        this.newline();
        return "\n";
      case "x": {
        const hex = this.src.substr(this.pos, 2);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) this.error("hexadecimal digit expected");
        this.pos += 2;
        return String.fromCharCode(parseInt(hex, 16));
      }
      case "u": {
        if (this.peek() !== "{") this.error("missing '{' in \\u{xxxx}");
        this.pos++;
        const start = this.pos;
        while (this.peek() !== "}") {
          if (this.pos >= this.src.length) this.error("unfinished \\u escape");
          this.pos++;
        }
        const code = parseInt(this.src.slice(start, this.pos), 16);
        this.pos++;
        return String.fromCodePoint(code);
      }
      case "z": {
        // Skips following whitespace, including newlines.
        while (/\s/.test(this.peek())) {
          if (this.peek() === "\n") {
            this.pos++;
            this.newline();
          } else this.pos++;
        }
        return "";
      }
      default: {
        if (isDigit(c)) {
          let digits = c;
          while (digits.length < 3 && isDigit(this.peek())) digits += this.src[this.pos++];
          return String.fromCharCode(parseInt(digits, 10));
        }
        this.error(`invalid escape sequence '\\${c}'`);
      }
    }
  }

  private readNumber(line: number, column: number): Token {
    const start = this.pos;
    if (this.peek() === "0" && (this.peek(1) === "x" || this.peek(1) === "X")) {
      this.pos += 2;
      while (/[0-9a-fA-F_]/.test(this.peek())) this.pos++;
      const text = this.src.slice(start, this.pos).replace(/_/g, "");
      return { type: "number", value: text, literal: parseInt(text, 16), line, column };
    }
    if (this.peek() === "0" && (this.peek(1) === "b" || this.peek(1) === "B")) {
      this.pos += 2;
      while (/[01_]/.test(this.peek())) this.pos++;
      const text = this.src.slice(start, this.pos).replace(/_/g, "");
      return { type: "number", value: text, literal: parseInt(text.slice(2), 2), line, column };
    }
    while (/[0-9_]/.test(this.peek())) this.pos++;
    if (this.peek() === ".") {
      this.pos++;
      while (/[0-9_]/.test(this.peek())) this.pos++;
    }
    if (this.peek() === "e" || this.peek() === "E") {
      this.pos++;
      if (this.peek() === "+" || this.peek() === "-") this.pos++;
      while (isDigit(this.peek())) this.pos++;
    }
    const text = this.src.slice(start, this.pos).replace(/_/g, "");
    const value = Number(text);
    if (Number.isNaN(value)) this.error(`malformed number near '${text}'`);
    return { type: "number", value: text, literal: value, line, column };
  }
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}
function isNameStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
}
function isNamePart(c: string): boolean {
  return isNameStart(c) || isDigit(c);
}

export function tokenize(src: string, chunkName = "chunk"): Token[] {
  return new Lexer(src, chunkName).tokenize();
}
