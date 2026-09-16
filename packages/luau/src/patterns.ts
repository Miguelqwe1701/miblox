/**
 * Lua 5.1 pattern matching, ported from the reference implementation in
 * lstrlib.c. Lua patterns are not regular expressions: `%` is the escape
 * character, `-` is a lazy quantifier, and there is no alternation, so the
 * matcher has to be written rather than mapped onto JS RegExp.
 */

const MAX_CAPTURES = 32;
/** Marks a position capture `()` rather than a text capture. */
const CAP_POSITION = -2;
/** Marks a capture whose end has not been recorded yet. */
const CAP_UNFINISHED = -1;

export interface Capture {
  init: number;
  len: number;
}

export class PatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatternError";
  }
}

export interface MatchResult {
  start: number;
  end: number;
  captures: Capture[];
}

class MatchState {
  level = 0;
  capture: Capture[] = [];
  matchDepth = 0;

  constructor(
    readonly src: string,
    readonly pattern: string,
  ) {}
}

function classMatch(c: string, cl: string): boolean {
  const lower = cl.toLowerCase();
  let res: boolean;
  switch (lower) {
    case "a": res = /[a-zA-Z]/.test(c); break;
    case "c": res = /[\x00-\x1f\x7f]/.test(c); break;
    case "d": res = c >= "0" && c <= "9"; break;
    case "g": res = /[\x21-\x7e]/.test(c); break;
    case "l": res = c >= "a" && c <= "z"; break;
    case "p": res = /[!-\/:-@\[-`{-~]/.test(c); break;
    case "s": res = /[ \t\n\v\f\r]/.test(c); break;
    case "u": res = c >= "A" && c <= "Z"; break;
    case "w": res = /[a-zA-Z0-9]/.test(c); break;
    case "x": res = /[0-9a-fA-F]/.test(c); break;
    default:
      return cl === c;
  }
  // An uppercase class letter negates the class.
  return cl >= "A" && cl <= "Z" ? !res : res;
}

/** Finds the index just past the character class starting at `p`. */
function classEnd(ms: MatchState, p: number): number {
  const c = ms.pattern[p++];
  if (c === "%") {
    if (p >= ms.pattern.length) throw new PatternError("malformed pattern (ends with '%')");
    return p + 1;
  }
  if (c === "[") {
    if (ms.pattern[p] === "^") p++;
    do {
      if (p >= ms.pattern.length) throw new PatternError("malformed pattern (missing ']')");
      const cc = ms.pattern[p++];
      if (cc === "%") {
        if (p >= ms.pattern.length) throw new PatternError("malformed pattern (ends with '%')");
        p++;
      }
    } while (ms.pattern[p] !== "]");
    return p + 1;
  }
  return p;
}

function matchBracketClass(ms: MatchState, c: string, p: number, ec: number): boolean {
  let sig = true;
  p++; // skip '['
  if (ms.pattern[p] === "^") {
    sig = false;
    p++;
  }
  while (p < ec) {
    if (ms.pattern[p] === "%") {
      p++;
      if (classMatch(c, ms.pattern[p])) return sig;
      p++;
      continue;
    }
    // A range like a-z, but only when '-' is not the last character.
    if (ms.pattern[p + 1] === "-" && p + 2 < ec) {
      if (ms.pattern[p] <= c && c <= ms.pattern[p + 2]) return sig;
      p += 3;
      continue;
    }
    if (ms.pattern[p] === c) return sig;
    p++;
  }
  return !sig;
}

function singleMatch(ms: MatchState, s: number, p: number, ep: number): boolean {
  if (s >= ms.src.length) return false;
  const c = ms.src[s];
  switch (ms.pattern[p]) {
    case ".": return true;
    case "%": return classMatch(c, ms.pattern[p + 1]);
    case "[": return matchBracketClass(ms, c, p, ep - 1);
    default: return ms.pattern[p] === c;
  }
}

function matchBalance(ms: MatchState, s: number, p: number): number {
  if (p + 1 >= ms.pattern.length) {
    throw new PatternError("malformed pattern (missing arguments to '%b')");
  }
  if (s >= ms.src.length || ms.src[s] !== ms.pattern[p]) return -1;
  const b = ms.pattern[p];
  const e = ms.pattern[p + 1];
  let cont = 1;
  let i = s + 1;
  while (i < ms.src.length) {
    const c = ms.src[i++];
    if (c === e) {
      if (--cont === 0) return i;
    } else if (c === b) cont++;
  }
  return -1;
}

function maxExpand(ms: MatchState, s: number, p: number, ep: number): number {
  let i = 0;
  while (singleMatch(ms, s + i, p, ep)) i++;
  while (i >= 0) {
    const res = doMatch(ms, s + i, ep + 1);
    if (res !== -1) return res;
    i--;
  }
  return -1;
}

function minExpand(ms: MatchState, s: number, p: number, ep: number): number {
  for (;;) {
    const res = doMatch(ms, s, ep + 1);
    if (res !== -1) return res;
    if (singleMatch(ms, s, p, ep)) s++;
    else return -1;
  }
}

function startCapture(ms: MatchState, s: number, p: number, what: number): number {
  if (ms.level >= MAX_CAPTURES) throw new PatternError("too many captures");
  ms.capture[ms.level] = { init: s, len: what };
  ms.level++;
  const res = doMatch(ms, s, p);
  if (res === -1) ms.level--;
  return res;
}

function endCapture(ms: MatchState, s: number, p: number): number {
  const l = captureToClose(ms);
  ms.capture[l].len = s - ms.capture[l].init;
  const res = doMatch(ms, s, p);
  if (res === -1) ms.capture[l].len = CAP_UNFINISHED;
  return res;
}

function captureToClose(ms: MatchState): number {
  for (let level = ms.level - 1; level >= 0; level--) {
    if (ms.capture[level].len === CAP_UNFINISHED) return level;
  }
  throw new PatternError("invalid pattern capture");
}

function checkCapture(ms: MatchState, l: number): number {
  const index = l - 1;
  if (index < 0 || index >= ms.level || ms.capture[index].len === CAP_UNFINISHED) {
    throw new PatternError(`invalid capture index %${l}`);
  }
  return index;
}

function matchCapture(ms: MatchState, s: number, l: number): number {
  const index = checkCapture(ms, l);
  const len = ms.capture[index].len;
  if (ms.src.length - s >= len) {
    const captured = ms.src.substr(ms.capture[index].init, len);
    if (ms.src.substr(s, len) === captured) return s + len;
  }
  return -1;
}

function doMatch(ms: MatchState, sInit: number, pInit: number): number {
  let s = sInit;
  let p = pInit;
  if (ms.matchDepth++ > 220) {
    ms.matchDepth--;
    throw new PatternError("pattern too complex");
  }

  try {
    for (;;) {
      if (p >= ms.pattern.length) return s;

      switch (ms.pattern[p]) {
        case "(":
          return ms.pattern[p + 1] === ")"
            ? startCapture(ms, s, p + 2, CAP_POSITION)
            : startCapture(ms, s, p + 1, CAP_UNFINISHED);
        case ")":
          return endCapture(ms, s, p + 1);
        case "$":
          if (p + 1 === ms.pattern.length) return s === ms.src.length ? s : -1;
          break;
        case "%":
          switch (ms.pattern[p + 1]) {
            case "b": {
              s = matchBalance(ms, s, p + 2);
              if (s === -1) return -1;
              p += 4;
              continue;
            }
            case "f": {
              p += 2;
              if (ms.pattern[p] !== "[") {
                throw new PatternError("missing '[' after '%f' in pattern");
              }
              const ep = classEnd(ms, p);
              const previous = s === 0 ? "\0" : ms.src[s - 1];
              const current = s < ms.src.length ? ms.src[s] : "\0";
              if (
                !matchBracketClass(ms, previous, p, ep - 1) &&
                matchBracketClass(ms, current, p, ep - 1)
              ) {
                p = ep;
                continue;
              }
              return -1;
            }
            default: {
              const digit = ms.pattern[p + 1];
              if (digit >= "0" && digit <= "9") {
                s = matchCapture(ms, s, Number(digit));
                if (s === -1) return -1;
                p += 2;
                continue;
              }
            }
          }
          break;
      }

      const ep = classEnd(ms, p);
      const quantifier = ms.pattern[ep];
      if (quantifier === "?") {
        if (singleMatch(ms, s, p, ep)) {
          const res = doMatch(ms, s + 1, ep + 1);
          if (res !== -1) return res;
        }
        p = ep + 1;
        continue;
      }
      if (quantifier === "+") {
        return singleMatch(ms, s, p, ep) ? maxExpand(ms, s + 1, p, ep) : -1;
      }
      if (quantifier === "*") {
        return maxExpand(ms, s, p, ep);
      }
      if (quantifier === "-") {
        return minExpand(ms, s, p, ep);
      }
      if (!singleMatch(ms, s, p, ep)) return -1;
      s++;
      p = ep;
    }
  } finally {
    ms.matchDepth--;
  }
}

/**
 * Finds `pattern` in `src` starting at `init` (0-based). Returns null when
 * there is no match.
 */
export function patternFind(src: string, pattern: string, init = 0): MatchResult | null {
  let p = 0;
  const anchored = pattern[0] === "^";
  if (anchored) p = 1;

  let s = Math.max(0, Math.min(init, src.length));
  do {
    const ms = new MatchState(src, pattern);
    ms.level = 0;
    ms.matchDepth = 0;
    const e = doMatch(ms, s, p);
    if (e !== -1) {
      return { start: s, end: e, captures: ms.capture.slice(0, ms.level) };
    }
    s++;
  } while (s <= src.length && !anchored);
  return null;
}

/**
 * Captures as Lua would return them: the matched text when the pattern has no
 * captures, 1-based positions for `()`, and substrings otherwise.
 */
export function capturesOf(
  src: string,
  result: MatchResult,
  wholeIfNone = true,
): Array<string | number> {
  if (result.captures.length === 0) {
    return wholeIfNone ? [src.slice(result.start, result.end)] : [];
  }
  return result.captures.map((cap) =>
    cap.len === CAP_POSITION ? cap.init + 1 : src.substr(cap.init, cap.len),
  );
}

export { CAP_POSITION };
