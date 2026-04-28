/**
 * Regression contract for SURGICAL `revalidatePath` in the Stripe
 * webhook route — pinned to the canonical fix 2026-04-25 where the
 * original broad `[invoiceId]` pattern was replaced by per-invoice
 * specific paths derived from `outcome.invoiceId`. These tests fence
 * three contracts:
 *
 *   1. The webhook route imports `revalidatePath` from `next/cache`.
 *   2. The route calls `revalidatePath` BOTH with a specific
 *      `${invoiceId}` path (surgical, when outcome carries the id)
 *      AND with the dynamic `[invoiceId]` pattern (fallback, when
 *      outcome is shape-mismatched / missing the id).
 *   3. The `revalidatePath` block is wrapped in try/catch so a
 *      transient cache error cannot bubble out and 500 the webhook —
 *      that would force Stripe into a 24h retry loop on an already-
 *      processed event (markProcessed has already committed by then).
 *
 * Static-analysis assertions are used (not runtime mocks) because the
 * webhook handler chains many side effects (signature verify, tenant
 * resolve, dispatch, audit) that are painful to set up in a unit test
 * — and the contract we want to pin is fully expressible in the
 * source string.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROUTE_SOURCE_PATH = resolve(
  process.cwd(),
  'src/app/api/webhooks/stripe/route.ts',
);
const source = readFileSync(ROUTE_SOURCE_PATH, 'utf8');

describe('webhook surgical revalidatePath contract', () => {
  it('imports `revalidatePath` from `next/cache`', () => {
    expect(source).toMatch(
      /import\s+\{\s*revalidatePath\s*\}\s+from\s+['"]next\/cache['"]/,
    );
  });

  it('REGRESSION (2026-04-25): calls surgical `revalidatePath(`/portal/invoices/${invoiceId}`)` for known-invoice outcomes', () => {
    // The canonical fix replaces broad `[invoiceId]` busts with a
    // specific path derived from the use-case outcome's `invoiceId`.
    // Match either template-literal or string-concat form.
    expect(
      source,
      'expected `revalidatePath(`/portal/invoices/${...}`)` (template-literal form, surgical bust)',
    ).toMatch(
      /revalidatePath\(\s*`\/portal\/invoices\/\$\{[^}]+\}`\s*\)/,
    );
    expect(
      source,
      'expected `revalidatePath(`/admin/invoices/${...}`)` (admin variant, surgical bust)',
    ).toMatch(
      /revalidatePath\(\s*`\/admin\/invoices\/\$\{[^}]+\}`\s*\)/,
    );
  });

  it('falls back to the broad `[invoiceId]` pattern when outcome carries no invoiceId', () => {
    // The fallback exists for events that don't pivot on a single
    // invoice (e.g. dispute) OR outcomes like `unknown_intent`.
    expect(source).toMatch(
      /revalidatePath\(\s*['"]\/portal\/invoices\/\[invoiceId\]['"],\s*['"]page['"]\s*\)/,
    );
    expect(source).toMatch(
      /revalidatePath\(\s*['"]\/admin\/invoices\/\[invoiceId\]['"],\s*['"]page['"]\s*\)/,
    );
  });

  it('list-page revalidation is broad (always invalidate `/portal/invoices` + `/admin/invoices`)', () => {
    // List pages aggregate badges/totals and should always be busted
    // for any invoice mutation — surgical isn't meaningful here.
    expect(source).toMatch(
      /revalidatePath\(\s*['"]\/portal\/invoices['"],\s*['"]page['"]\s*\)/,
    );
    expect(source).toMatch(
      /revalidatePath\(\s*['"]\/admin\/invoices['"],\s*['"]page['"]\s*\)/,
    );
  });

  it('REGRESSION (2026-04-25): `revalidatePath` calls are wrapped in try/catch — never bubble to webhook 500', () => {
    // Without try/catch, a transient `revalidatePath` failure would
    // 500 the webhook → Stripe retries 24h → retry storm chasing an
    // already-committed (markProcessed) event.
    const tryRevalidateBlock = source.match(
      /try\s*\{\s*[\s\S]{0,2000}?revalidatePath[\s\S]{0,2000}?\}\s*catch/,
    );
    expect(
      tryRevalidateBlock,
      'expected `revalidatePath` calls inside a try/catch — see comment "best-effort … 24-hour retry loop"',
    ).toBeTruthy();
  });

  it('only fires revalidation for outcome-bearing event types (filters out api_version_mismatch, livemode_mismatch, etc.)', () => {
    // The condition gating revalidation must include `evType === 'payment_intent.succeeded'`
    // and similar mutating event types. Non-mutating events (signature
    // rejected, env mismatch, duplicate delivery) should not churn
    // caches.
    expect(source).toMatch(
      /evType\s*===\s*['"]payment_intent\.succeeded['"]/,
    );
    expect(source).toMatch(
      /evType\s*===\s*['"]payment_intent\.payment_failed['"]/,
    );
    expect(source).toMatch(/evType\s*===\s*['"]charge\.refunded['"]/);
  });
});
