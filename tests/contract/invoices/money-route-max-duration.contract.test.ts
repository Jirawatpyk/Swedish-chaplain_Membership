/**
 * #58 — the issue and pay routes declare their own maxDuration, and the
 * dialogs' client timeout (MONEY_POST_TIMEOUT_MS) outlasts it, so a POST the
 * server still runs is never abandoned by the browser first.
 */
import { describe, expect, it } from 'vitest';
import { MONEY_POST_TIMEOUT_MS } from '@/app/(staff)/admin/invoices/_components/unknown-outcome';

describe('contract: money route maxDuration (#58)', () => {
  it('issue and pay declare 60 s, below the client timeout', async () => {
    const issue = (await import('@/app/api/invoices/[invoiceId]/issue/route')) as { maxDuration?: number };
    const pay = (await import('@/app/api/invoices/[invoiceId]/pay/route')) as { maxDuration?: number };
    expect(issue.maxDuration).toBe(60);
    expect(pay.maxDuration).toBe(60);
    expect(MONEY_POST_TIMEOUT_MS).toBeGreaterThan(60_000);
  }, 60_000);
});
