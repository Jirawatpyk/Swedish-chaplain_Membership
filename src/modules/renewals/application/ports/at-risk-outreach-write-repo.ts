/**
 * F8 Phase 6 Wave B (T157) — `AtRiskOutreachWriteRepo` Application port.
 *
 * Inserts rows into `at_risk_outreach` (data-model.md § 2.5;
 * migration 0090) for use by the T156 `record-at-risk-outreach` use-
 * case. Companion to the existing `AtRiskOutreachReadRepo` port (Phase
 * 4 Wave I2a) which exposes `hasOutreachWithinDays` for the FR-033
 * reminder-pause cascade — the read port covers reads, this port
 * covers writes.
 *
 * Migration 0090 enforces:
 *   - PK `(tenant_id, outreach_id)` with `outreach_id DEFAULT
 *     gen_random_uuid()` (adapter populates via DB default)
 *   - Channel CHECK ∈ ('email', 'phone', 'meeting')
 *   - Channel-template discriminant: email ⇒ template_id NOT NULL;
 *     phone/meeting ⇒ template_id NULL
 *   - Outcome-note ≤500 chars
 *   - Tenant FK + member FK (CASCADE)
 *
 * The use-case owns input validation (zod) before invoking the port;
 * the adapter trusts inputs at the SQL boundary. Adapter raises an
 * exception on CHECK-constraint violation (defence-in-depth — the
 * use-case zod schema mirrors the CHECK so this should never fire in
 * production).
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { TenantTx } from '@/lib/db';
import type {
  OutreachId,
  OutreachChannel,
} from '../../domain/at-risk-outreach';

/**
 * Input shape for `insertOutreachInTx`. The adapter narrows
 * `templateId` + `outcomeNote` to NULL when undefined.
 */
export interface InsertAtRiskOutreachInput {
  readonly memberId: string;
  readonly channel: OutreachChannel;
  /** Required for `channel === 'email'`; MUST be undefined for phone/meeting. */
  readonly templateId?: string;
  /** Free-form admin note ≤500 chars. */
  readonly outcomeNote?: string;
  /**
   * Acting user id from F1 session. Captured in `created_by_user_id`
   * for forensic provenance — admins and managers both write here per
   * FR-033 + FR-052a manager exception.
   */
  readonly actorUserId: string;
}

export interface InsertAtRiskOutreachResult {
  readonly outreachId: OutreachId;
  /** ISO 8601 UTC timestamp set by DB at INSERT time (DEFAULT NOW()). */
  readonly createdAt: string;
}

export interface AtRiskOutreachWriteRepo {
  /**
   * Insert a new `at_risk_outreach` row. Adapter:
   *   1. Generates `outreach_id` via DB DEFAULT `gen_random_uuid()`
   *   2. Sets `created_at` via DB DEFAULT NOW() — both surface in the
   *      RETURNING clause so the use-case can audit the canonical
   *      values (not approximated client-side timestamps).
   *   3. RLS scoping via the `runInTenant`-prepared `tx` — adapter
   *      does NOT explicitly set tenant_id (it's set by the platform
   *      RLS WITH CHECK + INSERT trigger).
   *
   * Throws on CHECK-constraint violation (channel-template
   * discriminant, outcome-note length, etc.) so the use-case can roll
   * back via the surrounding `runInTenant` boundary.
   */
  insertOutreachInTx(
    tx: TenantTx,
    tenantId: string,
    input: InsertAtRiskOutreachInput,
  ): Promise<InsertAtRiskOutreachResult>;
}
