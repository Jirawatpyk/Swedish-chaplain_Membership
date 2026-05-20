/**
 * T089 (F7.1a US7) — Contract test for `snapshotTemplateToDraft` use-case
 * (SC-007a — 500ms snapshot target verified separately in Phase 5J bench).
 *
 * Verifies member snapshot flow per contracts § 1.4:
 *   - Loads template (RLS-scoped) → applies substituteChamberName →
 *     UPDATEs draft subject + body + started_from_template_id +
 *     template_name_snapshot in same tx
 *   - template.started_from_count++ atomic
 *   - Cross-tenant probe (templateId belongs to tenant B) →
 *     template_not_found + broadcast_cross_tenant_probe audit
 *   - Soft-deleted template → template_not_found
 *
 * RED-first per Constitution Principle II. GREEN at Phase 5D T102.
 */
import { describe, expect, it, vi } from 'vitest';
import { snapshotTemplateToDraft } from '@/modules/broadcasts/application/use-cases/snapshot-template-to-draft';
import type {
  BroadcastTemplate,
  BroadcastTemplatesPort,
} from '@/modules/broadcasts/application/ports/broadcast-templates-port';
import type { TenantDisplayNamePort } from '@/modules/broadcasts/application/ports/tenant-display-name-port';
import type { BroadcastsRepo } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import type { AuditPort } from '@/modules/broadcasts/application/ports/audit-port';

const TENANT = 'tenant-swe' as never;
const ACTOR_MEMBER = 'user_mem_42';
const DRAFT_ID = '44444444-4444-4444-4444-444444444444';
const TEMPLATE_ID = '55555555-5555-5555-5555-555555555555';

const NOW = new Date('2026-05-20T03:00:00Z');

const makeTemplate = (overrides?: Partial<BroadcastTemplate>): BroadcastTemplate => ({
  id: TEMPLATE_ID,
  tenantId: TENANT,
  name: 'Monthly Newsletter',
  subject: '{{chamber_name}} Newsletter — [Month YYYY]',
  bodyHtml:
    '<h2>{{chamber_name}} Newsletter</h2><p>Hello [member name],</p><p>This month at {{chamber_name}}...</p>',
  locale: 'en',
  startedFromCount: 0,
  isSeeded: true,
  createdByUserId: null,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  ...overrides,
});

const makeDeps = (overrides?: {
  template?: BroadcastTemplate | null;
  chamberName?: string;
  ownership?:
    | { readonly probeKind: 'owned'; readonly broadcast: unknown }
    | { readonly probeKind: 'not_found'; readonly broadcast: null }
    | { readonly probeKind: 'cross_member'; readonly broadcast: null };
}): {
  templatesPort: BroadcastTemplatesPort;
  broadcastsRepo: BroadcastsRepo;
  tenantDisplayName: TenantDisplayNamePort;
  audit: AuditPort;
} => {
  // Explicit undefined-check — `??` would treat null as "use default"
  // and mask the cross-tenant-probe scenario.
  const tpl =
    overrides && 'template' in overrides
      ? overrides.template
      : makeTemplate();
  const ownership = overrides?.ownership ?? {
    probeKind: 'owned' as const,
    broadcast: { broadcastId: DRAFT_ID, requestedByMemberId: 'mem-1' },
  };
  return {
    templatesPort: {
      findById: vi.fn().mockResolvedValue(tpl),
      // R1.2 H-sf-2: snapshot use-case now calls findByIdInTx inside
      // withTx to close TOCTOU window. Mock returns same template.
      findByIdInTx: vi.fn().mockResolvedValue(tpl),
      // R3-F11: snapshot use-case now calls findByIdAllowDeletedInTx
      // INSTEAD of findByIdInTx so it can distinguish soft-deleted
      // from never-existed. Mock default returns the same template
      // (deletedAt null per makeTemplate default).
      findByIdAllowDeletedInTx: vi.fn().mockResolvedValue(tpl),
      findByTenantId: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      softDelete: vi.fn(),
      incrementStartedFromCount: vi.fn().mockResolvedValue(undefined),
      withTx: vi.fn(
        async <T>(_t: never, fn: (tx: unknown) => Promise<T>) => fn(null),
      ),
    } as BroadcastTemplatesPort,
    broadcastsRepo: {
      // Minimal mock — snapshot use-case needs findOwnedByMember (R1.1
      // CRIT-1 draft-ownership check) + updateDraftFromTemplate.
      findOwnedByMember: vi.fn().mockResolvedValue(ownership),
      updateDraftFromTemplate: vi.fn().mockResolvedValue(undefined),
    } as unknown as BroadcastsRepo,
    tenantDisplayName: {
      resolve: vi
        .fn()
        .mockResolvedValue(overrides?.chamberName ?? 'SweCham'),
    },
    audit: { emit: vi.fn().mockResolvedValue(undefined) },
  };
};

describe('snapshotTemplateToDraft contract — T089 (F7.1a US7)', () => {
  it('member picks template → draft updated with substituted chamber_name + template_name_snapshot', async () => {
const deps = makeDeps({ chamberName: 'SweCham' });
    const r = await snapshotTemplateToDraft(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_MEMBER,
      memberId: 'mem-1',
      draftId: DRAFT_ID,
      templateId: TEMPLATE_ID,
      requestId: 'req-030',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // chamber_name substituted in subject
      expect(r.value.subject).toBe('SweCham Newsletter — [Month YYYY]');
      // chamber_name substituted in body (both occurrences) + bracket
      // placeholders preserved literal
      expect(r.value.bodyHtml).toContain('SweCham Newsletter');
      expect(r.value.bodyHtml).toContain('This month at SweCham');
      expect(r.value.bodyHtml).toContain('[member name]');
      expect(r.value.templateNameSnapshot).toBe('Monthly Newsletter');
    }
    // template.started_from_count incremented atomically
    expect(deps.templatesPort.incrementStartedFromCount).toHaveBeenCalledWith(
      TENANT,
      TEMPLATE_ID,
      null,
    );
  });

  it('cross-tenant probe (template belongs to tenant B) → template_not_found + cross-tenant audit with template payload', async () => {
const deps = makeDeps({ template: null });
    // R3-F11: snapshot use-case now reads via findByIdAllowDeletedInTx.
    // Return null → cross-tenant probe (vs returning a row with
    // deletedAt populated which would be template_soft_deleted).
    (
      deps.templatesPort as unknown as {
        findByIdAllowDeletedInTx: ReturnType<typeof vi.fn>;
      }
    ).findByIdAllowDeletedInTx.mockResolvedValueOnce(null);
    const r = await snapshotTemplateToDraft(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_MEMBER,
      memberId: 'mem-1',
      draftId: DRAFT_ID,
      templateId: TEMPLATE_ID,
      requestId: 'req-031',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('template_not_found');
    // R1.1 H-code-4: payload now uses probedTemplateId + resourceKind
    expect(deps.audit.emit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        eventType: 'broadcast_cross_tenant_probe',
        payload: expect.objectContaining({
          probedTenantId: TENANT,
          probedTemplateId: TEMPLATE_ID,
          resourceKind: 'template',
        }),
      }),
    );
    expect(deps.templatesPort.incrementStartedFromCount).not.toHaveBeenCalled();
  });

  it('R3-F11: template soft-deleted between picker render + snapshot click → template_soft_deleted (distinct from not_found)', async () => {
    // Same template the picker showed at T1, now soft-deleted at T2
    // (admin deleted it while member was composing). Mock returns the
    // row with `deletedAt` populated.
    const tpl = makeTemplate();
    const softDeletedTpl: typeof tpl = {
      ...tpl,
      deletedAt: new Date('2026-05-20T12:00:00Z'),
    };
    const deps = makeDeps();
    (
      deps.templatesPort as unknown as {
        findByIdAllowDeletedInTx: ReturnType<typeof vi.fn>;
      }
    ).findByIdAllowDeletedInTx.mockResolvedValueOnce(softDeletedTpl);
    const r = await snapshotTemplateToDraft(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_MEMBER,
      memberId: 'mem-1',
      draftId: DRAFT_ID,
      templateId: TEMPLATE_ID,
      requestId: 'req-soft-deleted',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('template_soft_deleted');
    // R3.1 C-3 + R3.2 H-2 — refusal audit fires as a DISTINCT event
    // type (broadcast_template_snapshot_refused_deleted, NOT the same
    // as success), and is emitted via the active tx (not null) so it
    // co-commits with the snapshot tx (atomicity per Constitution I
    // clause 3). The first positional arg to audit.emit is the tx
    // token; the test mock's withTx callback passes null in place of
    // a real Drizzle tx.
    expect(deps.audit.emit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        eventType: 'broadcast_template_snapshot_refused_deleted',
        payload: expect.objectContaining({
          templateId: tpl.id,
          templateNameSnapshot: tpl.name,
        }),
      }),
    );
    // R3.4 M-2 compound assertion — no mutation side-effects fire.
    expect(deps.templatesPort.incrementStartedFromCount).not.toHaveBeenCalled();
    expect(
      (deps.broadcastsRepo as unknown as { updateDraftFromTemplate: ReturnType<typeof vi.fn> })
        .updateDraftFromTemplate,
    ).not.toHaveBeenCalled();
    // Only the refusal audit fires — no other audit events.
    expect(deps.audit.emit).toHaveBeenCalledTimes(1);
  });

  it('CRIT-1: cross-member draft hijack → broadcast_cross_member_probe audit + draft_not_found + counter NOT incremented', async () => {
    const deps = makeDeps({
      ownership: { probeKind: 'cross_member', broadcast: null },
    });
    const r = await snapshotTemplateToDraft(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_MEMBER,
      memberId: 'mem-attacker',
      draftId: DRAFT_ID,
      templateId: TEMPLATE_ID,
      requestId: 'req-crit1',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('draft_not_found');
    expect(deps.audit.emit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        eventType: 'broadcast_cross_member_probe',
        payload: expect.objectContaining({
          probedMemberId: 'mem-attacker',
          probedBroadcastId: DRAFT_ID,
        }),
      }),
    );
    // Counter MUST NOT bump on hostile probe
    expect(deps.templatesPort.incrementStartedFromCount).not.toHaveBeenCalled();
    // Body MUST NOT be touched
    expect(deps.broadcastsRepo.updateDraftFromTemplate).not.toHaveBeenCalled();
  });

  it('CRIT-1: draft genuinely not found → draft_not_found WITHOUT cross-member audit (benign cache miss)', async () => {
    const deps = makeDeps({
      ownership: { probeKind: 'not_found', broadcast: null },
    });
    const r = await snapshotTemplateToDraft(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_MEMBER,
      memberId: 'mem-1',
      draftId: DRAFT_ID,
      templateId: TEMPLATE_ID,
      requestId: 'req-crit1b',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('draft_not_found');
    // No probe audit for benign not_found
    expect(deps.audit.emit).not.toHaveBeenCalledWith(
      null,
      expect.objectContaining({ eventType: 'broadcast_cross_member_probe' }),
    );
  });

  it('R1.2 H-sf-3: BroadcastConcurrentMutationError → draft_status_drift kind + broadcast_concurrent_action_blocked audit', async () => {
    const { BroadcastConcurrentMutationError } = await import(
      '@/modules/broadcasts/application/ports/broadcasts-repo'
    );
    const deps = makeDeps();
    (
      deps.broadcastsRepo as unknown as {
        updateDraftFromTemplate: ReturnType<typeof vi.fn>;
      }
    ).updateDraftFromTemplate.mockRejectedValueOnce(
      new BroadcastConcurrentMutationError(
        'tenant-swe',
        DRAFT_ID as never,
        'submitted',
      ),
    );
    const r = await snapshotTemplateToDraft(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_MEMBER,
      memberId: 'mem-1',
      draftId: DRAFT_ID,
      templateId: TEMPLATE_ID,
      requestId: 'req-status-drift',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('draft_status_drift');
      if (r.error.kind === 'draft_status_drift') {
        expect(r.error.currentStatus).toBe('submitted');
      }
    }
    expect(deps.audit.emit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        eventType: 'broadcast_concurrent_action_blocked',
        payload: expect.objectContaining({
          broadcastId: DRAFT_ID,
          observedStatus: 'submitted',
        }),
      }),
    );
    // Counter MUST NOT bump on status drift
    expect(deps.templatesPort.incrementStartedFromCount).not.toHaveBeenCalled();
    // R4.1 C-3 — audit-last reorder: success audit MUST NOT fire
    // when the mutation throws. Pre-R4.1 emit order was audit-first
    // which left ghost `broadcast_template_snapshotted` rows when
    // the use-case caught + returned err() (Drizzle only rolls back
    // on thrown exceptions, not returned-Err).
    expect(deps.audit.emit).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'broadcast_template_snapshotted',
      }),
    );
  });

  it('R4.1 C-3: BroadcastNotFoundError post-ownership-check → draft_not_found + NO ghost snapshot audit', async () => {
    const { BroadcastNotFoundError } = await import(
      '@/modules/broadcasts/application/ports/broadcasts-repo'
    );
    const deps = makeDeps();
    (
      deps.broadcastsRepo as unknown as {
        updateDraftFromTemplate: ReturnType<typeof vi.fn>;
      }
    ).updateDraftFromTemplate.mockRejectedValueOnce(
      new BroadcastNotFoundError('tenant-swe', DRAFT_ID as never),
    );
    const r = await snapshotTemplateToDraft(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_MEMBER,
      memberId: 'mem-1',
      draftId: DRAFT_ID,
      templateId: TEMPLATE_ID,
      requestId: 'req-not-found',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('draft_not_found');
    // Counter MUST NOT bump on post-ownership disappearance
    expect(deps.templatesPort.incrementStartedFromCount).not.toHaveBeenCalled();
    // R4.1 C-3 ghost-audit guard — success audit MUST NOT fire.
    expect(deps.audit.emit).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'broadcast_template_snapshotted',
      }),
    );
  });

  it('R1.2 H-sf-3: unexpected generic Error → propagates (NOT mapped to draft_not_found)', async () => {
    const deps = makeDeps();
    (
      deps.broadcastsRepo as unknown as {
        updateDraftFromTemplate: ReturnType<typeof vi.fn>;
      }
    ).updateDraftFromTemplate.mockRejectedValueOnce(
      new Error('Postgres connection lost'),
    );
    await expect(
      snapshotTemplateToDraft(deps, {
        tenantId: TENANT,
        actorUserId: ACTOR_MEMBER,
        memberId: 'mem-1',
        draftId: DRAFT_ID,
        templateId: TEMPLATE_ID,
        requestId: 'req-unexpected',
      }),
    ).rejects.toThrow('Postgres connection lost');
  });

  it('CRIT-4: successful snapshot → audit emits broadcast_template_snapshotted inside withTx', async () => {
    const deps = makeDeps();
    const r = await snapshotTemplateToDraft(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_MEMBER,
      memberId: 'mem-1',
      draftId: DRAFT_ID,
      templateId: TEMPLATE_ID,
      requestId: 'req-crit4',
    });
    expect(r.ok).toBe(true);
    // emit called with tx-token (mock withTx passes null as tx) +
    // template_snapshotted event + payload includes templateId,
    // memberId, broadcastId, templateNameSnapshot
    expect(deps.audit.emit).toHaveBeenCalledWith(
      null, // tx (mock withTx)
      expect.objectContaining({
        eventType: 'broadcast_template_snapshotted',
        actorUserId: ACTOR_MEMBER,
        tenantId: TENANT,
        payload: expect.objectContaining({
          broadcastId: DRAFT_ID,
          templateId: TEMPLATE_ID,
          templateNameSnapshot: 'Monthly Newsletter',
          memberId: 'mem-1',
        }),
      }),
    );
  });

  it('soft-deleted template → template_not_found (deleted_at filter)', async () => {
// findById returns null because port filters deleted_at IS NULL
    const deps = makeDeps({ template: null });
    const r = await snapshotTemplateToDraft(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_MEMBER,
      memberId: 'mem-1',
      draftId: DRAFT_ID,
      templateId: TEMPLATE_ID,
      requestId: 'req-032',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('template_not_found');
  });

  it('tenant display_name with HTML metacharacters → escaped on substitution (XSS prevention)', async () => {
const deps = makeDeps({ chamberName: '<script>alert(1)</script>' });
    const r = await snapshotTemplateToDraft(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_MEMBER,
      memberId: 'mem-1',
      draftId: DRAFT_ID,
      templateId: TEMPLATE_ID,
      requestId: 'req-033',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.subject).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(r.value.subject).not.toContain('<script>');
      expect(r.value.bodyHtml).not.toContain('<script>');
    }
  });
});
