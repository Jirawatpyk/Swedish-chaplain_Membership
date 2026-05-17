/**
 * T152 — Command palette static registry + shared type definitions (US6).
 *
 * Canonical type surface that:
 *   - the `searchPlans` use case returns (via `@/modules/plans`), and
 *   - the `<CommandPalette>` client component consumes.
 *
 * The client component imports **only** these types and the
 * `filterEntriesByRole` helper. It does not import any other module —
 * the registry stays free of framework/React dependencies so it can be
 * consumed server-side too if future work ever needs it.
 *
 * The action + navigate entries that live in `search-plans.ts` are the
 * authoritative source of truth; this file only defines the shapes and
 * the role-filtering helper. Duplicating the registry here would drift.
 */

// Type-only import from the deep domain path. The auth public barrel
// chain-pulls `@node-rs/argon2` into the client bundle whenever a
// client component transitively imports from it. See the same
// rationale in `search-plans.ts` and `command-palette.tsx`.
 
import type { Role } from '@/modules/auth/domain/role';

// --- Entity (plan) hit shape -------------------------------------------------

export type PalettePlanEntity = {
  readonly plan_id: string;
  readonly plan_year: number;
  readonly plan_name: string; // already localised server-side
  readonly category: 'corporate' | 'partnership';
  readonly is_active: boolean;
  readonly url: string;
};

// --- Action + navigate entries ----------------------------------------------

export type PaletteRoleRequirement = 'admin' | 'read';

export type PaletteActionEntry = {
  readonly id: string;
  readonly label: string; // i18n key (e.g. `palette.actions.newPlan`)
  readonly url: string;
  readonly requires: PaletteRoleRequirement;
};

export type PaletteNavigateEntry = {
  readonly id: string;
  readonly label: string; // i18n key
  readonly url: string;
  readonly requires: PaletteRoleRequirement;
};

// --- Member entity hit shape -------------------------------------------------

export type PaletteMemberEntity = {
  readonly member_id: string;
  readonly company_name: string;
  readonly primary_contact_name: string | null;
  readonly status: 'active' | 'inactive' | 'archived';
  readonly url: string;
};

// --- Refundable-invoice entity (F5 Phase 6 / T118 fuzzy-search) -------------
//
// Admin-only command-palette group that fuzzy-searches paid-online invoices
// with remaining refundable balance > 0. Selection navigates to
// `/admin/invoices/[id]?refund=1` — `RefundDialog` (T113) auto-opens on
// the `?refund=1` query param so the admin lands directly in the refund
// flow without leaving the keyboard.

export type PaletteRefundableInvoiceEntity = {
  readonly invoice_id: string;
  readonly invoice_number: string;
  readonly member_company_name: string;
  /** Total satang formatted as a major-unit string (e.g. "53500.00 THB"). */
  readonly total_display: string;
  readonly url: string;
};

// --- Server-response contract ------------------------------------------------

/**
 * Shape returned by GET /api/plans/search — matches contracts/plans-api.md § 11.
 * Actions + navigate entries are already role-filtered by the server.
 *
 * `members` is populated when the signed-in actor has members:read and
 * the query returned hits. Empty array when none — the client renders
 * a heading only when length > 0.
 */
export type PaletteSearchResponse = {
  readonly results: {
    readonly plans: ReadonlyArray<PalettePlanEntity>;
    readonly members: ReadonlyArray<PaletteMemberEntity>;
    readonly refundableInvoices: ReadonlyArray<PaletteRefundableInvoiceEntity>;
    readonly actions: ReadonlyArray<{
      readonly id: string;
      readonly label: string;
      readonly url: string;
    }>;
    readonly navigate: ReadonlyArray<{
      readonly id: string;
      readonly label: string;
      readonly url: string;
    }>;
  };
};

// --- Role filter helper ------------------------------------------------------

/**
 * Client-side role gate, mirroring `search-plans.ts → filterByRole`.
 *
 * The server is the authoritative gate — every action and navigate
 * entry the response already excludes write-side items for managers.
 * This helper is a defence-in-depth belt-and-braces check so a bug in
 * the server filter cannot expose an admin action to a manager.
 */
export function filterEntriesByRole<T extends { readonly requires: PaletteRoleRequirement }>(
  entries: ReadonlyArray<T>,
  role: Role,
): ReadonlyArray<T> {
  if (role === 'admin') return entries;
  if (role === 'manager') return entries.filter((e) => e.requires === 'read');
  return [];
}
