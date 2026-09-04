/**
 * Tests for `scripts/lib/source-scan.ts` — the comment scanner shared by the
 * three RBAC static gates and the two nav/palette parity suites.
 *
 * This module exists because the 016 T065 gate shipped BLIND and reported
 * `23 marked, 0 unmarked` while it did so. Every case below is a regression
 * pin on a specific way that happened, or a way the sibling gates were defeated
 * before. A scanner with no tests of its own is how a gate silently stops being
 * one, and this one had none.
 */
import { describe, expect, it } from 'vitest';
import {
  isCommentLine,
  markerApplies,
  stripCommentLines,
  stripCommentsPreserveLines,
  extractPageGuard,
} from '../../../scripts/lib/source-scan';

describe('stripCommentLines — line accounting', () => {
  it('returns exactly one entry per source line', () => {
    const src = ['a', '/* x', ' y', '*/ b', 'c'].join('\n');
    expect(stripCommentLines(src)).toHaveLength(5);
  });

  it('keeps code that follows a block-comment close on the same line', () => {
    const out = stripCommentLines('/* x */ const role = 1;');
    expect(out[0]).toContain('const role = 1;');
  });
});

describe('stripCommentLines — the bug that made the T065 gate blind', () => {
  it('a glob inside a LINE comment does not open a block comment', () => {
    // The exact shape of the markers T065 added:
    //   `// rbac-portal-identity-ok: /portal/** belongs to the member subject.`
    // The first scanner searched for `/*` before stripping `//`, so `/**` here
    // opened a phantom block that blanked everything down to the next `*/` —
    // measured at 341 lines of src/config/nav.ts.
    const src = [
      "// rbac-portal-identity-ok: /portal/** belongs to the member subject.",
      "if (user.role !== 'member') {",
      '  deny();',
      '}',
    ].join('\n');
    const out = stripCommentLines(src);
    expect(out[1]).toContain("user.role !== 'member'");
    expect(out[2]).toContain('deny();');
  });

  it('a route glob in a line comment does not swallow the rest of the file', () => {
    // `// live under /admin/renewals/*` at src/config/nav.ts:268 blanked every
    // line after it — the entire staffNavConfig.
    const src = ['// live under /admin/renewals/*', "const a = role === 'manager';"].join('\n');
    expect(stripCommentLines(src)[1]).toContain("role === 'manager'");
  });

  it('a URL in a string does not start a line comment', () => {
    // `stripLineComment` cut at the first `//`, so a line carrying a URL lost
    // everything after it — a silent false negative in a gate.
    const src = "const u = 'https://x.test'; const a = role === 'admin';";
    const out = stripCommentLines(src)[0]!;
    expect(out).toContain("role === 'admin'");
  });

  it('a comment marker inside a string literal is still stripped as code, not comment', () => {
    const out = stripCommentLines("const s = '/* not a comment */'; const a = role === 'admin';")[0]!;
    expect(out).toContain("role === 'admin'");
  });

  it('an escaped quote does not end the string early', () => {
    const out = stripCommentLines("const s = 'it\\'s // fine'; const a = role === 'admin';")[0]!;
    expect(out).toContain("role === 'admin'");
  });

  it('a REGEX LITERAL containing /* does not open a block comment', () => {
    // Found while deciding whether the review fixes needed reviewing: the
    // scanner written to stop a phantom block comment had the same bug one
    // level down. `const re = /\/\*/;` blanked every line after it.
    const src = ['const re = /\\/\\*/;', "const a = role === 'admin';"].join('\n');
    expect(stripCommentLines(src)[1]).toContain("role === 'admin'");
  });

  it('a regex containing quotes does not leave the scanner inside a string', () => {
    const src = ['const re = /[\'"]/;', "const a = role === 'admin';"].join('\n');
    expect(stripCommentLines(src)[1]).toContain("role === 'admin'");
  });

  it('a regex character class may contain a slash', () => {
    // `/[/]/` is ONE regex — a naive skip ends it at the inner slash and then
    // reads the trailing `/` as the start of something else.
    const src = ['const re = /[/]/;', "const a = role === 'admin';"].join('\n');
    expect(stripCommentLines(src)[1]).toContain("role === 'admin'");
  });

  it('division is still division, not a regex swallowing the line', () => {
    const out = stripCommentLines("const n = a / b; const c = role === 'admin';")[0]!;
    expect(out).toContain("role === 'admin'");
  });

  it('a template literal does not hide a comparison after it', () => {
    const src = ['const s = `x ${y} //z`;', "const a = role === 'admin';"].join('\n');
    expect(stripCommentLines(src)[1]).toContain("role === 'admin'");
  });

  it('a LINE-LEADING block comment is a comment, never a regex', () => {
    // The regression the regex support introduced and the existing suite
    // caught: with `startsRegex('') === true`, every `/**` docblock became a
    // regex literal, went un-stripped, and the parity tests went straight back
    // to matching a guard EXAMPLE in a page header.
    const src = ['/** docblock */', "const a = role === 'admin';"].join('\n');
    const out = stripCommentLines(src);
    expect(out[0]).not.toContain('docblock');
    expect(out[1]).toContain("role === 'admin'");
  });

  it('a MULTI-LINE template literal does not let /* open a block comment', () => {
    // The final review's Critical: `quote` reset per line while `inBlock`
    // carried across, so a continuation line inside a template was scanned as
    // code. A `/*` there blanked the rest of the file — and 21 in-scope files
    // already contain multi-line templates.
    const src = [
      'const SQL_DOC = `',
      '  SELECT 1 /* a filtered subquery',
      '`;',
      "const a = role === 'manager';",
    ].join('\n');
    expect(stripCommentLines(src)[3]).toContain("role === 'manager'");
  });

  it('genuinely commented code IS removed', () => {
    const src = ["// if (role === 'admin') escalate();", '/* role === "admin" */'].join('\n');
    const out = stripCommentLines(src);
    expect(out[0]).not.toContain('admin');
    expect(out[1]).not.toContain('admin');
  });

  // 016 post-ship review finding #13 — the '/' branch consulted startsRegex()
  // BEFORE checking for '*', so a block opener preceded by code ending in
  // `=(,:[!&|?{};+*%~^<>` was consumed as a regex literal. A regex can never
  // START with '*' (a quantifier with nothing to repeat is a SyntaxError), so
  // `/*` after code is ALWAYS a comment.
  it('a trailing block comment after `=` is stripped, not parsed as a regex (finding #13)', () => {
    // `=` is in the startsRegex set — the old order kept this comment as CODE.
    const out = stripCommentLines(
      "const n = /* example: requirePagePermission('members.read') */ 1;",
    )[0]!;
    expect(out).not.toContain('requirePagePermission');
    expect(out).toContain('1;');
  });

  it('a phantom guard in a trailing comment is invisible to extractPageGuard (finding #13)', () => {
    const src = "const n = /* requirePagePermission('members.read') */ 1;";
    expect(extractPageGuard(src, 'x')).toBeNull();
  });

  it('a MULTI-LINE block comment opened after code keeps inBlock across lines (finding #13)', () => {
    // The old order left inBlock=false, so every following comment line read
    // as CODE — corrupting comment-ness for the rest of the file.
    const src = [
      'const n = 1; /* prose about',
      "role === 'admin' in prose",
      '*/',
      "const a = role === 'manager';",
    ].join('\n');
    const out = stripCommentLines(src);
    expect(out[1]).not.toContain('admin');
    expect(out[3]).toContain("role === 'manager'");
  });

  it('a regex literal containing /* STILL does not open a block (order preserved)', () => {
    // The reorder must not regress the original protection: `/\/\*/` is a
    // regex whose first char after `/` is `\`, so the `/*` check does not
    // fire and startsRegex still owns it.
    const src = ['const re = /\\/\\*/;', "const a = role === 'admin';"].join('\n');
    expect(stripCommentLines(src)[1]).toContain("role === 'admin'");
  });
});

describe('markerApplies — comment hosting', () => {
  const M = ['rbac-narrow-ok'];

  it('accepts a marker in the comment block directly above', () => {
    const lines = ['// rbac-narrow-ok: because', "if (role === 'admin') {}"];
    expect(markerApplies(lines, 1, M)).toBe(true);
  });

  it('accepts a trailing marker on the same line', () => {
    const lines = ["if (role === 'admin') {} // rbac-narrow-ok: because"];
    expect(markerApplies(lines, 0, M)).toBe(true);
  });

  it('REJECTS a marker that lives in a string constant', () => {
    // The hole the sibling gate closed once already: a plain constant silenced
    // every line beneath it.
    const lines = ["const tag = 'rbac-narrow-ok';", "if (role === 'admin') {}"];
    expect(markerApplies(lines, 1, M)).toBe(false);
  });

  it('REJECTS a marker separated by more than MAX_CODE_GAP code lines', () => {
    // An 8-line raw window let one legitimate marker cover an unrelated
    // authorization decision written underneath it.
    const lines = [
      '// rbac-narrow-ok: covers the line below only',
      "const a = role === 'admin';",
      'const b = 1;',
      'const c = 2;',
      'const d = 3;',
      "if (role === 'manager') escalate();",
    ];
    expect(markerApplies(lines, 1, M)).toBe(true);
    expect(markerApplies(lines, 5, M)).toBe(false);
  });

  it('accepts any marker from the supplied set', () => {
    const lines = ['// rbac-subgate-ok: field only', "if (role === 'admin') {}"];
    expect(markerApplies(lines, 1, ['rbac-narrow-ok', 'rbac-subgate-ok'])).toBe(true);
  });

  // 016 post-ship review finding #11 — the same-line arm took indexOf('//')
  // on the RAW line, so the '//' of a URL inside a string hosted a marker
  // that was itself inside the string. Reproduced against the real module
  // pre-fix; the marker must now be one stripping REMOVES (comment-hosted).
  it('REJECTS a marker hosted inside a URL string on the decision line (finding #11)', () => {
    const lines = [
      "const canWrite = role === 'admin'; track('https://ex.example/rbac-narrow-ok');",
    ];
    expect(markerApplies(lines, 0, M)).toBe(false);
  });

  it('REJECTS a marker in a plain string on the decision line itself', () => {
    const lines = ["const t = 'rbac-narrow-ok'; if (role === 'admin') {}"];
    expect(markerApplies(lines, 0, M)).toBe(false);
  });

  it('accepts a marker in a trailing BLOCK comment on the same line', () => {
    // Comment-hosted is the protocol; `/* … */` on the decision line is a
    // comment host too (the old `//`-only arm could not see it).
    const lines = ["if (role === 'admin') {} /* rbac-narrow-ok: type narrow */"];
    expect(markerApplies(lines, 0, M)).toBe(true);
  });

  it('same-line rejection also holds when the caller supplies codeLines', () => {
    const src = "const canWrite = role === 'admin'; track('https://ex.example/rbac-narrow-ok');";
    const lines = [src];
    expect(markerApplies(lines, 0, M, stripCommentLines(src))).toBe(false);
  });
});

describe('isCommentLine', () => {
  it.each([
    ['// x', true],
    [' * x', true],
    ['/* x', true],
    // JSX children admit no `//`, so `{/* … */}` is the only way to host a
    // marker beside a role literal in a component. Missing this arm made the
    // gate unsatisfiable in .tsx — every marker read as absent.
    ['        {/* rbac-presentation-only-ok: picks a badge icon */}', true],
    ["const a = role === 'admin';", false],
    ['', false],
  ])('%s → %s', (line, expected) => {
    expect(isCommentLine(line)).toBe(expected);
  });
});

describe('markerApplies — JSX comment hosting', () => {
  it('accepts a marker in a JSX comment directly above the literal', () => {
    const lines = [
      '{/* rbac-presentation-only-ok: picks a badge icon */}',
      "{user.role === 'super_admin' ? <Icon /> : null}",
    ];
    expect(markerApplies(lines, 1, ['rbac-presentation-only-ok'])).toBe(true);
  });

  it('still REJECTS a JSX-looking string that merely contains the marker text', () => {
    const lines = ["const s = '{/* rbac-narrow-ok */}';", "if (role === 'admin') {}"];
    expect(markerApplies(lines, 1, ['rbac-narrow-ok'])).toBe(false);
  });
});

describe('extractPageGuard', () => {
  it('reads the real call, not an example in the docblock', () => {
    // admin/compliance/erasure-log/page.tsx quotes its own guard in the header.
    // Both parity suites were matching THAT — comparing nav config against
    // prose on the highest-PII surface in the product.
    const src = [
      '/**',
      " * gated by `requirePagePermission('members.erasure_log_read', legacyAdminOnly)`.",
      ' */',
      "const { user } = await requirePagePermission('audit.read', legacySessionOnly);",
    ].join('\n');
    expect(extractPageGuard(src, 'x')).toEqual({ key: 'audit.read' });
  });

  it('returns null when there is no guard', () => {
    expect(extractPageGuard('export default function P() {}', 'x')).toBeNull();
  });

  it('THROWS when a page declares more than one guard', () => {
    // Silently taking the first is how the docblock bug survived. A page with
    // two guards is ambiguous and the author must resolve it.
    const src = [
      "await requirePagePermission('a.read', legacySessionOnly);",
      "await requirePagePermission('b.read', legacyAdminOnly);",
    ].join('\n');
    expect(() => extractPageGuard(src, 'two-guards.tsx')).toThrow(/exactly one/);
  });
});

describe('stripCommentsPreserveLines', () => {
  it('preserves the line count of the source', () => {
    const src = 'a\n/* x\ny */\nb';
    expect(stripCommentsPreserveLines(src).split('\n')).toHaveLength(4);
  });
});

describe('stripCommentLines — nested template literals (108 PR-A re-review MEDIUM-3)', () => {
  // The stripper tracked ONE open-quote character. A template literal's `${…}`
  // re-enters code context, where a second backtick opens a NESTED template —
  // and with one variable that inner backtick CLOSED the outer one. From there
  // the rest of the line read as code, so a `//` inside the outer template (a
  // URL, in practice) was treated as a line comment and everything after it
  // vanished. Six gates share this helper, so the blindness was theirs too.
  //
  // Measured impact when found: zero occurrences in scope. These tests exist so
  // it stays zero for a reason other than luck.

  it('keeps code that follows a nested template containing "//"', () => {
    const src = 'const to = `${a ? `https://x` : `y`}${snap.primary_contact_email}`;';
    expect(stripCommentLines(src).join('\n')).toContain('primary_contact_email');
  });

  it('keeps code after a nested template on an ordinary line', () => {
    const src = 'const cls = `${on ? `a` : `b`} ${role}`; check(actorRole);';
    const out = stripCommentLines(src).join('\n');
    expect(out).toContain('actorRole');
  });

  it('still strips a REAL line comment after a template', () => {
    const src = 'const u = `https://x`; // primary_contact_email';
    const out = stripCommentLines(src).join('\n');
    expect(out).toContain('https://x');
    expect(out).not.toContain('primary_contact_email');
  });

  it('still carries an unterminated template across lines', () => {
    const src = ['const q = sql`', '  SELECT 1 -- not a JS comment', '`;'].join('\n');
    expect(stripCommentLines(src).join('\n')).toContain('SELECT 1');
  });

  it('a `${` left open at end of line keeps the template open', () => {
    const src = ['const q = `${', '  cond ? `a` : `b`', '}`;'].join('\n');
    // The point is that line 2 is not mistaken for top-level code that ends the
    // template early; the closing backtick on line 3 must still terminate it.
    expect(stripCommentLines(src)).toHaveLength(3);
  });
});
