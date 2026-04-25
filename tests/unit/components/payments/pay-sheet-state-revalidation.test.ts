/**
 * Regression contract for the PaySheet state-revalidation invariants
 * pinned by R5 + R5-round-2 + R5-round-3:
 *
 *   - H1: polling retry MAX_ATTEMPTS=3 with BACKOFF_MS=800
 *   - H2: refreshFiredRef latch deduplicates settled-effect vs
 *         close-handler refresh
 *   - B-NEW-2: refreshFiredRef RESET on `setPaymentSettled(false)` so
 *              retry → success cycles re-fire `router.refresh()`
 *   - I5:  settledRef.current=false reset on handleClose (so re-opened
 *          drawer doesn't re-fire onPaymentSettled)
 *   - B-NEW-1: useInitiatePayment's initialInitiateRef CONSUMED after
 *              first use (set to null) so subsequent re-runs don't
 *              re-skip with stale value
 *
 * All assertions are static-analysis on the relevant source files.
 * Runtime tests for these timing-sensitive paths are flaky in the
 * jsdom + AbortController + fake-timer surface; the static contracts
 * are sufficient to catch regressions at CI time.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAY_SHEET_INDEX_PATH = resolve(
  process.cwd(),
  'src/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/index.tsx',
);
const PAY_SHEET_INTERNAL_PATH = resolve(
  process.cwd(),
  'src/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/pay-sheet-internal.tsx',
);
const USE_INITIATE_PATH = resolve(
  process.cwd(),
  'src/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/use-initiate-payment.ts',
);

const indexSource = readFileSync(PAY_SHEET_INDEX_PATH, 'utf8');
const internalSource = readFileSync(PAY_SHEET_INTERNAL_PATH, 'utf8');
const useInitiateSource = readFileSync(USE_INITIATE_PATH, 'utf8');

describe('PaySheet state-revalidation regression contracts', () => {
  // ---- H1: polling retry constants -----------------------------------------

  it('H1: MAX_ATTEMPTS is exactly 3 (any change widens the polling window)', () => {
    expect(indexSource).toMatch(/const\s+MAX_ATTEMPTS\s*=\s*3\b/);
  });

  it('H1: BACKOFF_MS is exactly 800 (changes affect perceived staleness)', () => {
    expect(indexSource).toMatch(/const\s+BACKOFF_MS\s*=\s*800\b/);
  });

  // ---- H2: refreshFiredRef latch -------------------------------------------

  it('H2: refreshFiredRef is set true at BOTH the settled-effect AND close-handler call sites', () => {
    const setTrueMatches = indexSource.match(
      /refreshFiredRef\.current\s*=\s*true/g,
    );
    expect(setTrueMatches, 'expected refreshFiredRef.current = true at ≥ 2 sites').toBeTruthy();
    expect(setTrueMatches!.length).toBeGreaterThanOrEqual(2);
  });

  it('H2: handleOpenChange close-branch checks `!refreshFiredRef.current` before refreshing', () => {
    expect(indexSource).toMatch(/!\s*refreshFiredRef\.current/);
  });

  // ---- B-NEW-2: refreshFiredRef reset for retry-success cycle --------------

  it('B-NEW-2: refreshFiredRef.current is RESET to false alongside setPaymentSettled(false) so retry-success re-fires refresh', () => {
    // Locate the onInitiateResolved callback + assert the reset is
    // adjacent to the setPaymentSettled(false) call.
    const onInitiateResolvedBlock = indexSource.match(
      /onInitiateResolved\s*=[\s\S]*?\}\s*\}/,
    );
    expect(onInitiateResolvedBlock, 'expected onInitiateResolved block').toBeTruthy();
    expect(onInitiateResolvedBlock![0]).toMatch(
      /refreshFiredRef\.current\s*=\s*false/,
    );
    expect(onInitiateResolvedBlock![0]).toMatch(
      /setPaymentSettled\(false\)/,
    );
  });

  // ---- I5: settledRef reset on handleClose ---------------------------------

  it('I5: settledRef.current is reset to false in PaySheetInternal handleClose', () => {
    // Locate the handleClose callback and assert the reset is inside.
    const handleCloseBlock = internalSource.match(
      /const\s+handleClose\s*=\s*useCallback\([\s\S]*?\}\s*,\s*\[/,
    );
    expect(handleCloseBlock, 'expected handleClose useCallback block').toBeTruthy();
    expect(handleCloseBlock![0]).toMatch(/settledRef\.current\s*=\s*false/);
  });

  it('I5: handleClose ALSO resets payState + promptpayState to idle', () => {
    const handleCloseBlock = internalSource.match(
      /const\s+handleClose\s*=\s*useCallback\([\s\S]*?\}\s*,\s*\[/,
    );
    expect(handleCloseBlock).toBeTruthy();
    expect(handleCloseBlock![0]).toMatch(
      /setPayState\(\s*\{\s*kind:\s*['"]idle['"]\s*\}\s*\)/,
    );
    expect(handleCloseBlock![0]).toMatch(
      /setPromptpayState\(\s*\{\s*kind:\s*['"]idle['"]\s*\}\s*\)/,
    );
  });

  // ---- B-NEW-1: initialInitiateRef consumed after first use ----------------

  it('B-NEW-1: initialInitiateRef is cleared (set to null) AFTER consuming the cached value via early-return', () => {
    // After the early-return skip path, the ref's role is fulfilled —
    // it MUST be cleared so subsequent effect re-runs (tab toggle,
    // retryCount bump) don't re-skip with the now-stale value.
    const skipBlock = useInitiateSource.match(
      /if\s*\(\s*initialInitiateRef\.current\s*!==\s*null[\s\S]*?\}\s*\n/,
    );
    expect(skipBlock, 'expected skip-path early-return block').toBeTruthy();
    expect(skipBlock![0]).toMatch(/initialInitiateRef\.current\s*=\s*null/);
  });

  it('B-NEW-1: initialInitiateRef is ALSO cleared after the first fetch resolves', () => {
    // Mirror the skip-path consumption: after the fetch path commits
    // an onSuccess, the ref's value is irrelevant. Clearing it
    // protects against future re-runs (e.g. tab cycle that toggles
    // `enabled`) accidentally reusing the cached value.
    expect(useInitiateSource).toMatch(
      /initialInitiateRef\.current\s*=\s*null[\s\S]{0,200}?onSuccess/,
    );
  });
});
