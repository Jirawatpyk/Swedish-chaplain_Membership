/**
 * #58 / #724 review — the issue and pay routes keep the platform's default run
 * limit (Fluid compute, 300 s): a lower `maxDuration` would make a kill inside
 * the transaction likelier, which can strand a receipt PDF at its key. The
 * dialogs' client timeout gives up well before that; going past it shows the
 * honest "can't tell — refresh to check", whatever the server is still doing.
 */
import { describe, expect, it } from 'vitest';
import { MONEY_POST_TIMEOUT_MS } from '@/app/(staff)/admin/invoices/_components/unknown-outcome';

describe('contract: money route run limit (#58)', () => {
  it('issue and pay set no maxDuration of their own; the client timeout is under the 300 s default', async () => {
    const issue = (await import('@/app/api/invoices/[invoiceId]/issue/route')) as { maxDuration?: number };
    const pay = (await import('@/app/api/invoices/[invoiceId]/pay/route')) as { maxDuration?: number };
    expect(issue.maxDuration).toBeUndefined();
    expect(pay.maxDuration).toBeUndefined();
    expect(MONEY_POST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(MONEY_POST_TIMEOUT_MS).toBeLessThan(300_000);
  }, 60_000);
});
