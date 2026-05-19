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
  // R3 Batch 4f (R3-S7) — discriminated variants of `BenefitMatrix`
  // by `partnership` field. Use these directly when a code site
  // already knows the variant (e.g., the partnership-only editor
  // panel) — the compiler will then refuse to access undefined
  // partnership-only fields on a corporate-typed value.
  CorporateBenefitMatrix,
  PartnershipBenefitMatrix,
  PartnershipBenefits,
  WebsitePageType,
  HomepageLogoCategory,
  DirectoryListingSize,
  EventDiscountScope,
  VideoFrequencyScope,
  DirectoryAdPosition,
} from './domain/benefit-matrix';
export {
  asBenefitMatrix,
  InvalidBenefitMatrixError,
} from './domain/benefit-matrix';

export type { LocaleText, LocaleKey } from './domain/locale-text';
export {
  LOCALE_KEYS,
  hasMissingTranslations,
  pickLocaleText,
  asLocaleText,
  EmptyEnLocaleTextError,
} from './domain/locale-text';

// R2 Batch 3f (R2-S11) — opt-in re-export of F1's `UserId` brand for
// future F2 code that wants to brand `Plan.created_by` /
// `ScheduledPlanChange.scheduledByUserId` / etc. The fields are
// `string` today for back-compat; new code should adopt `UserId`
// where it constructs these values to inherit F1's brand guarantees.
export type { UserId } from '@/modules/auth';

export type { Money, CurrencyCode } from './domain/money';
export {
  asMinorUnits,
  asMoney,
  planAnnualFee,
  addMoney,
  subtractMoney,
  multiplyMoney,
  addVat,
  formatMoney,
  isCurrencyCode,
  InvalidMoneyError,
  SUPPORTED_CURRENCIES,
} from './domain/money';

// NOTE: `TenantFeeConfig` was retired in R7/R8 consolidation
// (migration 0029 dropped `tenant_fee_config`; F4 `tenant_invoice_settings`
// is now authoritative). Re-export removed 2026-05-19 (post-ship R6 C5).

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
  DiffableField,
} from './domain/audit-event';
export {
  auditPayloadSchema,
  EVENT_SEVERITY,
  F2_AUDIT_EVENT_TYPES,
  isF2AuditEventType,
  KNOWN_DIFF_FIELDS,
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

// --- F8 cross-module use-cases (Complexity Tracking #4) --------------------
// `scheduled_plan_changes` table at
// `specs/011-renewal-reminders/data-model.md § 2.9` (migration 0086);
// Drizzle adapter at
// `src/modules/plans/infrastructure/db/drizzle-scheduled-plan-change-repo.ts`;
// contract tests at `tests/contract/f2-scheduled-plan-change.contract.test.ts`
// (in-memory mock for shape pinning).
export { scheduleNextRenewalPlanChange } from './application/schedule-next-renewal-plan-change';
export { getEffectivePlanForRenewal } from './application/get-effective-plan-for-renewal';
// F2 R6 Batch 2c (D7) — `cancelScheduledPlanChange` closes the
// `plan_change_cancelled` deferred-emitter TODO. Ready-to-call use-case
// with no API route yet; future admin "cancel scheduled change" surface
// or F8 auto-supersede flow wires the caller at composition root.
export { cancelScheduledPlanChange } from './application/cancel-scheduled-plan-change';
export type {
  ScheduleNextRenewalPlanChangeDeps,
} from './application/schedule-next-renewal-plan-change';
export type {
  CancelScheduledPlanChangeDeps,
} from './application/cancel-scheduled-plan-change';
export type {
  GetEffectivePlanForRenewalDeps,
  GetEffectivePlanForRenewalInput,
} from './application/get-effective-plan-for-renewal';
export type {
  ScheduledPlanChangeRepo,
  CurrentPlanResolverPort,
} from './application/ports';
// Round 6 W-008 — REVERTED inline barrel re-export of
// `drizzleScheduledPlanChangeRepo`. Adding a concrete Drizzle adapter
// to this barrel pulled `postgres` (postgres-js) into the client
// bundle through transitive `@/modules/plans` imports, breaking the
// Vercel/Webpack build with `Can't resolve 'fs'`. The cleaner fix
// (sub-barrel like `@/modules/plans/server` for server-only adapters,
// or moving the F2 Drizzle ports out of the public Domain barrel) is
// deferred to a follow-up task — but the *port type itself* IS exported
// from this barrel (above), so cross-module consumers (renewals)
// import the type via `@/modules/plans` and inject the concrete adapter
// at their own composition root, avoiding the client-bundle pollution.
export {
  SCHEDULED_PLAN_CHANGE_STATUSES,
  isTerminalStatus,
  assertValidScheduledPlanChange,
  // R3 Batch 4e (R3-S6) — discriminated-union factory + loose
  // hydration type. `makeScheduledPlanChange` is the canonical way to
  // construct a `ScheduledPlanChange` in test fixtures; the type
  // overloads enforce the status↔timestamp invariant at compile time.
  makeScheduledPlanChange,
  InvalidScheduledPlanChangeError,
} from './domain/scheduled-plan-change';
export type {
  ScheduledPlanChange,
  PendingScheduledPlanChange,
  AppliedScheduledPlanChange,
  SupersededScheduledPlanChange,
  CancelledScheduledPlanChange,
  // R3 Batch 4e (R3-S6) — loose hydration shape used by the Drizzle
  // adapter's `rowToDomain` + test-fixture helpers + the
  // `assertValidScheduledPlanChange` defence-in-depth input. Code
  // consumers should accept the discriminated `ScheduledPlanChange`
  // (the carry-the-invariant-in-the-type variant) wherever possible.
  MutableScheduledPlanChange,
  ScheduledPlanChangeStatus,
  ScheduleNextRenewalPlanChangeInput,
  ScheduleNextRenewalPlanChangeError,
  CancelScheduledPlanChangeInput,
  CancelScheduledPlanChangeError,
  EffectivePlanForRenewal,
  GetEffectivePlanForRenewalError,
} from './domain/scheduled-plan-change';

// F7 bridge — concrete `PlanRepo` instance moved out of the public barrel
// 2026-05-01: Public barrel re-exporting Infrastructure caused the client
// bundler to pull postgres + pino into Client Components
// (`plan-form-wizard.tsx`, `new-plan-client.tsx`) which transitively import
// from `@/modules/plans`. Build failed with Module-not-found on `fs`/`net`/
// `tls`/`perf_hooks`/`worker_threads`. Constitution Principle III also
// forbids Infrastructure leaks through Domain/Application barrels.
//
// F7's `broadcasts/infrastructure/plans-bridge.ts` now imports `planRepo`
// directly with `eslint-disable-next-line no-restricted-imports` — same
// composition-root escape-hatch pattern documented in F5 page.tsx +
// sweep-stale-pending-refunds + receipt-pdf-reconcile.
