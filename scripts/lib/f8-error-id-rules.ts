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
 * Does a `logger.error` carrying an `errorId` vouch for the 500 at `pos`?
 *
 * "Same arm" is LEXICAL, not textual. Round 3 proved the `lastIndexOf('case ')`
 * heuristic wrong in five shapes at once, all of them one variant of the same
 * error: a textual window happily reaches back into a block that has already
 * closed, so a logged `case` arm vouched for an unlogged 500 written after the
 * whole switch. Position in the file is not scope.
 *
 * So: walk BACKWARDS from the 500 at relative brace depth 0, descending into
 * nothing. Stop at the enclosing block's `{`, or at the `case` / `default:`
 * that opens this arm. An emit counts only if it is reached at depth 0 — i.e.
 * genuinely in this arm — and only if no completed `return` sits between it and
 * the 500, since such a return means that path exited and never reached here.
 */
export function vouchedFor(code: string, pos: number): boolean {
  let depth = 0;
  let i = pos - 1;
  // A `return` whose statement ended before `pos` means the emit that precedes
  // it belongs to a path that exited; it cannot vouch for this 500.
  let sawCompletedReturn = false;
  while (i >= 0) {
    const c = code[i]!;
    if (c === '}') {
      depth += 1;
      i -= 1;
      continue;
    }
    if (c === '{') {
      // Walking OUT one level, not stopping. The first `{` above a 500 is the
      // object literal of `errorResponse({ status: 500 })` itself, so bailing
      // here rejected the legitimate `emit; return errorResponse(500)` shape —
      // caught by the "accepts the legitimate shape" test, which is why that
      // test is written first.
      if (depth > 0) depth -= 1;
      i -= 1;
      continue;
    }
    if (depth !== 0) {
      i -= 1;
      continue;
    }
    if (c === ';') {
      // a statement boundary at this depth — was it a `return`?
      const stmtHead = code.lastIndexOf('\n', i);
      if (/\breturn\b/.test(code.slice(stmtHead === -1 ? 0 : stmtHead, i))) {
        sawCompletedReturn = true;
      }
      i -= 1;
      continue;
    }
    if (code.startsWith('logger.error(', i)) {
      if (!sawCompletedReturn) {
        const objEnd = blockEnd(code, code.indexOf('{', i) + 1);
        if (code.slice(i, objEnd).includes('errorId')) return true;
      }
      i -= 1;
      continue;
    }
    // The arm's upper boundary. Reaching one of these at depth 0 means we have
    // scanned everything that could legitimately vouch and found nothing. `try`
    // is a boundary too: without it, S3's 500 (written after the switch closed)
    // would keep walking up and find an emit from an unrelated earlier branch.
    if (
      code.startsWith('case ', i) ||
      code.startsWith('default:', i) ||
      code.startsWith('catch', i) ||
      code.startsWith('try', i) ||
      code.startsWith('function ', i)
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
