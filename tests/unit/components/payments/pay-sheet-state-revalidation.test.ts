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

  it('H1 (R5 round-7 2026-04-26): EXACTLY ONE call-site `router.refresh()` — multi-fire dropped session, optimistic UI handles user flip', () => {
    // R5 round-7: switched to optimistic UI overlay
    // (dispatchInvoicePaid + <OptimisticPaidOverlay>). The
    // page-perceived UX flip happens INSTANTLY without any RSC
    // re-fetch. `router.refresh()` is now ONLY a single
    // belt-and-braces RSC call to catch up the server-rendered
    // surface. Multi-fire dropped session at every spacing tried
    // (1.2s × 6, 2-2.5s × 2, 2-5s × 3, 3-4s × 4, 3-7-11s × 4).
    const callSiteLines = indexSource.split('\n').filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('* ') || trimmed.startsWith('*//')) return false;
      return /router\.refresh\(\)\s*;/.test(line);
    });
    expect(callSiteLines.length).toBe(1);
  });

  it('H1 (R5 round-7): settled effect contains NO setInterval AND NO setTimeout', () => {
    // Polling caused session drops at every spacing tried. The
    // settled effect must be a single synchronous fire — no
    // deferred / repeating timers.
    const settledEffectMatch = indexSource.match(
      /useEffect\(\(\)\s*=>\s*\{[\s\S]{0,4000}?paymentSettled[\s\S]{0,4000}?\},\s*\[paymentSettled,\s*router,\s*invoice\.id,\s*tToast\]/,
    );
    expect(settledEffectMatch, 'expected settled effect block').toBeTruthy();
    expect(settledEffectMatch![0]).not.toMatch(/setInterval\s*\(/);
    expect(settledEffectMatch![0]).not.toMatch(/setTimeout\s*\(/);
  });

  it('H1 (R5 round-7): settled effect calls `dispatchInvoicePaid` to drive the optimistic UI overlay', () => {
    const settledEffectMatch = indexSource.match(
      /useEffect\(\(\)\s*=>\s*\{[\s\S]{0,4000}?paymentSettled[\s\S]{0,4000}?\},\s*\[paymentSettled,\s*router,\s*invoice\.id,\s*tToast\]/,
    );
    expect(settledEffectMatch).toBeTruthy();
    expect(settledEffectMatch![0]).toMatch(/dispatchInvoicePaid\(/);
  });

  // ---- H2: refreshFiredRef latch -------------------------------------------

  it('H2 (R5 round-7): single settled-effect latch (`refreshFiredRef`) — close-handler refresh removed in favour of optimistic UI', () => {
    // R5 round-7: removed the close-handler refresh entirely
    // (it was redundant with the optimistic UI overlay). The
    // remaining latch (`refreshFiredRef`) prevents the settled
    // effect from re-firing on React StrictMode double-mount.
    const settledLatch = indexSource.match(
      /refreshFiredRef\.current\s*=\s*true/g,
    );
    expect(settledLatch, 'expected settled-effect latch').toBeTruthy();
    // closeRefreshFiredRef must NOT exist — its reintroduction
    // would mean someone added back the redundant close-handler
    // refresh that the optimistic UI made unnecessary.
    expect(indexSource).not.toMatch(/closeRefreshFiredRef/);
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
