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

export type PaletteActionItem = {
  readonly id: string;
  readonly label: string;
  readonly url: string;
};

export type PaletteNavigateItem = {
  readonly id: string;
  readonly label: string;
  readonly url: string;
};

export type SearchPlansSuccess = {
  readonly results: {
    readonly plans: ReadonlyArray<PalettePlanHit>;
    readonly actions: ReadonlyArray<PaletteActionItem>;
    readonly navigate: ReadonlyArray<PaletteNavigateItem>;
  };
};

export type SearchPlansError =
  | { readonly type: 'server_error'; readonly message: string };

export type SearchPlansDeps = {
  readonly tenant: TenantContext;
  readonly planRepo: PlanRepo;
  readonly clock: ClockPort;
};

// --- Static action + navigate registries ------------------------------------

type ActionEntry = PaletteActionItem & { readonly requires: 'admin' | 'read' };
type NavigateEntry = PaletteNavigateItem & { readonly requires: 'admin' | 'read' };

const ACTION_REGISTRY: ReadonlyArray<ActionEntry> = [
  { id: 'plan.new', label: 'palette.actions.newPlan', url: '/admin/plans/new', requires: 'admin' },
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
  },
  // F4 T059 — invoice surfaces reachable from the palette.
  {
    id: 'invoice.new',
    label: 'palette.actions.newInvoice',
    url: '/admin/invoices/new',
    requires: 'admin',
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
    // G-4 — Credit notes directory (/admin/credit-notes). Typing
    // 'CN' / 'credit' / 'kreditnota' hits the palette fuzzy match
    // via the i18n label so bookkeepers can jump straight to the
    // directory from any surface.
    id: 'nav.creditNotes',
    label: 'palette.navigate.creditNotesList',
    url: '/admin/credit-notes',
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
  const limit = input.limit ?? 20;
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
      message: e instanceof Error ? e.message : String(e),
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
    .filter((a) => matches(a.label, q) || matches(a.id, q))
    .slice(0, limit);
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
