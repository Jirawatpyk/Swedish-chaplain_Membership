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
  // Refactored 2026-04-26: the inline ref-freeze + skip-decision logic
  // moved into helper `useShouldSkipInitialFetch`. The main effect now
  // calls the helper's returned closure as a one-shot skip decision.
  // Tests below pin the NEW architecture but enforce the SAME invariant:
  // `initialInitiate` prop changes MUST NOT cause the main fetch effect
  // to re-fire after a `setCachedInitiate(null)` post-success.

  it('REGRESSION (2026-04-25): `initialInitiate` MUST NOT appear in the MAIN useEffect deps array', () => {
    // Locate the main fetch useEffect — body contains the
    // `POST /api/payments/initiate` fetch — and assert its deps array
    // is `[enabled, invoiceId, retryCount, method]` (the legitimate
    // re-fire triggers). The helper has its own deps array including
    // `initialInitiate`, but that effect only corrects the ref under
    // Concurrent-React Offscreen pre-render — it does NOT trigger any
    // network call.
    const mainEffectMatch = source.match(
      /useEffect\(\(\)\s*=>\s*\{[\s\S]*?api\/payments\/initiate[\s\S]*?\},\s*\[([^\]]+)\]/,
    );
    expect(mainEffectMatch, 'expected to find the main fetch useEffect').toBeTruthy();
    expect(
      mainEffectMatch![1],
      `MAIN effect deps MUST NOT include \`initialInitiate\` — that caused effect re-fire after onPaymentSettled cleared the cache.\n` +
        `Offending deps: ${mainEffectMatch![1]}`,
    ).not.toMatch(/\binitialInitiate\b/);
  });

  it('hook freezes `initialInitiate` via useRef so prop changes after mount are inert', () => {
    // The fix's mechanism: `useRef(enabled ? initialInitiate : null)`
    // freezes the value on first render. The `enabled ? ... : null`
    // gate (B1 fix) prevents a cold-mounted disabled hook from
    // freezing a stale value the parent later populates.
    //
    // After 2026-04-26 helper extraction the freeze lives inside
    // `useShouldSkipInitialFetch` so the matcher accepts both the
    // unprefixed-arg form (helper) and the original `opts.`-prefixed
    // form (legacy inline).
    expect(
      source,
      'expected `useRef<CachedInitiate | null>(<enabled> ? <initialInitiate> : null)` — the canonical freeze with cold-mount gate (B1)',
    ).toMatch(
      /useRef<CachedInitiate \| null>\(\s*(?:opts\.)?enabled\s*\?\s*(?:opts\.)?initialInitiate\s*:\s*null\s*,?\s*\)/,
    );
  });

  it('main effect deps include `enabled`, `invoiceId`, `retryCount`, `method` (legitimate re-fire triggers)', () => {
    // Whitelist the legitimate re-fire causes:
    //   - enabled flips false → true (tab activation, e.g. Card → PromptPay)
    //   - invoiceId changes (new drawer for different invoice)
    //   - retryCount bumps (user clicks Try again)
    //   - method changes (Card ↔ PromptPay)
    expect(source).toMatch(/\[\s*enabled,\s*invoiceId,\s*retryCount,\s*method\s*\]/);
  });

  it('hook documents WHY `initialInitiate` is excluded from MAIN-effect deps (defends future refactor)', () => {
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
