/**
 * `search-plans` use case (T074, US1 → US6 command palette backend).
 *
 * In-memory filter over the current year's plans + static action +
 * navigate registries. Role-filtered: admin sees every action;
 * manager sees only read-category items; member role should never
 * reach this use case (blocked by route handler + RBAC).
 *
 * No backend search engine — for 9 plans per tenant × ~20 tenants the
 * array filter is <1ms and has no deployment surface. When the
 * palette expands to cross-entity search (members + invoices + events
 * in F7+), revisit the Typesense/Meilisearch decision.
 */

import { err, ok, type Result } from '@/lib/result';
import { errKind } from '@/lib/log-id';
// Type-only import from the deep domain path. Importing from the
// `@/modules/auth` barrel here would chain-pull the heartbeat use case
// → auth-deps → `@node-rs/argon2` into the client bundle the moment
// any client component re-exports this file via the plans barrel.
// See plans/domain/policies.ts for the full rationale.
import type { Role } from '@/modules/auth/domain/role';
import type { TenantContext } from '@/modules/tenants';
import type { ClockPort, PlanRepo } from './ports';
import { asPlanYear, type Plan, type PlanCategory } from '../domain/plan';
import { pickLocaleText, type LocaleKey } from '../domain/locale-text';

// --- Types --------------------------------------------------------------------

export type SearchPlansInput = {
  readonly q: string;
  readonly limit?: number;
  readonly role: Role;
  readonly activeLocale: LocaleKey;
};

export type PalettePlanHit = {
  readonly plan_id: string;
  readonly plan_year: number;
  readonly plan_name: string; // already resolved to active locale
  readonly category: PlanCategory;
  readonly is_active: boolean;
  readonly url: string;
};

/**
 * Kill-switch tag for a palette entry whose destination is gated behind an env
 * feature flag. When the flag is OFF, the entry's target route is proxy-503'd
 * (F7 broadcasts → `/admin/broadcasts/**`), `notFound()` (F6 events →
 * `/admin/events/**`), or simply absent (088 §86/4 receipt re-render), so
 * surfacing the entry in ⌘K would be a dead-end jump. The Presentation layer
 * (the `/api/plans/search` route) strips tagged entries via
 * `filterPaletteEntriesByFeature`; the Application layer never reads `env`
 * (Principle III) — the tag is pure data (an `env.features` key NAME).
 */
export type PaletteFeatureFlag =
  | 'f6EventCreate'
  | 'f7Broadcasts'
  | 'f088TaxAtPayment';

export type PaletteActionItem = {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  /**
   * Extra search synonyms matched (case-insensitively) alongside the id and
   * i18n key. The visible label ("Create new plan") is only known after the
   * Presentation layer resolves the i18n key, so the backend can't match on
   * it — without synonyms, typing the leading verb "create" finds nothing
   * (BUG-024). Keep these in English; localized label search is a separate
   * follow-up.
   */
  readonly keywords?: readonly string[];
  /** See {@link PaletteFeatureFlag} — stripped by the route when the flag is OFF. */
  readonly feature?: PaletteFeatureFlag;
};

export type PaletteNavigateItem = {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  /** See {@link PaletteFeatureFlag} — stripped by the route when the flag is OFF. */
  readonly feature?: PaletteFeatureFlag;
};

export type SearchPlansSuccess = {
  readonly results: {
    readonly plans: ReadonlyArray<PalettePlanHit>;
    readonly actions: ReadonlyArray<PaletteActionItem>;
    readonly navigate: ReadonlyArray<PaletteNavigateItem>;
  };
};

export type SearchPlansError =
  // `errKind` is a SAFE error classifier (constructor name, e.g.
  // 'NeonDbError') — never the raw `e.message`, which on a Postgres
  // failure can carry SQL fragments / table + column names that must
  // not reach the log sink (log-hygiene; n43 / Wave-0 leak fix).
  | { readonly type: 'server_error'; readonly errKind: string };

export type SearchPlansDeps = {
  readonly tenant: TenantContext;
  readonly planRepo: PlanRepo;
  readonly clock: ClockPort;
};

// --- Static action + navigate registries ------------------------------------

type ActionEntry = PaletteActionItem & { readonly requires: 'admin' | 'read' };
type NavigateEntry = PaletteNavigateItem & { readonly requires: 'admin' | 'read' };

const ACTION_REGISTRY: ReadonlyArray<ActionEntry> = [
  { id: 'plan.new', label: 'palette.actions.newPlan', url: '/admin/plans/new', requires: 'admin', keywords: ['create', 'add'] },
  {
    id: 'plan.clone',
    label: 'palette.actions.cloneYear',
    url: '/admin/plans/clone',
    requires: 'admin',
  },
  // R8 consolidation — Fee Configuration palette entry removed.
  // Admins now edit VAT + currency + registration fee via Invoice
  // Settings (/admin/settings/invoicing). Palette has a separate
  // 'invoice.settings' nav entry for that.
  {
    id: 'audit.view',
    label: 'palette.actions.viewAuditLog',
    url: '/admin/audit',
    requires: 'read',
  },
  // F3 T069 — member surfaces reachable from the palette.
  {
    id: 'member.new',
    label: 'palette.actions.newMember',
    url: '/admin/members/new',
    requires: 'admin',
    keywords: ['create', 'add'],
  },
  // F4 T059 — invoice surfaces reachable from the palette.
  {
    id: 'invoice.new',
    label: 'palette.actions.newInvoice',
    url: '/admin/invoices/new',
    requires: 'admin',
    keywords: ['create', 'add'],
  },
  // 088 T021b / FR-035 — "Record payment for …" jump. Lands on the payable
  // (issued) invoice list carrying the `?pay=1` intent marker; the admin then
  // uses the per-row "Record payment" quick action (T021c) which opens the
  // money-mutation dialog. Admin-only (money mutation; managers are read-only
  // on finance).
  {
    id: 'invoice.recordPayment',
    label: 'palette.actions.recordPayment',
    url: '/admin/invoices?status=issued&pay=1',
    requires: 'admin',
  },
  // 088 T021b / FR-035 — "Re-render tax receipt" jump. Lands on the paid-invoice
  // list where the row ⋯ menu re-renders / resends the §86/4 RC tax receipt.
  // This is an 088 tax-at-payment concept (RC minted at payment), so the
  // `/api/plans/search` route STRIPS this entry when FEATURE_088_TAX_AT_PAYMENT
  // is OFF — the legacy §87-at-issue flow never surfaces it. Admin-only.
  {
    id: 'invoice.rerenderReceipt',
    label: 'palette.actions.rerenderTaxReceipt',
    url: '/admin/invoices?status=paid',
    requires: 'admin',
    feature: 'f088TaxAtPayment',
  },
  // F5 Phase 6 (T118) — refund flow browse-mode shortcut. Admin-only.
  // Lands on the invoices list pre-filtered to paid + partially-
  // credited invoices (the same filter the F5 reconciliation chip
  // uses) for admins who want to scan the list. A *direct* fuzzy-
  // search variant that auto-opens the refund dialog without leaving
  // the keyboard ships as the `refundableInvoices` palette group —
  // see `/api/plans/search` route + `PaletteRefundableInvoiceEntity`.
  {
    id: 'refund.issue',
    label: 'palette.actions.issueRefund',
    url: '/admin/invoices?paidOnly=1',
    requires: 'admin',
  },
  // F7 Smart-1 — Email Broadcast actions. Admins use the queue daily;
  // halt-clear is rare but high-stakes (Q14). Member-self-service
  // "compose" is reachable from the portal palette only (this module
  // serves the admin/staff palette).
  {
    id: 'broadcast.review',
    label: 'palette.actions.reviewBroadcasts',
    url: '/admin/broadcasts',
    requires: 'read',
    feature: 'f7Broadcasts',
  },
  {
    id: 'broadcast.halted',
    label: 'palette.actions.broadcastsHalted',
    url: '/admin/broadcasts?status=halted',
    requires: 'admin',
    feature: 'f7Broadcasts',
  },
  // F7.1a US7 Round 1 R4-S7 L2 — direct ⌘K jump to author a new
  // broadcast template. High-frequency admin task once chambers
  // start customising starter templates (J4-B9 smart-feature pattern).
  {
    id: 'broadcast.newTemplate',
    label: 'palette.actions.newBroadcastTemplate',
    url: '/admin/broadcasts/templates/new',
    requires: 'admin',
    keywords: ['create', 'add'],
    feature: 'f7Broadcasts',
  },
];

const NAVIGATE_REGISTRY: ReadonlyArray<NavigateEntry> = [
  {
    id: 'nav.plans',
    label: 'palette.navigate.plansList',
    url: '/admin/plans',
    requires: 'read',
  },
  {
    id: 'nav.invoiceSettings',
    label: 'palette.navigate.invoiceSettings',
    url: '/admin/settings/invoicing',
    requires: 'read',
  },
  {
    id: 'nav.users',
    label: 'palette.navigate.usersList',
    url: '/admin/users',
    requires: 'read',
  },
  {
    id: 'nav.dashboard',
    label: 'palette.navigate.dashboard',
    url: '/admin',
    requires: 'read',
  },
  {
    id: 'nav.members',
    label: 'palette.navigate.membersList',
    url: '/admin/members',
    requires: 'read',
  },
  {
    id: 'nav.invoices',
    label: 'palette.navigate.invoicesList',
    url: '/admin/invoices',
    requires: 'read',
  },
  {
    // Verify-fix S1 (2026-04-26): F5 Phase 5 paid-online reconciliation
    // jump-point. Smart-chamber-features § MVP #4 — high-frequency
    // monthly-reconciliation step. Available to admin + manager (both
    // roles see the timeline read-only on /admin/invoices).
    id: 'nav.invoicesPaidOnline',
    label: 'palette.navigate.invoicesPaidOnline',
    url: '/admin/invoices?paidOnline=1',
    requires: 'read',
  },
  {
    // G-4 — Credit notes directory (/admin/credit-notes). Typing
    // 'CN' / 'credit' / 'kreditnota' hits the palette fuzzy match
    // via the i18n label so bookkeepers can jump straight to the
    // directory from any surface.
    id: 'nav.creditNotes',
    label: 'palette.navigate.creditNotesList',
    url: '/admin/credit-notes',
    requires: 'read',
  },
  // F7 Smart-1 — broadcast review queue navigation entry.
  {
    id: 'nav.broadcasts',
    label: 'palette.navigate.broadcastsQueue',
    url: '/admin/broadcasts',
    requires: 'read',
    feature: 'f7Broadcasts',
  },
  // F7.1a US7 Round 1 R4-S7 L2 — admin broadcast templates library.
  // Read-only requires for visibility (manager can browse the library
  // even though they cannot edit; matches the templates page RBAC).
  {
    id: 'nav.broadcastTemplates',
    label: 'palette.navigate.broadcastTemplates',
    url: '/admin/broadcasts/templates',
    requires: 'read',
    feature: 'f7Broadcasts',
  },
  // F7.1a US2 image-allowlist editor (UX M-1 fix 2026-05-21,
  // review finding enterprise-ux-designer M-1). Admin surface for
  // managing the per-tenant `<img src>` hostname allowlist. `admin`
  // required (write surface — manager cannot mutate even via palette
  // jump). Without this entry, ⌘K cannot reach the allowlist editor,
  // forcing the admin to remember the sidebar nesting.
  {
    id: 'nav.broadcastImageSettings',
    label: 'palette.navigate.broadcastImageSettings',
    // Relocated from /admin/broadcasts/settings (404 — no page.tsx at the
    // old path); fixed as part of the nav-orphans follow-up sweep.
    url: '/admin/settings/broadcasts',
    requires: 'admin',
    feature: 'f7Broadcasts',
  },
  // J4-B9 (smart-feature #4 MVP) — F8 Phase 4 surfaces. Without
  // these entries, ⌘K-driven jumps to the renewal pipeline +
  // schedule editor are missing — every other major admin surface
  // (plans, members, invoices, broadcasts) is reachable via the
  // palette so omitting renewals would be an explicit smart-UX gap.
  {
    id: 'nav.renewals',
    label: 'palette.navigate.renewalsList',
    url: '/admin/renewals',
    requires: 'read',
  },
  {
    id: 'nav.renewalSchedules',
    label: 'palette.navigate.renewalSchedules',
    url: '/admin/settings/renewals/schedules',
    // Manager role can READ the schedule editor (it renders read-only
    // for them server-side per `requireRenewalAdminContext('read')`).
    // Admin-only mutations are still gated at the route handler.
    requires: 'read',
  },
  // Round 5 SF-1 close — F8 Phase 8 escalation task queue palette
  // entries (smart-chamber-features § MVP #4). Admin + manager can
  // read the queue; mutating actions on individual rows live inline
  // (Done/Skip/Reassign per row), not in the palette.
  {
    id: 'nav.escalationTasks',
    label: 'palette.navigate.escalationTasks',
    url: '/admin/renewals/tasks',
    requires: 'read',
  },
  {
    id: 'nav.escalationTasksMine',
    label: 'palette.navigate.escalationTasksMine',
    url: '/admin/renewals/tasks?assignment=mine',
    requires: 'read',
  },
  {
    id: 'nav.escalationTasksOverdue',
    label: 'palette.navigate.escalationTasksOverdue',
    url: '/admin/renewals/tasks?overdue_only=true',
    requires: 'read',
  },
  // Phase 5 review-fix S-13 (2026-05-13) — F6 EventCreate palette
  // entries (smart-chamber-features § MVP #4 command palette). Without
  // these the F6 events list + integration wizard were unreachable
  // via ⌘K despite being headline F6 surfaces. Both are admin+manager
  // readable per FR-035 — admin gets full read+write on events list +
  // exclusive access to the integration wizard; manager sees events
  // list read-only and gets a 404 on the integration entry (handled
  // by the route, not the palette filter — the palette label tells
  // the manager the surface exists; the 404 conveys the access tier).
  // The integration entry is gated to `admin` here so manager doesn't
  // see a tease they cannot reach.
  {
    id: 'nav.events',
    label: 'palette.navigate.eventsList',
    url: '/admin/events',
    requires: 'read',
    feature: 'f6EventCreate',
  },
  {
    id: 'nav.eventcreateIntegration',
    label: 'palette.navigate.eventcreateIntegration',
    url: '/admin/settings/integrations/eventcreate',
    requires: 'admin',
    feature: 'f6EventCreate',
  },
  // F6.1 R1 ux I8 — high-frequency navigation target for admins who
  // run imports daily. Manager role gets 404 per FR-035 RBAC.
  {
    id: 'nav.csvImportHistory',
    label: 'palette.navigate.csvImportHistory',
    url: '/admin/events/import/history',
    requires: 'admin',
    feature: 'f6EventCreate',
  },
  // F9 — distinct staff-only surfaces (audit log + member directory) that
  // otherwise can only be reached via the sidebar; both are read-tier (admin +
  // read-only manager) per the F9 RBAC.
  {
    id: 'nav.auditLog',
    label: 'palette.navigate.auditLog',
    url: '/admin/audit',
    requires: 'read',
  },
  {
    id: 'nav.directory',
    label: 'palette.navigate.directory',
    url: '/admin/directory',
    requires: 'read',
  },
];

function filterByRole<T extends { requires: 'admin' | 'read' }>(
  entries: ReadonlyArray<T>,
  role: Role,
): ReadonlyArray<T> {
  if (role === 'admin') return entries;
  if (role === 'manager') return entries.filter((e) => e.requires === 'read');
  return []; // member role should never reach this use case
}

// --- Filter helper ----------------------------------------------------------

function matches(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

// --- Use case ---------------------------------------------------------------

export async function searchPlans(
  input: SearchPlansInput,
  deps: SearchPlansDeps,
): Promise<Result<SearchPlansSuccess, SearchPlansError>> {
  // Clamp user-controlled limit to 100 to bound the in-memory filter
  // cost. At SweCham scale (~10 plans + ~50 registry entries) this is
  // a small protection, but a future multi-tenant ramp could see
  // thousands of plans where an unclamped `limit: 10_000` would page
  // the whole table.
  const limit = Math.min(input.limit ?? 20, 100);
  const currentYear = asPlanYear(deps.clock.currentYear());
  const q = input.q.trim();

  // Load the current year's plans (RLS-scoped) and filter in memory
  let plans: Plan[];
  try {
    plans = await deps.planRepo.findByTenantAndYear(deps.tenant, {
      year: currentYear,
      showDeleted: false,
    });
  } catch (e) {
    return err({
      type: 'server_error',
      errKind: errKind(e),
    });
  }

  const planHits: PalettePlanHit[] = [];
  for (const plan of plans) {
    if (planHits.length >= limit) break;
    const localised = pickLocaleText(plan.plan_name, input.activeLocale);
    const nameMatch =
      matches(localised.value, q) ||
      matches(plan.plan_name.en, q) ||
      matches(plan.plan_id, q);
    if (nameMatch) {
      planHits.push({
        plan_id: plan.plan_id,
        plan_year: plan.plan_year,
        plan_name: localised.value,
        category: plan.plan_category,
        is_active: plan.is_active,
        url: `/admin/plans/${plan.plan_year}/${plan.plan_id}`,
      });
    }
  }

  // Action + navigate filters (string match on the i18n KEY is fine —
  // presentation layer resolves the key to text; this backend doesn't
  // need to know the active-locale label for a static entry)
  const actionPool = filterByRole(ACTION_REGISTRY, input.role);
  const navigatePool = filterByRole(NAVIGATE_REGISTRY, input.role);

  const actions = actionPool
    .filter(
      (a) =>
        matches(a.label, q) ||
        matches(a.id, q) ||
        (a.keywords?.some((k) => matches(k, q)) ?? false),
    )
    .slice(0, limit);
  // Navigate entries carry no search synonyms (unlike actions), so a plain
  // key + id match is sufficient.
  const navigate = navigatePool
    .filter((n) => matches(n.label, q) || matches(n.id, q))
    .slice(0, limit);

  return ok({
    results: {
      plans: planHits,
      actions,
      navigate,
    },
  });
}

// --- Kill-switch strip (called from the Presentation layer) ------------------

/**
 * Drop palette entries whose {@link PaletteFeatureFlag} is disabled. Pure — the
 * caller (the `/api/plans/search` route) resolves the flag values from `env` and
 * passes them in, so the Application layer never reads `env` (Principle III). An
 * untagged entry (no `feature`) always survives. Used to keep ⌘K from surfacing
 * jumps whose destination route is proxy-503'd / `notFound()` when the owning
 * feature is switched off (F5 offline-first, F6/F7 dark-launch break-glass).
 */
export function filterPaletteEntriesByFeature<
  T extends { readonly feature?: PaletteFeatureFlag },
>(
  entries: ReadonlyArray<T>,
  enabledFeatures: Readonly<Record<PaletteFeatureFlag, boolean>>,
): ReadonlyArray<T> {
  return entries.filter(
    (entry) => entry.feature === undefined || enabledFeatures[entry.feature],
  );
}
