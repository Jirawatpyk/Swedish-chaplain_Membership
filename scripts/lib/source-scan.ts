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
 * So the scanner here is character-wise and STRING-AWARE.
 *
 * CONSOLIDATION IS TOTAL since the 016 post-ship review (2026-08-14): the two
 * gates that still carried private regex strippers + marker helpers
 * (`check-api-route-guard.ts`, `check-staff-page-guard.ts`) migrated here after
 * the review CONFIRMED bugs in both private copies — the regex stripper opened
 * a phantom block comment on a string containing `/*` (finding V3b), and the
 * raw-line markerApplies honored a marker hosted inside a string/URL on the
 * decision line (finding #11). "Deliberately deferred" stopped being prudence
 * the moment both copies were proven wrong. Consumers now: all three RBAC
 * static gates + the three parity suites. A fix here reaches every one.
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

/**
 * A source line that is entirely comment (`//`, `*`, `/*`, or a JSX `{/*`).
 *
 * The JSX form matters because these scanners run over `.tsx`, and the marker
 * protocol they enforce is "host the marker in a comment". Inside JSX CHILDREN
 * the only comment syntax is `{/* … *​/}`; `//` is unavailable there. Without
 * this arm, a literal sitting in JSX children could not be marked in place at
 * all — the author had to restructure working code to appease the tool.
 *
 * Narrower than it first looks, and worth stating precisely: `//` markers
 * always worked in the TS body AND in JSX attribute position, which is how
 * three of the sites in `invite-user-dialog.tsx` are marked. Only children
 * were unreachable.
 */
export function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*');
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
  // Set when the open block came from a JSX `{/*`, so its `}` is consumed too.
  let inJsxBlock = false;
  // Template literals span lines; `'` and `"` cannot. `inBlock` was already
  // carried across lines and `quote` was not, so a `/*` on the CONTINUATION
  // line of a multi-line template was scanned as CODE and opened a phantom
  // block — the same failure this module exists to close, one state variable
  // away. Latent when found (no file in scope triggered it) but the trigger is
  // a near-cousin of the original incident: a glob or a SQL comment inside a
  // `sql`-tagged template would do it, and 21 in-scope files carry multi-line
  // templates.
  let inTemplate = false;
  for (const line of src.split('\n')) {
    let res = '';
    let i = 0;
    // A STACK, not one value. A template literal's `${…}` re-enters CODE
    // context, where another backtick opens a NESTED template — and with a
    // single variable the inner backtick closed the OUTER one. Everything after
    // it on that line was then read as code, so a `//` inside the outer template
    // (a URL, usually) truncated the rest of the line and every gate built on
    // this helper went blind to it. Measured shape:
    //   const to = `${a ? `https://x` : `y`}${snap.primary_contact_email}`;
    // — the token after the nested template was invisible. Six gates share this.
    const stack: string[] = inTemplate ? ['`'] : [];
    while (i < line.length) {
      const c = line[i]!;
      const next = line[i + 1];
      if (inBlock) {
        if (c === '*' && next === '/') {
          inBlock = false;
          i += 2;
          // A JSX comment closes `*​/}` — swallow the brace too, or the line
          // survives stripping as a lone `}` and reads as CODE. That is enough
          // to make a marker on the line above look separated from the site it
          // covers by a code gap.
          if (inJsxBlock) {
            inJsxBlock = false;
            if (line[i] === '}') i += 1;
          }
          continue;
        }
        i += 1;
        continue;
      }
      const open = stack[stack.length - 1] ?? null;
      if (open !== null && open !== '${') {
        if (c === '\\') {
          res += c + (next ?? '');
          i += 2;
          continue;
        }
        // Inside a template, `${` opens a CODE frame and its matching `}` pops
        // back to the template. Only inside that frame can a backtick start a
        // NEW template rather than end this one.
        if (open === '`' && c === '$' && next === '{') {
          stack.push('${');
          res += '${';
          i += 2;
          continue;
        }
        if (c === open) stack.pop();
        res += c;
        i += 1;
        continue;
      }
      // Code context — top level, or inside a template's `${…}`.
      if (open === '${' && c === '}') {
        stack.pop();
        res += c;
        i += 1;
        continue;
      }
      // JSX comment opener. Handled BEFORE the `/` cases because `{` is in the
      // `startsRegex` set, so `{/*` was read as "a regex begins here" and the
      // whole comment was copied through as CODE — which is why role literals
      // written inside a JSX comment were being counted as decision sites.
      if (c === '{' && next === '/' && line[i + 2] === '*') {
        inBlock = true;
        inJsxBlock = true;
        i += 3;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        stack.push(c);
        res += c;
        i += 1;
        continue;
      }
      // A line comment runs to end of line — nothing after it is code, and
      // crucially nothing in it can open a block comment.
      if (c === '/' && next === '/') break;
      if (c === '/') {
        // `/` is either division, a comment opener, or a REGEX literal.
        //
        // `/*` is checked FIRST (016 post-ship review finding #13): a regex
        // literal can never START with `*` (a quantifier with nothing to
        // repeat is a SyntaxError), so `/*` after code is ALWAYS a block
        // comment. The old order consulted startsRegex() first, so a block
        // opener preceded by code ending in `=(,:[` etc. — e.g.
        // `const n=1; /* example: requirePagePermission('members.read') */`
        // — was consumed as a regex literal: the trailing comment survived
        // stripping as CODE (a phantom guard for the parity suites, fail-
        // open) and a multi-line one left `inBlock=false`, corrupting every
        // later line's comment-ness.
        if (next === '*') {
          inBlock = true;
          i += 2;
          continue;
        }
        // Now the remaining ambiguity is regex vs division. A regex
        // containing `/*` — e.g. `/\/\*/` — must not open a block comment;
        // that is the exact bug this module exists to prevent, one level up.
        if (startsRegex(res)) {
          const end = skipRegex(line, i);
          res += line.slice(i, end);
          i = end;
          continue;
        }
      }
      res += c;
      i += 1;
    }
    // Carry an unterminated template to the next line. A `${…}` still open at
    // EOL sits ABOVE its template frame on the stack, so ask the whole stack
    // rather than just the top.
    inTemplate = stack.includes('`');
    out.push(res);
  }
  return out;
}

/** `stripCommentLines` joined back into a string. Line numbers preserved. */
export function stripCommentsPreserveLines(src: string): string {
  return stripCommentLines(src).join('\n');
}

/**
 * 0-based line number of a character offset within `text`. Pairs with
 * whole-text `matchAll` scans (the only shape that can see a comparison
 * wrapped across a newline — 016 post-ship review finding #12) so a match
 * offset maps back to the line the marker protocol anchors on.
 */
export function lineOfIndex(text: string, index: number): number {
  let line = 0;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
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
  /** `stripCommentLines(src)` for the same file — see the note inside. */
  codeLines?: readonly string[],
): boolean {
  const hosts = (text: string): boolean => markers.some((m) => text.includes(m));

  const line = lines[index] ?? '';
  // Same-line arm (016 post-ship review finding #11): a marker on the
  // decision line counts only when STRIPPING removes it — i.e. it lives in
  // the comment part. The old form took indexOf('//') on the RAW line, so a
  // '//' inside a string (`track('https://x/rbac-narrow-ok')`) hosted a
  // marker that was itself inside the string — the exact string-constant
  // hole this function's docstring claims closed. Strings survive stripping
  // verbatim, so "in the raw line but not in the stripped line" is exactly
  // "comment-hosted". Known edge (security review 2026-08-14, accepted): a
  // line carrying the marker in BOTH a string and a trailing comment is
  // rejected — fail-CLOSED (a loud false finding, never a bypass); reword
  // the string or move the marker above. When the caller did not supply
  // codeLines, strip this one line in place (single-line contexts only,
  // which is all the same-line arm can ever see).
  const codeLine = codeLines?.[index] ?? stripCommentLines(line)[0] ?? '';
  if (hosts(line) && !hosts(codeLine)) return true;

  // Comment-ness is decided from the STRIPPED source when the caller supplies
  // it, and only falls back to the line-shape guess otherwise.
  //
  // Shape alone cannot see a multi-line comment's CONTINUATION lines: the second
  // line of a `{/* … */}` starts with prose, so it read as CODE, and a marker on
  // the opening line was separated from the site it covers by a phantom gap.
  // With `MAX_CODE_GAP` slack that merely wasted budget; with any adjacency
  // rule it silently stopped working. The stripped source has no such blind
  // spot — a comment line is exactly a line that survives stripping as blank.
  const blank = (n: number): boolean => (lines[n] ?? '').trim() === '';
  const code = (n: number): boolean => {
    if (blank(n)) return false;
    return codeLines ? (codeLines[n] ?? '').trim() !== '' : !isCommentLine(lines[n] ?? '');
  };

  let i = index - 1;
  let codeGap = 0;
  while (i >= 0) {
    if (blank(i)) {
      i -= 1;
      continue;
    }
    if (!code(i)) {
      // A contiguous comment run — search all of it, then stop. Walking further
      // would let a marker reach across unrelated code.
      for (let j = i; j >= 0 && !code(j); j -= 1) {
        if (hosts(lines[j]!)) return true;
      }
      return false;
    }
    codeGap += 1;
    if (codeGap > MAX_CODE_GAP) return false;
    i -= 1;
  }
  return false;
}

export interface PageGuard {
  readonly key: string;
}

/**
 * The `requirePagePermission('key')` a page file declares. (The second
 * argument — the legacy-shim row — died with the legacy leg in PR 5.)
 *
 * Throws when a file declares MORE THAN ONE — a page with two guards is
 * ambiguous, and silently taking the first is how the parity tests ended up
 * reading a docblock. Returns null when there is none.
 */
export function extractPageGuard(src: string, label: string): PageGuard | null {
  const code = stripCommentsPreserveLines(src);
  const re = /requirePagePermission\(\s*'([^']+)'/g;
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
  return { key: m[1]! };
}
