/**
 * Public barrel for the `broadcasts` bounded context (F7 — Email Broadcast).
 *
 * The ONLY surface that code OUTSIDE `src/modules/broadcasts/**` may
 * import from. The ESLint barrel-guard rule (eslint.config.mjs) blocks
 * deep imports into ./domain/**, ./application/**, ./infrastructure/**
 * from outside the module.
 *
 * This barrel currently exposes the Domain types + constants emitted
 * by Phase 2 Foundational Batch A (T020 + T024–T028). Use cases, route
 * handlers, and Infrastructure adapters arrive in subsequent batches.
 *
 * Constitution Principle III (NON-NEGOTIABLE): only Domain types +
 * Application audit-event types are exported. Drizzle Row types,
 * repository adapters, and port interfaces are intentionally NOT
 * re-exported — they are consumed only by Infrastructure adapters
 * within this module.
 */

// --- Domain branded types + aggregates (T027) -----------------------------
export {
  asBroadcastId,
  parseBroadcastId,
  type Broadcast,
  type BroadcastActorRole,
  type BroadcastId,
  type BroadcastIdError,
} from './domain/broadcast';
export {
  asBroadcastDeliveryId,
  parseBroadcastDeliveryId,
  type BounceType,
  type BroadcastDelivery,
  type BroadcastDeliveryId,
  type BroadcastDeliveryIdError,
} from './domain/broadcast-delivery';
export {
  isMarketingUnsubscribeReason,
  MARKETING_UNSUBSCRIBE_REASONS,
  type MarketingUnsubscribe,
  type MarketingUnsubscribeReason,
} from './domain/marketing-unsubscribe';
export {
  asBroadcastSegmentDefinitionId,
  parseBroadcastSegmentDefinitionId,
  type BroadcastSegmentDefinition,
  type BroadcastSegmentDefinitionId,
  type BroadcastSegmentDefinitionIdError,
  type RecipientSegment,
} from './domain/recipient-segment';

// --- Domain VOs + enums (T024) -------------------------------------------
export {
  asEmailLower,
  isEmailLower,
  unsafeBrandEmailLower,
  type EmailLower,
  type EmailLowerError,
} from './domain/value-objects/email-lower';
export {
  asQuotaCounter,
  hasRemainingSlot,
  zeroQuota,
  type QuotaCounter,
  type QuotaCounterError,
} from './domain/value-objects/quota-counter';
export {
  BROADCAST_STATUSES,
  isBroadcastStatus,
  isTerminalStatus,
  type BroadcastStatus,
} from './domain/value-objects/broadcast-status';
export {
  BROADCAST_SEGMENT_TYPES,
  isBroadcastSegmentType,
  type BroadcastSegmentType,
} from './domain/value-objects/segment-type';
export {
  BROADCAST_DELIVERY_STATUSES,
  isBroadcastDeliveryStatus,
  isSuppressionTriggering,
  type BroadcastDeliveryStatus,
} from './domain/value-objects/delivery-status';

// --- Domain policies (T026) ----------------------------------------------
export {
  authorizeCancel,
  canCancel,
  type CancelCutoffError,
} from './domain/policies/cancel-cutoff-policy';
export {
  BROADCAST_TRANSITIONS,
  canTransition,
  transition,
  type BroadcastTransitionError,
} from './domain/policies/broadcast-status-transitions';

// --- Application audit-event types (T028) --------------------------------
// Exported for F1+F2+F3 audit-log consumers + observability dashboards.
// Port interfaces (BroadcastsRepo, GatewayPort, etc.) are NOT re-exported.
export {
  F7_AUDIT_EVENT_TYPES,
  F7_AUDIT_RETENTION_YEARS,
  f7RetentionFor,
  type F7AuditEvent,
  type F7AuditEventType,
} from './application/ports/audit-port';

// --- Application use-cases (Phase 3 US1) ---------------------------------
// Per-story use-case functions + their Input/Output types. NOT ports
// (Constitution Principle III — only Domain types + Application
// functions cross the barrel).
export {
  saveDraft,
  type SaveDraftError,
  type SaveDraftInput,
  type SaveDraftOutput,
} from './application/use-cases/save-draft';
export {
  submitBroadcast,
  type SubmitBroadcastError,
  type SubmitBroadcastInput,
  type SubmitBroadcastOutput,
} from './application/use-cases/submit-broadcast';
export {
  computeQuotaCounter,
  currentQuotaYear,
  type ComputeQuotaError,
  type ComputeQuotaInput,
  type ComputeQuotaOutput,
} from './application/use-cases/compute-quota-counter';
export {
  enforceTenantContext,
  type CrossTenantProbeError,
  type EnforceTenantContextInput,
} from './application/use-cases/enforce-tenant-context';
export {
  sanitizeHtml,
  type SanitizeHtmlError,
  type SanitizeHtmlInput,
  type SanitizeHtmlOutput,
} from './application/use-cases/sanitize-html';
export {
  validateCustomRecipients,
  type ValidateCustomRecipientsError,
  type ValidateCustomRecipientsInput,
  type ValidateCustomRecipientsOutput,
} from './application/use-cases/validate-custom-recipients';
export {
  resolveSegmentRecipients,
  type ResolveSegmentError,
  type ResolveSegmentInput,
  type ResolveSegmentOutput,
} from './application/use-cases/resolve-segment-recipients';

// --- Composition root factories (Phase 3) --------------------------------
export {
  makeSaveDraftDeps,
  makeSubmitBroadcastDeps,
  makeComputeQuotaDeps,
  makeEnforceTenantContextDeps,
  makeGetBroadcastDeps,
  makeListSegmentDefinitionsDeps,
  systemClock,
} from './infrastructure/broadcasts-deps';
