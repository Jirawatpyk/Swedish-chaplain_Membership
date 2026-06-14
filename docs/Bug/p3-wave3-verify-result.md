# Wave-3 P3 verification — full triage

counts: {"REAL_DEFECT": 25, "COSMETIC": 12, "ALREADY_FIXED": 12, "REFUTED": 12}

## REAL_DEFECT — P1 (2)
### [n16] listLinkedUserIdsForMemberInTx silently returns [] on DB error, archive cascade may proceed without full session revocation
- module/sev: P1
- evidence: src/modules/members/infrastructure/db/drizzle-contact-repo.ts:221-235 — catch block logs error and returns [] without distinguishing 'no contacts' from 'DB query failed'; src/modules/members/application/use-cases/archive-member.ts:151-189 — caller has no way to detect the failure; if linkedUserIds is [] the session-revocation loop (line 165) never executes and NO audit event is emitted
- reason: If the contact lookup query silently fails, sessions won't be revoked but there is no audit trail to indicate this. The member is marked archived while portal users retain active sessions, a critical data integrity issue. Only a logger.error call exists, which may not be monitored.

### [n42] Download token exposed in Vercel platform access logs via URL query string
- module/sev: P1
- evidence: src/app/api/portal/account/data-export/[jobId]/download/route.ts:94 — `url.searchParams.set('token', result.value.token)`. Same pattern in admin members route (line 64) and directory exports route (line 87). The 303 redirect includes the token in the Location header.
- reason: Download tokens appear in Vercel access logs, browser history, and Referer headers due to query-string transmission. This is a genuine information disclosure risk on a sensitive authentication artifact.

## REAL_DEFECT — P2 (14)
### [n7] unsafeBrandTenantSlug exported from public barrel with documentation-only call-site enforcement — no ESLint rule blocks new violating call sites
- module/sev: P2
- evidence: src/modules/tenants/index.ts:28 — `unsafeBrandTenantSlug` is re-exported from the public barrel. src/modules/tenants/domain/tenant-slug.ts:60-82 — allowed call sites are enumerated only in a JSDoc comment with no corresponding ESLint rule in eslint.config.mjs. Grep confirms the function is currently called in only 3 files (all allowed), but there is no linter gate that would fail CI if a new violation were added.
- reason: The security-sensitive unsafeBrandTenantSlug function has only documentation-based governance. A developer could inadvertently add a call site in a new file without triggering a linter error, violating the JSDoc's stated security constraint.

### [n10] planPatchSchema comment misrepresents merged-result validation
- module/sev: P2
- evidence: src/modules/plans/domain/plan-validators.ts:223-224 comment claims 'the merged-result validation in update-plan.ts catches cross-field mismatches against the full plan.' src/modules/plans/application/update-plan.ts:166 validates patch in isolation with planPatchSchema.safeParse; lines 147-262 show NO step that merges existing plan with patch and re-validates. The comment describes an unimplemented defense.
- reason: The comment misleads future maintainers by claiming a validation step that does not exist in the code. This is a documentation defect that could lead to incorrect architectural decisions or maintenance errors.

### [n13] Bare ⚠ glyph used for missing-translation badge instead of lucide icon
- module/sev: P2
- evidence: src/components/plans/locale-text-display.tsx:54 uses {locale.toUpperCase()} ⚠ (bare U+26A0 emoji). src/components/plans/locale-text-input.tsx:98 uses {l.label} ⚠ (same bare emoji). No lucide icon component is used.
- reason: Both UI components violate the design token standard by using raw emoji instead of sized lucide icon components, reducing consistency and accessibility. Other badges in the module correctly use lucide icons.

### [n20] serialiseInvoice returns internal Vercel Blob object keys to admin API consumers
- module/sev: P2
- evidence: src/app/api/invoices/_serialise.ts:47,55 — Lines return `pdf_blob_key: invoice.pdf?.blobKey ?? null` and `receipt_pdf_blob_key: invoice.receiptPdf?.blobKey ?? null`. These are exposed by GET /api/invoices, GET /api/invoices/[invoiceId], POST /api/invoices/[invoiceId]/issue, POST /api/invoices/[invoiceId]/pay, and DELETE /api/invoices/[invoiceId] (all admin-only endpoints). Blob keys follow format `invoicing/{tenantId}/{fiscalYear}/{uuid}_v{version}.pdf` which exposes internal infrastructure details.
- reason: The admin API surfaces internal blob storage keys that expose tenant structure and object identifiers. While admin-only, these are unnecessary for the admin UI (which uses dedicated /api/invoices/[id]/pdf route) and constitute mild information disclosure per STRIDE.

### [n24] POST /api/refunds/initiate rate-limit hit emits no audit event
- module/sev: P2
- evidence: src/app/api/refunds/initiate/route.ts:146-152 — on `!rl.success` the route returns 429 with logger.warn but no call to `f5AuditAdapter.emit`. Contrast src/app/api/payments/initiate/route.ts:181-200 which emits `payment_initiate_rate_limited`. The refund route is the only F5 rate-limited surface without an audit emission on rate-limit hits.
- reason: Refund rate-limit hits are not audited, creating a gap in the forensic trail. Payment initiate correctly emits the audit event; refunds must do the same for compliance and observability parity.

### [n26] SecurityFooter privacy disclosure <a> has no accessible name beyond its text content — focus ring uses underline only, not ring-2
- module/sev: P2
- evidence: src/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/security-footer.tsx:39-51 — the Stripe privacy link uses className='underline hover:text-foreground' with no focus-visible:ring-2 or focus-visible:ring classes. Contrast payment-timeline.tsx:422 which correctly uses focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 on the 'View in Stripe' link.
- reason: Missing visible focus indicator violates WCAG 2.1 Success Criterion 2.4.7 (Focus Visible). Keyboard users cannot reliably see when the link has focus.

### [n27] PaymentTimeline empty state 'Record payment manually' link uses fragment href (#record-payment) — unreliable scroll on Safari + broken if element not in DOM
- module/sev: P2
- evidence: src/app/(staff)/admin/invoices/[invoiceId]/_components/payment-timeline.tsx:474 — <a href={`/admin/invoices/${invoiceId}#record-payment`}> targets an element that may not exist if the staff role check hides RecordPaymentDialog, and in-page anchor scrolling is unreliable with sticky headers.
- reason: Navigation to a non-existent fragment is a UX defect. If RecordPaymentDialog is hidden (e.g., for non-admin roles), the link navigates to a hash that does not exist on the page.

### [n30] Webhook rate-limit step-4 metric label fires 'rejected_bad_sig' for pre-auth rate-limits
- module/sev: P2
- evidence: src/app/api/webhooks/eventcreate/v1/[tenantSlug]/route.ts:364-366 — the rate-limit exceeded branch calls `eventcreateMetrics.webhookReceiptsTotal(tenantSlug, 'rejected_bad_sig', 'rate_limited')`. The label `rejected_bad_sig` is semantically incorrect (no signature was attempted). Line 284 uses `'rejected_pre_auth'` for Content-Type checks, and metrics.ts:2733 defines this as a valid label. The rate-limit path should use `'rejected_pre_auth'` to match.
- reason: Misclassified metric label causes incorrect OTel histogram classification. Rate-limited requests are pre-auth events, not signature mismatches. This produces misleading observability data that could mask actual signature failures.

### [n32] FR-005 rate-limit spec text (10 req/min) contradicts implemented value (60 req/min) — spec.md not updated after round-2 E13 adjustment
- module/sev: P2
- evidence: specs/012-eventcreate-integration/spec.md:193 reads 'System MUST rate-limit incoming webhook requests to no more than **10 requests per minute per tenant**'. src/lib/events-webhook-deps.ts:68 sets `const F6_WEBHOOK_MAX_PER_MIN = 60`. The spec was not updated to reflect the round-2 E13 adjustment.
- reason: Spec-code mismatch that will mislead future maintainers. The spec is the source of truth for feature requirements; having it contradict the implementation by 6x is a correctness issue for documentation and compliance verification.

### [n34] Inline-image upload draftId not ownership-checked at route layer
- module/sev: P2
- evidence: src/app/api/broadcasts/inline-image-upload/route.ts:75 — accepts `draftId` from form field and passes directly to use-case without ownership verification. src/modules/broadcasts/application/use-cases/upload-inline-image.ts:51 accepts draftId only for audit/logging (lines 99, 124, 184); no DB lookup against ctx.member.memberId. Any authenticated member can upload to any draftId.
- reason: A member can upload inline images and attach them to another member's draft broadcasts by supplying any draftId UUID string. The route and use-case perform no ownership check. This is an IDOR vulnerability.

### [n41] No rate limit on admin directory export request
- module/sev: P2
- evidence: src/app/api/admin/directory/exports/route.ts:1-80 — no rateLimiter import or call anywhere in the file. The POST route (lines 29-79) creates directory export jobs with no frequency cap after the role gate.
- reason: A staff user can repeatedly POST to enqueue unlimited CPU-intensive PDF export jobs with no per-actor or per-tenant rate limit, creating a resource exhaustion vector. The find explicitly states this is missing.

### [n56] Broadcasts consent banner: acknowledgement stores locale but not consent notice version
- module/sev: P2
- evidence: src/modules/broadcasts/application/use-cases/acknowledge-broadcasts-terms.ts:157-163 — the audit payload stores memberId, userId, acknowledgedAt, bannerLocale, and retentionYears. No notice_version or terms_hash field is included. drizzle/migrations/0071_alter_members_add_broadcasts_acknowledged_at.sql:23-27 explicitly documents that 'The audit-log row `member_acknowledged_broadcasts_terms` carries the original timestamp + banner_locale', but this migration was written with the expectation that a version would be tracked to satisfy GDPR Art. 7 'demonstrable consent' when terms change. No broadcasts_terms_notice_version column exists on the members table (verified via grep of schema-members.ts:116-118).
- reason: The consent notice content is stored only in mutable i18n JSON files (portal.broadcasts.banner.acknowledgement.* at src/i18n/messages/en.json:4035-4045). When terms change (e.g. F12 white-label customization), a tenant admin can reset broadcasts_acknowledged_at to NULL per the migration, but the audit row carries no reference to the specific version/URL of the terms shown — making future GDPR Art. 7 audits unable to prove what the member actually consented to. This is a genuine GDPR compliance gap.

### [n57] Smart-insight 'at_risk_followup' line is informational text with a scopeRef but no link to act on it
- module/sev: P2
- evidence: src/components/dashboard/insights-panel.tsx:45 — the insight line renders as <span>{line.text}</span> with no Link/href; src/modules/insights/application/use-cases/compute-dashboard-snapshot.ts:163 — the at_risk_followup insight is created without a scopeRef property: candidates.push({ key: 'at_risk_followup', count: atRisk }). Even if scopeRef existed, InsightsPanel does not make the text clickable for any insight.
- reason: The at-risk insight on the admin dashboard displays a count of affected members (e.g., '5 members at risk') but provides no way for admins to navigate directly to that filtered member list. The NeedsAttentionList above it does provide clickable links with hrefs to drill-down views; insights receive the same treatment as non-interactive informational elements. This creates friction in the common workflow: seeing a warning requires manually navigating to Members and applying the at-risk filter.

### [n59] Invitation dead-link offers no self-service recovery and the page-level dead-token branch lacks the 'contact admin' guidance the form branch has
- module/sev: P2
- evidence: src/app/(auth-public)/invite/[token]/page.tsx:78-86 renders only `{t('errors.tokenExpired')}` in the alert. src/components/auth/invite-redeem-form.tsx:156-173 renders both `{t('errors.tokenExpired')}` (line 168) and `{t('errors.contactAdminCta')}` (line 170). The two dead-token surfaces are inconsistent.
- reason: The member receives inconsistent guidance depending on when the invitation token expires — no guidance at page-load, but full guidance if it expires during form submission. This is a genuine UX defect affecting member error recovery.

## REAL_DEFECT — P3 (9)
### [n6] SLUG_PATTERN duplicated in tenant-context.ts and tenant-slug.ts without sharing the exported constant
- module/sev: P3
- evidence: src/modules/tenants/domain/tenant-context.ts:46 — `const SLUG_PATTERN = /^[a-z0-9-]{1,63}$/;` (private, exported as TENANT_SLUG_PATTERN at line 75). src/modules/tenants/domain/tenant-slug.ts:27 — identical `const SLUG_PATTERN = /^[a-z0-9-]{1,63}$/;` (private, NOT importing the exported constant from tenant-context.ts). The duplication is factually present on main.
- reason: SLUG_PATTERN is defined twice identically in two files in the same module. tenant-slug.ts should import TENANT_SLUG_PATTERN from tenant-context.ts to maintain DRY principle and ensure single source of truth for the validation regex.

### [n8] No dedicated unit tests for asTenantSlug or unsafeBrandTenantSlug — rejection cases and the weak tryTenantId pattern-gap are untested
- module/sev: P3
- evidence: Glob search shows tests/unit/tenants/ contains only tenant-context.test.ts and iana-timezone.test.ts. No tenant-slug.test.ts exists. The functions asTenantSlug and unsafeBrandTenantSlug have zero dedicated test coverage. The exported TENANT_SLUG_PATTERN is tested in tenant-context.test.ts lines 110-115, but the tenant-slug.ts module's own constructors and edge cases are not tested.
- reason: The tenant-slug.ts module exports public validator functions (asTenantSlug) and an escape hatch (unsafeBrandTenantSlug) without corresponding test coverage. Missing tests for rejection cases (empty, uppercase, >63 chars, etc.) means regressions or future changes are not caught.

### [n9] Missing architecture scan test backstop for the tenants barrel — ESLint no-restricted-imports rule may be shadowed
- module/sev: P3
- evidence: Glob search of tests/unit/architecture/ returns: invoicing-members-bidirectional-dep.test.ts, events-barrel.test.ts, broadcasts-barrel.test.ts, insights-barrel.test.ts, application-layer-imports.test.ts. No tenants-barrel.test.ts exists. The broadcasts-barrel.test.ts and similar files exist precisely as a defense-in-depth against the ESLint flat-config shadow bug documented in their headers.
- reason: The tenants module lacks a source-scan architecture test to verify that no new deep imports from @/modules/tenants/(domain|application|infrastructure) slip into src/app/** or src/components/** unexpectedly. The broadcasts, events, and insights modules each have such a test as a backstop for the ESLint shadow bug.

### [n14] Prior-year lock banner hand-rolls outline-button className instead of reusing buttonVariants
- module/sev: P3
- evidence: src/components/plans/prior-year-lock-banner.tsx:40 uses manual className='inline-flex items-center rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-accent hover:text-accent-foreground'. Other components in the same module correctly use buttonVariants({ variant: 'outline', size: 'sm' }).
- reason: Inconsistent component composition violates the module's pattern of reusing buttonVariants(). This creates style drift and maintenance burden when the button primitive is updated.

### [n29] wasAlreadyPseudonymised idempotency condition is non-obvious and partially redundant
- module/sev: P3
- evidence: src/modules/events/application/use-cases/pseudonymise-stale-non-member-pii.ts:146-147 — `const wasAlreadyPseudonymised = updateResult.value.piiPseudonymisedAt !== null && updateResult.value.piiPseudonymisedAt.getTime() !== input.occurredAt.getTime();` The timestamp-inequality check is fragile and misleading. If a caller passes the same `occurredAt` on retry AND a concurrent sweep already ran, the guard returns false (timestamps equal) and the audit emits twice.
- reason: The condition relies on timestamp inequality to detect prior pseudonymisation, which is fragile. The timestamp check is unnecessary since checking `piiPseudonymisedAt !== null` alone is sufficient to detect prior pseudonymisation. Current code has a genuine concurrency bug risk.

### [n57] Smart-insight 'at_risk_followup' line is informational text with no link to act on it
- module/sev: P3
- evidence: src/modules/insights/application/use-cases/compute-dashboard-snapshot.ts:163 — at_risk_followup is created without a scopeRef: `candidates.push({ key: 'at_risk_followup', count: atRisk })`. src/components/dashboard/insights-panel.tsx:45 renders only `<span>{line.text}</span>` with a dismiss button and no link element.
- reason: The at-risk insight communicates a count of members needing action but provides no navigation to act on it. Even though the recommendation suggests threading a scopeRef, the insight is created without one and the panel has no affordance to make insights navigable. This blocks the intended UX flow.

### [n43] raw DB e.message leaks into Vercel function logs via SearchPlansError
- module/sev: P3
- evidence: src/modules/plans/application/search-plans.ts:366 — `message: e instanceof Error ? e.message : String(e)` captures raw exception text. src/app/api/plans/search/route.ts:275 logs `{ requestId: ctx.requestId, err: result.error }` where result.error is the SearchPlansError plain object with the message field. The logger (src/lib/logger.ts:650-676) has no serializers.err custom handler; it serializes plain objects by enumerating properties, so the `message` field lands in logs unredacted.
- reason: The SearchPlansError's message property contains raw DB exception text (table names, column names, SQL fragments from Postgres). Pino serializes this plain object without sanitization, violating log-hygiene policy for secrets/schema-leakage.

### [n47] F9-flag-off fallback lists F3–F6 as 'upcoming' despite all being shipped
- module/sev: P3
- evidence: src/app/(staff)/admin/page.tsx:58,83 — when `!env.features.f9Dashboard`, the page renders ROADMAP_PHASES = ['F3', 'F4', 'F5', 'F6'] via tHome('roadmap.{phase}') keys. src/i18n/messages/en.json:447 cardDescription reads 'F1 (auth) is the foundation. The rest of the staff workspace lands in upcoming phases.' F3–F8 are all marked SHIPPED in CLAUDE.md per the task instructions ('all P0/P1/P2 + stage-0 P3 fixes already landed'). The fallback copy is stale.
- reason: The flag-off fallback misleads users into thinking F3–F6 are unreleased features when they are actually shipped. This violates the principle of accurate status reporting, especially in a production staff interface. The recommendation to replace with a neutral 'Dashboard is loading' message is sound — this path only renders when the flag is artificially off, not because features are genuinely pending.

### [n59] Invitation dead-link offers no self-service recovery and the page-level dead-token branch lacks the 'contact admin' guidance the form branch has
- module/sev: P3
- evidence: src/app/(auth-public)/invite/[token]/page.tsx:78-86 — renders alert with only t('errors.tokenExpired') with no additional guidance. Contrast: src/components/auth/invite-redeem-form.tsx:161-172 — renders both t('errors.tokenExpired') AND t('errors.contactAdminCta') ('Contact an administrator to request a new invitation.') when link becomes invalid during form submission.
- reason: The two dead-token surfaces are inconsistent: a token that is dead at page-load (pre-validation) gives the member no recovery guidance, while a token that goes dead at form-submit (post-validation) includes the contact-admin CTA. This inconsistency violates the principle that both flows should guide the user identically when the same error condition occurs.

## COSMETIC (12)
- [n3] (P3) UsersFilters 'Clear filters' button: XIcon not aria-hidden — redundant SR announcement
- [n11] (P3) plan-audit-adapter logger.error passes raw err string
- [n12] (P3) searchPlans palette route passes raw caught exception objects to logger
- [n15] (P3) deferred-to-f3.md 'Resolved' section still empty despite F3 shipping
- [n17] (P3) Members empty/error-state headings stack .text-h3 token utility with conflicting text-lg font-semibold
- [n18] (P3) Bulk-archive typed-phrase in TH locale requires typing complex Thai script — may block staff without Thai IME active
- [n22] (P3) Logo upload confirms via opaque blob-key text, not a visual preview
- [n25] (P3) Test-mode badge uses arbitrary text-[10px] instead of the type scale
- [n28] (P3) PaySheetInternal aria-live announcer is role=status — 'success' state announcement may be politely queued behind ongoing SR speech
- [n31] (P3) Match-status and quota-effect badges use hardcoded multi-hue palettes — justified deviation, but text-contrast (4.5:1) is unverified
- [n33] (P3) drizzle-registrations-repository.ts header comment incorrectly lists implemented methods as stubs
- [n40] (P3) SV locale tierBucket.thai_alumni untranslated — kept as 'Thai Alumni' (same as EN)

## ALREADY_FIXED (12)
- [n1] reissueInvitation emits no F1 audit event — silent path if called outside F3
- [n2] change-role / disable-user countActiveAdmins uses pool-global db outside any transaction
- [n4] Argon2id dummy-hash is computed lazily on first cold-start sign-in attempt — adds ~50ms
- [n5] FR-025 invitation resend affordance: user-initiated resend intentionally absent — design divergence from spec literal
- [n19] searchDirectory correlated EXISTS subquery for q-filter not guarded by the contacts_tenant_member_idx partial index — potential secondary seq scan on non-removed contacts
- [n21] Cross-tenant invoice probe integration test exercises real two-tenant scenario
- [n36] ComposeStaleDraftBanner component shipped as a building block but no page mounts it
- [n37] drizzle-bounce-event-query step-2 uses global db (intentional, documented)
- [n38] drizzle-reminder-audit-query-repo uses global db without runInTenant
- [n46] Observability metrics catalogue complete and wired
- [n44] No rate limit on staff directory export enqueue (POST /api/admin/directory/exports)
- [n45] No rate limit on admin on-behalf GDPR export (POST /api/admin/members/[id]/data-export)

## REFUTED (12)
- [n35] F7.1b deferred engagement-tracking, per-contact opt-in, saved-segment, attachments, and PII-scanner contracts are documents only
- [n39] Tier / urgency / risk badge multi-hue scales are JUSTIFIED — do not flag as token drift
- [n46] observability.md §25.1 metrics catalogue is complete and all 4 US1 counters/histograms are wired in metrics.ts
- [n48] PASS — PAN/CVV never received by application server; PaymentElement used exclusively
- [n49] PASS — Webhook uses request.text() before any parse; constructEvent called with raw body
- [n50] PASS — clientSecret never logged; REDACT_PATHS covers clientSecret, client_secret, and card.*
- [n51] PASS — DB stores only last4, brand, expMonth, expYear; no PAN, CVV, or fingerprint
- [n52] PASS — CSP frame-src includes js.stripe.com and hooks.stripe.com; nonce-based script-src in production
- [n53] PASS — STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET never under NEXT_PUBLIC_ prefix; boot-time live/test segregation enforced
- [n54] PASS — Idempotency keys present on createPaymentIntent and createRefund
- [n55] PASS — 3DS/SCA handled: requires_action state + client-side poll loop via useThreeDSecurePoll
- [n58] Manager sidebar shows the same nav as admin; combined with the detail-page issue there is no role-level signal that the staff surface is read-only
