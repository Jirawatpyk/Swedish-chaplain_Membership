/**
 * Auth-owned GDPR audit-subset READER contract (F9 US6 / T091).
 *
 * `audit_log` is owned by the `auth` module, so the bounded reader that gathers
 * a single member's audit subset (member-performed ∪ member-targeted) for their
 * GDPR archive lives here — the insights `gdpr-archive` builder consumes it
 * through the auth public barrel (mirrors `auditQueryReadAdapter`).
 *
 * The union predicate is applied server-side (a bounded `LIMIT`-capped scan,
 * NOT an unbounded full-table read into app memory):
 *   actor_user_id  IN (:memberUserIds)      -- the member performed it
 *   OR target_user_id IN (:memberUserIds)   -- it targeted the member's account
 *   OR payload->>'member_id' = :memberId    -- member-targeted (F3 taxonomy)
 *   OR payload->>'subject_member_id' = :memberId  -- F9 / on-behalf taxonomy
 *
 * The reader returns the FULL payload — third-party redaction (FR-029) is the
 * consuming insights builder's concern (`gdpr-audit-subset`), not the reader's.
 * Tenant isolation: explicit `tenant_id = ctx.slug` (app-layer half) on top of
 * the permissive RLS policy (db-layer half), excluding legacy null-tenant rows.
 *
 * Pure types only (Principle III). Drizzle impl: `infrastructure/db/gdpr-audit-subset-repo.ts`.
 */
import type { AuditEventType } from '../domain/audit-event';
import type { AuditQueryReadRow } from './audit-query-read';

export interface GdprAuditSubsetReadInput {
  /**
   * The user-account ids linked to the member's contacts (a member org can have
   * several portal users). Empty when no contact has a portal account — then
   * only the payload member-id arms apply.
   */
  readonly memberUserIds: readonly string[];
  /** The member id (matches `payload.member_id` / `payload.subject_member_id`). */
  readonly memberId: string;
  /** Hard cap on the rows returned (the archive bounds the subset; FR-037). */
  readonly limit: number;
}

export interface GdprAuditSubsetReadPort {
  /**
   * Returns up to `input.limit` rows for the member's audit subset, newest-first
   * (`timestamp DESC, id DESC`). Throws on a DB read failure — the consuming
   * use-case maps that to its Result channel.
   */
  query(
    ctx: import('@/modules/tenants').TenantContext,
    input: GdprAuditSubsetReadInput,
  ): Promise<readonly AuditQueryReadRow[]>;
}

export type { AuditEventType };
