/**
 * #400 W1 — the tenant-table REGISTRY behind `pnpm check:multi-tenant`,
 * moved out of `scripts/check-multi-tenant-ready.ts` so the positive control
 * (`multi-tenant-coverage.ts`) can check the real schema against it in the
 * UNIT suite: `tests/unit/scripts/multi-tenant-coverage.test.ts` parses every
 * Drizzle `tenant_id` table and fails on one registered nowhere. The script
 * needs a database and runs in no hook and no CI job; the unit test needs
 * neither, so CI enforces the registration rule on every PR.
 *
 * Pure data — no imports but a type.
 */
import type { ExemptTable } from './multi-tenant-coverage';

/**
 * Tables in the SCOPED set — these MUST pass every check. CI fails
 * if any of these regress.
 *
 * Wave C scope (per /speckit.tasks T029 + the E18 round 1 spec
 * "scope-cut to F8 tables only and defer the broader registry to
 * Phase 10" decision documented in plan.md):
 *
 *   * All 9 F8-owned tables (Wave C migrations 0086–0094).
 *   * Tables whose tenant isolation has been audited + verified post-
 *     F8 (F2, F3 except email_change_tokens, F4 except notifications_
 *     outbox + credit_note_lines, F5 except processor_events,
 *     F7 broadcasts module — all already shipped + reviewed).
 *
 * Adding a new tenant-scoped table = adding it here. Adding a row to
 * `LEGACY_KNOWN_GAPS` instead is reserved for fixing-later debt that
 * predates this script.
 */
export const SCOPED_TABLES = [
  // F2 plans
  'membership_plans',
  // F3 members
  'members',
  'contacts',
  'email_change_tokens',
  // F114 member change requests (migration 0300) — RLS ENABLE + FORCE +
  // the strict 0209 policy on both tables.
  'member_change_requests',
  'member_change_request_fields',
  // F4 invoicing
  'invoices',
  'invoice_lines',
  'credit_notes',
  'tenant_invoice_settings',
  'tenant_document_sequences',
  'notifications_outbox',
  // F5 payments
  'payments',
  'refunds',
  'tenant_payment_settings',
  // F7 broadcasts
  'broadcasts',
  'broadcast_deliveries',
  'marketing_unsubscribes',
  'broadcast_segment_definitions',
  // F119 E-Blast approval (migration 0304) — the image lifecycle record, RLS
  // ENABLE + FORCE + the 0064 policy; and the pre-existing-but-unlisted
  // tenant_broadcast_settings (RLS since 0166), which 0304 turns into a
  // tenant-authored WRITE surface (brand colour + postal address).
  'broadcast_images',
  'tenant_broadcast_settings',
  // F119 PR-2 (migration 0308) — the approval round's version history and
  // the append-only member decisions; RLS ENABLE + FORCE + the 0064 policy.
  'broadcast_versions',
  'broadcast_member_decisions',
  // #400 PR-B — tables that always carried RLS + FORCE + a tenant policy but
  // were never registered here, so the gate never checked them. Found by the
  // positive control below; each verified on the dev branch (relrowsecurity,
  // relforcerowsecurity, one policy) before it was added.
  // F7 broadcasts: batch dispatch + the template library.
  'broadcast_batch_delivery_events',
  'broadcast_batch_manifests',
  'broadcast_templates',
  // F3 members: the member-number allocator and the per-tenant member settings.
  'tenant_member_sequences',
  'tenant_member_settings',
  // F6 events (EventCreate integration).
  'events',
  'event_registrations',
  'eventcreate_idempotency_receipts',
  'csv_import_records',
  'tenant_webhook_configs',
  // F9 insights.
  'dashboard_metrics_cache',
  'directory_listings',
  'export_jobs',
  'smart_insight_dismissals',
  // F7 broadcasts: the image-source allow-list.
  'tenant_image_source_allowlist',
  // F8 renewals (Wave C)
  'scheduled_plan_changes',
  'renewal_cycles',
  'renewal_reminder_events',
  'tenant_renewal_settings',
  'tenant_renewal_schedule_policies',
  'at_risk_outreach',
  'tier_upgrade_suggestions',
  'renewal_escalation_tasks',
  'consumed_link_tokens',
] as const;

/**
 * Pre-existing tables with documented isolation gaps that PREDATE
 * this readiness script. Audited at /speckit.implement Wave C T029
 * (2026-05-04) and triaged below. Each entry is a known item awaiting
 * a follow-up sweep (deferred to Phase 10 polish per plan.md).
 *
 * The script REPORTS on these but DOES NOT fail on them — separating
 * "new regression" (SCOPED_TABLES) from "old debt" (this list) lets
 * CI block the former without churning on the latter.
 *
 * Triage notes:
 *   * `users`/`sessions`/`invitations` — F1 identity tables; user
 *     accounts are intentionally GLOBAL (cross-tenant) per the F1
 *     design so admins can hold roles in multiple tenants. NOT
 *     tenant-scoped → not a gap; remove from any future "tenant
 *     readiness" lists.
 *   * `audit_log` — append-only F1 table; tenant_id is a row-level
 *     attribute but RLS isn't enabled because audit reads happen
 *     through dedicated read paths that already filter. Documented
 *     pattern; not a gap requiring schema change.
 *   * `rate_limit_state` — F1 Upstash mirror, no tenant_id column;
 *     keyed by user/IP. Not tenant-scoped → not in scope.
 *   * `credit_note_lines` — F4 child rows scoped via FK to
 *     credit_notes (no own tenant_id column). Indirect tenant
 *     isolation through cascade. Acceptable; not a gap.
 *   * `processor_events` — F5 webhook events, 53 orphan NULL-tenant
 *     rows (likely from system-bootstrap inserts). **Real gap.** Phase 10.
 *
 * Resolved at /speckit.implement Phase 10 backlog item A (2026-05-04):
 *   * `email_change_tokens` — RLS+FORCE+POLICY added via migration 0097;
 *     promoted to SCOPED_TABLES.
 *   * `notifications_outbox` — RLS+FORCE+POLICY added + 10 orphan rows
 *     deleted + tenant_id ALTER NOT NULL via migration 0098; promoted
 *     to SCOPED_TABLES.
 */
export const LEGACY_KNOWN_GAPS: ReadonlyArray<string> = [
  'audit_log',
  'processor_events',
];

/**
 * #400 PR-B — `tenant_id` tables deliberately OUTSIDE the RLS contract, each
 * with the reason. Empty: every `tenant_id` table today is either scoped or a
 * known legacy gap. An entry here is a decision someone must be able to read
 * back, so the control refuses one without a reason.
 */
export const EXEMPT: ReadonlyArray<ExemptTable> = [];
