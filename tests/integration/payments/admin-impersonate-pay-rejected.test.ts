/**
 * T137 — Admin pay-on-behalf-of-member rejected (FR-018, R2-E6 amendment).
 *
 * Spec authority: spec.md FR-018 + plan.md § Constitution Check § Principle I.
 * Per the R2-E6 critique amendment: members pay their own invoices; admin
 * cannot POST `/api/payments/initiate`. The route MUST return 403 because:
 *   (a) Members own the payment-method-of-record (card / PromptPay) — the
 *       admin cannot legitimately tokenise a member's card via Stripe Elements
 *       (SAQ-A scope: card details never touch the app server).
 *   (b) Admin-impersonate-pay would create an audit-trail ambiguity around
 *       "who actually authorised this transaction" — surfaced as a
 *       Constitution Principle I issue (audit-trail integrity).
 *
 * F5 enforces this at the route layer via `requireMemberContext`, which
 * returns a 403 rejection for any session whose user role is not `member`.
 *
 * Asserts (lean — full E2E coverage in `tests/e2e/payment-tenant-isolation.spec.ts`
 * and similar):
 *
 *   (a) Source-code invariant: `requireMemberContext` rejects non-member
 *       sessions with status 403. This is a static-analysis check on the
 *       helper file that backs every member-only F5 route.
 *
 *   (b) The F5 initiate route imports `requireMemberContext` (the role guard)
 *       — i.e. the route is wired to enforce RBAC, not bypass it.
 *
 * Mocking policy: NONE — pure file-system inspection. The route-level 403
 * response is exercised by the mock-based contract test at
 * `tests/contract/payments/post-payments-initiate.contract.test.ts` and by
 * E2E. THIS file is the cheapest possible regression guard against a refactor
 * that silently drops the role check.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const cwd = process.cwd();

describe('T137 admin POST /api/payments/initiate is rejected (FR-018 R2-E6)', () => {
  it('(a) requireMemberContext rejects non-member roles with 403', () => {
    const path = join(cwd, 'src/lib/member-context.ts');
    expect(existsSync(path), 'src/lib/member-context.ts must exist').toBe(true);
    const src = readFileSync(path, 'utf-8');

    // The role check pattern. We tolerate both string-equality and
    // negation styles (`role !== 'member'`, `role === 'admin' || role === 'manager'`)
    // by accepting any pattern that mentions both `role` and `'member'` in
    // proximity inside an `if (...)` or ternary, AND that returns a 403.
    expect(
      src,
      'requireMemberContext must check the session role against "member"',
    ).toMatch(/role\s*!==?\s*['"]member['"]/);
    expect(
      src,
      'requireMemberContext must return status 403 on role rejection',
    ).toMatch(/status:\s*403/);
  });

  it('(b) /api/payments/initiate route imports requireMemberContext', () => {
    const path = join(cwd, 'src/app/api/payments/initiate/route.ts');
    expect(existsSync(path), 'route.ts must exist').toBe(true);
    const src = readFileSync(path, 'utf-8');

    // The route MUST import + call requireMemberContext. Any refactor
    // that drops this import (e.g. inline auth check that forgets the
    // role gate) silently re-opens FR-018 R2-E6.
    expect(src, 'route must import requireMemberContext').toMatch(
      /from\s+['"]@\/lib\/member-context['"]/,
    );
    expect(src, 'route must call requireMemberContext').toMatch(
      /requireMemberContext\s*\(/,
    );
  });

  it('(b) /api/payments/initiate route handles forbidden_role explicitly', () => {
    const path = join(cwd, 'src/app/api/payments/initiate/route.ts');
    const src = readFileSync(path, 'utf-8');

    // Belt-and-suspenders: the route ALSO catches the test-mock-style
    // throw with `code: 'forbidden_role'` and translates to 403. This
    // ensures both production-path (rejection-object) and contract-test-
    // path (thrown error) end up at the same 403 response.
    expect(src).toMatch(/['"]forbidden_role['"]/);
    expect(src).toMatch(/errorResponse\s*\(\s*403/);
  });
});
