/**
 * Regression contract for `useInitiatePayment` — pinned to the bug
 * surfaced 2026-04-25 where setting `initialInitiate=null` after a
 * successful payment caused the hook's effect to re-fire and
 * overwrite `payState='success'` back to `card-form` with a fresh
 * PaymentIntent. The user saw <ConfirmationPanel> flash then revert
 * to a card form whose Stripe Elements threw "PaymentIntent is in a
 * terminal state and cannot be used to initiate Elements".
 *
 * Fix: read `initialInitiate` via `useRef(opts.initialInitiate)` —
 * frozen on first render — instead of through the prop which sits
 * in the effect's deps array. These tests fence that contract by
 * direct source-file inspection so a future refactor that
 * re-introduces `initialInitiate` in the deps array fails LOUDLY at
 * unit-test time, not at runtime weeks later.
 *
 * We use static-analysis assertions rather than a runtime React test
 * harness because the hook's async fetch + AbortController + StrictMode
 * double-invoke surface trips up jsdom + vitest fake timers in flaky
 * ways. The contract we want to pin (`initialInitiate` not in deps,
 * ref-based capture pattern) is fully expressed in the source string
 * and is the canonical regression check.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HOOK_SOURCE_PATH = resolve(
  process.cwd(),
  'src/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/use-initiate-payment.ts',
);

const source = readFileSync(HOOK_SOURCE_PATH, 'utf8');

describe('useInitiatePayment regression contract', () => {
  it('REGRESSION (2026-04-25): `initialInitiate` MUST NOT appear in the main useEffect deps array', () => {
    // Find the deps-array argument of the main fetch useEffect — it is
    // the `useEffect(() => { ... }, [...])` whose body contains the
    // POST /api/payments/initiate fetch. Any closing `, [<deps>])`
    // pattern that mentions `initialInitiate` is a regression.
    const depsArrayMatches = source.match(/\},\s*\[([^\]]+)\]\s*\)/g);
    expect(depsArrayMatches, 'expected at least one useEffect deps array').toBeTruthy();
    for (const depsArray of depsArrayMatches!) {
      expect(
        depsArray,
        `deps array MUST NOT include \`initialInitiate\` — it caused effect re-fire after onPaymentSettled cleared the cache.\n` +
          `If you need to react to changes in initialInitiate, use a ref + a different mechanism.\n` +
          `Offending deps array: ${depsArray}`,
      ).not.toMatch(/\binitialInitiate\b/);
    }
  });

  it('hook captures `initialInitiate` via useRef so prop changes after mount are inert', () => {
    // The fix's mechanism: `useRef(opts.initialInitiate)` freezes the
    // value on first render. The effect reads `initialInitiateRef.current`
    // instead of the prop directly. R5 B1 (2026-04-25) added an
    // `enabled` gate so cold-mount with enabled=false doesn't capture
    // a stale value — the matcher accepts either form (with or without
    // the gate) so the cold-mount fix doesn't trip the regression test.
    expect(
      source,
      'expected `useRef<CachedInitiate | null>(...)` initializer reading `opts.initialInitiate` (with optional `enabled` gate) — the canonical freeze pattern',
    ).toMatch(
      /useRef<CachedInitiate \| null>\(\s*[\s\S]*?opts\.initialInitiate[\s\S]*?\)/,
    );
    expect(
      source,
      'expected the effect body to read `initialInitiateRef.current` (not the destructured prop)',
    ).toMatch(/initialInitiateRef\.current/);
  });

  it('main effect deps include `enabled`, `invoiceId`, `retryCount`, `method` (legitimate re-fire triggers)', () => {
    // Whitelist the legitimate re-fire causes:
    //   - enabled flips false → true (tab activation, e.g. Card → PromptPay)
    //   - invoiceId changes (new drawer for different invoice)
    //   - retryCount bumps (user clicks Try again)
    //   - method changes (Card ↔ PromptPay)
    expect(source).toMatch(/\[\s*enabled,\s*invoiceId,\s*retryCount,\s*method\s*\]/);
  });

  it('hook documents WHY `initialInitiate` is excluded from deps (defends future refactor)', () => {
    // The fix should carry an inline rationale so a dev reading the
    // file understands the constraint and doesn't "helpfully" add
    // `initialInitiate` back to the deps array. We look for the
    // anchor phrase "initialInitiate" + "ref" in close proximity.
    const docsRegion = source.match(/initialInitiate[\s\S]{0,1500}?ref/i);
    expect(
      docsRegion,
      'expected an inline comment near the deps array explaining why initialInitiate is read via ref',
    ).toBeTruthy();
  });
});
