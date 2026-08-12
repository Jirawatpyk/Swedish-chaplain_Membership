/**
 * T015 — FROZEN pre-sweep authorization baseline (016-rbac-permissions PR 2).
 *
 * This file is the REFEREE for the whole PR-2 sweep. It records, per staff
 * surface, (a) the authorization expression observed in the code BEFORE any
 * sweep edit, (b) the `PermissionKey` that surface will declare on the flag-ON
 * leg, (c) the flag-OFF shim row, and (d) the per-role outcome the flag-OFF leg
 * MUST keep producing.
 *
 * Captured 2026-08-10 from commit `81bb1e807` (PR 1 head, zero sweep edits) by
 * a mechanical per-handler walk of `src/app/api/**​/route.ts` plus the full
 * `src/app/(staff)/admin/**​/page.tsx` guard walk pinned in
 * `specs/016-rbac-permissions/contracts/authorization-surfaces.md § 1.1`.
 *
 * ## What is OBSERVED and what is PROJECTED
 *
 * The `admin` / `manager` / `member` columns are OBSERVED: they are what the
 * pre-016 code does today, derived from the guard in the `guard` field. No
 * `super_admin` or `marketing` row can exist yet (`ASSIGNABLE_ROLES` excludes
 * both and Migration C has not run), so those two columns are the D16
 * PROJECTION the flag-OFF leg must implement: `super_admin` evaluates as
 * `admin`; `marketing` is DENIED on every staff surface.
 *
 * ## Anti-circularity
 *
 * The `cells` were computed by an INDEPENDENT re-implementation of the pre-016
 * policy rules (transcribed from the `policies.ts` doc comment, not copied from
 * its body) and are frozen here as literals. `role-endpoint-matrix.test.ts`
 * asserts the REAL `evaluateLegacyRow` — which calls the REAL `canAccess` —
 * reproduces every cell. Agreement between two independent implementations is
 * what makes the pin meaningful; the cells are never derived from the shim
 * table they are checking.
 *
 * ## Two legs, two independent fields
 *
 * `row` governs the flag-OFF leg and MUST preserve observed behaviour byte for
 * byte (SC-002). `key` governs the flag-ON leg and MAY narrow — every
 * intentional narrowing is listed in `INTENTIONAL_NARROWINGS` below and nowhere
 * else, so a narrowing can never enter silently.
 *
 * Maintenance: when the sweep converts a surface, update `guard` to the new
 * guard call in the SAME commit. `cells` must NOT change — that is the whole
 * point of the file.
 */

import type { PermissionKey } from '@/modules/auth/domain/permissions/permission-catalogue';
import type { Role } from '@/modules/auth/domain/role';

export type ObservedOutcome = 'allow' | 'deny';

/**
 * Flag-OFF shim row, mirroring `LegacyRow` in the Domain shim. Declared
 * structurally here (rather than imported) so the baseline is readable as a
 * standalone document and does not silently follow a shim refactor.
 */
export type ObservedRow =
  | { readonly kind: 'legacySessionOnly' }
  | { readonly kind: 'legacyAdminOrManager' }
  | { readonly kind: 'legacyAdminOnly' }
  | { readonly kind: 'legacyF6Guard' }
  | { readonly kind: 'mappedLegacy'; readonly resource: string; readonly action: string };

export interface ObservedSurface {
  /** Page path, or `METHOD /api/...` for a route handler. */
  readonly surface: string;
  readonly kind: 'page' | 'api';
  /** The key the surface declares on the flag-ON leg. */
  readonly key: PermissionKey;
  /** The call-site class that reproduces pre-sweep behaviour on the OFF leg. */
  readonly row: ObservedRow;
  /** The authorization expression as observed at capture time. */
  readonly guard: string;
  readonly cells: Readonly<Record<Role, ObservedOutcome>>;
}

export const OBSERVED_PAGES: readonly ObservedSurface[] = [
  { surface: '/admin', kind: 'page', key: 'dashboard.view', row: { kind: 'legacySessionOnly' }, guard: 'requireSession(\'staff\') only', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/account', kind: 'page', key: 'dashboard.view', row: { kind: 'legacySessionOnly' }, guard: 'requireSession(\'staff\') only', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/audit', kind: 'page', key: 'audit.read', row: { kind: 'legacySessionOnly' }, guard: 'requireSession(\'staff\') + f9Dashboard flag only', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/broadcasts', kind: 'page', key: 'broadcasts.read', row: { kind: 'legacySessionOnly' }, guard: 'requireSession(\'staff\') only (isReadOnlyManager is presentational)', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/broadcasts/[id]', kind: 'page', key: 'broadcasts.read', row: { kind: 'legacySessionOnly' }, guard: 'requireSession(\'staff\') only (isReadOnlyManager is presentational)', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/credit-notes/[creditNoteId]', kind: 'page', key: 'invoicing.read', row: { kind: 'legacySessionOnly' }, guard: 'requireSession(\'staff\') only', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/directory', kind: 'page', key: 'directory.export', row: { kind: 'legacySessionOnly' }, guard: 'requireSession(\'staff\') + f9Dashboard flag only', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/invoices', kind: 'page', key: 'invoicing.read', row: { kind: 'legacySessionOnly' }, guard: 'requireSession(\'staff\') only (isAdmin is presentational)', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/invoices/[invoiceId]', kind: 'page', key: 'invoicing.read', row: { kind: 'legacySessionOnly' }, guard: 'requireSession(\'staff\') only (isAdmin is presentational)', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/members', kind: 'page', key: 'members.read', row: { kind: 'legacySessionOnly' }, guard: 'requireSession(\'staff\') only', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/members/[memberId]', kind: 'page', key: 'members.read', row: { kind: 'legacySessionOnly' }, guard: 'requireSession(\'staff\') only (canWrite is presentational)', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/members/[memberId]/timeline', kind: 'page', key: 'members.read', row: { kind: 'legacySessionOnly' }, guard: 'requireSession(\'staff\') only', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/plans', kind: 'page', key: 'plans.read', row: { kind: 'legacySessionOnly' }, guard: 'requireSession(\'staff\') only', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/plans/[year]/[planId]', kind: 'page', key: 'plans.read', row: { kind: 'legacySessionOnly' }, guard: 'requireSession(\'staff\') only', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/settings', kind: 'page', key: 'dashboard.view', row: { kind: 'legacySessionOnly' }, guard: 'requireSession(\'staff\') only', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/settings/invoicing', kind: 'page', key: 'settings.invoicing', row: { kind: 'legacySessionOnly' }, guard: 'requireSession(\'staff\') only (canEdit is presentational)', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/users', kind: 'page', key: 'users.manage', row: { kind: 'legacySessionOnly' }, guard: 'requireSession(\'staff\') only (InviteUserDialog disabled= is presentational)', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/credit-notes', kind: 'page', key: 'invoicing.read', row: { kind: 'legacyAdminOrManager' }, guard: 'role !== \'admin\' && role !== \'manager\' -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/events', kind: 'page', key: 'events.read', row: { kind: 'legacyAdminOrManager' }, guard: 'role !== \'admin\' && role !== \'manager\' -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/events/[eventId]', kind: 'page', key: 'events.read', row: { kind: 'legacyAdminOrManager' }, guard: 'role !== \'admin\' && role !== \'manager\' -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/members/[memberId]/benefits', kind: 'page', key: 'members.read', row: { kind: 'legacyAdminOrManager' }, guard: 'role !== \'admin\' && role !== \'manager\' -> THROW (500), BELOW the PII reads', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/renewals', kind: 'page', key: 'renewals.read', row: { kind: 'legacyAdminOrManager' }, guard: 'role !== \'admin\' && role !== \'manager\' -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/renewals/[cycleId]', kind: 'page', key: 'renewals.read', row: { kind: 'legacyAdminOrManager' }, guard: 'role !== \'admin\' && role !== \'manager\' -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/renewals/tasks', kind: 'page', key: 'renewals.read', row: { kind: 'legacyAdminOrManager' }, guard: 'role !== \'admin\' && role !== \'manager\' -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/settings/renewals/schedules', kind: 'page', key: 'settings.renewal_schedules', row: { kind: 'legacyAdminOrManager' }, guard: 'role !== \'admin\' && role !== \'manager\' -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/broadcasts/new', kind: 'page', key: 'broadcasts.write', row: { kind: 'legacyAdminOnly' }, guard: 'role !== \'admin\' -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/broadcasts/templates', kind: 'page', key: 'broadcasts.write', row: { kind: 'legacyAdminOnly' }, guard: 'role !== \'admin\' -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/broadcasts/templates/new', kind: 'page', key: 'broadcasts.write', row: { kind: 'legacyAdminOnly' }, guard: 'role !== \'admin\' -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/broadcasts/templates/[id]/edit', kind: 'page', key: 'broadcasts.write', row: { kind: 'legacyAdminOnly' }, guard: 'role !== \'admin\' -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/compliance/erasure-log', kind: 'page', key: 'members.erasure_log_read', row: { kind: 'legacyAdminOnly' }, guard: 'role !== \'admin\' -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/events/[eventId]/registrations/[registrationId]/erase', kind: 'page', key: 'events.erasure', row: { kind: 'legacyAdminOnly' }, guard: 'role !== \'admin\' -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/events/erasure', kind: 'page', key: 'events.erasure', row: { kind: 'legacyAdminOnly' }, guard: 'role !== \'admin\' -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/events/import', kind: 'page', key: 'events.write', row: { kind: 'legacyAdminOnly' }, guard: 'role !== \'admin\' -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/events/import/history', kind: 'page', key: 'events.write', row: { kind: 'legacyAdminOnly' }, guard: 'role !== \'admin\' -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/invoices/new', kind: 'page', key: 'invoicing.write', row: { kind: 'legacyAdminOnly' }, guard: 'role !== \'admin\' -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/invoices/registers', kind: 'page', key: 'invoicing.receipt', row: { kind: 'legacyAdminOnly' }, guard: 'role !== \'admin\' || !f088TaxAtPayment -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/invoices/[invoiceId]/void', kind: 'page', key: 'invoicing.void', row: { kind: 'legacyAdminOnly' }, guard: 'role !== \'admin\' -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/invoices/[invoiceId]/credit-notes/new', kind: 'page', key: 'credit_notes.write', row: { kind: 'legacyAdminOnly' }, guard: 'role !== \'admin\' -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/members/new', kind: 'page', key: 'members.write', row: { kind: 'legacyAdminOnly' }, guard: 'role !== \'admin\' -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/members/[memberId]/edit', kind: 'page', key: 'members.write', row: { kind: 'legacyAdminOnly' }, guard: 'role !== \'admin\' -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/plans/new', kind: 'page', key: 'plans.write', row: { kind: 'legacyAdminOnly' }, guard: 'role !== \'admin\' -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/plans/clone', kind: 'page', key: 'plans.clone', row: { kind: 'legacyAdminOnly' }, guard: 'role !== \'admin\' -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/plans/[year]/[planId]/edit', kind: 'page', key: 'plans.write', row: { kind: 'legacyAdminOnly' }, guard: 'role !== \'admin\' -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/renewals/tier-upgrades', kind: 'page', key: 'renewals.write', row: { kind: 'legacyAdminOnly' }, guard: 'role !== \'admin\' -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/settings/broadcasts', kind: 'page', key: 'settings.broadcasts', row: { kind: 'legacyAdminOnly' }, guard: 'role !== \'admin\' -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: '/admin/settings/integrations/eventcreate', kind: 'page', key: 'settings.integrations', row: { kind: 'legacyAdminOnly' }, guard: 'role !== \'admin\' -> notFound()', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
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
  { surface: 'DELETE /api/admin/broadcasts/templates/[id]', kind: 'api', key: 'broadcasts.write', row: { kind: 'mappedLegacy', resource: 'broadcast', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'broadcast\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'DELETE /api/invoices/[invoiceId]', kind: 'api', key: 'invoicing.write', row: { kind: 'mappedLegacy', resource: 'invoice', action: 'delete' }, guard: 'requireAdminContext(request, { resource: \'invoice\', action: \'delete\' }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'DELETE /api/members/[memberId]/contacts/[contactId]', kind: 'api', key: 'contacts.write', row: { kind: 'mappedLegacy', resource: 'contacts', action: 'delete' }, guard: 'requireAdminContext(request, { resource: \'contacts\', action: \'delete\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'DELETE /api/plans/[year]/[planId]', kind: 'api', key: 'plans.write', row: { kind: 'mappedLegacy', resource: 'plan', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'plan\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/admin/audit/export.csv', kind: 'api', key: 'audit.read', row: { kind: 'legacyAdminOrManager' }, guard: 'requireSession(\'staff\') ; role !== \'admin\' ; role !== \'manager\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/admin/broadcasts', kind: 'api', key: 'broadcasts.read', row: { kind: 'mappedLegacy', resource: 'broadcast', action: 'read' }, guard: 'requireAdminContext(request, { resource: \'broadcast\', action: \'read\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/admin/broadcasts/sla-stats', kind: 'api', key: 'broadcasts.read', row: { kind: 'mappedLegacy', resource: 'broadcast', action: 'read' }, guard: 'requireAdminContext(request, { resource: \'broadcast\', action: \'read\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/admin/broadcasts/templates', kind: 'api', key: 'broadcasts.read', row: { kind: 'mappedLegacy', resource: 'broadcast', action: 'read' }, guard: 'requireAdminContext(request, { resource: \'broadcast\', action: \'read\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/admin/directory/exports/[jobId]/download', kind: 'api', key: 'directory.export', row: { kind: 'legacyAdminOrManager' }, guard: 'getCurrentSession() ; role === \'member\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/admin/events', kind: 'api', key: 'events.read', row: { kind: 'legacyAdminOrManager' }, guard: 'getCurrentSession() ; role !== \'admin\' ; role !== \'manager\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/admin/events/[eventId]', kind: 'api', key: 'events.read', row: { kind: 'legacyAdminOrManager' }, guard: 'requireSession(\'staff\') ; getCurrentSession() ; role !== \'admin\' ; role !== \'manager\' ; role === \'admin\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/admin/events/import/history', kind: 'api', key: 'events.write', row: { kind: 'legacyF6Guard' }, guard: 'adminOnlyGuard', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/admin/events/import/[recordId]/error-csv', kind: 'api', key: 'events.write', row: { kind: 'legacyF6Guard' }, guard: 'adminOnlyGuard', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/admin/integrations/eventcreate', kind: 'api', key: 'settings.integrations', row: { kind: 'legacyF6Guard' }, guard: 'adminOnlyGuard', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/admin/invoices/export.csv', kind: 'api', key: 'invoicing.read', row: { kind: 'mappedLegacy', resource: 'invoice', action: 'read' }, guard: 'requireAdminContext(request, { resource: \'invoice\', action: \'read\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/admin/members/export.zip', kind: 'api', key: 'members.bulk', row: { kind: 'mappedLegacy', resource: 'members:bulk', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'members:bulk\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/admin/members/[id]/data-export/[jobId]/download', kind: 'api', key: 'members.bulk', row: { kind: 'mappedLegacy', resource: 'members', action: 'read' }, guard: 'requireAdminContext(request, { resource: \'members\', action: \'read\' }', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/admin/members/search', kind: 'api', key: 'members.read', row: { kind: 'mappedLegacy', resource: 'member', action: 'read' }, guard: 'requireAdminContext(request, { resource: \'member\', action: \'read\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/admin/renewals', kind: 'api', key: 'renewals.read', row: { kind: 'mappedLegacy', resource: 'renewal', action: 'read' }, guard: 'requireRenewalAdminContext(request, \'read\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/admin/renewals/at-risk', kind: 'api', key: 'renewals.read', row: { kind: 'mappedLegacy', resource: 'renewal', action: 'read' }, guard: 'requireRenewalAdminContext(request, \'read\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/admin/renewals/[cycleId]', kind: 'api', key: 'renewals.read', row: { kind: 'mappedLegacy', resource: 'renewal', action: 'read' }, guard: 'requireRenewalAdminContext(request, \'read\' ; role === \'admin\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/admin/renewals/settings/schedules', kind: 'api', key: 'settings.renewal_schedules', row: { kind: 'mappedLegacy', resource: 'renewal', action: 'read' }, guard: 'requireRenewalAdminContext(request, \'read\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/admin/renewals/settlement-preview', kind: 'api', key: 'renewals.read', row: { kind: 'mappedLegacy', resource: 'renewal', action: 'read' }, guard: 'requireRenewalAdminContext(request, \'read\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/admin/renewals/tasks', kind: 'api', key: 'renewals.read', row: { kind: 'mappedLegacy', resource: 'renewal', action: 'read' }, guard: 'requireRenewalAdminContext(request, \'read\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/admin/renewals/tier-upgrades', kind: 'api', key: 'renewals.write', row: { kind: 'mappedLegacy', resource: 'renewal', action: 'write' }, guard: 'requireRenewalAdminContext(request, \'write\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/admin/users/staff-active', kind: 'api', key: 'renewals.read', row: { kind: 'legacyAdminOrManager' }, guard: 'requireSession(\'staff\') ; role !== \'admin\' ; role !== \'manager\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/credit-notes/[creditNoteId]', kind: 'api', key: 'invoicing.read', row: { kind: 'mappedLegacy', resource: 'credit_note', action: 'read' }, guard: 'requireAdminContext(request, { resource: \'credit_note\', action: \'read\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/credit-notes/[creditNoteId]/pdf', kind: 'api', key: 'invoicing.read', row: { kind: 'mappedLegacy', resource: 'credit_note', action: 'read' }, guard: 'requireAdminContext(request, { resource: \'credit_note\', action: \'read\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/geo/postal/[code]', kind: 'api', key: 'members.read', row: { kind: 'mappedLegacy', resource: 'members', action: 'read' }, guard: 'requireAdminContext(request, { resource: \'members\', action: \'read\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/invoices', kind: 'api', key: 'invoicing.read', row: { kind: 'mappedLegacy', resource: 'invoice', action: 'read' }, guard: 'requireAdminContext(request, { resource: \'invoice\', action: \'read\' }', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/invoices/[invoiceId]', kind: 'api', key: 'invoicing.read', row: { kind: 'mappedLegacy', resource: 'invoice', action: 'read' }, guard: 'requireAdminContext(request, { resource: \'invoice\', action: \'read\' }', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/invoices/[invoiceId]/pdf', kind: 'api', key: 'invoicing.read', row: { kind: 'mappedLegacy', resource: 'invoice', action: 'read' }, guard: 'requireAdminContext(request, { resource: \'invoice\', action: \'read\' }', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/invoices/[invoiceId]/preview', kind: 'api', key: 'invoicing.write', row: { kind: 'mappedLegacy', resource: 'invoice', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'invoice\', action: \'write\' }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/invoices/[invoiceId]/receipt/pdf', kind: 'api', key: 'invoicing.read', row: { kind: 'mappedLegacy', resource: 'invoice', action: 'read' }, guard: 'requireAdminContext(request, { resource: \'invoice\', action: \'read\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/invoices/[invoiceId]/zero-rate-cert', kind: 'api', key: 'invoicing.read', row: { kind: 'mappedLegacy', resource: 'invoice', action: 'read' }, guard: 'requireAdminContext(request, { resource: \'invoice\', action: \'read\' } ; role === \'manager\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/invoices/member-renewal-context', kind: 'api', key: 'invoicing.read', row: { kind: 'mappedLegacy', resource: 'invoice', action: 'read' }, guard: 'requireAdminContext(request, { resource: \'invoice\', action: \'read\' }', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/members', kind: 'api', key: 'members.read', row: { kind: 'mappedLegacy', resource: 'members', action: 'read' }, guard: 'requireAdminContext(request, { resource: \'members\', action: \'read\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/members/ids', kind: 'api', key: 'members.read', row: { kind: 'mappedLegacy', resource: 'members', action: 'read' }, guard: 'requireAdminContext(request, { resource: \'members\', action: \'read\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/members/[memberId]', kind: 'api', key: 'members.read', row: { kind: 'mappedLegacy', resource: 'members', action: 'read' }, guard: 'requireAdminContext(request, { resource: \'members\', action: \'read\', } ; role === \'admin\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/members/[memberId]/invoices', kind: 'api', key: 'invoicing.read', row: { kind: 'mappedLegacy', resource: 'invoice', action: 'read' }, guard: 'requireAdminContext(request, { resource: \'invoice\', action: \'read\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/members/[memberId]/timeline', kind: 'api', key: 'members.read', row: { kind: 'mappedLegacy', resource: 'members', action: 'read' }, guard: 'requireAdminContext(request, { resource: \'members\', action: \'read\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/plans', kind: 'api', key: 'plans.read', row: { kind: 'mappedLegacy', resource: 'plan', action: 'read' }, guard: 'requireAdminContext(request, { resource: \'plan\', action: \'read\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  // 016 T064 — DELIBERATE widening, the only baseline row PR 4 moves. The ⌘K
  // palette is not a plans surface; it is the entry point to every staff
  // surface, and each entry now carries its own destination permission (see
  // palette-permission-parity.test.ts). Guarding the endpoint on `plans.read`
  // denied it wholesale to `marketing`, whose bundle carries members +
  // broadcasts + events, so its palette came back empty. The KEY widens to
  // `dashboard.view`; the legacy ROW is unchanged, so the OFF-leg population is
  // byte-identical. Plan HITS are re-gated on `plans.read` inside the handler —
  // so `marketing: 'allow'` here means "reaches the endpoint", not "sees plans".
  { surface: 'GET /api/plans/search', kind: 'api', key: 'dashboard.view', row: { kind: 'mappedLegacy', resource: 'plan', action: 'read' }, guard: 'requireApiPermission(request, \'dashboard.view\', mappedLegacy(\'plan\', \'read\'))', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/plans/[year]/[planId]', kind: 'api', key: 'plans.read', row: { kind: 'mappedLegacy', resource: 'plan', action: 'read' }, guard: 'requireAdminContext(request, { resource: \'plan\', action: \'read\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/plans/[year]/[planId]/affected-members', kind: 'api', key: 'members.read', row: { kind: 'mappedLegacy', resource: 'members', action: 'read' }, guard: 'requireAdminContext(request, { resource: \'members\', action: \'read\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'GET /api/tenant-invoice-settings', kind: 'api', key: 'settings.invoicing', row: { kind: 'mappedLegacy', resource: 'tenant_invoice_settings', action: 'read' }, guard: 'requireAdminContext(request, { resource: \'tenant_invoice_settings\', action: \'read\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'PATCH /api/admin/broadcasts/templates/[id]', kind: 'api', key: 'broadcasts.write', row: { kind: 'mappedLegacy', resource: 'broadcast', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'broadcast\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'PATCH /api/admin/members/[id]/preferred-locale', kind: 'api', key: 'members.write', row: { kind: 'mappedLegacy', resource: 'members', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'members\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'PATCH /api/members/[memberId]', kind: 'api', key: 'members.write', row: { kind: 'mappedLegacy', resource: 'members', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'members\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'PATCH /api/members/[memberId]/contacts/[contactId]', kind: 'api', key: 'contacts.write', row: { kind: 'mappedLegacy', resource: 'contacts', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'contacts\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'PATCH /api/members/[memberId]/inline-edit', kind: 'api', key: 'members.write', row: { kind: 'mappedLegacy', resource: 'members', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'members\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'PATCH /api/plans/[year]/[planId]', kind: 'api', key: 'plans.write', row: { kind: 'mappedLegacy', resource: 'plan', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'plan\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'PATCH /api/tenant-invoice-settings', kind: 'api', key: 'settings.invoicing', row: { kind: 'mappedLegacy', resource: 'tenant_invoice_settings', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'tenant_invoice_settings\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/broadcasts/[id]/accept-partial', kind: 'api', key: 'broadcasts.send', row: { kind: 'mappedLegacy', resource: 'broadcast', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'broadcast\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/broadcasts/[id]/approve', kind: 'api', key: 'broadcasts.send', row: { kind: 'mappedLegacy', resource: 'broadcast', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'broadcast\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/broadcasts/[id]/cancel', kind: 'api', key: 'broadcasts.write', row: { kind: 'mappedLegacy', resource: 'broadcast', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'broadcast\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/broadcasts/[id]/reject', kind: 'api', key: 'broadcasts.write', row: { kind: 'mappedLegacy', resource: 'broadcast', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'broadcast\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/broadcasts/[id]/retry', kind: 'api', key: 'broadcasts.send', row: { kind: 'mappedLegacy', resource: 'broadcast', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'broadcast\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/broadcasts/proxy-submit', kind: 'api', key: 'broadcasts.send', row: { kind: 'mappedLegacy', resource: 'broadcast', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'broadcast\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/broadcasts/settings/allowlist', kind: 'api', key: 'settings.broadcasts', row: { kind: 'mappedLegacy', resource: 'broadcast', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'broadcast\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/broadcasts/templates', kind: 'api', key: 'broadcasts.write', row: { kind: 'mappedLegacy', resource: 'broadcast', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'broadcast\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/directory/exports', kind: 'api', key: 'directory.export', row: { kind: 'legacyAdminOrManager' }, guard: 'getCurrentSession() ; role === \'member\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/events', kind: 'api', key: 'events.write', row: { kind: 'legacyF6Guard' }, guard: 'adminOnlyWriterGuard', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/events/erasure', kind: 'api', key: 'events.erasure', row: { kind: 'legacyF6Guard' }, guard: 'adminOnlyWriterGuard', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/events/[eventId]/archive', kind: 'api', key: 'events.write', row: { kind: 'legacyF6Guard' }, guard: 'adminOnlyWriterGuard', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/events/[eventId]/registrations/[registrationId]/erase', kind: 'api', key: 'events.erasure', row: { kind: 'legacyF6Guard' }, guard: 'adminOnlyWriterGuard', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/events/[eventId]/registrations/[registrationId]/relink', kind: 'api', key: 'events.relink', row: { kind: 'legacyF6Guard' }, guard: 'adminOnlyWriterGuard', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/events/[eventId]/toggle-cultural-event', kind: 'api', key: 'events.write', row: { kind: 'legacyF6Guard' }, guard: 'adminOnlyWriterGuard', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/events/[eventId]/toggle-partner-benefit', kind: 'api', key: 'events.write', row: { kind: 'legacyF6Guard' }, guard: 'adminOnlyWriterGuard', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/events/import', kind: 'api', key: 'events.write', row: { kind: 'legacyF6Guard' }, guard: 'adminOnlyWriterGuard', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/insights/dismiss', kind: 'api', key: 'insights.engagement', row: { kind: 'legacyAdminOrManager' }, guard: 'getCurrentSession() ; role === \'member\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/integrations/eventcreate/disable', kind: 'api', key: 'settings.integrations', row: { kind: 'legacyF6Guard' }, guard: 'adminOnlyGuard', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/integrations/eventcreate/generate-secret', kind: 'api', key: 'settings.integrations', row: { kind: 'legacyF6Guard' }, guard: 'adminOnlyGuard', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/integrations/eventcreate/rotate-secret', kind: 'api', key: 'settings.integrations', row: { kind: 'legacyF6Guard' }, guard: 'adminOnlyGuard', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/integrations/eventcreate/test-webhook', kind: 'api', key: 'settings.integrations', row: { kind: 'legacyF6Guard' }, guard: 'adminOnlyGuard ; Webhook(', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/members/[id]/block-auto-reactivation', kind: 'api', key: 'renewals.write', row: { kind: 'mappedLegacy', resource: 'renewal', action: 'write' }, guard: 'requireRenewalAdminContext(request, \'write\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/members/[id]/broadcasts-halt-clear', kind: 'api', key: 'broadcasts.write', row: { kind: 'mappedLegacy', resource: 'broadcast', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'broadcast\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/members/[id]/data-export', kind: 'api', key: 'members.bulk', row: { kind: 'mappedLegacy', resource: 'members', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'members\', action: \'write\' }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/members/[id]/renew', kind: 'api', key: 'renewals.write', row: { kind: 'mappedLegacy', resource: 'renewal', action: 'write' }, guard: 'requireRenewalAdminContext(request, \'write\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/members/[id]/unblock-auto-reactivation', kind: 'api', key: 'renewals.write', row: { kind: 'mappedLegacy', resource: 'renewal', action: 'write' }, guard: 'requireRenewalAdminContext(request, \'write\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/renewals/at-risk/[memberId]/outreach', kind: 'api', key: 'renewals.read', row: { kind: 'mappedLegacy', resource: 'renewal', action: 'read' }, guard: 'requireRenewalAdminContext(request, \'manager_exception\' ; role === \'manager\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'allow', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/renewals/at-risk/[memberId]/snooze', kind: 'api', key: 'renewals.write', row: { kind: 'mappedLegacy', resource: 'renewal', action: 'write' }, guard: 'requireRenewalAdminContext(request, \'write\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/renewals/[cycleId]/cancel', kind: 'api', key: 'renewals.write', row: { kind: 'mappedLegacy', resource: 'renewal', action: 'write' }, guard: 'requireRenewalAdminContext(request, \'write\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/renewals/[cycleId]/mark-paid-offline', kind: 'api', key: 'renewals.write', row: { kind: 'mappedLegacy', resource: 'renewal', action: 'write' }, guard: 'requireRenewalAdminContext(request, \'write\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/renewals/[cycleId]/reactivate', kind: 'api', key: 'renewals.write', row: { kind: 'mappedLegacy', resource: 'renewal', action: 'write' }, guard: 'requireRenewalAdminContext(request, \'write\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/renewals/[cycleId]/reject', kind: 'api', key: 'renewals.write', row: { kind: 'mappedLegacy', resource: 'renewal', action: 'write' }, guard: 'requireRenewalAdminContext(request, \'write\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/renewals/[cycleId]/send-reminder-now', kind: 'api', key: 'renewals.write', row: { kind: 'mappedLegacy', resource: 'renewal', action: 'write' }, guard: 'requireRenewalAdminContext(request, \'write\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/renewals/tasks/[taskId]/done', kind: 'api', key: 'renewals.write', row: { kind: 'mappedLegacy', resource: 'renewal', action: 'write' }, guard: 'requireRenewalAdminContext(request, \'write\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/renewals/tasks/[taskId]/reassign', kind: 'api', key: 'renewals.write', row: { kind: 'mappedLegacy', resource: 'renewal', action: 'write' }, guard: 'requireRenewalAdminContext(request, \'write\' ; role !== \'admin\' ; role !== \'manager\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/renewals/tasks/[taskId]/skip', kind: 'api', key: 'renewals.write', row: { kind: 'mappedLegacy', resource: 'renewal', action: 'write' }, guard: 'requireRenewalAdminContext(request, \'write\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/renewals/tier-upgrades/[suggestionId]/accept', kind: 'api', key: 'renewals.write', row: { kind: 'mappedLegacy', resource: 'renewal', action: 'write' }, guard: 'requireRenewalAdminContext(request, \'write\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/renewals/tier-upgrades/[suggestionId]/dismiss', kind: 'api', key: 'renewals.write', row: { kind: 'mappedLegacy', resource: 'renewal', action: 'write' }, guard: 'requireRenewalAdminContext(request, \'write\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/renewals/tier-upgrades/[suggestionId]/escalate', kind: 'api', key: 'renewals.write', row: { kind: 'mappedLegacy', resource: 'renewal', action: 'write' }, guard: 'requireRenewalAdminContext(request, \'write\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/admin/scheduled-plan-changes/[id]/cancel', kind: 'api', key: 'plans.write', row: { kind: 'mappedLegacy', resource: 'plan', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'plan\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/auth/invite', kind: 'api', key: 'users.manage', row: { kind: 'mappedLegacy', resource: 'auth:user', action: 'write' }, guard: 'requireAdminContext(request ; role !== \'member\' ; role === \'member\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/auth/users/[id]/disable', kind: 'api', key: 'users.manage', row: { kind: 'mappedLegacy', resource: 'auth:user', action: 'write' }, guard: 'requireAdminContext(request', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/auth/users/[id]/enable', kind: 'api', key: 'users.manage', row: { kind: 'mappedLegacy', resource: 'auth:user', action: 'write' }, guard: 'requireAdminContext(request', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/auth/users/[id]/reissue-invite', kind: 'api', key: 'users.manage', row: { kind: 'mappedLegacy', resource: 'auth:user', action: 'write' }, guard: 'requireAdminContext(request', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/auth/users/[id]/revoke-invite', kind: 'api', key: 'users.manage', row: { kind: 'mappedLegacy', resource: 'auth:user', action: 'write' }, guard: 'requireAdminContext(request', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/auth/users/[id]/role', kind: 'api', key: 'users.manage', row: { kind: 'mappedLegacy', resource: 'auth:user', action: 'write' }, guard: 'requireAdminContext(request', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/credit-notes', kind: 'api', key: 'credit_notes.write', row: { kind: 'mappedLegacy', resource: 'credit_note', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'credit_note\', action: \'write\', } ; role !== \'admin\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/credit-notes/[creditNoteId]/resend', kind: 'api', key: 'credit_notes.write', row: { kind: 'mappedLegacy', resource: 'credit_note', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'credit_note\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/invoices', kind: 'api', key: 'invoicing.write', row: { kind: 'mappedLegacy', resource: 'invoice', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'invoice\', action: \'write\' }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/invoices/event-draft', kind: 'api', key: 'invoicing.write', row: { kind: 'mappedLegacy', resource: 'invoice', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'invoice\', action: \'write\' }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/invoices/[invoiceId]/discard-auto-draft', kind: 'api', key: 'invoicing.write', row: { kind: 'mappedLegacy', resource: 'invoice', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'invoice\', action: \'write\' }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/invoices/[invoiceId]/issue', kind: 'api', key: 'invoicing.issue', row: { kind: 'mappedLegacy', resource: 'invoice', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'invoice\', action: \'write\' }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/invoices/[invoiceId]/issue-as-paid', kind: 'api', key: 'invoicing.issue', row: { kind: 'mappedLegacy', resource: 'invoice', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'invoice\', action: \'write\' }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/invoices/[invoiceId]/issue-auto-drafted', kind: 'api', key: 'invoicing.issue', row: { kind: 'mappedLegacy', resource: 'invoice', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'invoice\', action: \'write\' }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/invoices/[invoiceId]/pay', kind: 'api', key: 'invoicing.write', row: { kind: 'mappedLegacy', resource: 'invoice', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'invoice\', action: \'write\' }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/invoices/[invoiceId]/resend', kind: 'api', key: 'invoicing.write', row: { kind: 'mappedLegacy', resource: 'invoice', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'invoice\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/invoices/[invoiceId]/void', kind: 'api', key: 'invoicing.void', row: { kind: 'mappedLegacy', resource: 'invoice', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'invoice\', action: \'write\' } ; role !== \'admin\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/invoices/[invoiceId]/zero-rate-cert-upload', kind: 'api', key: 'invoicing.write', row: { kind: 'mappedLegacy', resource: 'invoice', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'invoice\', action: \'write\' }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/members', kind: 'api', key: 'members.write', row: { kind: 'mappedLegacy', resource: 'members', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'members\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/members/bulk', kind: 'api', key: 'members.bulk', row: { kind: 'mappedLegacy', resource: 'members:bulk', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'members:bulk\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/members/[memberId]/archive', kind: 'api', key: 'members.write', row: { kind: 'mappedLegacy', resource: 'members', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'members\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/members/[memberId]/contacts', kind: 'api', key: 'contacts.write', row: { kind: 'mappedLegacy', resource: 'contacts', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'contacts\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/members/[memberId]/contacts/[contactId]/invite-portal', kind: 'api', key: 'contacts.write', row: { kind: 'mappedLegacy', resource: 'contacts', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'contacts\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/members/[memberId]/contacts/[contactId]/promote-primary', kind: 'api', key: 'contacts.write', row: { kind: 'mappedLegacy', resource: 'contacts', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'contacts\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/members/[memberId]/contacts/[contactId]/resend-invite', kind: 'api', key: 'contacts.write', row: { kind: 'mappedLegacy', resource: 'members', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'members\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/members/[memberId]/contacts/[contactId]/resend-verification', kind: 'api', key: 'contacts.write', row: { kind: 'mappedLegacy', resource: 'members', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'members\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/members/[memberId]/erase', kind: 'api', key: 'members.erasure', row: { kind: 'mappedLegacy', resource: 'members', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'members\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/members/[memberId]/undelete', kind: 'api', key: 'members.write', row: { kind: 'mappedLegacy', resource: 'members', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'members\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/plans', kind: 'api', key: 'plans.write', row: { kind: 'mappedLegacy', resource: 'plan', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'plan\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/plans/clone', kind: 'api', key: 'plans.clone', row: { kind: 'mappedLegacy', resource: 'plan', action: 'clone' }, guard: 'requireAdminContext(request, { resource: \'plan\', action: \'clone\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/plans/[year]/[planId]/activate', kind: 'api', key: 'plans.write', row: { kind: 'mappedLegacy', resource: 'plan', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'plan\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/plans/[year]/[planId]/deactivate', kind: 'api', key: 'plans.write', row: { kind: 'mappedLegacy', resource: 'plan', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'plan\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/plans/[year]/[planId]/undelete', kind: 'api', key: 'plans.write', row: { kind: 'mappedLegacy', resource: 'plan', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'plan\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/refunds/initiate', kind: 'api', key: 'refunds.write', row: { kind: 'mappedLegacy', resource: 'refund', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'refund\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/refunds/resolve-auto-refund-failure', kind: 'api', key: 'refunds.write', row: { kind: 'mappedLegacy', resource: 'refund', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'refund\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'POST /api/tenant-invoice-settings/logo', kind: 'api', key: 'settings.invoicing', row: { kind: 'mappedLegacy', resource: 'tenant_invoice_settings', action: 'write' }, guard: 'requireAdminContext(request, { resource: \'tenant_invoice_settings\', action: \'write\', }', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
  { surface: 'PUT /api/admin/renewals/settings/schedules/[tierBucket]', kind: 'api', key: 'settings.renewal_schedules', row: { kind: 'mappedLegacy', resource: 'renewal', action: 'write' }, guard: 'requireRenewalAdminContext(request, \'write\'', cells: { super_admin: 'allow', admin: 'allow', manager: 'deny', marketing: 'deny', member: 'deny' } },
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
