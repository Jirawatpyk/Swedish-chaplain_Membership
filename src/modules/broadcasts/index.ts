/**
 * Public barrel for the `broadcasts` bounded context (F7 — Email Broadcast).
 *
 * The ONLY surface that code OUTSIDE `src/modules/broadcasts/**` may
 * import from. The ESLint barrel-guard rule (eslint.config.mjs) blocks
 * deep imports into ./domain/**, ./application/**, ./infrastructure/**
 * from outside the module.
 *
 * Exposes Domain types + Application use-cases for Phase 3 US1
 * (compose + submit), Phase 4 US2 (admin review + dispatch), and
 * Phase 5 US3 (member quota dashboard + history + Q15 banner). A
 * small set of Infrastructure adapters is exposed only when callers
 * cross use-case boundaries — e.g. the admin review route notifies
 * members via `emailTransactionalBridge` AFTER the use-case
 * completes, outside the use-case's port boundary.
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
  nextResetAtFor,
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

// --- Application use-cases (Phase 4 US2) ---------------------------------
export {
  approveBroadcast,
  type ApproveBroadcastError,
  type ApproveBroadcastInput,
  type ApproveBroadcastOutput,
  type ApproveDecision,
} from './application/use-cases/approve-broadcast';
export {
  rejectBroadcast,
  type RejectBroadcastError,
  type RejectBroadcastInput,
  type RejectBroadcastOutput,
} from './application/use-cases/reject-broadcast';
export {
  cancelBroadcast,
  type CancelActor,
  type CancelBroadcastError,
  type CancelBroadcastInput,
  type CancelBroadcastOutput,
} from './application/use-cases/cancel-broadcast';
export {
  proxySubmitBroadcast,
  type ProxySubmitBroadcastError,
  type ProxySubmitBroadcastInput,
  type ProxySubmitBroadcastOutput,
} from './application/use-cases/proxy-submit-broadcast';
export {
  clearHalt,
  type ClearHaltError,
  type ClearHaltInput,
  type ClearHaltOutput,
} from './application/use-cases/clear-halt';
export {
  dispatchScheduledBroadcast,
  type DispatchScheduledBroadcastError,
  type DispatchScheduledBroadcastInput,
  type DispatchScheduledBroadcastOutput,
} from './application/use-cases/dispatch-scheduled-broadcast';

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

// --- Composition root factories (Phase 4 US2) ----------------------------
export {
  makeApproveBroadcastDeps,
  makeRejectBroadcastDeps,
  makeCancelBroadcastDeps,
  makeProxySubmitBroadcastDeps,
  makeClearHaltDeps,
  makeDispatchScheduledBroadcastDeps,
} from './infrastructure/broadcasts-deps';

// --- Application use-cases (Phase 5 US3) ---------------------------------
export {
  acknowledgeBroadcastsTerms,
  type AcknowledgeBroadcastsTermsError,
  type AcknowledgeBroadcastsTermsInput,
  type AcknowledgeBroadcastsTermsOutput,
} from './application/use-cases/acknowledge-broadcasts-terms';
export {
  getMemberBroadcast,
  type DeliveryBreakdown,
  type GetMemberBroadcastError,
  type GetMemberBroadcastInput,
  type GetMemberBroadcastOutput,
} from './application/use-cases/get-member-broadcast';
export {
  listMemberBroadcasts,
  type ListMemberBroadcastsInput,
  type ListMemberBroadcastsOutput,
} from './application/use-cases/list-member-broadcasts';

// --- Composition root factories (Phase 5 US3) ----------------------------
export {
  makeAcknowledgeBroadcastsTermsDeps,
  makeGetMemberBroadcastDeps,
  makeListMemberBroadcastsDeps,
} from './infrastructure/broadcasts-deps';

// --- Application use-cases (Phase 7 US5) ---------------------------------
export {
  processWebhookEvent,
  type ProcessWebhookEventDeps,
  type ProcessWebhookEventError,
  type ProcessWebhookEventInput,
  type ProcessWebhookEventOutcome,
} from './application/use-cases/process-webhook-event';
export {
  reconcileStuckSending,
  type ReconcileStuckSendingDeps,
  type ReconcileStuckSendingError,
  type ReconcileStuckSendingInput,
  type ReconcileStuckSendingOutcome,
} from './application/use-cases/reconcile-stuck-sending';

// --- Composition root factories (Phase 7 US5) ----------------------------
export {
  makeProcessWebhookEventDeps,
  makeReconcileStuckSendingDeps,
  resendBroadcastsWebhookVerifier,
  resolveTenantByResendBroadcastId,
} from './infrastructure/broadcasts-deps';

// --- Application port — webhook verifier (Phase 7 US5) -------------------
// Exposed at the barrel because the webhook route handler imports
// `WebhookSignatureError` to discriminate signature-verification kinds
// for audit emit. `WebhookVerifierPort` interface is intentionally NOT
// exported (verify finding G2 — 2026-05-01): no caller outside
// `src/modules/broadcasts/**` constructs the port type directly. The
// production verifier is a Domain-typed singleton; tests inject stubs
// via the module-level `vi.mock` of `@/modules/broadcasts` rather than
// re-implementing the port shape.
export {
  WebhookSignatureError,
  type VerifiedBroadcastEvent,
} from './application/ports/webhook-verifier-port';

// --- Infrastructure adapters consumed by routes (Phase 4 US2) ------------
// EmailTransactionalPort impl is exposed at the barrel because admin
// review API routes (approve/reject/cancel) trigger member notifications
// AFTER the use-case completes — outside the use-case's port boundary,
// so the route handler imports it directly.
export { emailTransactionalBridge } from './infrastructure/email-transactional-bridge';
export type {
  EmailTransactionalPort,
  SendEmailInput,
} from './application/ports/email-transactional-port';

// MembersBridge instance — exposed for the admin queue server component
// which reads halt-state inline.
export { membersBridge } from './infrastructure/members-bridge';

// F7 audit adapter — exposed at the barrel because the
// `/api/portal/broadcasts/acknowledge` route emits the GDPR Art. 7
// `member_acknowledged_broadcasts_terms` event AFTER the F3 use-case
// completes, outside its port boundary (Round-4 CRIT-B).
export { f7AuditAdapter } from './infrastructure/audit-adapter';
export type {
  MemberHaltSummary,
  MemberRecipient,
  MembersBridgePort,
} from './application/ports/members-bridge-port';

// DOMPurify sanitizer — exposed at the barrel because the admin broadcast
// detail server component re-sanitises stored HTML at render time as a
// defence-in-depth measure (UX I14 + IMP-3 round-3).
export { dompurifySanitizer } from './infrastructure/sanitizer/dompurify-sanitizer';
