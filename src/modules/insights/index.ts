/**
 * Public barrel for the `insights` bounded context (F9 — Admin Dashboard +
 * Directory + Timeline + Audit).
 *
 * The ONLY surface that code OUTSIDE `src/modules/insights/**` may import
 * from. The ESLint barrel-guard rule (eslint.config.mjs) blocks deep imports
 * into ./domain/**, ./application/**, ./infrastructure/** from outside the
 * module; a source-scan architecture test backstops the flat-config shadow.
 *
 * Constitution Principle III (NON-NEGOTIABLE): only Domain types + Application
 * use-cases + Application audit-event types + composition-root factories are
 * exported. Drizzle Row types, repository adapters, and port interfaces stay
 * internal to Infrastructure.
 *
 * F9 owns: dashboard snapshots, smart insights, benefit usage, engagement
 * score projection, directory listings, and export-job orchestration. The
 * timeline enrichment lives in `members`; the audit-query reader lives in
 * `auth` (which owns `audit_log`) — neither is re-exported here.
 *
 * Exports are added per phase as use-cases land (T013+ Foundational, T024+
 * US1, …).
 */

// --- Domain (US1) ---------------------------------------------------------
export {
  projectEngagementScore,
  type EngagementBand,
  type EngagementInput,
  type EngagementScore,
  type RiskBand,
} from './domain/engagement-score';
export {
  INSIGHT_CATALOGUE,
  INSIGHT_KEYS,
  isInsightKey,
  type InsightCycleGranularity,
  type InsightKey,
  type SmartInsight,
} from './domain/smart-insight';
export { cycleKeyFor } from './domain/insight-cycle-key';
export {
  emptySnapshot,
  type DashboardSnapshot,
  type MembershipCounts,
  type NeedsAttention,
} from './domain/dashboard-snapshot';

// --- Domain (US4 — benefit usage) -----------------------------------------
export {
  UNDER_USE_WARNING_THRESHOLD_PCT,
  assessUnderUse,
  buildBenefitUsage,
  yearElapsedPct,
  type ActiveBenefit,
  type BenefitUsage,
  type QuantifiableBenefit,
  type QuantifiableBenefitKey,
} from './domain/benefit-usage';

// --- Application audit-event taxonomy (Foundational T013) -----------------
export {
  F9_AUDIT_EVENT_TYPES,
  F9_AUDIT_RETENTION_YEARS,
  f9RetentionFor,
  isF9AuditEventType,
  type F9AuditEvent,
  type F9AuditEventType,
  type F9AuditPayloadByType,
} from './application/ports/audit-port';

// --- Application use-cases (US1) ------------------------------------------
export {
  dismissInsight,
  type DismissInsightError,
  type DismissInsightInput,
  type DismissInsightMeta,
  type InsightsActorRole,
} from './application/use-cases/dismiss-insight';
export {
  computeDashboardSnapshot,
  type ComputeDashboardSnapshotDeps,
  type SnapshotError,
} from './application/use-cases/compute-dashboard-snapshot';
export {
  computeBenefitUsage,
  type ComputeBenefitUsageDeps,
  type ComputeBenefitUsageError,
  type ComputeBenefitUsageInput,
} from './application/use-cases/compute-benefit-usage';
export {
  listDashboard,
  type DashboardActorRole,
  type DashboardError,
  type DashboardView,
  type ListDashboardMeta,
} from './application/use-cases/list-dashboard';
export {
  activityFeedQuery,
  type ActivityFeedActorRole,
  type ActivityFeedError,
  type ActivityFeedMeta,
} from './application/use-cases/activity-feed-query';
export {
  listSmartInsights,
  type ListSmartInsightsDeps,
} from './application/use-cases/list-smart-insights';
export type { ActivityFeedItem } from './application/ports/activity-feed-source';

// --- Application use-cases (US2 — audit viewer) ---------------------------
export {
  auditQuery,
  auditExport,
  AUDIT_EXPORT_SYNC_CAP,
  type AuditQueryActorRole,
  type AuditQueryDeps,
  type AuditQueryError,
  type AuditQueryInput,
  type AuditQueryMeta,
  type AuditQueryResult,
  type AuditQueryRow,
  type AuditExportError,
  type AuditExportResult,
} from './application/use-cases/audit-query';
export {
  redactPayloadForRole,
  GLOBAL_SENSITIVE_PAYLOAD_FIELDS,
  SENSITIVE_PAYLOAD_FIELDS,
  type AuditViewerRole,
} from './application/audit-redaction';
export type {
  ActorDirectory,
  ActorIdentityView,
} from './application/ports/actor-directory';

// --- Composition root factories (US1) -------------------------------------
export {
  makeDismissInsightDeps,
  makeComputeDashboardSnapshotDeps,
  makeComputeBenefitUsageDeps,
  recordStaffBenefitView,
  recordStaffTimelineView,
  makeListDashboardDeps,
  makeListSmartInsightsDeps,
  makeActivityFeedDeps,
  makeAuditQueryDeps,
  systemClock,
} from './infrastructure/insights-deps';
