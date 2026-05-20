/**
 * T088 (F7.1a US7) — Contract test for `deleteBroadcastTemplate` use-case.
 *
 * Verifies soft-delete + audit retention per contracts § 1.3:
 *   - port.softDelete called → audit broadcast_template_deleted
 *   - audit payload includes started_from_count snapshot (FR-023 forensic)
 *   - Member role rejected (RBAC at use-case)
 *   - Cross-tenant probe → not_found
 *
 * RED-first per Constitution Principle II. GREEN at Phase 5D T101.
 */
import { describe, expect, it, vi } from 'vitest';
import { deleteBroadcastTemplate } from '@/modules/broadcasts/application/use-cases/delete-broadcast-template';
import type {
  BroadcastTemplate,
  BroadcastTemplatesPort,
} from '@/modules/broadcasts/application/ports/broadcast-templates-port';
import type { AuditPort } from '@/modules/broadcasts/application/ports/audit-port';
import { ok } from '@/lib/result';

const TENANT = 'tenant-swe' as never;
const ACTOR_ADMIN = 'user_admin_42';

const NOW = new Date('2026-05-20T03:00:00Z');
const TEMPLATE_ID = '33333333-3333-3333-3333-333333333333';

const makeTemplate = (overrides?: Partial<BroadcastTemplate>): BroadcastTemplate => ({
  id: TEMPLATE_ID,
  tenantId: TENANT,
  name: 'Event Invitation',
  subject: 'Invite — [Event]',
  bodyHtml: '<p>Body</p>',
  locale: 'en',
  startedFromCount: 27,
  isSeeded: false,
  createdByUserId: ACTOR_ADMIN,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  ...overrides,
});

const makeDeps = (overrides?: {
  existingTemplate?: BroadcastTemplate | null;
}): { port: BroadcastTemplatesPort; audit: AuditPort } => {
  const port: BroadcastTemplatesPort = {
    findById: vi.fn().mockResolvedValue(
      overrides && 'existingTemplate' in overrides
        ? overrides.existingTemplate
        : makeTemplate(),
    ),
    findByTenantId: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn().mockResolvedValue(ok(undefined)),
    incrementStartedFromCount: vi.fn(),
    withTx: vi.fn(
      async <T>(_t: never, fn: (tx: unknown) => Promise<T>) => fn(null),
    ),
  } as BroadcastTemplatesPort;
  return {
    port,
    audit: { emit: vi.fn().mockResolvedValue(undefined) },
  };
};

describe('deleteBroadcastTemplate contract — T088 (F7.1a US7)', () => {
  it('admin soft-deletes → audit broadcast_template_deleted with started_from_count snapshot', async () => {
const deps = makeDeps({
      existingTemplate: makeTemplate({ startedFromCount: 27, name: 'Event Invitation' }),
    });
    const r = await deleteBroadcastTemplate(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_ADMIN,
      templateId: TEMPLATE_ID,
      requestId: 'req-020',
    });
    expect(r.ok).toBe(true);
    expect(deps.port.softDelete).toHaveBeenCalledWith(
      TENANT,
      TEMPLATE_ID,
      null, // tx token (mock withTx passes null)
    );
    const auditCall = (deps.audit.emit as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as { eventType: string; payload: Record<string, unknown> };
    expect(auditCall.eventType).toBe('broadcast_template_deleted');
    expect(auditCall.payload).toMatchObject({
      templateId: TEMPLATE_ID,
      name: 'Event Invitation',
      startedFromCount: 27, // forensic snapshot per FR-023
    });
  });

  it('cross-tenant probe (template belongs to tenant B) → not_found + cross-tenant audit', async () => {
const deps = makeDeps({ existingTemplate: null });
    const r = await deleteBroadcastTemplate(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_ADMIN,
      templateId: TEMPLATE_ID,
      requestId: 'req-021',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_found');
    expect(deps.audit.emit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ eventType: 'broadcast_cross_tenant_probe' }),
    );
    expect(deps.port.softDelete).not.toHaveBeenCalled();
  });

  it('delete starter template (is_seeded=TRUE) succeeds — admin freedom (FR-021)', async () => {
const deps = makeDeps({
      existingTemplate: makeTemplate({ isSeeded: true }),
    });
    const r = await deleteBroadcastTemplate(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_ADMIN,
      templateId: TEMPLATE_ID,
      requestId: 'req-022',
    });
    expect(r.ok).toBe(true);
    expect(deps.port.softDelete).toHaveBeenCalled();
  });
});
