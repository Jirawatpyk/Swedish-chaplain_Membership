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
  recipientSegmentFromPersisted,
  type BroadcastSegmentDefinition,
  type BroadcastSegmentDefinitionId,
  type BroadcastSegmentDefinitionIdError,
  type BroadcastSegmentDefinitionParams,
  type MalformedSegmentError,
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
  OFFERED_BROADCAST_STATUSES,
  TERMINAL_BROADCAST_STATUSES,
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
  RETIRED_F7_AUDIT_EVENT_TYPES,
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
  isMissingAddressOrphan,
  resolveSegmentRecipients,
  type OrphanReason,
  type ResolvedOrphan,
  type ResolveSegmentDeps,
  type ResolveSegmentError,
  type ResolveSegmentInput,
  type ResolveSegmentOutput,
} from './application/use-cases/resolve-segment-recipients';
// 108 PR-C — the flag-derived resolver leg (Domain type; env read only in the
// composition root).
export type { AudienceMode } from './domain/audience-mode';

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
  buildAudienceTick,
  IMPORT_STUCK_AFTER_MS,
  type BuildAudienceTickError,
  type BuildAudienceTickOutput,
} from './application/use-cases/build-audience-tick';
export {
  dispatchScheduledBroadcast,
  type DispatchScheduledBroadcastError,
  type DispatchScheduledBroadcastInput,
  type DispatchScheduledBroadcastOutput,
} from './application/use-cases/dispatch-scheduled-broadcast';
// Moved out of `dispatch-scheduled-broadcast` in 108 Phase 9 so BOTH dispatch
// paths can send the FR-021 notification. The import path had none.
export {
  enqueueDispatchFailureNotification,
  type DispatchFailureNotificationDeps,
} from './application/use-cases/_enqueue-dispatch-failure-notification';
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
// 108 PR-C — the flag-derived resolver leg, read in the composition root only.
export {
  currentAudienceMode,
  configuredAudienceCeiling,
  currentAudienceCeiling,
  makeResolveSegmentDeps,
} from './infrastructure/broadcasts-deps';
// 108 PR-C T085 — the one ceiling (Domain) + the split threshold it bounds.
export {
  audienceCeiling,
  DELIVERABLE_RECIPIENTS_PER_TICK,
} from './domain/audience-ceiling';
export type { BroadcastApprovalCounter } from './application/ports/broadcast-approval-counter';

// --- Composition root factories (Phase 4 US2) ----------------------------
export {
  makeApproveBroadcastDeps,
  makeRejectBroadcastDeps,
  makeCancelBroadcastDeps,
  makeProxySubmitBroadcastDeps,
  makeClearHaltDeps,
  makeDispatchScheduledBroadcastDeps,
  makeBuildAudienceTickDeps,
  makePruneExpiredDraftsDeps,
  makeMarkOwnerImagesRemovedDeps,
  makeCancelInFlightBroadcastsForMemberDeps,
  makeScrubBroadcastContentForMemberDeps,
} from './infrastructure/broadcasts-deps';

// --- F7.1a Phase 3 Cluster B (US1 — Pagination 5k→50k) -------------------
export {
} from './infrastructure/broadcasts-deps';
export {
  isF71aUs1Enabled,
  isF7ImportAudienceEnabled,
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

// --- PR-2 Task 4 — reclaim-orphaned-audiences cron (defect #5 companion) -
// Safety-net for audiences whose broadcast row is already gone — complements
// cleanup-orphaned-audiences (which handles the row-exists-but-terminal case).
export {
  reclaimOrphanedAudiences,
  type ReclaimOrphanedAudiencesDeps,
  type ReclaimOrphanedAudiencesInput,
  type ReclaimOrphanedAudiencesOutput,
  type ReclaimOrphanedAudiencesError,
} from './application/use-cases/reclaim-orphaned-audiences';
export { makeReclaimOrphanedAudiencesDeps } from './infrastructure/broadcasts-deps';

// --- Ship-blocker A — batch completion roll-up --------------------------

// --- Composition root factories (Phase 7 US5) ----------------------------
export {
  makeProcessWebhookEventDeps,
  makeReconcileStuckSendingDeps,
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
export { makeDrizzleBroadcastsRepo } from './infrastructure/db/drizzle-broadcasts-repo';
export { makeDrizzleMarketingUnsubscribesRepo } from './infrastructure/db/drizzle-marketing-unsubscribes-repo';
export { eventAttendeesStub } from './infrastructure/event-attendees-stub';
// F6 → F7 production bridge for the event_attendees_last_90d segment
// (replaces eventAttendeesStub in the live composition roots now that F6
// EventCreate has shipped). Stub export retained for empty-segment tests.
export { eventAttendeesBridge } from './infrastructure/event-attendees-bridge';
export { resendBroadcastsGateway } from './infrastructure/resend/resend-broadcasts-gateway';
// Round 4, whole-branch review #9 — `noOpAdvisoryLock` re-export removed with
// its module. It had no consumer in `src/`, `tests/` or `scripts/`; the barrel
// was the only thing keeping it reachable, which is what made it look alive.
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
// F119 T108 (FR-046) — the compose picker's template-start counter.
export {
  countTemplateStart,
  type CountTemplateStartDeps,
  type CountTemplateStartError,
  type CountTemplateStartInput,
  type CountTemplateStartOutput,
} from './application/use-cases/count-template-start';

// US7 Composition root factories (Phase 5E)
export {
  makeCreateBroadcastTemplateDeps,
  makeUpdateBroadcastTemplateDeps,
  makeDeleteBroadcastTemplateDeps,
  makeSnapshotTemplateToDraftDeps,
  makeListBroadcastTemplatesDeps,
  makeCountTemplateStartDeps,
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

// ---------------------------------------------------------------------------
// F119 — E-Blast writing tool + member-approval round (PR-1 surface).
//
// Domain: brand value objects + WCAG contrast, design-block markers and the
// post-sanitise renderer. Application: the brand use cases and the ports the
// composition roots (`src/lib/broadcast-brand-deps.ts`) implement.
// Infrastructure: the Drizzle brand repo consumed by that composition root.
// ---------------------------------------------------------------------------
export {
  DEFAULT_BRAND_PRIMARY_COLOR,
  BRAND_POSTAL_ADDRESS_MAX,
  parseBrandPrimaryColor,
  parseBrandPostalAddress,
  type BrandSettings,
} from './domain/brand/brand-settings';
export {
  AA_MIN_CONTRAST,
  contrastRatio,
  contrastRatioOnWhite,
  meetsAaOnWhiteText,
  relativeLuminance,
} from './domain/brand/contrast';
export {
  CTA_MAX_PER_MESSAGE,
  CTA_TEXT_MAX,
  BANNER_ALT_MAX,
  parseBlockMarkers,
  validateBlocks,
  type BlockViolation,
  type DesignBlock,
} from './domain/design-blocks/block-markers';
export { applyDesignBlocks } from './domain/design-blocks/render-blocks';
export type {
  BrandSettingsRecord,
  BrandSettingsRepo,
  BrandSettingsTx,
  BrandSettingsWrite,
} from './application/ports/brand-settings-repo';
export type { TenantLogoUrlPort } from './application/ports/tenant-logo-url-port';
export type { BrandChromePort } from './application/ports/brand-chrome-port';
// The port TYPE only — the `src/lib/broadcast-brand-deps.ts` composition root
// binds `f7AuditAdapter` (already exported above) to it.
export type { AuditPort as BroadcastsAuditPort } from './application/ports/audit-port';
export {
  setBrandSettings,
  type SetBrandSettingsDeps,
  type SetBrandSettingsError,
  type SetBrandSettingsInput,
} from './application/use-cases/set-brand-settings';
export {
  getBrandSettings,
  INVOICE_SETTINGS_HREF,
  type BrandSettingsView,
  type GetBrandSettingsDeps,
  type GetBrandSettingsInput,
} from './application/use-cases/get-brand-settings';
export { drizzleBrandSettingsRepo } from './infrastructure/db/drizzle-brand-settings-repo';
export type {
  BroadcastImageOwnerKind,
  BroadcastImageRecord,
  BroadcastImagesRepo,
  BroadcastImagesTx,
  NewBroadcastImage,
} from './application/ports/broadcast-images-repo';
export type { StoredImageRef } from './application/ports/image-storage-port';
export type { UploadInlineImageActor } from './application/use-cases/upload-inline-image';
export {
  reclaimOrphanedImages,
  IMAGE_SWEEP_BATCH,
  type ReclaimOrphanedImagesDeps,
  type ReclaimOrphanedImagesError,
  type ReclaimOrphanedImagesInput,
  type ReclaimOrphanedImagesOutput,
} from './application/use-cases/reclaim-orphaned-images';
export { makeReclaimOrphanedImagesDeps, makeAuthorizeImageOwnerDeps, makeUploadInlineImageDeps } from './infrastructure/broadcasts-deps';
export {
  authorizeImageOwner,
  IMAGE_UPLOAD_MEMBER_STAGES,
  IMAGE_UPLOAD_STAFF_STAGES,
  type AuthorizeImageOwnerDeps,
  type AuthorizeImageOwnerError,
  type AuthorizeImageOwnerInput,
  type AuthorizeImageOwnerOutput,
  type ImageUploadActor,
} from './application/use-cases/authorize-image-owner';
export {
  uploadInlineImage,
  type UploadInlineImageDeps,
  type UploadInlineImageError,
  type UploadInlineImageInput,
  type UploadInlineImageOutput,
} from './application/use-cases/upload-inline-image';
export { isF71aUs2Enabled, f71aUs2DisabledReason } from './infrastructure/feature-flags';
export { drizzleBroadcastImagesRepo } from './infrastructure/db/drizzle-broadcast-images-repo';
// F119 review finding F2-1 — the shared stamp+audit step both hard-delete
// paths run inside their own transaction (draft discard, draft prune).
export {
  markOwnerImagesRemoved,
  type ImageRemovalReason,
  type MarkOwnerImagesRemovedDeps,
  type MarkOwnerImagesRemovedInput,
} from './application/use-cases/_mark-owner-images-removed';
export { sharpImageReencoder } from './infrastructure/sharp-image-reencoder';
export type { ImageReencoderPort, ImageReencodeError, ReencodedImage } from './application/ports/image-reencoder-port';
export type { EmailRendererPort, RenderEmailInput, BroadcastRenderLocale } from './application/ports/email-renderer-port';
export { emailTemplateRenderer } from './infrastructure/resend/email-template-renderer';
export type { TestCopyMailerPort, TestCopyMailerError, TestCopyMessage } from './application/ports/test-copy-mailer-port';
export {
  sendTestCopy,
  TEST_COPY_BODY_MAX_BYTES,
  TEST_COPY_SUBJECT_MAX,
  TEST_COPY_SUBJECT_PREFIX,
  type SendTestCopyDeps,
  type SendTestCopyError,
  type SendTestCopyInput,
  type SendTestCopyOutput,
} from './application/use-cases/send-test-copy';
export {
  renderBroadcastPreview,
  PREVIEW_BODY_MAX_BYTES,
  PREVIEW_SUBJECT_MAX,
  type PreviewSurface,
  type RenderBroadcastPreviewDeps,
  type RenderBroadcastPreviewError,
  type RenderBroadcastPreviewInput,
  type RenderBroadcastPreviewOutput,
} from './application/use-cases/render-broadcast-preview';
export { isEblastMemberApprovalEnabled } from './infrastructure/feature-flags';
