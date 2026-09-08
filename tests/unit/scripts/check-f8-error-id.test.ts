/**
 * Unit tests for the F8 errorId gate's rules.
 *
 * These exist because four rounds of review each proved a rule wrong, and for
 * the first three the proof lived in a throwaway script: "10/10 mutants killed"
 * could not be reproduced from the repo, so the next round started from zero
 * and found the next spelling.
 *
 * The shapes pinned below are the ones a review demonstrated AND that the rules
 * had to change to handle. Round 3's S4 (a helper declared below the handler)
 * is deliberately absent: the rules already answered it correctly, so a test
 * would assert nothing about a change. An earlier version of this docblock
 * claimed EVERY demonstrated shape was pinned, which was false for exactly
 * that reason — the fourth round caught it.
 *
 * Round 1 — ten routes returned an unlogged 500 from the exhaustiveness arm.
 * Round 2 — fourteen did the same from `case 'server_error':`, and the gate was
 *   structurally blind because its rules keyed on SYNTAX (`catch`,
 *   `_exhaustive`).
 * Round 3 — the replacement rule keyed on the token `status: 500,` and scoped
 *   "same arm" with `lastIndexOf`, which cannot tell whether the block it
 *   found had already closed. Five shapes passed all seven rules.
 */
import { describe, expect, it } from 'vitest';
import {
  checkSource,
  fiveHundredSites,
  parseUnion,
  vouchedFor,
} from '../../../scripts/lib/f8-error-id-rules';

const UNION = new Set(['F8.CYCLE_CANCEL', 'F8.ACCEPT_TIER']);
const DECL = "const ERROR_ID = 'F8.CYCLE_CANCEL';\n";

function check(body: string) {
  return checkSource(DECL + body, UNION).failures.map((f) => f.message);
}
const has500Finding = (body: string) =>
  check(body).some((m) => m.includes('no errorId'));

describe('F8 errorId gate — a 500 must be vouched for by an errorId in its own arm', () => {
  it('accepts the legitimate shape: emit then 500 in the same case arm', () => {
    expect(
      has500Finding(`
      switch (result.error.kind) {
        case 'server_error':
          logger.error({ errorId: \`\${ERROR_ID}.SERVER_ERROR\` }, 'm');
          return errorResponse({
            status: 500,
            code: 'server_error',
          });
      }`),
    ).toBe(false);
  });

  // Round 3, S3 — the shape that broke `lastIndexOf`. The 500 sits AFTER the
  // switch has closed; the textual window reached back into the closed arm and
  // let its logger.error vouch for a 500 it never saw.
  it('S3 — a 500 after the switch closes is NOT vouched for by an arm inside it', () => {
    expect(
      has500Finding(`
      if (!result.ok) {
        switch (result.error.kind) {
          case 'server_error':
            logger.error({ errorId: \`\${ERROR_ID}.SERVER_ERROR\` }, 'm');
            return errorResponse({ status: 500, code: 'server_error' });
        }
      }
      if (!result.value.invoiceId) {
        return errorResponse({
          status: 500,
          code: 'server_error',
        });
      }`),
    ).toBe(true);
  });

  // Round 3, S2 — a catch whose first branch logs and returns, and whose second
  // branch returns 500 bare. The completed `return` means the emit belongs to a
  // path that exited.
  it('S2 — an emit before a completed return does not vouch for a later 500', () => {
    expect(
      has500Finding(`
      } catch (e) {
        if (isKnown(e)) {
          logger.error({ errorId: \`\${ERROR_ID}.UNEXPECTED\` }, 'm');
          return errorResponse({ status: 502, code: 'x' });
        }
        return errorResponse({ status: 500, code: 'server_error' });
      }`),
    ).toBe(true);
  });

  // Round 3, S1 — `status: 500` written last in the object, so no comma.
  it('S1 — a 500 with no trailing comma is still a 500', () => {
    expect(fiveHundredSites("errorResponse({ code: 'e', status: 500 })").length).toBe(1);
    expect(
      has500Finding(`
      switch (k) {
        case 'server_error':
          return errorResponse({ code: 'server_error', status: 500 });
      }`),
    ).toBe(true);
  });

  // Round 3, S5 — the status comes from a named constant.
  it('S5 — a 500 behind a named constant is still a 500', () => {
    expect(
      fiveHundredSites('errorResponse({ status: HTTP_INTERNAL_SERVER_ERROR })').length,
    ).toBe(1);
    // and `status: 200` must not be swept up
    expect(fiveHundredSites('successResponse({ status: 200 })').length).toBe(0);
  });

  // Round 4 — the emit is at the same brace depth as the 500 but is GUARDED by
  // a brace-less `if`, so it does not run on the path that reaches the 500.
  // `if (cond) stmt;` appears ~235 times in `src/app/api/**/route.ts`, including
  // `if ('response' in ctx) return ctx.response;` in all 26 F8 routes, so this
  // is the house style rather than a contrived shape.
  it('R4 — a brace-less guarded emit does not vouch for the 500 after it', () => {
    expect(
      has500Finding(`
      } catch (e) {
        if (isKnown(e)) logger.error({ errorId: \`\${ERROR_ID}.UNEXPECTED\` }, 'm');
        return errorResponse({ status: 500, code: 'server_error' });
      }`),
    ).toBe(true);
  });

  it('R4 — a ternary-guarded emit does not vouch either', () => {
    expect(
      has500Finding(`
      } catch (e) {
        isKnown(e) ? logger.error({ errorId: \`\${ERROR_ID}.UNEXPECTED\` }, 'm') : noop();
        return errorResponse({ status: 500, code: 'server_error' });
      }`),
    ).toBe(true);
  });

  // Round 4 NON-BLOCKING set, promoted to tests because each one reds the build
  // on CORRECT code, which is worse than a miss: the walk was matching keywords
  // inside identifiers and reading braces inside string literals.
  it('R4 — an identifier containing "try"/"case" does not truncate the walk', () => {
    for (const decoy of ['const country = pick(e);', "const s = 'case closed';"]) {
      expect(
        has500Finding(`
      } catch (e) {
        logger.error({ errorId: \`\${ERROR_ID}.UNEXPECTED\` }, 'm');
        ${decoy}
        return errorResponse({ status: 500, code: 'server_error' });
      }`),
      ).toBe(false);
    }
  });

  it('R4 — a brace inside a string literal does not shift the depth', () => {
    expect(
      has500Finding(`
      } catch (e) {
        logger.error({ errorId: \`\${ERROR_ID}.UNEXPECTED\` }, 'm');
        const tpl = 'a } b';
        void tpl;
        return errorResponse({ status: 500, code: 'server_error' });
      }`),
    ).toBe(false);
  });

  it('vouchedFor is lexical, not textual: a nested logged block does not vouch', () => {
    const code = `
      { logger.error({ errorId: 'x' }, 'm'); }
      return errorResponse({ status: 500 });`;
    const at = fiveHundredSites(code)[0]!;
    expect(vouchedFor(code, at)).toBe(false);
  });
});

describe('F8 errorId gate — the rules the 500 rule does NOT subsume', () => {
  // Round 3, S6 — `return _exhaustive` produces NO `status: 500` token at all
  // (Next rejects the non-Response and 500s), so the 500 rule cannot see it.
  // A runbook sentence claimed the 500 rule subsumed this one; it does not.
  it('S6 — an exhaustiveness arm that returns is caught by its own rule', () => {
    const found = check(`
      default: {
        const _exhaustive: never = result.error;
        return _exhaustive;
      }`);
    expect(found.some((m) => m.includes('returns instead of throwing'))).toBe(true);
  });

  it('a hardcoded id is caught even when interpolated', () => {
    expect(
      check('logger.error({ errorId: `F8.ACCEPT_TIER.${suffix}` }, "m");').some((m) =>
        m.includes('hardcodes errorId'),
      ),
    ).toBe(true);
  });

  it('an errorId that is only in a comment does not satisfy the catch rule', () => {
    // `checkSource` receives comment-STRIPPED source, so the comment is gone by
    // the time any rule runs — this pins that contract at the seam.
    const found = check(`
      } catch (e) {
        logger.error({ correlationId }, 'm');
        return errorResponse({ status: 500 });
      }`);
    expect(found.some((m) => m.includes('carries no errorId'))).toBe(true);
  });

  it('every logger.error in a catch is checked, not just the first', () => {
    const found = check(`
      } catch (e) {
        logger.error({ errorId: \`\${ERROR_ID}.UNEXPECTED\` }, 'a');
        logger.error({ correlationId }, 'b');
        return errorResponse({ status: 500 });
      }`);
    expect(found.some((m) => m.includes('carries no errorId'))).toBe(true);
  });

  // Round 2 — a regex literal containing a quote made the block scan overrun
  // into the FOLLOWING catch, whose errorId then vouched for a block with none.
  it('a regex literal containing a quote does not let a block hide behind the next', () => {
    const found = check(`
      } catch {
        const s = raw.replace(/'/g, '');
        void s;
        return errorResponse({ status: 500 });
      } catch (e) {
        logger.error({ errorId: \`\${ERROR_ID}.UNEXPECTED\` }, 'm');
      }`);
    expect(found.some((m) => m.includes('logs nothing') || m.includes('no errorId'))).toBe(
      true,
    );
  });

  it('an id outside the union is rejected', () => {
    const found = checkSource("const ERROR_ID = 'F8.NOT_IN_UNION';\n", UNION).failures;
    expect(found.some((f) => f.message.includes('not a member'))).toBe(true);
  });

  // Found the moment this work landed on `main`: the gate declared itself
  // inert on a Windows checkout, because `core.autocrlf=true` ends the union
  // with `;\r\n` and the parser required `;\n`. CI could never have caught it —
  // Linux checks out LF — so it is pinned here on BOTH line endings.
  it('parses the union on CRLF as well as LF', () => {
    const src = (eol: string) =>
      ["export type F8ErrorId =", "  | 'F8.CYCLE_CANCEL'", "  | 'F8.ACCEPT_TIER';", ''].join(eol);
    expect(parseUnion(src('\n')).size).toBe(2);
    expect(parseUnion(src('\r\n')).size).toBe(2);
  });

  it('an unparseable union yields an empty set, so the gate can call itself inert', () => {
    // The guard that surfaced the CRLF bug depends on this returning empty
    // rather than throwing or guessing.
    expect(parseUnion('export type Something Else = never;\n').size).toBe(0);
  });

  it('a file declaring no ERROR_ID is rejected', () => {
    expect(checkSource('export async function POST() {}', UNION).declaredId).toBeNull();
  });
});
