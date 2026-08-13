/**
 * Shared source-scanning primitives for the RBAC static gates and the nav /
 * palette parity tests.
 *
 * These existed as FOUR near-copies (`check-staff-page-guard`,
 * `check-api-route-guard`, and the two parity tests). The copies had already
 * drifted, and the drift was not cosmetic — it was the difference between a
 * gate that works and one that reports OK while blind:
 *
 *  - The 016 T065 gate stripped `//` AFTER looking for `/*`, so a line comment
 *    containing a glob (`// …/portal/** belongs to…`) opened a phantom block
 *    comment and blanked everything down to the next `*​/`. Measured: 341
 *    source lines of `src/config/nav.ts` invisible, including the whole of
 *    `staffNavConfig`. Four mutants planted there survived. The markers added
 *    by that same task were the trigger.
 *  - The two parity tests stripped only whole-line `//`, so a
 *    `requirePagePermission(...)` example inside a page's JSDoc header matched
 *    before the real call. `admin/compliance/erasure-log/page.tsx` — the
 *    highest-PII surface in the product — was being compared against prose.
 *
 * So the scanner here is character-wise and STRING-AWARE. It is the only
 * version; do not re-inline a regex variant.
 */

/**
 * Whether a `/` at this point begins a REGEX literal rather than division or a
 * comment, decided from the last significant character before it.
 *
 * Not a parser — a heuristic biased toward "regex", because the failure it
 * guards is a regex being mistaken for a comment opener, which BLANKS code and
 * makes a gate silently blind. Mistaking division for a regex costs at most a
 * garbled fragment on one line, and the callers only look for
 * `role === 'literal'`, which division never precedes.
 */
function startsRegex(before: string): boolean {
  const t = before.trimEnd();
  // NOTHING before it on this line → a comment, not a regex. This arm first
  // returned `true` (a `/` at the start of an expression usually IS a regex),
  // which made every `/**` docblock a regex literal — un-stripped — and
  // instantly reinstated the exact Critical this module was written to close:
  // the parity tests went back to matching the `requirePagePermission(...)`
  // example in a page's header. Two existing tests caught it immediately.
  //
  // The asymmetry is deliberate. Mistaking a comment for a regex breaks EVERY
  // docblock in the tree; mistaking a line-leading regex for a comment costs
  // one blanked line in a shape (`const re =` then the literal on the next
  // line) that is rare and that `MIN_EXPECTED_SITES` would surface.
  if (t === '') return false;
  const last = t[t.length - 1]!;
  if ('=(,:[!&|?{};+*%~^<>'.includes(last)) return true;
  // `return /re/`, `case /re/`, `typeof /re/` … keyword-preceded.
  return /\b(return|case|typeof|instanceof|in|of|new|delete|void|do|else|yield|await)$/.test(t);
}

/**
 * Index just past the closing `/` of the regex literal starting at `start`.
 * Honours escapes and character classes (`/[/]/` is one regex, not two).
 * Unterminated on this line → consume to end of line.
 */
function skipRegex(line: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < line.length) {
    const c = line[i]!;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return i + 1;
    i += 1;
  }
  return line.length;
}

/** A source line that is entirely comment (`//`, `*`, `/*`). */
export function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/**
 * Blank out every comment, PRESERVING line count and line numbers.
 *
 * Character-wise rather than regex, because both failure modes above are
 * context bugs a regex cannot see:
 *  - `//` inside a string (`'https://x'`) must NOT start a comment;
 *  - `/*` inside a string or inside a line comment must NOT start a block.
 *
 * Result index N corresponds to source line N+1, always.
 */
export function stripCommentLines(src: string): readonly string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    let res = '';
    let i = 0;
    let quote: string | null = null;
    while (i < line.length) {
      const c = line[i]!;
      const next = line[i + 1];
      if (inBlock) {
        if (c === '*' && next === '/') {
          inBlock = false;
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      if (quote !== null) {
        if (c === '\\') {
          res += c + (next ?? '');
          i += 2;
          continue;
        }
        if (c === quote) quote = null;
        res += c;
        i += 1;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        quote = c;
        res += c;
        i += 1;
        continue;
      }
      // A line comment runs to end of line — nothing after it is code, and
      // crucially nothing in it can open a block comment.
      if (c === '/' && next === '/') break;
      if (c === '/') {
        // `/` is either division, a comment opener, or a REGEX literal. Only
        // the last one needs care: a regex containing `/*` — e.g. `/\/\*/` —
        // would otherwise open a block comment and blank the rest of the file.
        // That is the exact bug this module exists to prevent, one level up.
        if (startsRegex(res)) {
          const end = skipRegex(line, i);
          res += line.slice(i, end);
          i = end;
          continue;
        }
        if (next === '*') {
          inBlock = true;
          i += 2;
          continue;
        }
      }
      res += c;
      i += 1;
    }
    out.push(res);
  }
  return out;
}

/** `stripCommentLines` joined back into a string. Line numbers preserved. */
export function stripCommentsPreserveLines(src: string): string {
  return stripCommentLines(src).join('\n');
}

/**
 * A marker may sit at most this many CODE lines above the site it covers — a
 * guard's condition often spans several lines, so strict adjacency is too
 * tight, but an 8-line raw window let one marker silence unrelated statements
 * beneath it.
 */
export const MAX_CODE_GAP = 3;

/**
 * True when an opt-out marker legitimately covers the code at `index` (0-based).
 *
 * A marker counts ONLY when it is hosted in a COMMENT — after `//` on the same
 * line, or inside the contiguous comment block at most `MAX_CODE_GAP` code
 * lines above. A bare `window.includes(marker)` over raw lines accepts a marker
 * sitting in a string constant (`const tag = 'rbac-narrow-ok'`), which silences
 * everything beneath it. That hole was found and closed once already in
 * `check-api-route-guard`; this is that implementation, shared.
 *
 * What remains is trust in the ANNOTATION: someone who writes a marker comment
 * directly above a genuine authorization decision defeats any textual gate.
 * That is what reviewing marker diffs is for.
 */
export function markerApplies(
  lines: readonly string[],
  index: number,
  markers: readonly string[],
): boolean {
  const hosts = (text: string): boolean => markers.some((m) => text.includes(m));

  const line = lines[index] ?? '';
  const slash = line.indexOf('//');
  if (slash >= 0 && hosts(line.slice(slash))) return true;

  let i = index - 1;
  let codeGap = 0;
  while (i >= 0) {
    const l = lines[i] ?? '';
    if (isCommentLine(l)) {
      for (let j = i; j >= 0 && isCommentLine(lines[j] ?? ''); j -= 1) {
        if (hosts(lines[j]!)) return true;
      }
      return false;
    }
    if (l.trim() !== '') {
      codeGap += 1;
      if (codeGap > MAX_CODE_GAP) return false;
    }
    i -= 1;
  }
  return false;
}

export interface PageGuard {
  readonly key: string;
  /** The IDENTIFIER of the legacy row, e.g. `legacyAdminOnly`. */
  readonly legacy: string;
}

/**
 * The `requirePagePermission('key', legacyRow)` a page file declares.
 *
 * Throws when a file declares MORE THAN ONE — a page with two guards is
 * ambiguous, and silently taking the first is how the parity tests ended up
 * reading a docblock. Returns null when there is none.
 */
export function extractPageGuard(src: string, label: string): PageGuard | null {
  const code = stripCommentsPreserveLines(src);
  const re = /requirePagePermission\(\s*'([^']+)'\s*,\s*([A-Za-z_$][\w$]*)/g;
  const matches = [...code.matchAll(re)];
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `${label}: ${matches.length} requirePagePermission calls found ` +
        `(${matches.map((m) => m[1]).join(', ')}). A page must declare exactly one, ` +
        'or the parity check cannot say which one the nav entry should mirror.',
    );
  }
  const m = matches[0]!;
  return { key: m[1]!, legacy: m[2]! };
}
