/**
 * COMP-1 US2b — `f7BroadcastsDeliveryTombstoneAdapter` forwarding contract.
 *
 * The adapter is the F3↔F7 boundary for the GDPR Art. 17 / PDPA §33
 * broadcast-DELIVERY tombstone that runs INSIDE the caller's atomic
 * members-scrub tx (the 2026-06-18 2nd /code-review HIGH fix). Unlike the
 * post-commit content-scrub / cancel adapters, it forwards the CALLER'S tx
 * straight to the repo so the tombstone co-commits with `erased_at`, and it
 * is FAIL-LOUD — a throw propagates so the caller's atomic tx rolls back (no
 * try/catch, no swallow).
 *
 * These tests pin:
 *   (a) the repo built from the tenant slug + the caller's tx + emails
 *       forwarded verbatim, count returned;
 *   (b) a repo throw propagates (NOT swallowed) — the atomic-rollback signal;
 *   (c) the noop adapter returns 0 without invoking F7.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  tombstoneDeliveriesForMemberInTx,
  redactMemberEmailFromCustomRecipientsInTx,
  makeDrizzleBroadcastsRepo,
} = vi.hoisted(() => {
  const tombstone = vi.fn();
  const redactCustom = vi.fn();
  return {
    tombstoneDeliveriesForMemberInTx: tombstone,
    redactMemberEmailFromCustomRecipientsInTx: redactCustom,
    makeDrizzleBroadcastsRepo: vi.fn(() => ({
      tombstoneDeliveriesForMemberInTx: tombstone,
      redactMemberEmailFromCustomRecipientsInTx: redactCustom,
    })),
  };
});
vi.mock('@/modules/broadcasts', () => ({ makeDrizzleBroadcastsRepo }));

import {
  f7BroadcastsDeliveryTombstoneAdapter,
  noopBroadcastsDeliveryTombstoneAdapter,
} from '@/modules/members/infrastructure/adapters/broadcasts-delivery-tombstone-adapter';
import type { TenantTx } from '@/lib/db';
import { asTenantSlug } from '@/modules/tenants';

const fakeTx = { __fakeTx: true } as unknown as TenantTx;
// The port now takes a branded `TenantSlug` (the I2 type-design fix); brand the
// fixture slug so the adapter call type-checks.
const tenantSlug = asTenantSlug('test-tenant');
const emails = ['a@example.com', 'b@example.com'] as const;

describe('f7BroadcastsDeliveryTombstoneAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards the caller tx + tenant slug + emails to the repo and returns the count', async () => {
    tombstoneDeliveriesForMemberInTx.mockResolvedValueOnce({
      tombstonedCount: 4,
    });

    const result =
      await f7BroadcastsDeliveryTombstoneAdapter.tombstoneDeliveriesInTx(
        fakeTx,
        tenantSlug,
        emails,
      );

    expect(result.tombstonedCount).toBe(4);
    // Repo built from the tenant slug.
    expect(makeDrizzleBroadcastsRepo).toHaveBeenCalledWith(tenantSlug);
    // The CALLER'S tx is forwarded verbatim (co-commit with erased_at), with
    // the tenant slug + the live-contact email set. The slug flows through
    // un-rebranded (no `asTenantSlug` in the adapter anymore).
    expect(tombstoneDeliveriesForMemberInTx).toHaveBeenCalledWith(
      fakeTx,
      tenantSlug,
      emails,
    );
  });

  it('propagates a repo throw (FAIL-LOUD — the atomic-rollback signal, NOT swallowed)', async () => {
    tombstoneDeliveriesForMemberInTx.mockRejectedValueOnce(
      new Error('broadcast_deliveries_append_only raised'),
    );

    await expect(
      f7BroadcastsDeliveryTombstoneAdapter.tombstoneDeliveriesInTx(
        fakeTx,
        tenantSlug,
        emails,
      ),
    ).rejects.toThrow(/append_only/);
  });

  it('redactCustomRecipientEmailsInTx forwards the caller tx + tenant slug + emails to the repo and returns the count', async () => {
    redactMemberEmailFromCustomRecipientsInTx.mockResolvedValueOnce({
      redactedCount: 2,
    });

    const result =
      await f7BroadcastsDeliveryTombstoneAdapter.redactCustomRecipientEmailsInTx(
        fakeTx,
        tenantSlug,
        emails,
      );

    expect(result.redactedCount).toBe(2);
    expect(makeDrizzleBroadcastsRepo).toHaveBeenCalledWith(tenantSlug);
    // The CALLER'S tx is forwarded verbatim (co-commit with erased_at), with
    // the tenant slug + the live-contact email set.
    expect(redactMemberEmailFromCustomRecipientsInTx).toHaveBeenCalledWith(
      fakeTx,
      tenantSlug,
      emails,
    );
  });

  it('redactCustomRecipientEmailsInTx propagates a repo throw (FAIL-LOUD, NOT swallowed)', async () => {
    redactMemberEmailFromCustomRecipientsInTx.mockRejectedValueOnce(
      new Error('broadcast_redaction_only_pii_cols raised'),
    );

    await expect(
      f7BroadcastsDeliveryTombstoneAdapter.redactCustomRecipientEmailsInTx(
        fakeTx,
        tenantSlug,
        emails,
      ),
    ).rejects.toThrow(/redaction_only_pii_cols/);
  });
});

describe('noopBroadcastsDeliveryTombstoneAdapter', () => {
  it('returns tombstonedCount 0 without invoking F7', async () => {
    const result =
      await noopBroadcastsDeliveryTombstoneAdapter.tombstoneDeliveriesInTx(
        fakeTx,
        tenantSlug,
        emails,
      );
    expect(result.tombstonedCount).toBe(0);
    expect(makeDrizzleBroadcastsRepo).not.toHaveBeenCalled();
  });

  it('redactCustomRecipientEmailsInTx returns redactedCount 0 without invoking F7', async () => {
    const result =
      await noopBroadcastsDeliveryTombstoneAdapter.redactCustomRecipientEmailsInTx(
        fakeTx,
        tenantSlug,
        emails,
      );
    expect(result.redactedCount).toBe(0);
    expect(makeDrizzleBroadcastsRepo).not.toHaveBeenCalled();
  });
});
