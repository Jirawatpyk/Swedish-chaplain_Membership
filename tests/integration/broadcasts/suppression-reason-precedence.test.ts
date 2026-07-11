/**
 * Bug #11 (2026-07-10) — the `marketing_unsubscribes` idempotent upsert must
 * NEVER downgrade a stronger suppression classification. Previously the
 * `ON CONFLICT DO UPDATE SET reason = EXCLUDED.reason, reason_text =
 * EXCLUDED.reason_text` overwrote a prior `complaint` / `hard_bounce` with a
 * later `recipient_initiated` self-unsubscribe (and NULLed its reason_text),
 * silently losing the compliance/deliverability classification.
 *
 * Live DB (real ON CONFLICT semantics can only be verified against Postgres).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { runInTenant } from '@/lib/db';
import { marketingUnsubscribes } from '@/modules/broadcasts/infrastructure/schema';
import { makeDrizzleMarketingUnsubscribesRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-marketing-unsubscribes-repo';
import { unsafeBrandEmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

describe('marketing_unsubscribes upsert — bug #11 reason precedence (no downgrade)', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
  });

  afterAll(async () => {
    if (tenant) await tenant.cleanup();
  });

  async function readRow(email: string) {
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(marketingUnsubscribes)
        .where(
          and(
            eq(marketingUnsubscribes.tenantId, tenant.ctx.slug),
            eq(marketingUnsubscribes.emailLower, email),
          ),
        ),
    );
    return rows[0];
  }

  it('a later recipient_initiated does NOT downgrade a prior complaint (keeps reason + reason_text)', async () => {
    const repo = makeDrizzleMarketingUnsubscribesRepo(tenant.ctx.slug);
    const email = unsafeBrandEmailLower(`p11a-${randomUUID().slice(0, 8)}@example.com`);

    // 1) Spam complaint records a strong suppression with diagnostic text.
    const first = await runInTenant(tenant.ctx, (tx) =>
      repo.upsert(tx, {
        tenantId: tenant.ctx.slug,
        emailLower: email,
        memberId: null,
        reason: 'complaint',
        reasonText: 'spam report',
        sourceBroadcastId: null,
        sourceTokenHash: null,
      }),
    );
    expect(first.wasNew).toBe(true);

    // 2) Recipient later clicks the (weaker) self-unsubscribe link.
    const second = await runInTenant(tenant.ctx, (tx) =>
      repo.upsert(tx, {
        tenantId: tenant.ctx.slug,
        emailLower: email,
        memberId: null,
        reason: 'recipient_initiated',
        reasonText: null,
        sourceBroadcastId: null,
        sourceTokenHash: null,
      }),
    );
    expect(second.wasNew).toBe(false);

    const row = await readRow(email);
    expect(row!.reason).toBe('complaint'); // NOT downgraded
    expect(row!.reasonText).toBe('spam report'); // NOT nulled
  });

  it('a stronger complaint DOES upgrade a prior recipient_initiated (+ takes its reason_text)', async () => {
    const repo = makeDrizzleMarketingUnsubscribesRepo(tenant.ctx.slug);
    const email = unsafeBrandEmailLower(`p11b-${randomUUID().slice(0, 8)}@example.com`);

    await runInTenant(tenant.ctx, (tx) =>
      repo.upsert(tx, {
        tenantId: tenant.ctx.slug,
        emailLower: email,
        memberId: null,
        reason: 'recipient_initiated',
        reasonText: null,
        sourceBroadcastId: null,
        sourceTokenHash: null,
      }),
    );
    await runInTenant(tenant.ctx, (tx) =>
      repo.upsert(tx, {
        tenantId: tenant.ctx.slug,
        emailLower: email,
        memberId: null,
        reason: 'complaint',
        reasonText: 'abuse@complaint',
        sourceBroadcastId: null,
        sourceTokenHash: null,
      }),
    );

    const row = await readRow(email);
    expect(row!.reason).toBe('complaint'); // upgraded
    expect(row!.reasonText).toBe('abuse@complaint');
  });

  it('bug #10: upsertStandalone opens its own tenant tx and inserts (batch webhook path)', async () => {
    const repo = makeDrizzleMarketingUnsubscribesRepo(tenant.ctx.slug);
    const email = unsafeBrandEmailLower(`p10-${randomUUID().slice(0, 8)}@example.com`);

    const r = await repo.upsertStandalone!({
      tenantId: tenant.ctx.slug,
      emailLower: email,
      memberId: null,
      reason: 'complaint',
      reasonText: 'batch complaint',
      sourceBroadcastId: null,
      sourceTokenHash: null,
    });
    expect(r.wasNew).toBe(true);

    const row = await readRow(email);
    expect(row!.reason).toBe('complaint');
    expect(row!.reasonText).toBe('batch complaint');
  });

  it('a strict UPGRADE takes the new reason_text (even NULL) — never keeps the weaker reason label’s diagnostic', async () => {
    const repo = makeDrizzleMarketingUnsubscribesRepo(tenant.ctx.slug);
    const email = unsafeBrandEmailLower(`p11d-${randomUUID().slice(0, 8)}@example.com`);

    // 1) hard bounce with an SMTP diagnostic.
    await runInTenant(tenant.ctx, (tx) =>
      repo.upsert(tx, {
        tenantId: tenant.ctx.slug,
        emailLower: email,
        memberId: null,
        reason: 'hard_bounce',
        reasonText: 'mailbox full',
        sourceBroadcastId: null,
        sourceTokenHash: null,
      }),
    );
    // 2) later spam complaint (STRONGER) with NO errorMessage (common for ARF).
    await runInTenant(tenant.ctx, (tx) =>
      repo.upsert(tx, {
        tenantId: tenant.ctx.slug,
        emailLower: email,
        memberId: null,
        reason: 'complaint',
        reasonText: null,
        sourceBroadcastId: null,
        sourceTokenHash: null,
      }),
    );

    const row = await readRow(email);
    expect(row!.reason).toBe('complaint'); // upgraded
    // Must NOT be 'mailbox full' — a spam-complaint row annotated with a
    // bounce diagnostic would corrupt the compliance forensic record.
    expect(row!.reasonText).toBeNull();
  });

  it('equal-strength replay keeps a prior non-null reason_text when the new event carries none', async () => {
    const repo = makeDrizzleMarketingUnsubscribesRepo(tenant.ctx.slug);
    const email = unsafeBrandEmailLower(`p11c-${randomUUID().slice(0, 8)}@example.com`);

    await runInTenant(tenant.ctx, (tx) =>
      repo.upsert(tx, {
        tenantId: tenant.ctx.slug,
        emailLower: email,
        memberId: null,
        reason: 'hard_bounce',
        reasonText: 'mailbox full',
        sourceBroadcastId: null,
        sourceTokenHash: null,
      }),
    );
    await runInTenant(tenant.ctx, (tx) =>
      repo.upsert(tx, {
        tenantId: tenant.ctx.slug,
        emailLower: email,
        memberId: null,
        reason: 'hard_bounce',
        reasonText: null,
        sourceBroadcastId: null,
        sourceTokenHash: null,
      }),
    );

    const row = await readRow(email);
    expect(row!.reason).toBe('hard_bounce');
    expect(row!.reasonText).toBe('mailbox full'); // COALESCE preserved it
  });
});
