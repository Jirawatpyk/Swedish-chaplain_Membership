/**
 * The F8 errorId rules, as pure functions over source text.
 *
 * Extracted from `scripts/check-f8-error-id.ts` after round 3 of review, for a
 * reason worth stating: rounds 1, 2 and 3 each proved a rule wrong, and each
 * time the proof lived in a throwaway script. "10/10 mutants killed" could not
 * be reproduced from the repo, so the next round started from zero. These
 * functions are unit-tested in `tests/unit/scripts/check-f8-error-id.test.ts`
 * against every shape a review has proved bypassable — the proof now runs in CI.
 *
 * Input is always COMMENT-STRIPPED source (`stripCommentsPreserveLines`), so an
 * errorId promised in a `//` line cannot satisfy any rule.
 */
import { lineOfIndex, skipRegex, startsRegex } from './source-scan';

/**
 * End offset of the block opened just before `start`, by brace balance, with
 * string, template and regex-literal contents skipped.
 *
 * The regex clause is not hypothetical: round 2 proved the first version wrong
 * on `raw.replace(/'/g, '')` — the `'` inside the regex opened a string that ran
 * past the closing brace, so the scan returned an offset inside the FOLLOWING
 * catch, whose errorId then vouched for a block that had none.
 */
export function blockEnd(code: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < code.length) {
    const c = code[i]!;
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i += 1;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === '\\') i += 1;
        i += 1;
      }
    } else if (c === '/' && startsRegex(code.slice(0, i))) {
      const lineStart = code.lastIndexOf('\n', i) + 1;
      const lineEnd = code.indexOf('\n', i);
      const line = code.slice(lineStart, lineEnd === -1 ? code.length : lineEnd);
      i = lineStart + skipRegex(line, i - lineStart);
      continue;
    } else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return code.length;
}

/**
 * Every site where this file answers with a 500.
 *
 * Round 3 proved the first pattern (`/status: 500,/`) blind to two spellings
 * the repo actually uses: the property written last in the object literal (no
 * trailing comma) and a named constant (`status: HTTP_INTERNAL_SERVER_ERROR`).
 * Matching the VALUE loosely and the key exactly is the trade that catches both
 * without matching `status: 200`.
 */
export function fiveHundredSites(code: string): readonly number[] {
  const out: number[] = [];
  for (const m of code.matchAll(/status:\s*(500\b|[A-Z_][A-Z0-9_]{3,})/g)) {
    out.push(m.index!);
  }
  return out;
}

/**
 * A copy of `code` with the CONTENTS of every string, template and regex
 * literal replaced by spaces — same length, same line breaks, so every offset
 * still maps back to the original.
 *
 * `blockEnd` knew about literals; the backwards walk did not, and round 4
 * proved both halves of that gap on real house style: `const tpl = 'a } b';`
 * between an emit and a 500 pushed the depth to 1 and hid the emit, and
 * `'case closed'` truncated the walk. Both reported a CORRECT 500 as unlogged,
 * which is worse than a miss — it reds the build on code that is right.
 */
export function maskLiterals(code: string): string {
  const out = code.split('');
  let i = 0;
  while (i < code.length) {
    const c = code[i]!;
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i += 1;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === '\\') {
          out[i] = ' ';
          i += 1;
        }
        if (i < code.length && code[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === '/' && startsRegex(code.slice(0, i))) {
      const lineStart = code.lastIndexOf('\n', i) + 1;
      const lineEnd = code.indexOf('\n', i);
      const line = code.slice(lineStart, lineEnd === -1 ? code.length : lineEnd);
      const end = lineStart + skipRegex(line, i - lineStart);
      for (let j = i + 1; j < end - 1 && j < code.length; j += 1) out[j] = ' ';
      i = end;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** `true` when `code[i..]` starts `word` and is not part of a longer identifier. */
function wordAt(code: string, i: number, word: string): boolean {
  if (!code.startsWith(word, i)) return false;
  const before = i > 0 ? code[i - 1]! : ' ';
  if (/[A-Za-z0-9_$]/.test(before)) return false;
  const after = code[i + word.length] ?? ' ';
  return !/[A-Za-z0-9_$]/.test(after);
}

/**
 * Is the `logger.error(` at `at` an unconditional statement, or the body of a
 * brace-less guard?
 *
 * `if (cond) logger.error(…);` sits at the same brace depth as a 500 below it
 * but does not run on the path that reaches it. `if (cond) stmt;` is the house
 * style here — ~235 occurrences under `src/app/api/**​/route.ts`, including
 * `if ('response' in ctx) return ctx.response;` in all 26 F8 routes — so this
 * is the common shape, not a contrived one.
 */
function isUnconditionalStatement(code: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0 && /\s/.test(code[i]!)) i -= 1;
  if (i < 0) return true;
  const c = code[i]!;
  // `)` closes an `if (…)` / `for (…)` / `while (…)` head; `?` and `:` are the
  // arms of a ternary. A `:` can also end a `case` label, which IS a statement
  // position — distinguish by looking for the `case`/`default` that owns it.
  if (c === ')' || c === '?') return false;
  if (c === ':') {
    const lineStart = code.lastIndexOf('\n', i) + 1;
    const head = code.slice(lineStart, i);
    return /\b(case\b|default)/.test(head);
  }
  let j = i;
  while (j >= 0 && /[A-Za-z0-9_$]/.test(code[j]!)) j -= 1;
  return code.slice(j + 1, i + 1) !== 'else';
}

/**
 * Does a `logger.error` carrying an `errorId` vouch for the 500 at `pos`?
 *
 * "Same arm" is LEXICAL, not textual. Round 3 proved the `lastIndexOf('case ')`
 * heuristic wrong in five shapes at once, all of them one variant of the same
 * error: a textual window happily reaches back into a block that has already
 * closed, so a logged `case` arm vouched for an unlogged 500 written after the
 * whole switch. Position in the file is not scope.
 *
 * So: walk BACKWARDS from the 500 at relative brace depth 0, descending into
 * nothing, over a copy with literal contents masked. The walk does NOT stop at
 * the enclosing `{` — it steps out through it, because the first `{` above any
 * 500 is the object literal of the response itself. It stops at the `case` /
 * `default` / `catch` / `try` / `function` that opens the arm, matched on word
 * boundaries.
 *
 * An emit counts only if it is reached at depth 0 AND is an unconditional
 * statement: `if (cond) logger.error(…);` sits at the same depth as the 500 but
 * does not run on the path that reaches it.
 *
 * Round 4 found this docblock describing a `{`-stop and a completed-`return`
 * guard that the code did not have — the guard only ever matched a `return` on
 * the same LINE as its `;`, which this repo's multi-line return style never
 * produces. It has been removed rather than described.
 */
export function vouchedFor(rawCode: string, pos: number): boolean {
  // Walk the MASKED copy: same offsets, but braces and keywords inside string,
  // template and regex literals cannot steer the scan.
  const code = maskLiterals(rawCode);
  let depth = 0;
  let i = pos - 1;
  while (i >= 0) {
    const c = code[i]!;
    if (c === '}') {
      depth += 1;
      i -= 1;
      continue;
    }
    if (c === '{') {
      // Walking OUT one level, NOT stopping. The first `{` above a 500 is the
      // object literal of `errorResponse({ status: 500 })` itself, so bailing
      // here rejected the legitimate `emit; return errorResponse(500)` shape —
      // caught by the "accepts the legitimate shape" test, which is why that
      // test is written first. (An earlier version of this docblock said this
      // function "stops at the enclosing block's `{`"; it never did.)
      if (depth > 0) depth -= 1;
      i -= 1;
      continue;
    }
    if (depth !== 0) {
      i -= 1;
      continue;
    }
    if (code.startsWith('logger.error(', i)) {
      if (isUnconditionalStatement(code, i)) {
        const objEnd = blockEnd(rawCode, rawCode.indexOf('{', i) + 1);
        if (rawCode.slice(i, objEnd).includes('errorId')) return true;
      }
      i -= 1;
      continue;
    }
    // The arm's upper boundary. Reaching one of these at depth 0 means we have
    // scanned everything that could legitimately vouch and found nothing. `try`
    // is a boundary too: without it, S3's 500 (written after the switch closed)
    // keeps walking up and finds an emit from an unrelated earlier branch.
    //
    // Word boundaries, not `startsWith`: `entry`, `country` and `retry` all
    // contain `try`, and `entry` is this feature's own vocabulary. Round 4
    // proved `const country = pick(e);` between an emit and a 500 truncated the
    // walk and reported a correctly-logged 500 as unlogged.
    if (
      wordAt(code, i, 'case') ||
      wordAt(code, i, 'default') ||
      wordAt(code, i, 'catch') ||
      wordAt(code, i, 'try') ||
      wordAt(code, i, 'function')
    ) {
      return false;
    }
    i -= 1;
  }
  return false;
}

export interface RuleFailure {
  readonly line: number;
  readonly message: string;
}

/** All rules for one file. `union` is the parsed `F8ErrorId` membership set. */
export function checkSource(
  code: string,
  union: ReadonlySet<string>,
): { readonly declaredId: string | null; readonly failures: readonly RuleFailure[] } {
  const failures: RuleFailure[] = [];
  const push = (at: number, message: string) =>
    failures.push({ line: lineOfIndex(code, at) + 1, message });

  const decl = /const ERROR_ID(?:: F8ErrorId)? = '(F8\.[A-Z_]+)';/.exec(code);
  if (!decl) {
    return {
      declaredId: null,
      failures: [
        {
          line: 1,
          message:
            "declares no ERROR_ID. Add `const ERROR_ID = 'F8.<NAME>';` and add that\n    name to the F8ErrorId union in src/lib/renewals-route-helpers.ts.",
        },
      ],
    };
  }
  const declaredId = decl[1]!;

  if (union.size > 0 && !union.has(declaredId)) {
    push(
      decl.index!,
      `declares ${declaredId}, which is not a member of the F8ErrorId union. Add it\n    to src/lib/renewals-route-helpers.ts (the union is the taxonomy).`,
    );
  }

  // A hardcoded F8 literal is how one route comes to speak in another's name.
  // No closing quote in the pattern: an interpolated form is still a hardcode.
  for (const m of code.matchAll(/errorId: ['`](F8\.[A-Z_.]+)/g)) {
    push(
      m.index!,
      `hardcodes errorId '${m[1]}'. Build it from ERROR_ID instead, so the route\n    cannot come to speak in another route's name.`,
    );
  }

  // An exhaustiveness arm that RETURNS rather than throws. Kept as its own rule
  // even though the 500 rule below is broader: `return _exhaustive` produces NO
  // `status: 500` token at all — Next rejects the non-Response and 500s — so
  // the 500 rule cannot see it. Round 3 proved exactly this, against a runbook
  // sentence claiming the 500 rule subsumed this one.
  for (const m of code.matchAll(/const _exhaustive: never = /g)) {
    push(
      m.index!,
      "exhaustiveness arm returns instead of throwing, so an unmapped error kind\n    produces a 500 with NO log line and no errorId. Use `assertNever(x, …)`.",
    );
  }

  // Every 500 must be vouched for by an errorId'd log in its own arm.
  for (const at of fiveHundredSites(code)) {
    if (!vouchedFor(code, at)) {
      push(
        at,
        "a 500 is returned here with no errorId'd log in the same arm, so no F8\n    alert rule can match it — while this file's docblock promises a rule keyed\n    on `<ERROR_ID>.*` matches every 500 the route can produce.",
      );
    }
  }

  // Every logger.error inside a catch must carry an errorId, and a catch that
  // answers 500 must log at all. `catch {` with no binding is valid JS and this
  // repo uses it, so the parameter group is optional here.
  for (const m of code.matchAll(/\}\s*catch\s*(?:\([^)]*\))?\s*\{/g)) {
    const start = m.index! + m[0].length;
    const body = code.slice(start, blockEnd(code, start));
    const emits = [...body.matchAll(/logger\.error\(/g)];
    if (emits.length === 0) {
      if (fiveHundredSites(body).length > 0) {
        push(
          start,
          'a catch answers 500 but logs nothing, so the failure is invisible to every\n    alert rule. Log it with an errorId built from ERROR_ID.',
        );
      }
      continue;
    }
    // EVERY emit, not just the first: a catch whose second `logger.error`
    // carried no id was passing on the strength of its first.
    for (const e of emits) {
      const objEnd = blockEnd(body, body.indexOf('{', e.index!) + 1);
      if (body.slice(e.index!, objEnd).includes('errorId')) continue;
      push(
        start + e.index!,
        'logger.error inside a catch carries no errorId, so no F8 alert rule can\n    match this failure (docs/runbooks/audit-emit-loss.md).',
      );
    }
  }

  return { declaredId, failures };
}
