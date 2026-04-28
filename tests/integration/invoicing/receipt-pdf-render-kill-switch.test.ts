/**
 * R2-IG-2 — kill-switch dispatcher filter integration test.
 *
 * Pins the contract that when `FEATURE_F5_ASYNC_RECEIPT_PDF=false`,
 * the outbox dispatcher's SELECT filter excludes
 * `notification_type='receipt_pdf_render'` rows. Without this filter,
 * flipping the kill-switch off in production would NOT actually stop
 * the worker — the dispatcher would keep invoking `renderReceiptPdf`
 * on rows that were enqueued before the flip.
 *
 * Pattern: `process.env` override + `vi.resetModules()` + dynamic
 * import (mirrors `feature-flag-kill-switch.test.ts` for F4 invoicing).
 * The env singleton is re-evaluated on import, so this is the only
 * way to flip the flag at test time.
 *
 * IMPORTANT — this test MUST be in its own file (not co-mounted with
 * receipt-pdf-render-dispatch.test.ts) because the global integration
 * setup forces FEATURE_F5_ASYNC_RECEIPT_PDF=true. Running both in the
 * same Vitest worker would race over module-cache state.
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

import { db } from '@/lib/db';
import { notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

describe('R2-IG-2 — receipt_pdf_render dispatcher kill-switch', () => {
  let tenant: TestTenant;
  let _user: TestUser;
  // Snapshot the original env value so we can restore in afterEach.
  const originalFlag = process.env['FEATURE_F5_ASYNC_RECEIPT_PDF'];

  beforeAll(async () => {
    _user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    // Restore the integration-setup default (true).
    if (originalFlag === undefined) {
      delete process.env['FEATURE_F5_ASYNC_RECEIPT_PDF'];
    } else {
      process.env['FEATURE_F5_ASYNC_RECEIPT_PDF'] = originalFlag;
    }
    vi.resetModules();
  });

  it('flag=false → dispatcher skips receipt_pdf_render rows (status stays pending, no attempts bump)', async () => {
    // Seed an outbox row BEFORE flipping the flag — simulates the
    // realistic scenario: rows enqueued under flag=true, operator
    // flips flag false, dispatcher must NOT process them.
    const id = randomUUID();
    const invoiceId = randomUUID();
    await db.insert(notificationsOutbox).values({
      id,
      tenantId: tenant.ctx.slug,
      notificationType: 'receipt_pdf_render',
      toEmail: 'system:kill-switch-test@swecham.test',
      locale: 'en',
      contextData: {
        invoice_id: invoiceId,
        fiscal_year: 2026,
        template_version: 1,
      },
      status: 'pending',
      attempts: 0,
      nextRetryAt: new Date(Date.now() - 1000),
    });

    // Flip flag → false + reset modules so env.ts re-validates.
    process.env['FEATURE_F5_ASYNC_RECEIPT_PDF'] = 'false';
    const { GET: outboxDispatchKilled } = await import(
      '@/app/api/cron/outbox-dispatch/route'
    );

    const req = new NextRequest('http://localhost/api/cron/outbox-dispatch', {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    const resp = await outboxDispatchKilled(req);
    expect(resp.status).toBe(200);

    const [row] = await db
      .select()
      .from(notificationsOutbox)
      .where(eq(notificationsOutbox.id, id))
      .limit(1);

    // Row MUST be untouched — kill-switch filter excluded it from
    // the candidate SELECT entirely.
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(0);

    // Cleanup so subsequent tests aren't polluted.
    await db
      .delete(notificationsOutbox)
      .where(
        and(
          eq(notificationsOutbox.tenantId, tenant.ctx.slug),
          eq(notificationsOutbox.id, id),
        ),
      );
  }, 60_000);
});
