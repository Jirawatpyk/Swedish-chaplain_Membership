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
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '@/lib/logger';
import { deriveTemplateProvenance } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import type { BroadcastRow } from '@/modules/broadcasts/infrastructure/schema';

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
