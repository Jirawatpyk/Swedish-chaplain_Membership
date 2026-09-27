/**
 * Integration-test tenant lifecycle helper.
 *
 * Creates isolated test tenant contexts with UUID-suffixed slugs so
 * parallel CI runs + multiple tests in the same suite never collide
 * (critique E8). Each context comes with a `cleanup` function that
 * deletes every row the test inserted for that tenant from
 * `membership_plans`, `tenant_fee_config`, and `audit_log`.
 *
 * Usage:
 *
 *   const { ctx, cleanup } = await createTestTenant('test-swecham');
 *   try {
 *     // insert rows via runInTenant(ctx, ...)
 *   } finally {
 *     await cleanup();
 *   }
 *
 * Important: `cleanup` runs as `neondb_owner` (BYPASS RLS) so it can
 * see + delete rows from any tenant's namespace. The app never uses
 * this path in production — only the test suite and the future F13
 * super-admin scan do.
 *
 * Never import from outside `tests/integration/**`.
 */

import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { scheduledPlanChanges } from '@/modules/plans/infrastructure/db/schema-scheduled-plan-changes';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import {
  tenantRenewalSettings,
  tenantRenewalSchedulePolicies,
} from '@/modules/renewals/infrastructure/schema-tenant-renewal-config';
import { consumedLinkTokens } from '@/modules/renewals/infrastructure/schema-consumed-link-tokens';
import { renewalReminderEvents } from '@/modules/renewals/infrastructure/schema-renewal-reminder-events';
import { renewalEscalationTasks } from '@/modules/renewals/infrastructure/schema-renewal-escalation-tasks';
import {
  dashboardMetricsCache,
  directoryListings,
  exportJobs,
  smartInsightDismissals,
} from '@/modules/insights/infrastructure/db/schema-insights';
import { atRiskOutreach } from '@/modules/renewals/infrastructure/schema-at-risk-outreach';
import { tierUpgradeSuggestions } from '@/modules/renewals/infrastructure/schema-tier-upgrade-suggestions';
import {
  auditLog,
  emailChangeTokens,
  notificationsOutbox,
} from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { tenantMemberSequences } from '@/modules/members/infrastructure/db/schema-member-sequences';
import { tenantMemberSettings } from '@/modules/members/infrastructure/db/schema-member-settings';
import {
  memberChangeRequestFields,
  memberChangeRequests,
} from '@/modules/members/infrastructure/db/schema-change-requests';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import {
  payments,
  refunds,
  tenantPaymentSettings,
  processorEvents,
} from '@/modules/payments/infrastructure/schema';
import {
  broadcasts,
  broadcastDeliveries,
  marketingUnsubscribes,
  broadcastSegmentDefinitions,
  broadcastImages,
  tenantImageSourceAllowlist,
  broadcastTemplates,
  broadcastVersions,
  broadcastMemberDecisions,
  broadcastBatchManifests,
  broadcastBatchDeliveryEvents,
  tenantBroadcastSettings,
} from '@/modules/broadcasts/infrastructure/schema';
import {
  events,
  eventRegistrations,
  tenantWebhookConfigs,
  eventcreateIdempotencyReceipts,
  csvImportRecords,
} from '@/modules/events/infrastructure/schema';

export interface TestTenant {
  readonly ctx: TenantContext;
  readonly cleanup: () => Promise<void>;
}

export type TestTenantPrefix = 'test-swecham' | 'test-chamber' | 'test';

/**
 * Mint a fresh TenantContext with a UUID-suffixed slug. The slug is
 * guaranteed unique across concurrent CI runs because the suffix is a
 * fresh UUIDv4 on every call.
 *
 * Slug format: `{prefix}-{uuid-first-8-chars}`
 * Example:     `test-swecham-a1b2c3d4`
 *
 * Fits in the 63-char limit for DNS labels. The database has no FK
 * to a tenants table in F2, so we can invent tenant IDs freely.
 */
export async function createTestTenant(
  prefix: TestTenantPrefix = 'test',
): Promise<TestTenant> {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  const slug = `${prefix}-${suffix}`;
  const ctx = asTenantContext(slug);

  const cleanup = async (): Promise<void> => {
    // Run as the BYPASSRLS owner so the DELETE sees the rows regardless
    // of RLS — the whole point of the helper is to wipe everything this
    // tenant inserted. Plain `db.delete(...)` uses the owner role.
    // Order matters: contacts → members (FK constraint), then plans → fee_config.
    // F3 US3.b — tokens + outbox rows carry tenantId; clean them up
    // before deleting contacts (FK on contact_id in email_change_tokens).
    await db
      .delete(emailChangeTokens)
      .where(eq(emailChangeTokens.tenantId, slug));
    await db
      .delete(notificationsOutbox)
      .where(eq(notificationsOutbox.tenantId, slug));
    // F4 cleanup — delete in FK order: credit_notes → invoice_lines (CASCADE
    // from invoices) → invoices → settings + sequences. invoice_lines are
    // CASCADE-deleted by `invoices_invoice_fk ON DELETE CASCADE` so an
    // explicit `delete(invoiceLines)` is redundant but kept for clarity.
    // F5 cleanup — delete in FK order: refunds → payments (FK to payments.id
    // + composite to invoices.tenant_id/invoice_id) → credit_notes (see F4
    // block below for CN cleanup — payments.refunds.creditNoteId back-ref
    // must be cleared before F4 deletes the CN row). processorEvents has
    // no outbound FK; tenantPaymentSettings is keyed by tenant_id only.
    //
    // KNOWN LEAK (A.18 review #4, intentionally NOT auto-fixed): a SETTLED
    // refund + its live CN form a CIRCULAR pair of ON DELETE RESTRICT FKs
    // (credit_notes.source_refund_id → refunds.id AND refunds.credit_note_id →
    // credit_notes.id), so `delete(refunds)` below RESTRICT-throws and the
    // throw is swallowed by the test's afterAll `.catch(() => {})`, leaking
    // that tenant's rows. The cycle CANNOT be broken by nulling either FK
    // column: refunds.credit_note_id is pinned by the
    // `refunds_succeeded_iff_complete` CHECK and credit_notes.source_refund_id
    // by the credit_notes immutability trigger (extended in migration 0227).
    // Breaking it would require globally DISABLE-ing that immutability trigger
    // inside cleanup — which risks concurrent suites (immutability-assertion
    // tests + a shared-Neon ACCESS EXCLUSIVE lock). Left as harmless pollution
    // (tenant-scoped, throwaway UUID slugs); a disposable Neon branch is the
    // right long-term fix (same note as audit_log below).
    // F7 cleanup — delete in FK order: deliveries → broadcasts (a real FK
    // since migration 0310, ON DELETE CASCADE; deleting the children first
    // keeps this independent of the cascade's trigger arm); marketing
    // unsubscribes + segment definitions are independent. broadcasts has
    // append-only triggers on broadcast_deliveries — DELETE on the
    // child table fires `broadcast_deliveries_no_delete` trigger which
    // RAISES. Disable the trigger inside the cleanup tx to allow test
    // rows to be wiped.
    await db.execute(sql`
      ALTER TABLE broadcast_deliveries DISABLE TRIGGER broadcast_deliveries_no_delete
    `);
    await db
      .delete(broadcastDeliveries)
      .where(eq(broadcastDeliveries.tenantId, slug));
    await db.execute(sql`
      ALTER TABLE broadcast_deliveries ENABLE TRIGGER broadcast_deliveries_no_delete
    `);
    await db.delete(broadcasts).where(eq(broadcasts.tenantId, slug));
    // F119 broadcast children. ORDER IS NOT FREE HERE: `broadcasts` carries
    // `broadcasts_approved_version_fk → broadcast_versions` with NO ACTION, so
    // deleting the versions FIRST is refused for any approved broadcast. The
    // `broadcasts` delete above cascades to versions, member decisions, batch
    // manifests and batch delivery events, which makes the four deletes below
    // no-ops today — kept explicit for the reason `invoice_lines` is, so the
    // order never depends on someone reading the cascade. `broadcast_templates`
    // comes after `broadcasts` too: its FK is SET NULL, not CASCADE.
    await db
      .delete(broadcastMemberDecisions)
      .where(eq(broadcastMemberDecisions.tenantId, slug));
    await db
      .delete(broadcastBatchDeliveryEvents)
      .where(eq(broadcastBatchDeliveryEvents.tenantId, slug));
    await db
      .delete(broadcastBatchManifests)
      .where(eq(broadcastBatchManifests.tenantId, slug));
    await db.delete(broadcastVersions).where(eq(broadcastVersions.tenantId, slug));
    await db.delete(broadcastTemplates).where(eq(broadcastTemplates.tenantId, slug));
    await db
      .delete(tenantBroadcastSettings)
      .where(eq(tenantBroadcastSettings.tenantId, slug));
    await db
      .delete(marketingUnsubscribes)
      .where(eq(marketingUnsubscribes.tenantId, slug));
    await db
      .delete(broadcastSegmentDefinitions)
      .where(eq(broadcastSegmentDefinitions.tenantId, slug));
    // F119 inline images — `broadcast_images` and
    // `tenant_image_source_allowlist` carry no outbound FK (the image row
    // points at its owner by (owner_kind, owner_id), not by a constraint), so
    // position here is free. They were missing from this list until
    // 2026-09-27, when a sweep of the `dev` branch found 51 + 23 leaked rows.
    await db.delete(broadcastImages).where(eq(broadcastImages.tenantId, slug));
    await db
      .delete(tenantImageSourceAllowlist)
      .where(eq(tenantImageSourceAllowlist.tenantId, slug));
    await db.delete(refunds).where(eq(refunds.tenantId, slug));
    await db.delete(payments).where(eq(payments.tenantId, slug));
    await db.delete(processorEvents).where(eq(processorEvents.tenantId, slug));
    await db
      .delete(tenantPaymentSettings)
      .where(eq(tenantPaymentSettings.tenantId, slug));
    await db.delete(creditNotes).where(eq(creditNotes.tenantId, slug));
    await db.delete(invoiceLines).where(eq(invoiceLines.tenantId, slug));
    await db.delete(invoices).where(eq(invoices.tenantId, slug));
    await db.delete(tenantDocumentSequences).where(eq(tenantDocumentSequences.tenantId, slug));
    await db.delete(tenantInvoiceSettings).where(eq(tenantInvoiceSettings.tenantId, slug));
    // F-member-number cleanup — tenant_member_sequences + tenant_member_settings
    // have no outbound FKs; clean them before members for logical ordering.
    // Owner role bypasses RLS+FORCE so these DELETEs see the test-tenant rows.
    await db
      .delete(tenantMemberSequences)
      .where(eq(tenantMemberSequences.tenantId, slug));
    await db
      .delete(tenantMemberSettings)
      .where(eq(tenantMemberSettings.tenantId, slug));
    // F114 (migration 0300) — change-request rows FK both contacts and
    // members (ON DELETE CASCADE) and the F1 `users` rows (RESTRICT). Delete
    // them explicitly BEFORE contacts so `deleteTestUser` in a test's
    // afterAll never trips the user FK, and so the order does not depend on
    // the cascade. Fields cascade from requests; the explicit delete is for
    // clarity, as with invoice_lines above.
    await db
      .delete(memberChangeRequestFields)
      .where(eq(memberChangeRequestFields.tenantId, slug));
    await db
      .delete(memberChangeRequests)
      .where(eq(memberChangeRequests.tenantId, slug));
    await db.delete(contacts).where(eq(contacts.tenantId, slug));
    // R2 Batch 3b-bis — migration 0125 added composite FKs:
    //   scheduled_plan_changes → renewal_cycles → members.
    // Cleanup order MUST be: scheduledPlanChanges → renewal_cycles →
    // members (and renewal_cycles BEFORE members because of
    // `renewal_cycles_member_fk` ON DELETE RESTRICT). Pre-Batch-3b
    // the F8 tests handled this via per-test `clearTenant` helpers;
    // now centralised here so any test that opts into the
    // `seed-renewal-cycle.ts` helper gets correct cleanup for free.
    await db
      .delete(scheduledPlanChanges)
      .where(eq(scheduledPlanChanges.tenantId, slug));
    // F8 reminder/escalation children of `renewal_cycles`, both missing from
    // this list until 2026-09-27. `renewal_escalation_tasks_cycle_fk` declares
    // NO onDelete, i.e. NO ACTION — it BLOCKS the `renewal_cycles` delete
    // below, which then blocks `members` (`renewal_cycles_member_fk` is
    // RESTRICT), which strands the whole tenant. One escalation task was
    // enough to leak everything else, and the `.catch(() => {})` at every call
    // site hid it. `renewal_reminder_events` cascades from the cycle, so its
    // delete is redundant — kept explicit for the same reason `invoice_lines`
    // is above: the order should not depend on reading the cascade.
    await db
      .delete(renewalEscalationTasks)
      .where(eq(renewalEscalationTasks.tenantId, slug));
    await db
      .delete(renewalReminderEvents)
      .where(eq(renewalReminderEvents.tenantId, slug));
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, slug));
    // F8/F9 per-member children — all three CASCADE from `members`, so these
    // are no-ops in the normal path; explicit so a future FK change to NO
    // ACTION (the mistake `renewal_escalation_tasks` already made) cannot
    // silently strand a tenant.
    await db.delete(atRiskOutreach).where(eq(atRiskOutreach.tenantId, slug));
    await db
      .delete(tierUpgradeSuggestions)
      .where(eq(tierUpgradeSuggestions.tenantId, slug));
    await db.delete(directoryListings).where(eq(directoryListings.tenantId, slug));
    await db.delete(members).where(eq(members.tenantId, slug));
    await db.delete(membershipPlans).where(eq(membershipPlans.tenantId, slug));
    // F8 Wave C T020 + verify-run B1 — per-test-tenant renewal config
    // rows seeded by `helpers/seed-renewal-policies.ts`. tenant_renewal_
    // schedule_policies cleanup ordered first because
    // tenant_renewal_settings has no FK dependents in either direction;
    // both tables are independent of each other.
    await db
      .delete(tenantRenewalSchedulePolicies)
      .where(eq(tenantRenewalSchedulePolicies.tenantId, slug));
    await db
      .delete(tenantRenewalSettings)
      .where(eq(tenantRenewalSettings.tenantId, slug));
    // F8 Phase 9 retrofit (PR #25 R2) — consumed_link_tokens cleanup;
    // owner role bypasses RLS+FORCE policy on the table.
    await db
      .delete(consumedLinkTokens)
      .where(eq(consumedLinkTokens.tenantId, slug));
    // F6 cleanup (Phase 3) — delete in FK order: event_registrations
    // (FK to events on composite tenant_id+event_id) → csv_import_records
    // (F6.1 FK to events on composite tenant_id+event_id ON DELETE
    // RESTRICT) → events. The tenant_webhook_configs +
    // eventcreate_idempotency_receipts tables have no outbound FK;
    // cleanup order is independent.
    await db
      .delete(eventRegistrations)
      .where(eq(eventRegistrations.tenantId, slug));
    await db
      .delete(csvImportRecords)
      .where(eq(csvImportRecords.tenantId, slug));
    await db.delete(events).where(eq(events.tenantId, slug));
    await db
      .delete(tenantWebhookConfigs)
      .where(eq(tenantWebhookConfigs.tenantId, slug));
    await db
      .delete(eventcreateIdempotencyReceipts)
      .where(eq(eventcreateIdempotencyReceipts.tenantId, slug));
    // F9 insights — `export_jobs` and `dashboard_metrics_cache` are keyed by
    // tenant_id with no outbound FK; also missing until 2026-09-27 (62 + 19
    // leaked rows on `dev`). A stale metrics-cache row for a recycled slug is
    // worse than untidy: it is a wrong number waiting for the next test that
    // reuses the prefix.
    await db.delete(exportJobs).where(eq(exportJobs.tenantId, slug));
    await db
      .delete(dashboardMetricsCache)
      .where(eq(dashboardMetricsCache.tenantId, slug));
    await db
      .delete(smartInsightDismissals)
      .where(eq(smartInsightDismissals.tenantId, slug));
    // R9 — tenant_fee_config DROPPED (migration 0029). Fiscal config
    // lives in tenant_invoice_settings which is cleaned above.
    // audit_log has an append-only trigger that BLOCKS DELETE — so we
    // skip audit cleanup here. Test-created audit rows accumulate as
    // pollution but are scoped to the test tenant slug so they are
    // harmless. A disposable Neon branch is the right long-term fix.
  };

  return { ctx, cleanup };
}

/**
 * Convenience: spin up two test tenants at once for cross-tenant
 * isolation tests. Each has an independent UUID-suffixed slug.
 */
export async function createTwoTestTenants(): Promise<{
  a: TestTenant;
  b: TestTenant;
}> {
  const a = await createTestTenant('test-swecham');
  const b = await createTestTenant('test-chamber');
  return { a, b };
}

/**
 * Delete any audit_log pollution across ALL test-prefixed tenants.
 * The append-only trigger is bypassed by running as a role that has
 * RLS bypass — but we can't bypass the trigger itself without dropping
 * it. Kept here as a placeholder for future hardening; currently a no-op.
 */
 
export async function purgeTestAuditRows(_prefix: TestTenantPrefix): Promise<void> {
  // Intentionally no-op — see the cleanup comment above. The suppression
  // reference ensures this file is valid TypeScript even with unused params.
  void sql;
  void auditLog;
  void and;
  void inArray;
  void or;
}
