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
  phaseOf,
  type Broadcast,
  type BroadcastActorRole,
  type BroadcastId,
  type BroadcastIdError,
  type BroadcastPhase,
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
  type BroadcastSegmentDefinitionParams,
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

// --- Application error types — public contract --------------------------
// Typed errors that callers (route handlers, cron jobs) need for
// `instanceof` narrowing. Phase 3F.11.9 (HIGH-1 — Round 3): the
// split-large-broadcasts cron narrows on `BroadcastConcurrentMutationError`
// to distinguish benign race-lost from real DB outage. Port
// INTERFACES (BroadcastsRepo, GatewayPort, etc.) remain unexported
// per Constitution III boundary; the ERROR CLASS is a value-level
// API surface analogous to `BroadcastTransitionError` above.
export { BroadcastConcurrentMutationError } from './application/ports/broadcasts-repo';

// --- Application audit-event types (T028) --------------------------------
// Exported for F1+F2+F3 audit-log consumers + observability dashboards.
// Port interfaces (BroadcastsRepo, GatewayPort, etc.) are NOT re-exported.
export {
  F7_AUDIT_EVENT_TYPES,
  F7_AUDIT_RETENTION_YEARS,
  f7RetentionFor,
  isF7AuditEventType,
  type F7AuditEvent,
  type F7AuditEventType,
  // R8.1 M-2 — `F7AuditPayloadFor<E>` dropped; consumers use
  // `F7AuditPayloadShapes[E]` directly (or `TypedAuditEmitInput<E>`).
  type F7AuditPayloadShapes,
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
  type ProxyMemberLookup,
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
  enqueueDispatchFailureNotification,
  type DispatchScheduledBroadcastError,
  type DispatchScheduledBroadcastInput,
  type DispatchScheduledBroadcastOutput,
} from './application/use-cases/dispatch-scheduled-broadcast';
export {
  pruneExpiredDrafts,
  type PruneExpiredDraftsError,
  type PruneExpiredDraftsOutput,
} from './application/use-cases/prune-expired-drafts';
// Phase 9 / T178a — F3 archival/erasure cascade. Exposed at the barrel
// because the F3 archival/erasure use-case calls into F7 to auto-cancel
// in-flight broadcasts when the originating member is archived/erased.
// Spec § Edge Cases L353 / Coverage Gap C2.
export {
  cancelInFlightBroadcastsForMember,
  type CancelInFlightForMemberDeps,
  type CancelInFlightForMemberError,
  type CancelInFlightForMemberInput,
  type CancelInFlightForMemberOutput,
} from './application/use-cases/cancel-in-flight-broadcasts-for-member';
// COMP-1 US2b — GDPR Art.17 / PDPA §33 F7 broadcast CONTENT redaction
// (CONTENT-only; the delivery tombstone runs in the members-module atomic
// scrub tx, not via this export). Exposed at the barrel because the members-
// module erasure cascade (`BroadcastsContentScrubPort` adapter) calls into
// F7 to redact the PII a member AUTHORED into broadcasts when the
// originating member is erased.
export {
  scrubBroadcastContentForMember,
  type ScrubBroadcastContentForMemberDeps,
  type ScrubBroadcastContentForMemberError,
  type ScrubBroadcastContentForMemberInput,
  type ScrubBroadcastContentForMemberOutput,
  type ScrubContentReason,
} from './application/use-cases/scrub-broadcast-content-for-member';

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

// --- F9 cross-module read (dashboard needs-attention, FR-002/AS-2) -------
export { makeBroadcastApprovalCounter } from './infrastructure/broadcasts-deps';
export type { BroadcastApprovalCounter } from './application/ports/broadcast-approval-counter';

// --- Composition root factories (Phase 4 US2) ----------------------------
export {
  makeApproveBroadcastDeps,
  makeRejectBroadcastDeps,
  makeCancelBroadcastDeps,
  makeProxySubmitBroadcastDeps,
  makeClearHaltDeps,
  makeDispatchScheduledBroadcastDeps,
  makePruneExpiredDraftsDeps,
  makeCancelInFlightBroadcastsForMemberDeps,
  makeScrubBroadcastContentForMemberDeps,
} from './infrastructure/broadcasts-deps';

// --- F7.1a Phase 3 Cluster B (US1 — Pagination 5k→50k) -------------------
export {
  splitBroadcastIntoBatches,
  type SplitBroadcastIntoBatchesDeps,
  type SplitBroadcastIntoBatchesError,
  type SplitBroadcastIntoBatchesInput,
  type SplitBroadcastIntoBatchesOutput,
} from './application/use-cases/split-broadcast-into-batches';
export {
  retryFailedBatches,
  MANUAL_RETRY_BUDGET,
  type RetryFailedBatchesDeps,
  type RetryFailedBatchesError,
  type RetryFailedBatchesInput,
  type RetryFailedBatchesOutput,
} from './application/use-cases/retry-failed-batches';
export {
  acceptPartialDelivery,
  MAX_REASON_LENGTH,
  type AcceptPartialDeliveryDeps,
  type AcceptPartialDeliveryError,
  type AcceptPartialDeliveryInput,
  type AcceptPartialDeliveryOutput,
} from './application/use-cases/accept-partial-delivery';
export {
  makeSplitBroadcastIntoBatchesDeps,
  makeRetryFailedBatchesDeps,
  makeAcceptPartialDeliveryDeps,
  makeAutoRetryFailedBatchesDeps,
  makeApplyBatchWebhookEventDeps,
  resolveTenantByBatchProviderBroadcastId,
} from './infrastructure/broadcasts-deps';
export {
  autoRetryFailedBatch,
  sweepAutoRetryFailedBatches,
  AUTO_RETRY_BUDGET,
  AUTO_RETRY_COOLOFF_SECONDS,
  type AutoRetryFailedBatchesDeps,
  type AutoRetryFailedBatchesError,
  type AutoRetryFailedBatchesInput,
  type AutoRetryFailedBatchesOutput,
  type AutoRetrySweepInput,
  type AutoRetrySweepOutcome,
  type AutoRetrySweepOutput,
} from './application/use-cases/auto-retry-failed-batches';
export {
  applyBatchWebhookEvent,
  type ApplyBatchWebhookEventDeps,
  type ApplyBatchWebhookEventError,
  type ApplyBatchWebhookEventInput,
  type BatchWebhookEventType,
} from './application/use-cases/apply-batch-webhook-event';
export {
  isF71aUs1Enabled,
  f71aUs1DisabledReason,
  type F71aUs1DisabledReason,
  isF71aUs7Enabled,
  f71aUs7DisabledReason,
  type F71aUs7DisabledReason,
} from './infrastructure/feature-flags';

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

// --- PR-2 Task 4 — cleanup-orphaned-audiences cron (defect #5) -----------
export {
  cleanupOrphanedAudiences,
  type CleanupOrphanedAudiencesDeps,
  type CleanupOrphanedAudiencesInput,
  type CleanupOrphanedAudiencesOutput,
  type CleanupOrphanedAudiencesError,
} from './application/use-cases/cleanup-orphaned-audiences';
export { makeCleanupOrphanedAudiencesDeps } from './infrastructure/broadcasts-deps';

// --- Ship-blocker A — batch completion roll-up --------------------------
export {
  rollUpBatchBroadcast,
  sweepBatchCompletion,
  evaluateBatchCompletion,
  type RollUpBatchBroadcastDeps,
  type RollUpBatchBroadcastInput,
  type RollUpOutcome,
  type RollUpError,
  type BatchCompletion,
  type SweepBatchCompletionInput,
  type SweepBatchCompletionOutput,
} from './application/use-cases/roll-up-batch-broadcast';

// --- Composition root factories (Phase 7 US5) ----------------------------
export {
  makeProcessWebhookEventDeps,
  makeReconcileStuckSendingDeps,
  makeRollUpBatchBroadcastDeps,
  resendBroadcastsWebhookVerifier,
  resolveTenantByResendBroadcastId,
} from './infrastructure/broadcasts-deps';

// --- Application use-cases (Phase 6 US4) ---------------------------------
export {
  unsubscribeRecipient,
  type UnsubscribeRecipientDeps,
  type UnsubscribeRecipientError,
  type UnsubscribeRecipientInput,
  type UnsubscribeRecipientOutput,
} from './application/use-cases/unsubscribe-recipient';

// --- Application port — unsubscribe token (Phase 6 US4) ------------------
export type {
  TokenVerifyError,
  UnsubscribeTokenPayload,
  UnsubscribeTokenPort,
} from './application/ports/unsubscribe-token-port';

// --- Composition root factories (Phase 6 US4) ----------------------------
export {
  makeUnsubscribeRecipientDeps,
  tenantDefaultLocaleFor,
  unsubscribeTokenSigner,
} from './infrastructure/broadcasts-deps';
export {
  peekTokenTenantId,
  peekTokenLang,
} from './infrastructure/unsubscribe-token/hmac-signer';
// R8 staff-review R8-A3 — re-export the brand so callers annotating
// `peekTokenTenantId` return type don't reach into the infrastructure
// subpath (Constitution Principle III barrel rule).
export type { UnverifiedTenantSlug } from './infrastructure/unsubscribe-token/hmac-signer';
export { broadcastsRateLimiter } from './infrastructure/rate-limiter';

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
export { makeTickMemoizedMembersBridge } from './infrastructure/tick-memoized-members-bridge';

// F7 audit adapter — exposed at the barrel because the
// `/api/portal/broadcasts/acknowledge` route emits the GDPR Art. 7
// `member_acknowledged_broadcasts_terms` event AFTER the F3 use-case
// completes, outside its port boundary (Round-4 CRIT-B).
export { f7AuditAdapter } from './infrastructure/audit-adapter';

// F7.1b B2 closure 2026-05-21 — Infrastructure singletons + factories
// exposed at the barrel so the 2 broadcasts cron routes
// (`/api/cron/broadcasts/dispatch-batches` + `split-large-broadcasts`)
// can compose their deps without 12+ deep imports from
// `@/modules/broadcasts/infrastructure/...`. Closes ~28 entries from
// the `broadcasts-barrel.test.ts` KNOWN_BACKLOG (Round 2 staff-review
// W3 architectural warning).
export { makeDrizzleBatchManifestsRepo } from './infrastructure/drizzle-batch-manifests-repo';
export { makeDrizzleBroadcastsRepo } from './infrastructure/db/drizzle-broadcasts-repo';
export { makeDrizzleMarketingUnsubscribesRepo } from './infrastructure/db/drizzle-marketing-unsubscribes-repo';
export { eventAttendeesStub } from './infrastructure/event-attendees-stub';
// F6 → F7 production bridge for the event_attendees_last_90d segment
// (replaces eventAttendeesStub in the live composition roots now that F6
// EventCreate has shipped). Stub export retained for empty-segment tests.
export { eventAttendeesBridge } from './infrastructure/event-attendees-bridge';
export { resendBroadcastsGateway } from './infrastructure/resend/resend-broadcasts-gateway';
export { noOpAdvisoryLock } from './infrastructure/noop-advisory-lock';
export { dispatchAllPendingBatches } from './application/services/batch-dispatcher';
export type {
  MemberHaltSummary,
  MemberRecipient,
  MembersBridgePort,
} from './application/ports/members-bridge-port';

// DOMPurify sanitizer — exposed at the barrel because the admin broadcast
// detail server component re-sanitises stored HTML at render time as a
// defence-in-depth measure (UX I14 + IMP-3 round-3).
export { dompurifySanitizer } from './infrastructure/sanitizer/dompurify-sanitizer';

// F7 transactional notification email builders (Phase 8 — 2026-05-02).
// Exposed at the barrel because the F4 cron outbox-dispatcher
// (`/api/cron/outbox-dispatch`) renders broadcast_*_notification rows
// outside the F7 use-case boundary — same pattern as F1+F4 build
// helpers (`buildInvitationEmail`, `buildInvoiceAutoEmail`).
export {
  buildBroadcastDeliveredEmail,
  buildBroadcastFailedToDispatchEmail,
  buildBroadcastApprovedEmail,
  buildBroadcastRejectedEmail,
  buildBroadcastCancelledEmail,
  type BuildBroadcastDeliveredEmailInput,
  type BuildBroadcastFailedToDispatchEmailInput,
  type BuildBroadcastApprovedEmailInput,
  type BuildBroadcastRejectedEmailInput,
  type BuildBroadcastCancelledEmailInput,
  type BroadcastNotificationLocale,
} from './infrastructure/email/broadcast-notification-emails';

// ---------------------------------------------------------------------------
// F7.1a Phase 2 T030 — Domain-typed surface for the 3 new aggregates.
//
// Only TYPES are exported here (Constitution Principle III). Use-case
// factories + composition root wiring land in Phase 3 (US1 batch
// pagination), Phase 4 (US2 image embedding), Phase 5 (US7 template
// library). Infrastructure adapters (`makeDrizzleBatchManifestsRepo`,
// `makeDrizzleImageAllowlistRepo`, `makeDrizzleBroadcastTemplatesRepo`,
// `makeClamavVirusScanner`) are wired inline via `broadcasts-deps.ts`
// at those phases — NOT re-exported from this barrel.
// ---------------------------------------------------------------------------

// US1 (Pagination) — BatchManifest port types + Domain value types
export type {
  BatchManifest,
  BatchManifestsPort,
  BatchStatus,
  BatchInsertError,
  BatchUpdateError,
  BatchStatusUpdate,
  NewBatchManifestInput,
} from './application/ports/batch-manifests-port';

// US2 (Image embedding) — VirusScanner + ImageAllowlist port types
export type {
  VirusScannerPort,
  VirusScanVerdict,
} from './application/ports/virus-scanner-port';
export type {
  AllowlistEntry,
  AllowlistAddError,
  AllowlistRemoveError,
  Hostname,
  ImageAllowlistPort,
} from './application/ports/image-allowlist-port';

// US7 (Template library) — BroadcastTemplate port types + Domain value types
export type {
  BroadcastTemplate,
  BroadcastTemplatesPort,
  BroadcastTemplatesTx,
  CreateTemplateInput,
  ListTemplatesOpts,
  TemplateCreateError,
  TemplateDeleteError,
  TemplateLocale,
  TemplateUpdateError,
  UpdateTemplateInput,
} from './application/ports/broadcast-templates-port';
export type { TenantDisplayNamePort } from './application/ports/tenant-display-name-port';

// US7 Domain VO (T097)
export {
  escapeHtml,
  substituteChamberName,
} from './domain/value-objects/template-snapshot';

// US7 Phase 5 Round 1 R2.2 A3+A4 — template field limits (shared
// between Application use-cases + Presentation Zod schemas in the
// API route handlers). Constants only — no validation logic.
export {
  TEMPLATE_MAX_BODY_BYTES,
  TEMPLATE_MAX_NAME_LENGTH,
  TEMPLATE_MAX_SUBJECT_LENGTH,
} from './application/use-cases/_template-field-limits';

// US7 Application use-cases (Phase 5D T099-T103)
export {
  createBroadcastTemplate,
  type CreateBroadcastTemplateDeps,
  type CreateBroadcastTemplateError,
  type CreateBroadcastTemplateInput,
  type CreateBroadcastTemplateOutput,
} from './application/use-cases/create-broadcast-template';
export {
  updateBroadcastTemplate,
  type UpdateBroadcastTemplateDeps,
  type UpdateBroadcastTemplateError,
  type UpdateBroadcastTemplateInput,
  type UpdateBroadcastTemplateOutput,
} from './application/use-cases/update-broadcast-template';
export {
  deleteBroadcastTemplate,
  type DeleteBroadcastTemplateDeps,
  type DeleteBroadcastTemplateError,
  type DeleteBroadcastTemplateInput,
} from './application/use-cases/delete-broadcast-template';
export {
  snapshotTemplateToDraft,
  type SnapshotTemplateToDraftDeps,
  type SnapshotTemplateToDraftError,
  type SnapshotTemplateToDraftInput,
  type SnapshotTemplateToDraftOutput,
} from './application/use-cases/snapshot-template-to-draft';
export {
  listBroadcastTemplates,
  type ListBroadcastTemplatesDeps,
  type ListBroadcastTemplatesInput,
  type ListBroadcastTemplatesOutput,
} from './application/use-cases/list-broadcast-templates';

// US7 Composition root factories (Phase 5E)
export {
  makeCreateBroadcastTemplateDeps,
  makeUpdateBroadcastTemplateDeps,
  makeDeleteBroadcastTemplateDeps,
  makeSnapshotTemplateToDraftDeps,
  makeListBroadcastTemplatesDeps,
} from './infrastructure/broadcasts-deps';
export { envTenantDisplayName } from './infrastructure/env-tenant-display-name';

// R6.6 M-4 — dead `__resetEnvTenantDisplayNameForTestsOnly` barrel
// re-export removed (R4.3 M-14 added it speculatively for test
// fixtures that never materialised). The underlying
// `__resetForTestsOnly` was also dropped from
// `infrastructure/env-tenant-display-name.ts`. If a future test needs
// to reset the module-scoped `warnedAboutFallback` flag, prefer
// `vi.resetModules()` which is the standard vitest seam — adding a
// custom reset hook again would re-introduce the same dead-export
// surface.
