/**
 * T015 — the per-surface PERMISSION KEY register (016-rbac-permissions).
 *
 * Until PR 5 this was the FROZEN pre-sweep baseline: per staff surface it also
 * carried the flag-OFF shim row, the observed guard expression, and the
 * per-role outcome the OFF leg had to keep producing byte for byte (SC-002).
 * The legacy leg is deleted (T068), so those three columns went with it — what
 * remains load-bearing is the (surface -> key) register that
 * `check-staff-page-guard`, `check-api-route-guard` and the role x endpoint
 * matrix hold the real code to, plus the D4 narrowing declarations below.
 *
 * Maintenance: adding a staff surface means adding its row here in the SAME
 * commit — both gates fail on an unregistered surface, and that is the point.
 */

import type { PermissionKey } from '@/modules/auth/domain/permissions/permission-catalogue';

export interface ObservedSurface {
  /** Page path, or `METHOD /api/...` for a route handler. */
  readonly surface: string;
  readonly kind: 'page' | 'api';
  /** The permission key the surface declares. */
  readonly key: PermissionKey;
}

export const OBSERVED_PAGES: readonly ObservedSurface[] = [
  { surface: '/admin', kind: 'page', key: 'dashboard.view' },
  { surface: '/admin/account', kind: 'page', key: 'dashboard.view' },
  { surface: '/admin/audit', kind: 'page', key: 'audit.read' },
  { surface: '/admin/broadcasts', kind: 'page', key: 'broadcasts.read' },
  { surface: '/admin/broadcasts/[id]', kind: 'page', key: 'broadcasts.read' },
  { surface: '/admin/credit-notes/[creditNoteId]', kind: 'page', key: 'invoicing.read' },
  { surface: '/admin/directory', kind: 'page', key: 'directory.export' },
  { surface: '/admin/invoices', kind: 'page', key: 'invoicing.read' },
  { surface: '/admin/invoices/[invoiceId]', kind: 'page', key: 'invoicing.read' },
  { surface: '/admin/members', kind: 'page', key: 'members.read' },
  { surface: '/admin/members/[memberId]', kind: 'page', key: 'members.read' },
  { surface: '/admin/members/[memberId]/timeline', kind: 'page', key: 'members.read' },
  { surface: '/admin/plans', kind: 'page', key: 'plans.read' },
  { surface: '/admin/plans/[year]/[planId]', kind: 'page', key: 'plans.read' },
  { surface: '/admin/settings', kind: 'page', key: 'dashboard.view' },
  { surface: '/admin/settings/invoicing', kind: 'page', key: 'settings.invoicing' },
  { surface: '/admin/users', kind: 'page', key: 'users.manage' },
  { surface: '/admin/credit-notes', kind: 'page', key: 'invoicing.read' },
  { surface: '/admin/events', kind: 'page', key: 'events.read' },
  { surface: '/admin/events/[eventId]', kind: 'page', key: 'events.read' },
  { surface: '/admin/members/[memberId]/benefits', kind: 'page', key: 'members.read' },
  { surface: '/admin/renewals', kind: 'page', key: 'renewals.read' },
  { surface: '/admin/renewals/[cycleId]', kind: 'page', key: 'renewals.read' },
  { surface: '/admin/renewals/tasks', kind: 'page', key: 'renewals.read' },
  { surface: '/admin/settings/renewals/schedules', kind: 'page', key: 'settings.renewal_schedules' },
  { surface: '/admin/broadcasts/new', kind: 'page', key: 'broadcasts.write' },
  { surface: '/admin/broadcasts/templates', kind: 'page', key: 'broadcasts.write' },
  { surface: '/admin/broadcasts/templates/new', kind: 'page', key: 'broadcasts.write' },
  { surface: '/admin/broadcasts/templates/[id]/edit', kind: 'page', key: 'broadcasts.write' },
  { surface: '/admin/compliance/erasure-log', kind: 'page', key: 'members.erasure_log_read' },
  { surface: '/admin/events/[eventId]/registrations/[registrationId]/erase', kind: 'page', key: 'events.erasure' },
  { surface: '/admin/events/erasure', kind: 'page', key: 'events.erasure' },
  { surface: '/admin/events/import', kind: 'page', key: 'events.write' },
  { surface: '/admin/events/import/history', kind: 'page', key: 'events.write' },
  { surface: '/admin/invoices/new', kind: 'page', key: 'invoicing.write' },
  { surface: '/admin/invoices/registers', kind: 'page', key: 'invoicing.receipt' },
  { surface: '/admin/invoices/[invoiceId]/void', kind: 'page', key: 'invoicing.void' },
  { surface: '/admin/invoices/[invoiceId]/credit-notes/new', kind: 'page', key: 'credit_notes.write' },
  { surface: '/admin/members/new', kind: 'page', key: 'members.write' },
  { surface: '/admin/members/[memberId]/edit', kind: 'page', key: 'members.write' },
  { surface: '/admin/plans/new', kind: 'page', key: 'plans.write' },
  { surface: '/admin/plans/clone', kind: 'page', key: 'plans.clone' },
  { surface: '/admin/plans/[year]/[planId]/edit', kind: 'page', key: 'plans.write' },
  { surface: '/admin/renewals/tier-upgrades', kind: 'page', key: 'renewals.write' },
  { surface: '/admin/settings/broadcasts', kind: 'page', key: 'settings.broadcasts' },
  { surface: '/admin/settings/integrations/eventcreate', kind: 'page', key: 'settings.integrations' },
];

/**
 * T028 capture correction: `GET /api/internal/exports/[jobId]/download` was
 * originally captured here as `legacyAdminOrManager` with `member: deny` — a
 * misread. The `role === 'member'` branch in that file RESOLVES the acting
 * member id, it does not deny: the route is the dual-audience private-artefact
 * proxy that `/api/portal/account/data-export/[jobId]/download` 303-redirects
 * the SUBJECT MEMBER to for their own GDPR archive. Gating it on a staff
 * permission would 403 that member flow. Its real guards are the single-use
 * job-bound HMAC token plus `downloadExport`'s subject-or-staff authorize();
 * it is therefore classified `session-any` in the exhaustiveness test, not
 * role-matrix. The STAFF entry points that mint its tokens stay role-gated
 * (`directory.export` / `members.bulk`).
 */
export const OBSERVED_API: readonly ObservedSurface[] = [
  { surface: 'DELETE /api/admin/broadcasts/templates/[id]', kind: 'api', key: 'broadcasts.write' },
  { surface: 'DELETE /api/invoices/[invoiceId]', kind: 'api', key: 'invoicing.write' },
  { surface: 'DELETE /api/members/[memberId]/contacts/[contactId]', kind: 'api', key: 'contacts.write' },
  { surface: 'DELETE /api/plans/[year]/[planId]', kind: 'api', key: 'plans.write' },
  { surface: 'GET /api/admin/audit/export.csv', kind: 'api', key: 'audit.read' },
  { surface: 'GET /api/admin/broadcasts', kind: 'api', key: 'broadcasts.read' },
  { surface: 'GET /api/admin/broadcasts/sla-stats', kind: 'api', key: 'broadcasts.read' },
  { surface: 'GET /api/admin/broadcasts/templates', kind: 'api', key: 'broadcasts.read' },
  { surface: 'GET /api/admin/directory/exports/[jobId]/download', kind: 'api', key: 'directory.export' },
  { surface: 'GET /api/admin/events', kind: 'api', key: 'events.read' },
  { surface: 'GET /api/admin/events/[eventId]', kind: 'api', key: 'events.read' },
  { surface: 'GET /api/admin/events/import/history', kind: 'api', key: 'events.write' },
  { surface: 'GET /api/admin/events/import/[recordId]/error-csv', kind: 'api', key: 'events.write' },
  { surface: 'GET /api/admin/integrations/eventcreate', kind: 'api', key: 'settings.integrations' },
  { surface: 'GET /api/admin/invoices/export.csv', kind: 'api', key: 'invoicing.read' },
  { surface: 'GET /api/admin/members/export.zip', kind: 'api', key: 'members.bulk' },
  { surface: 'GET /api/admin/members/[id]/data-export/[jobId]/download', kind: 'api', key: 'members.bulk' },
  { surface: 'GET /api/admin/members/search', kind: 'api', key: 'members.read' },
  { surface: 'GET /api/admin/renewals', kind: 'api', key: 'renewals.read' },
  { surface: 'GET /api/admin/renewals/at-risk', kind: 'api', key: 'renewals.read' },
  { surface: 'GET /api/admin/renewals/[cycleId]', kind: 'api', key: 'renewals.read' },
  { surface: 'GET /api/admin/renewals/settings/schedules', kind: 'api', key: 'settings.renewal_schedules' },
  { surface: 'GET /api/admin/renewals/settlement-preview', kind: 'api', key: 'renewals.read' },
  { surface: 'GET /api/admin/renewals/tasks', kind: 'api', key: 'renewals.read' },
  { surface: 'GET /api/admin/renewals/tier-upgrades', kind: 'api', key: 'renewals.write' },
  { surface: 'GET /api/admin/users/staff-active', kind: 'api', key: 'renewals.read' },
  { surface: 'GET /api/credit-notes/[creditNoteId]', kind: 'api', key: 'invoicing.read' },
  { surface: 'GET /api/credit-notes/[creditNoteId]/pdf', kind: 'api', key: 'invoicing.read' },
  { surface: 'GET /api/geo/postal/[code]', kind: 'api', key: 'members.read' },
  { surface: 'GET /api/invoices', kind: 'api', key: 'invoicing.read' },
  { surface: 'GET /api/invoices/[invoiceId]', kind: 'api', key: 'invoicing.read' },
  { surface: 'GET /api/invoices/[invoiceId]/pdf', kind: 'api', key: 'invoicing.read' },
  { surface: 'GET /api/invoices/[invoiceId]/preview', kind: 'api', key: 'invoicing.write' },
  { surface: 'GET /api/invoices/[invoiceId]/receipt/pdf', kind: 'api', key: 'invoicing.read' },
  { surface: 'GET /api/invoices/[invoiceId]/zero-rate-cert', kind: 'api', key: 'invoicing.read' },
  { surface: 'GET /api/invoices/member-renewal-context', kind: 'api', key: 'invoicing.read' },
  { surface: 'GET /api/members', kind: 'api', key: 'members.read' },
  { surface: 'GET /api/members/ids', kind: 'api', key: 'members.read' },
  { surface: 'GET /api/members/[memberId]', kind: 'api', key: 'members.read' },
  { surface: 'GET /api/members/[memberId]/invoices', kind: 'api', key: 'invoicing.read' },
  { surface: 'GET /api/members/[memberId]/timeline', kind: 'api', key: 'members.read' },
  { surface: 'GET /api/plans', kind: 'api', key: 'plans.read' },
  // 016 T064 — DELIBERATE widening, the only baseline row PR 4 moves. The ⌘K
  // palette is not a plans surface; it is the entry point to every staff
  // surface, and each entry now carries its own destination permission (see
  // palette-permission-parity.test.ts). Guarding the endpoint on `plans.read`
  // denied it wholesale to `marketing`, whose bundle carries members +
  // broadcasts + events, so its palette came back empty. The KEY widens to
  // `dashboard.view`; the legacy ROW is unchanged, so the OFF-leg population is
  // byte-identical. Plan hits are re-gated on `plans.read` inside the handler,
  // and member hits on `members.read` (016 review).
  //
  // `cells` records the OFF LEG — that is what `T015 flag-OFF leg reproduces
  // observed behaviour` compares against — so the unchanged row still denies
  // marketing here. The ON-leg reach is pinned separately by T053's frozen
  // list, which now includes this surface. An earlier draft of this comment
  // glossed the cell as `marketing: 'allow'`, contradicting the line below it.
  { surface: 'GET /api/plans/search', kind: 'api', key: 'dashboard.view' },
  { surface: 'GET /api/plans/[year]/[planId]', kind: 'api', key: 'plans.read' },
  { surface: 'GET /api/plans/[year]/[planId]/affected-members', kind: 'api', key: 'members.read' },
  { surface: 'GET /api/tenant-invoice-settings', kind: 'api', key: 'settings.invoicing' },
  { surface: 'PATCH /api/admin/broadcasts/templates/[id]', kind: 'api', key: 'broadcasts.write' },
  { surface: 'PATCH /api/admin/members/[id]/preferred-locale', kind: 'api', key: 'members.write' },
  { surface: 'PATCH /api/members/[memberId]', kind: 'api', key: 'members.write' },
  { surface: 'PATCH /api/members/[memberId]/contacts/[contactId]', kind: 'api', key: 'contacts.write' },
  { surface: 'PATCH /api/members/[memberId]/inline-edit', kind: 'api', key: 'members.write' },
  { surface: 'PATCH /api/plans/[year]/[planId]', kind: 'api', key: 'plans.write' },
  { surface: 'PATCH /api/tenant-invoice-settings', kind: 'api', key: 'settings.invoicing' },
  { surface: 'POST /api/admin/broadcasts/[id]/accept-partial', kind: 'api', key: 'broadcasts.send' },
  { surface: 'POST /api/admin/broadcasts/[id]/approve', kind: 'api', key: 'broadcasts.send' },
  { surface: 'POST /api/admin/broadcasts/[id]/cancel', kind: 'api', key: 'broadcasts.write' },
  { surface: 'POST /api/admin/broadcasts/[id]/reject', kind: 'api', key: 'broadcasts.write' },
  { surface: 'POST /api/admin/broadcasts/[id]/retry', kind: 'api', key: 'broadcasts.send' },
  { surface: 'POST /api/admin/broadcasts/proxy-submit', kind: 'api', key: 'broadcasts.send' },
  { surface: 'POST /api/admin/broadcasts/settings/allowlist', kind: 'api', key: 'settings.broadcasts' },
  { surface: 'POST /api/admin/broadcasts/templates', kind: 'api', key: 'broadcasts.write' },
  { surface: 'POST /api/admin/directory/exports', kind: 'api', key: 'directory.export' },
  { surface: 'POST /api/admin/events', kind: 'api', key: 'events.write' },
  { surface: 'POST /api/admin/events/erasure', kind: 'api', key: 'events.erasure' },
  { surface: 'POST /api/admin/events/[eventId]/archive', kind: 'api', key: 'events.write' },
  { surface: 'POST /api/admin/events/[eventId]/registrations/[registrationId]/erase', kind: 'api', key: 'events.erasure' },
  { surface: 'POST /api/admin/events/[eventId]/registrations/[registrationId]/relink', kind: 'api', key: 'events.relink' },
  { surface: 'POST /api/admin/events/[eventId]/toggle-cultural-event', kind: 'api', key: 'events.write' },
  { surface: 'POST /api/admin/events/[eventId]/toggle-partner-benefit', kind: 'api', key: 'events.write' },
  { surface: 'POST /api/admin/events/import', kind: 'api', key: 'events.write' },
  { surface: 'POST /api/admin/insights/dismiss', kind: 'api', key: 'insights.engagement' },
  { surface: 'POST /api/admin/integrations/eventcreate/disable', kind: 'api', key: 'settings.integrations' },
  { surface: 'POST /api/admin/integrations/eventcreate/generate-secret', kind: 'api', key: 'settings.integrations' },
  { surface: 'POST /api/admin/integrations/eventcreate/rotate-secret', kind: 'api', key: 'settings.integrations' },
  { surface: 'POST /api/admin/integrations/eventcreate/test-webhook', kind: 'api', key: 'settings.integrations' },
  { surface: 'POST /api/admin/members/[id]/block-auto-reactivation', kind: 'api', key: 'renewals.write' },
  { surface: 'POST /api/admin/members/[id]/broadcasts-halt-clear', kind: 'api', key: 'broadcasts.clear_halt' },
  { surface: 'POST /api/admin/members/[id]/data-export', kind: 'api', key: 'members.bulk' },
  { surface: 'POST /api/admin/members/[id]/renew', kind: 'api', key: 'renewals.write' },
  { surface: 'POST /api/admin/members/[id]/unblock-auto-reactivation', kind: 'api', key: 'renewals.write' },
  { surface: 'POST /api/admin/renewals/at-risk/[memberId]/outreach', kind: 'api', key: 'renewals.read' },
  { surface: 'POST /api/admin/renewals/at-risk/[memberId]/snooze', kind: 'api', key: 'renewals.write' },
  { surface: 'POST /api/admin/renewals/[cycleId]/cancel', kind: 'api', key: 'renewals.write' },
  { surface: 'POST /api/admin/renewals/[cycleId]/mark-paid-offline', kind: 'api', key: 'renewals.write' },
  { surface: 'POST /api/admin/renewals/[cycleId]/reactivate', kind: 'api', key: 'renewals.write' },
  { surface: 'POST /api/admin/renewals/[cycleId]/reject', kind: 'api', key: 'renewals.write' },
  { surface: 'POST /api/admin/renewals/[cycleId]/send-reminder-now', kind: 'api', key: 'renewals.write' },
  { surface: 'POST /api/admin/renewals/tasks/[taskId]/done', kind: 'api', key: 'renewals.write' },
  { surface: 'POST /api/admin/renewals/tasks/[taskId]/reassign', kind: 'api', key: 'renewals.write' },
  { surface: 'POST /api/admin/renewals/tasks/[taskId]/skip', kind: 'api', key: 'renewals.write' },
  { surface: 'POST /api/admin/renewals/tier-upgrades/[suggestionId]/accept', kind: 'api', key: 'renewals.write' },
  { surface: 'POST /api/admin/renewals/tier-upgrades/[suggestionId]/dismiss', kind: 'api', key: 'renewals.write' },
  { surface: 'POST /api/admin/renewals/tier-upgrades/[suggestionId]/escalate', kind: 'api', key: 'renewals.write' },
  { surface: 'POST /api/admin/scheduled-plan-changes/[id]/cancel', kind: 'api', key: 'plans.write' },
  { surface: 'POST /api/auth/invite', kind: 'api', key: 'users.manage' },
  { surface: 'POST /api/auth/users/[id]/disable', kind: 'api', key: 'users.manage' },
  { surface: 'POST /api/auth/users/[id]/enable', kind: 'api', key: 'users.manage' },
  { surface: 'POST /api/auth/users/[id]/reissue-invite', kind: 'api', key: 'users.manage' },
  { surface: 'POST /api/auth/users/[id]/revoke-invite', kind: 'api', key: 'users.manage' },
  { surface: 'POST /api/auth/users/[id]/role', kind: 'api', key: 'users.manage' },
  { surface: 'POST /api/credit-notes', kind: 'api', key: 'credit_notes.write' },
  { surface: 'POST /api/credit-notes/[creditNoteId]/resend', kind: 'api', key: 'credit_notes.write' },
  { surface: 'POST /api/invoices', kind: 'api', key: 'invoicing.write' },
  { surface: 'POST /api/invoices/event-draft', kind: 'api', key: 'invoicing.write' },
  { surface: 'POST /api/invoices/[invoiceId]/discard-auto-draft', kind: 'api', key: 'invoicing.write' },
  { surface: 'POST /api/invoices/[invoiceId]/issue', kind: 'api', key: 'invoicing.issue' },
  { surface: 'POST /api/invoices/[invoiceId]/issue-as-paid', kind: 'api', key: 'invoicing.issue' },
  { surface: 'POST /api/invoices/[invoiceId]/issue-auto-drafted', kind: 'api', key: 'invoicing.issue' },
  { surface: 'POST /api/invoices/[invoiceId]/pay', kind: 'api', key: 'invoicing.write' },
  { surface: 'POST /api/invoices/[invoiceId]/resend', kind: 'api', key: 'invoicing.write' },
  { surface: 'POST /api/invoices/[invoiceId]/void', kind: 'api', key: 'invoicing.void' },
  { surface: 'POST /api/invoices/[invoiceId]/zero-rate-cert-upload', kind: 'api', key: 'invoicing.write' },
  { surface: 'POST /api/members', kind: 'api', key: 'members.write' },
  { surface: 'POST /api/members/bulk', kind: 'api', key: 'members.bulk' },
  { surface: 'POST /api/members/[memberId]/archive', kind: 'api', key: 'members.write' },
  { surface: 'POST /api/members/[memberId]/contacts', kind: 'api', key: 'contacts.write' },
  { surface: 'POST /api/members/[memberId]/contacts/[contactId]/invite-portal', kind: 'api', key: 'contacts.write' },
  { surface: 'POST /api/members/[memberId]/contacts/[contactId]/promote-primary', kind: 'api', key: 'contacts.write' },
  { surface: 'POST /api/members/[memberId]/contacts/[contactId]/resend-invite', kind: 'api', key: 'contacts.write' },
  { surface: 'POST /api/members/[memberId]/contacts/[contactId]/resend-verification', kind: 'api', key: 'contacts.write' },
  { surface: 'POST /api/members/[memberId]/erase', kind: 'api', key: 'members.erasure' },
  { surface: 'POST /api/members/[memberId]/undelete', kind: 'api', key: 'members.write' },
  { surface: 'POST /api/plans', kind: 'api', key: 'plans.write' },
  { surface: 'POST /api/plans/clone', kind: 'api', key: 'plans.clone' },
  { surface: 'POST /api/plans/[year]/[planId]/activate', kind: 'api', key: 'plans.write' },
  { surface: 'POST /api/plans/[year]/[planId]/deactivate', kind: 'api', key: 'plans.write' },
  { surface: 'POST /api/plans/[year]/[planId]/undelete', kind: 'api', key: 'plans.write' },
  { surface: 'POST /api/refunds/initiate', kind: 'api', key: 'refunds.write' },
  { surface: 'POST /api/refunds/resolve-auto-refund-failure', kind: 'api', key: 'refunds.write' },
  { surface: 'POST /api/tenant-invoice-settings/logo', kind: 'api', key: 'settings.invoicing' },
  { surface: 'PUT /api/admin/renewals/settings/schedules/[tierBucket]', kind: 'api', key: 'settings.renewal_schedules' },
];

/** Every captured surface. */
export const OBSERVED_BASELINE: readonly ObservedSurface[] = [
  ...OBSERVED_PAGES,
  ...OBSERVED_API,
];

/**
 * `/admin/compliance` is a bare `redirect('/admin/compliance/erasure-log')`
 * with no gate of its own — the 47th page. It carries no permission key and is
 * the single exemption `check:staff-page-guard` (T037) accepts.
 */
export const GUARD_EXEMPT_PAGES: readonly string[] = ['/admin/compliance'];

/**
 * Flag-ON narrowings that are DELIBERATE. Every surface whose `key` denies a
 * role that its `row` allows must appear here with a reason; the matrix test
 * computes the narrowing set from the data and fails on any entry that is not
 * listed (and on any listed entry that is no longer a narrowing).
 */
export const INTENTIONAL_NARROWINGS: Readonly<Record<string, string>> = {
  // ---- D4: the audit trail becomes a super-admin surface -------------------
  // Manager reads a redacted projection today; admin reads it in full.
  '/admin/audit': 'D4 — audit.read is superAdminOnly; manager + admin lose the viewer',
  'GET /api/admin/audit/export.csv': 'D4 — audit.read is superAdminOnly',

  // ---- D4: staff administration becomes super-admin-only -------------------
  // The six mutating routes are admin-only today; the page is ungated. Both
  // narrow to super_admin, which is the entire point of US1.
  '/admin/users': 'D4 — users.manage is superAdminOnly; the page follows the routes',
  'POST /api/auth/invite': 'D4 — users.manage is superAdminOnly (staff-role targets)',
  'POST /api/auth/users/[id]/role': 'D4 — users.manage is superAdminOnly',
  'POST /api/auth/users/[id]/disable': 'D4 — users.manage is superAdminOnly',
  'POST /api/auth/users/[id]/enable': 'D4 — users.manage is superAdminOnly',
  'POST /api/auth/users/[id]/reissue-invite': 'D4 — users.manage is superAdminOnly',
  'POST /api/auth/users/[id]/revoke-invite': 'D4 — users.manage is superAdminOnly',

  // ---- D4: irreversible PII erasure becomes super-admin-only ---------------
  '/admin/compliance/erasure-log': 'D4 — members.erasure_log_read is superAdminOnly',
  'POST /api/members/[memberId]/erase': 'D4 — members.erasure is superAdminOnly',
  '/admin/events/erasure': 'D4 — events.erasure is superAdminOnly',
  'POST /api/admin/events/erasure': 'D4 — events.erasure is superAdminOnly',
  '/admin/events/[eventId]/registrations/[registrationId]/erase':
    'D4 — events.erasure is superAdminOnly',
  'POST /api/admin/events/[eventId]/registrations/[registrationId]/erase':
    'D4 — events.erasure is superAdminOnly',

  // ---- D4: tax/numbering configuration becomes super-admin-only ------------
  '/admin/settings/invoicing': 'D4 — settings.invoicing is superAdminOnly',
  'GET /api/tenant-invoice-settings': 'D4 — settings.invoicing is superAdminOnly; manager reads it today',
  'PATCH /api/tenant-invoice-settings': 'D4 — settings.invoicing is superAdminOnly',
  'POST /api/tenant-invoice-settings/logo': 'D4 — settings.invoicing is superAdminOnly',

  // ---- design § 10: manager holds no settings.* key ------------------------
  '/admin/settings/renewals/schedules': 'design § 10 — manager holds no settings.* key',
  'GET /api/admin/renewals/settings/schedules': 'design § 10 — manager holds no settings.* key',

  // ---- PII egress asymmetry closed -----------------------------------------
  'GET /api/admin/members/[id]/data-export/[jobId]/download':
    'PII egress — creation is admin-only today; the download side is keyed to match',
};
