/**
 * Public barrel for the `plans` bounded context (F2).
 *
 * This is the ONLY surface that code OUTSIDE `src/modules/plans/**`
 * may import from. Deep imports into `./domain/`, `./application/`,
 * or `./infrastructure/` from outside the module are blocked by
 * `no-restricted-imports` in `eslint.config.mjs` (Constitution
 * Principle III — Clean Architecture boundary enforcement).
 *
 * Internal files inside `src/modules/plans/**` MUST NOT import from
 * this barrel (circular dependency). Internal cross-layer imports
 * continue to use the deep paths — the ESLint rule scope excludes
 * the module itself.
 *
 * What is exported:
 *   1. Application use cases — the external entry points to mutate
 *      or read plans catalogue state. These are gradually filled in
 *      through Phase 3–8 (US1–US6); Phase 2e ships the port + audit
 *      infrastructure, so the use-case exports below are wired up as
 *      each phase lands.
 *   2. Domain cross-boundary types — `Plan`, `PlanCategory`,
 *      `MemberTypeScope`, `LocaleText`, `Money`, `F2AuditEvent`, etc.
 *      Presentation + sibling modules type their code against these.
 *   3. Domain branded-type constructors (`asPlanSlug`, `asPlanYear`,
 *      `asTenantSlug`) — called at trust boundaries (HTTP request
 *      parsers, seed scripts, tests) to turn raw strings/numbers into
 *      validated brands.
 *
 * What is NOT exported:
 *   - The composition root `plans-deps.ts` — consumers import that
 *     directly from `@/modules/plans/plans-deps` because it is a
 *     Presentation adapter, not a Domain/Application surface.
 *   - Drizzle schema / row types — those leak ORM details.
 *   - Internal helpers inside `application/` or `infrastructure/`.
 */

// --- Domain: cross-boundary types ---------------------------------------------

export type {
  Plan,
  PlanCategory,
  MemberTypeScope,
  PlanSlug,
  PlanYear,
  TenantSlug,
} from './domain/plan';
export {
  asPlanSlug,
  asPlanYear,
  asTenantSlug,
  isPlanCategory,
  isMemberTypeScope,
  PLAN_CATEGORIES,
  MEMBER_TYPE_SCOPES,
} from './domain/plan';

export type {
  BenefitMatrix,
  PartnershipBenefits,
  WebsitePageType,
  HomepageLogoCategory,
  DirectoryListingSize,
  EventDiscountScope,
  VideoFrequencyScope,
  DirectoryAdPosition,
} from './domain/benefit-matrix';

export type { LocaleText, LocaleKey } from './domain/locale-text';
export {
  LOCALE_KEYS,
  hasMissingTranslations,
  pickLocaleText,
} from './domain/locale-text';

export type { Money, CurrencyCode } from './domain/money';
export {
  asMinorUnits,
  asMoney,
  addMoney,
  subtractMoney,
  multiplyMoney,
  addVat,
  formatMoney,
  isCurrencyCode,
  InvalidMoneyError,
  SUPPORTED_CURRENCIES,
} from './domain/money';

export type { TenantFeeConfig } from './domain/fee-config';

export type {
  PlanState,
  PlanStateSnapshot,
  TransitionResult,
  TransitionOk,
  TransitionErr,
} from './domain/plan-state';
export { canTransition, planStateOf } from './domain/plan-state';

export type { LockedField } from './domain/locked-field-rule';
export {
  detectLockedFieldChanges,
  LOCKED_FIELDS_ON_PRIOR_YEAR,
} from './domain/locked-field-rule';

export type {
  F2AuditEvent,
  F2AuditEventType,
  AuditSeverity,
  AuditDiff,
  MutableAuditDiff,
} from './domain/audit-event';
export {
  auditPayloadSchema,
  EVENT_SEVERITY,
  F2_AUDIT_EVENT_TYPES,
  isF2AuditEventType,
} from './domain/audit-event';

export {
  planSchema,
  planPatchSchema,
  benefitMatrixSchema,
  partnershipBenefitsSchema,
  localeTextSchema,
} from './domain/plan-validators';
export type {
  PlanSchemaInput,
  PlanSchemaOutput,
  PlanPatchInput,
  PlanPatchOutput,
} from './domain/plan-validators';

export {
  canAdminMutatePlan,
  canReadPlan,
  canManagerReadPlan,
  canCloneYear,
  canReadFeeConfig,
  canMutateFeeConfig,
} from './domain/policies';

// --- Application: port types (for Presentation + tests) ---------------------

export type {
  PlanRepo,
  AuditPort,
  AuditContext,
  AuditError,
  ClockPort,
  MemberAttachmentChecker,
  PlansDeps,
  ListPlansFilter,
  PlanDraftInput,
  CloneYearSummary,
  CloneYearError,
} from './application/ports';

export { recordAuditEvent } from './application/record-audit-event';
export type { RecordAuditEventError } from './application/record-audit-event';

// --- Application: use cases -------------------------------------------------
//
// Phase 3 (US1 — T072-T074) — shipped:

export {
  listPlans,
  type ListPlansInput,
  type ListPlansSuccess,
  type ListPlansError,
  type ListPlansDeps,
  type PlanListItem,
} from './application/list-plans';

export {
  getPlan,
  type GetPlanInput,
  type GetPlanError,
  type GetPlanDeps,
} from './application/get-plan';

export {
  searchPlans,
  type SearchPlansInput,
  type SearchPlansSuccess,
  type SearchPlansError,
  type SearchPlansDeps,
  type PalettePlanHit,
  type PaletteActionItem,
  type PaletteNavigateItem,
} from './application/search-plans';

// Phase 4 (US2 — T098-T099) — shipped:

export {
  createPlan,
  type CreatePlanInput,
  type CreatePlanError,
  type CreatePlanDeps,
} from './application/create-plan';

export {
  clonePlansToYear,
  type ClonePlansToYearInput,
  type ClonePlansToYearSuccess,
  type ClonePlansToYearError,
  type ClonePlansToYearDeps,
} from './application/clone-plans-to-year';

// Phase 5 (US3 — T116) — shipped:

export {
  updatePlan,
  type UpdatePlanInput,
  type UpdatePlanError,
  type UpdatePlanDeps,
} from './application/update-plan';

// Phase 6 (US4 — T127-T130) — shipped:

export {
  activatePlan,
  type ActivatePlanInput,
  type ActivatePlanError,
  type ActivatePlanDeps,
} from './application/activate-plan';

export {
  deactivatePlan,
  type DeactivatePlanInput,
  type DeactivatePlanError,
  type DeactivatePlanDeps,
} from './application/deactivate-plan';

export {
  softDeletePlan,
  type SoftDeletePlanInput,
  type SoftDeletePlanError,
  type SoftDeletePlanDeps,
} from './application/soft-delete-plan';

export {
  undeletePlan,
  type UndeletePlanInput,
  type UndeletePlanError,
  type UndeletePlanDeps,
} from './application/undelete-plan';

// Phase 7 (F2 US5 — T144-T145) — REMOVED in R7 consolidation.
// Fee Configuration page was deleted after F4 `tenant_invoice_settings`
// became the authoritative source for VAT + currency + registration
// fee. `getFeeConfig` / `updateFeeConfig` use-cases were deleted in
// R7 commit C4; their tests likewise. F4 `getTenantTaxPolicy` is
// the cross-module replacement.

// --- Schema tables (read-only, for sibling-module joins) --------------------
//
// Expose the Drizzle table object so sibling modules (F3 members, future
// F4 invoices, etc.) can alias + JOIN against plans in their own queries
// without duplicating the column definitions or reaching into
// `./infrastructure/db/**` (ESLint-blocked). This is a deliberate
// architectural decision: the table shape IS the plans module's
// public read contract. Mutations still go through the Application-
// layer use cases; sibling modules MUST NOT call INSERT/UPDATE on
// this handle.
export { membershipPlans } from './infrastructure/db/schema';

// ===========================================================================
// F7 Batch C extension (T030) — getPlanForMember use-case for F7 bridges
// ===========================================================================

export {
  getPlanForMember,
  type GetPlanForMemberDeps,
  type MemberPlanSummary,
  type MemberPlanIdentityLookup,
  type PlanLookupError,
} from './application/get-plan-for-member';

// F7 bridge — concrete `PlanRepo` instance for F7's `plans-bridge.ts`
// composition root (T061). F7 invokes `getPlanForMember` through this repo.
export { planRepo as drizzlePlanRepo } from './infrastructure/db/plan-repo';
