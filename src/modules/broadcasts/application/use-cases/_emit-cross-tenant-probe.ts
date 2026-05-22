/**
 * Cross-tenant probe audit emit — single canonical helper.
 *
 * Consolidates the THREE diverging probe-emit paths (review finding
 * simplifier H1 closure 2026-05-21):
 *   - template surface (`emitTemplateCrossTenantProbeAudit`, kept as
 *     a thin back-compat wrapper around `emitCrossTenantProbe`)
 *   - allowlist surface (was inline try/catch in `manage-image-allowlist.ts`)
 *   - broadcast surface (was inline try/catch in `retry-failed-batches.ts`
 *     + `accept-partial-delivery.ts`)
 *
 * All three now emit `broadcast_cross_tenant_probe` via `safeAuditEmit`
 * which gives them:
 *   1. Automatic `broadcasts_audit_emit_failed_total` counter increment
 *      on transient audit-port failure (SRE alert pipeline fires per
 *      `docs/observability.md § 22.2`).
 *   2. Consistent log key `broadcasts.audit.emit_failed` for SIEM
 *      pivots across all surfaces.
 *   3. Programmer-bug invariant re-throw (R8.5 LOW-1 — adapter
 *      `f7AuditAdapter:`-prefixed throws surface as test failures).
 *
 * The `surface` discriminated union carries the per-surface payload
 * variant — the helper builds the right shape based on `kind`.
 *
 * Returns void — caller still controls the error-result.
 */
import { safeAuditEmit } from './_safe-audit-emit';
import { assertNever } from '@/lib/assert-never';
import type { AuditPort } from '../ports/audit-port';
import type { TenantSlug } from '@/modules/tenants';

/**
 * Discriminated surface union — each variant carries the per-surface
 * payload fields. Adding a new probe-emit surface = add a kind here
 * + extend the switch in `emitCrossTenantProbe`. TypeScript exhaustive
 * narrowing surfaces missing cases at compile time.
 */
/**
 * Template-surface operation kinds. M7 Round 2 closure 2026-05-21
 * (type-design-analyzer §2): literal union prevents typo'd values
 * landing in the audit-log payload. Add a new operation = extend this
 * union + every consumer recompiles.
 */
export type TemplateProbeOperation = 'delete' | 'update' | 'snapshot';

/**
 * Broadcast-surface use-case identifiers. M7 Round 2 closure 2026-05-21.
 * Each variant maps to a use-case file whose probe-emit path uses this
 * helper. Adding a new use-case = extend this union.
 */
export type BroadcastProbeUseCase =
  | 'retry-failed-batches'
  | 'accept-partial-delivery'
  | 'cancel-broadcast';

export type CrossTenantProbeSurface =
  | {
      readonly kind: 'template';
      readonly templateId: string;
      readonly operation: TemplateProbeOperation;
    }
  | {
      readonly kind: 'allowlist';
      readonly hostname: string;
      readonly operation: 'remove';
    }
  | {
      readonly kind: 'broadcast';
      readonly broadcastId: string;
      readonly useCase: BroadcastProbeUseCase;
    };

export interface CrossTenantProbeInput {
  readonly audit: AuditPort;
  readonly tenantId: TenantSlug;
  readonly actorUserId: string;
  readonly requestId: string | null;
  readonly surface: CrossTenantProbeSurface;
  /**
   * Optional tx token. Pass when the caller is already inside a
   * `withTx` scope and wants the probe-emit row to participate in the
   * same rollback boundary (broadcast surface). Pass null/undefined
   * for best-effort post-commit emits (template + allowlist surfaces).
   */
  readonly tx?: unknown;
}

export async function emitCrossTenantProbe(
  input: CrossTenantProbeInput,
): Promise<void> {
  let summary: string;
  let payload: Record<string, unknown>;

  switch (input.surface.kind) {
    case 'template':
      summary = `Cross-tenant probe on ${input.surface.operation}-template ${input.surface.templateId}`;
      payload = {
        // `probedTenantId` is the ACTOR'S OWN tenant (the RLS boundary
        // the actor was querying INTO) — NOT a foreign tenant id.
        // Forensic analysts read this as "tenant X probed its own
        // namespace + got null back" — stale link / deleted race /
        // UUID-guessed attack.
        probedTenantId: input.tenantId,
        probedTemplateId: input.surface.templateId,
        resourceKind: 'template',
      };
      break;
    case 'allowlist':
      summary = `Allowlist ${input.surface.operation} probe: hostname '${input.surface.hostname}' not present in tenant ${input.tenantId}`;
      payload = {
        surface: 'tenant_image_source_allowlist',
        operation: input.surface.operation,
        probedHostname: input.surface.hostname,
        expectedTenantId: input.tenantId,
      };
      break;
    case 'broadcast':
      summary = `Admin ${input.actorUserId} probed unknown broadcast ${input.surface.broadcastId} (${input.surface.useCase} path)`;
      payload = {
        broadcastId: input.surface.broadcastId,
        probedBroadcastId: input.surface.broadcastId,
        expectedTenantId: input.tenantId,
        useCase: input.surface.useCase,
      };
      break;
    default:
      // M6 Round 2 closure 2026-05-21 (type-design-analyzer §2):
      // exhaustive-narrow guard. Adding a 4th surface kind without
      // extending the switch above produces a TS2345 compile error
      // here ("Argument of type ... is not assignable to parameter
      // of type 'never'") — far better failure mode than the prior
      // "used before assigned" cryptic error on `summary` / `payload`.
      assertNever(input.surface);
  }

  await safeAuditEmit(input.audit, input.tx ?? null, {
    eventType: 'broadcast_cross_tenant_probe',
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    summary,
    payload,
    requestId: input.requestId,
  });
}

// ---------------------------------------------------------------------------
// Back-compat shim — preserves the template-scoped helper signature.
// All template use-case sites (delete, update, snapshot) still call
// this name; internally it delegates to the generic helper above.
// New code should call `emitCrossTenantProbe` directly with
// `surface: { kind: 'template', ... }`.
// ---------------------------------------------------------------------------

export interface TemplateProbeAuditInput {
  readonly audit: AuditPort;
  readonly tenantId: TenantSlug;
  readonly actorUserId: string;
  readonly templateId: string;
  // M7 Round 2: tightened from `string` to the literal union to
  // prevent typo'd operations landing in audit payload.
  readonly operation: TemplateProbeOperation;
  readonly requestId: string;
}

export async function emitTemplateCrossTenantProbeAudit(
  input: TemplateProbeAuditInput,
): Promise<void> {
  await emitCrossTenantProbe({
    audit: input.audit,
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    requestId: input.requestId,
    surface: {
      kind: 'template',
      templateId: input.templateId,
      operation: input.operation,
    },
  });
}
