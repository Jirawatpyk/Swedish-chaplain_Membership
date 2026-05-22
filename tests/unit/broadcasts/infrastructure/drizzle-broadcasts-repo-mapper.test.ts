/**
 * R6.3 H-5 — direct unit test for `deriveTemplateProvenance` mapper
 * helper.
 *
 * R5 Final 2 senior-tester flagged the Drizzle mapper's XOR /
 * half-populated branch had zero unit coverage. R4.3 H-3 obs added a
 * `logger.error` when EXACTLY ONE of `startedFromTemplateId` /
 * `templateNameSnapshot` is non-null, but the branch was only
 * exercised indirectly via integration tests against a clean schema
 * (which never produces a corrupt row in practice).
 *
 * This test mocks `logger.error` and constructs synthetic `BroadcastRow`
 * shapes to verify all 4 cases of the XOR invariant:
 *   (a) both null      → return null, NO log
 *   (b) both populated → return DU, NO log
 *   (c) id-only        → return null, logger.error fires
 *   (d) name-only      → return null, logger.error fires
 */
import { describe, expect, expectTypeOf, it, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '@/lib/logger';
import {
  deriveTemplateProvenance,
  rowToBroadcast,
} from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import type { BroadcastRow } from '@/modules/broadcasts/infrastructure/schema';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';

const BASE_ROW: BroadcastRow = {
  broadcastId: '11111111-1111-1111-1111-111111111111',
  tenantId: 'tenant-test',
  startedFromTemplateId: null,
  templateNameSnapshot: null,
} as unknown as BroadcastRow;

describe('deriveTemplateProvenance — R6.3 H-5 XOR mapper', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('both columns NULL → returns null, NO log (blank-canvas path)', () => {
    const out = deriveTemplateProvenance(BASE_ROW);
    expect(out).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('both columns POPULATED → returns DU, NO log (snapshot path)', () => {
    const out = deriveTemplateProvenance({
      ...BASE_ROW,
      startedFromTemplateId: 'tpl-abc-123',
      templateNameSnapshot: 'Monthly Newsletter',
    } as BroadcastRow);
    expect(out).toEqual({
      templateId: 'tpl-abc-123',
      templateNameSnapshot: 'Monthly Newsletter',
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('ID-only populated (templateNameSnapshot null) → returns null, logger.error fires', () => {
    const out = deriveTemplateProvenance({
      ...BASE_ROW,
      startedFromTemplateId: 'tpl-orphan-id',
      templateNameSnapshot: null,
    } as BroadcastRow);
    // Safer to return null than half-truth; SIEM correlates via the
    // error log + broadcastId.
    expect(out).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        broadcastId: BASE_ROW.broadcastId,
        tenantId: BASE_ROW.tenantId,
        hasStartedFromTemplateId: true,
        hasTemplateNameSnapshot: false,
      }),
      'broadcasts.mapper.template_provenance_half_populated',
    );
  });

  it('NAME-only populated (startedFromTemplateId null) → returns null, logger.error fires', () => {
    const out = deriveTemplateProvenance({
      ...BASE_ROW,
      startedFromTemplateId: null,
      templateNameSnapshot: 'Orphaned Name',
    } as BroadcastRow);
    expect(out).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        broadcastId: BASE_ROW.broadcastId,
        tenantId: BASE_ROW.tenantId,
        hasStartedFromTemplateId: false,
        hasTemplateNameSnapshot: true,
      }),
      'broadcasts.mapper.template_provenance_half_populated',
    );
  });
});

describe('rowToBroadcast end-to-end — R8.5 (R7 code-reviewer LOW-2 close)', () => {
  /**
   * R7 code-reviewer LOW-2 flagged that the standalone
   * `deriveTemplateProvenance` test does NOT prove the full
   * `rowToBroadcast` mapper correctly composes the helper into the
   * Domain shape. A future refactor that accidentally removes the
   * `templateProvenance: deriveTemplateProvenance(row)` line from
   * the mapper would pass the standalone helper test + only fail
   * the integration suite. R8.5 closes by exercising the wiring
   * directly.
   */

  const NOW = new Date('2026-05-21T00:00:00Z');
  const FULL_ROW: BroadcastRow = {
    broadcastId: '11111111-1111-1111-1111-111111111111',
    tenantId: 'tenant-test',
    requestedByMemberId: '22222222-2222-2222-2222-222222222222',
    requestedByMemberPlanIdSnapshot: '33333333-3333-3333-3333-333333333333',
    submittedByUserId: '44444444-4444-4444-4444-444444444444',
    actorRole: 'member_self_service',
    subject: 'Subject',
    bodyHtml: '<p>Body</p>',
    bodySource: 'plain',
    fromName: 'Test Chamber',
    replyToEmail: 'test@test.local',
    segmentType: 'all_members',
    segmentParams: null,
    customRecipientEmails: null,
    estimatedRecipientCount: 100,
    status: 'submitted',
    submittedAt: NOW,
    approvedAt: null,
    approvedByUserId: null,
    rejectedAt: null,
    rejectedByUserId: null,
    rejectionReason: null,
    scheduledFor: null,
    sendingStartedAt: null,
    sentAt: null,
    cancelledAt: null,
    cancelledByUserId: null,
    cancellationReason: null,
    failedToDispatchAt: null,
    failureReason: null,
    quotaYearConsumed: null,
    quotaConsumedAt: null,
    resendAudienceId: null,
    resendBroadcastId: null,
    retentionYears: 5,
    manualRetryCount: 0,
    partialDeliveryAcceptedAt: null,
    partialDeliveryAcceptedByUserId: null,
    startedFromTemplateId: 'tpl-snapshot-id',
    templateNameSnapshot: 'Monthly Newsletter',
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as BroadcastRow;

  it('composes templateProvenance via deriveTemplateProvenance helper', () => {
    const out = rowToBroadcast(FULL_ROW);
    // Wiring assertion: if a future refactor removes the
    // `templateProvenance: deriveTemplateProvenance(row)` line, this
    // assertion fails — even if deriveTemplateProvenance itself is
    // unchanged.
    expect(out.templateProvenance).toEqual({
      templateId: 'tpl-snapshot-id',
      templateNameSnapshot: 'Monthly Newsletter',
    });
  });

  it('rowToBroadcast carries every BroadcastRow field into the Domain shape', () => {
    const out = rowToBroadcast(FULL_ROW);
    // Sanity sample — checking every field would duplicate the
    // structural type. Verify the critical denormalised ones:
    expect(out.broadcastId).toBe(FULL_ROW.broadcastId);
    expect(out.tenantId).toBe(FULL_ROW.tenantId);
    expect(out.status).toBe('submitted');
    expect(out.retentionYears).toBe(5);
    expect(out.createdAt).toEqual(NOW);
  });

  it('R8.5 L-5 (R7 type-design): templateProvenance type-equivalence lock', () => {
    /**
     * Indexed-access type lock (mirrors `_AssertF7AuditEventCount`
     * pattern in audit-port.ts:172). If the Domain `Broadcast.templateProvenance`
     * shape drifts (e.g., adds a new field like `snapshottedAt`),
     * this expectTypeOf catches it immediately at typecheck time —
     * forcing a deliberate review-and-update rather than silent
     * propagation through the mapper.
     */
    expectTypeOf<Broadcast['templateProvenance']>().toEqualTypeOf<
      | { readonly templateId: string; readonly templateNameSnapshot: string }
      | null
    >();
  });
});
