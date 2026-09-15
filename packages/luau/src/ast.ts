/** AST for the Luau subset this engine runs. Type annotations are parsed and
 *  discarded: Luau types are erased at runtime, so ignoring them is faithful. */

export interface Node {
  line: number;
}

export type Expr =
  | { kind: "Nil"; line: number }
  | { kind: "True"; line: number }
  | { kind: "False"; line: number }
  | { kind: "Number"; value: number; line: number }
  | { kind: "String"; value: string; line: number }
  | { kind: "Vararg"; line: number }
  /** A parenthesised expression, which truncates multiple returns to one. */
  | { kind: "Paren"; expr: Expr; line: number }
  | { kind: "Name"; name: string; line: number }
  | { kind: "Index"; object: Expr; index: Expr; line: number }
  | { kind: "Call"; callee: Expr; args: Expr[]; line: number }
  | { kind: "MethodCall"; object: Expr; method: string; args: Expr[]; line: number }
  | { kind: "Function"; params: string[]; isVararg: boolean; body: Block; name: string; line: number }
  | { kind: "Table"; entries: TableEntry[]; line: number }
  | { kind: "Binary"; op: BinaryOp; left: Expr; right: Expr; line: number }
  | { kind: "Unary"; op: UnaryOp; operand: Expr; line: number }
  | { kind: "Interp"; parts: Array<string | Expr>; line: number }
  | { kind: "IfElseExpr"; cond: Expr; then: Expr; else: Expr; line: number };

export type TableEntry =
  | { type: "array"; value: Expr }
  | { type: "record"; key: Expr; value: Expr };

export type BinaryOp =
  | "+" | "-" | "*" | "/" | "//" | "%" | "^" | ".."
  | "==" | "~=" | "<" | "<=" | ">" | ">="
  | "and" | "or";

export type UnaryOp = "-" | "not" | "#";

export type Stat =
  | { kind: "Local"; names: string[]; values: Expr[]; line: number }
  | { kind: "Assign"; targets: Expr[]; values: Expr[]; line: number }
  | { kind: "CompoundAssign"; target: Expr; op: BinaryOp; value: Expr; line: number }
  | { kind: "ExprStat"; expr: Expr; line: number }
  | { kind: "Do"; body: Block; line: number }
  | { kind: "While"; cond: Expr; body: Block; line: number }
  | { kind: "Repeat"; body: Block; cond: Expr; line: number }
  | {
      kind: "If";
      clauses: Array<{ cond: Expr; body: Block }>;
      orelse: Block | null;
      line: number;
    }
  | {
      kind: "NumericFor";
      name: string;
      start: Expr;
      limit: Expr;
      step: Expr | null;
      body: Block;
      line: number;
    }
  | { kind: "GenericFor"; names: string[]; exprs: Expr[]; body: Block; line: number }
  | { kind: "Return"; values: Expr[]; line: number }
  | { kind: "Break"; line: number }
  | { kind: "Continue"; line: number }
  | { kind: "LocalFunction"; name: string; fn: Expr; line: number }
  | { kind: "FunctionDecl"; target: Expr; fn: Expr; line: number }
  /** `type X = ...`, retained so tooling can see it but a no-op at runtime. */
  | { kind: "TypeAlias"; name: string; line: number };

export interface Block {
  stats: Stat[];
}

/** Binding powers. Right-associative operators carry a lower right power. */
export const BINARY_PRECEDENCE: Record<string, [number, number]> = {
  or: [1, 1],
  and: [2, 2],
  "<": [3, 3], ">": [3, 3], "<=": [3, 3], ">=": [3, 3], "~=": [3, 3], "==": [3, 3],
  "..": [9, 8], // right associative
  "+": [10, 10], "-": [10, 10],
  "*": [11, 11], "/": [11, 11], "//": [11, 11], "%": [11, 11],
  "^": [14, 13], // right associative
};

export const UNARY_PRECEDENCE = 12;
