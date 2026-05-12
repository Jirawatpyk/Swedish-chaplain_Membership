# Records of Processing — Chamber-OS

**Purpose**: Statutory record-of-processing log per **PDPA §39** (Thailand
Personal Data Protection Act) and **GDPR Article 30** (EU General Data
Protection Regulation). One section per F-stack feature documents the
controller, processor, categories of data subjects, categories of
personal data, processing purpose, recipients, cross-border transfers,
retention periods, and technical + organisational measures (TOMs).

**Owner**: Chamber DPO (Data Protection Officer) — coordinates with
chamber legal-counsel for regulatory updates and with platform
on-call for technical detail.

**Last reviewed**: 2026-04-29 (Batch D T034 spec scaffolding)

> **TODO**: F1 (Auth & RBAC), F4 (Invoices & Receipts), and F5 (Online
> Payment) sections are part of the Constitution-mandated compliance
> backlog and NOT in F7 scope. They MUST be authored before the next
> chamber-of-commerce annual data-protection report cycle. Tracking:
> see `.specify/memory/constitution.md` § Compliance — record-of-
> processing requirement.

---

## F7 — Email Broadcast (E-Blast)

**Status**: SPEC — emit sites land Phase 3+ (T036+). Branch
`010-email-broadcast`. This entry codifies the processing record BEFORE
the use-cases ship so the Spec Kit `/speckit.review` privacy gate can
verify the platform implementation matches the documented record.

### Controller

The chamber tenant operating the Chamber-OS deployment (single-tenant in
F1 deployment = Thailand-Swedish Chamber of Commerce / SweCham). Each
F-stack tenant in F11+ multi-tenant SaaS deployment is its own
controller; the platform vendor (chamber-os.zyncdata.app maintainer) is
a processor under contract.

### Processors

- **Vercel Inc.** (US-incorporated; deployment region `sin1` Singapore)
  — application hosting, edge network, function execution, Speed
  Insights metrics. Data Processing Addendum (DPA) executed +
  Standard Contractual Clauses (SCCs) on file with Vercel Marketplace
  default contract.
- **Neon Inc.** (US-incorporated; deployment region `ap-southeast-1`
  Singapore) — Postgres database. DPA + SCCs on file.
- **Resend Inc.** (US-incorporated; broadcast delivery via EU regional
  cluster) — F7 Broadcasts API for marketing email dispatch + delivery
  webhook events. DPA + SCCs on file. **Sub-processor list reviewed
  quarterly** (Resend may use AWS / SendGrid / etc. as
  sub-sub-processors).
- **Upstash Inc.** (US-incorporated; deployment region Singapore) —
  Redis rate-limit cache. DPA on file.
- **Sentry / Vercel OTel** — error tracking + distributed tracing. PII
  scrubbing enforced via redact rules (see `docs/observability.md
  § 22.4`).

### Categories of data subjects

- **Chamber members** (legal-entity chamber members; technically the
  "data subjects" under PDPA / GDPR are the natural persons who are
  primary contacts of those entities).
- **Primary contacts of chamber members** — natural persons whose name
  + email + tier code is stored in `members` (primary contact email)
  and `contacts` (secondary contacts).
- **Custom recipient list emails** — natural persons whose email
  appears in a `broadcasts.custom_recipient_emails` array. **Per
  FR-015d** these MUST resolve to a known email in the tenant graph
  (members.primary_contact_email OR contacts.email OR
  event_attendees.email — F6 stub returns `[]` until F6 ships).
  External-only recipients are out of MVP scope. This restriction
  prevents chamber sender reputation being used for arbitrary
  external mass-marketing.

### Categories of personal data

| Category | Field | Notes |
|---|---|---|
| **Identity** | `members.company_name`, `contacts.given_name`, `contacts.family_name`, `members.member_id` | Pseudonymised member id used internally; display name surfaces in `from_name` of broadcasts |
| **Contact** | `members.primary_contact_email`, `contacts.email`, `broadcasts.custom_recipient_emails`, `broadcasts.reply_to_email` | All normalised lowercase + trimmed (`EmailLower` VO) |
| **Membership** | `members.plan_id`, `members.plan_year`, plan tier code from F2 | Used for segment targeting |
| **Behavioural** | `broadcast_deliveries.status` (sent\|delivered\|bounced\|soft_bounced\|complained), `broadcast_deliveries.event_timestamp` | Per-recipient × per-broadcast |
| **Consent** | `members.broadcasts_acknowledged_at` (Q15 GDPR Art. 7 banner ack timestamp) | Indefinite retention while member row exists |
| **Suppression / objection** | `marketing_unsubscribes.email_lower` + reason (recipient_initiated\|hard_bounce\|complaint\|admin_added) | **Indefinite retention** per GDPR Art. 21 + PDPA §32 |
| **Operational** | `broadcasts.subject`, `broadcasts.body_html` (sanitised), `broadcasts.body_source` (Tiptap raw), `broadcasts.from_name`, `broadcasts.reply_to_email` | Member-authored content; sanitised at Application boundary (FR-002a strict-allowlist DOMPurify) |

**No special categories (Art. 9 / PDPA §26)** are processed by F7 —
no health, religion, political opinion, racial origin, sexual
orientation, biometric, or genetic data. Member tier codes are
business categorisation, not special-category PII.

### Purpose of processing

- **Marketing communications** under contract performance per **PDPA
  §24** + **GDPR Art. 6(1)(b)** — chamber membership tiers contractually
  include an annual quota of E-Blasts (1–15 per year across paying
  tiers). The processing is necessary to deliver the contractually
  promised benefit.
- **Demonstrable consent timestamp** per **GDPR Art. 7** — the Q15
  banner CTA records `broadcasts_acknowledged_at` as evidence-
  strengthening for the "demonstrable consent" obligation. Does NOT
  shift the lawful basis from contract to consent; both bases coexist
  per the controller's discretion.
- **Statutory compliance** — `broadcast_deliveries` retention serves
  PDPA §39 / GDPR Art. 30 record-of-processing obligation. Audit-log
  retention serves Constitution Principle VIII reliability + financial-
  records-related events.

### Recipients of personal data

- **Chamber members + their primary contacts** — recipients of the
  broadcast emails dispatched by F7.
- **Resend Inc. (processor)** — receives the broadcast HTML body +
  recipient list at dispatch time; transmits the email; reports
  delivery events back via webhook.
- **Chamber admins (data subjects in the controller's role)** —
  receive admin-notification emails on submission via F1+F4
  transactional path (NOT via F7 Broadcasts).
- **Chamber DPO + legal-counsel** — under chamber bylaws, may access
  any processing record for compliance review.

### Cross-border data transfers

- **Singapore (Neon, Vercel, Upstash)** — Thailand → Singapore is
  covered by Thailand PDPA §28 cross-border provisions. Swedish/EU
  data subjects covered by **GDPR Standard Contractual Clauses (SCCs)**
  with Vercel + Neon + Upstash.
- **EU (Resend)** — chamber member primary contact emails are
  transferred to Resend's EU regional cluster for dispatch. Covered by
  Resend's DPA + SCCs. EU → EU within Resend's network is not a
  cross-border transfer.
- **No US-direct transfer** — all processors maintain regional
  deployments (SG / EU); raw personal data does NOT transit US-based
  Resend / Vercel infrastructure.

### Retention periods

| Resource | Retention | Authority |
|---|---|---|
| `broadcasts` rows + `broadcast_deliveries` rows | **5 years** (Constitution v1.4.0 default for non-tax-document audit) | F7 has no §87/3 / §86/10 obligation; standard 5y matches operational + record-of-processing baseline |
| `marketing_unsubscribes` rows | **Indefinite** | GDPR Art. 21 right to object — once a recipient unsubscribes, the suppression record MUST persist forever to honour future processing avoidance |
| `members.broadcasts_acknowledged_at` | **Indefinite** while member row exists | GDPR Art. 7 demonstrable consent — deleted alongside member on Art. 17 erasure; admin SHOULD reset to NULL on F12 white-label terms change to force re-acknowledgement |
| `members.broadcasts_halted_until_admin_review` | **Indefinite** while member row exists | Q14 SC-005 (b) auto-halt operational state |
| `audit_log` rows for F7 events (37 event types) | **5 years** | All F7 events default 5y per `src/modules/broadcasts/application/ports/audit-port.ts` `F7_AUDIT_RETENTION_YEARS` map |
| Resend Broadcasts API send logs | Resend default (90 days) | Provider retention; not under chamber control |

### Technical + organisational measures (TOMs)

**Technical**:

- **Tenant isolation (NON-NEGOTIABLE)** — Constitution v1.4.0 Principle I
  clause 3: every F7 table has Postgres `ENABLE ROW LEVEL SECURITY` +
  `FORCE ROW LEVEL SECURITY` + tenant-isolation policy. Cross-tenant
  integration test (T022) is a Review-Gate blocker.
- **Sanitisation (NON-NEGOTIABLE)** — FR-002a strict-allowlist
  DOMPurify HTML sanitiser at Application layer; raw editor output is
  NEVER persisted. OWASP A06 sanitiser-boundary discipline.
- **HMAC unsubscribe tokens** — one-click unsubscribe links signed
  with `UNSUBSCRIBE_TOKEN_SECRET` (≥ 32 bytes, distinct from
  `AUTH_COOKIE_SIGNING_SECRET` per research.md § 4); tokens valid
  forever per FR-030 idempotency. Compromise recovered via key
  rotation; existing tokens invalidated.
- **Signed webhooks** — Resend Broadcasts webhook signatures
  verified via Svix HMAC-SHA256 over raw body BEFORE parsing JSON
  (Node runtime pinned). Failed verifications emit
  `broadcast_webhook_signature_rejected` audit (5y retention) for
  forensic review.
- **Append-only audit log** — `audit_log` table has BEFORE UPDATE +
  BEFORE DELETE triggers raising `check_violation` for any non-system
  attempted mutation. F7 contributes 37 new audit event types.
- **Rate limiting** — F1 Upstash Redis token buckets prevent runaway
  submission (10 / 24h per member per tenant per FR-002d) and webhook
  replay abuse (600 / min per source IP).
- **Encryption** — TLS in-flight (Vercel managed certificates); Postgres
  at-rest encryption (Neon managed); Resend in-flight encryption to
  recipient mailboxes.

**Organisational**:

- **Quarterly secret rotation** calendar maintained by chamber DPO.
- **Spec Kit `/speckit.review` privacy gate** — every F-stack feature
  must pass privacy + security checklists before ship.
- **Annual data-protection report** to chamber bylaws committee.
- **Incident response runbooks** under `docs/runbooks/` covering
  deliverability incidents, breach notification (PDPA §37 24h + GDPR
  Art. 33 72h), credential compromise, webhook abuse, queue overflow,
  performance regression, halt-clear workflow.
- **Solo-maintainer substitute** (Constitution v1.4.0 Principle IX +
  Governance) governs review workflow when no second human reviewer
  is available — automated review + threat-modeller + DB-level
  defence-in-depth substitute the ≥ 2-reviewer rule.

### Data subject rights — exercise procedures

| Right (GDPR / PDPA equivalent) | Procedure |
|---|---|
| **Right to access (Art. 15 / §30)** | Member portal `/portal/profile` shows all stored personal data; admin extension via F1 audit-log query for full dataset including F7 broadcast history |
| **Right to rectification (Art. 16 / §31)** | Member self-service portal edits primary contact email; admin can update `members` + `contacts` rows directly |
| **Right to erasure (Art. 17 / §32)** | F1 admin-archive cascade sets `member_id` to NULL on `marketing_unsubscribes` + `broadcast_deliveries` BUT retains the rows for record-of-processing. Suppression invariant ("we will not contact this email again") preserves the data subject's prior objection |
| **Right to restrict processing (Art. 18 / §33)** | F7 kill-switch (`FEATURE_F7_BROADCASTS=false`) halts all new submissions tenant-wide; per-member halt via Q14 `broadcasts_halted_until_admin_review` |
| **Right to data portability (Art. 20)** | F1+F2+F3 portable export covers member + plan + contact data; F7 broadcast history accessible via member portal |
| **Right to object (Art. 21 / PDPA §32)** | One-click unsubscribe link in every broadcast (HMAC token → suppression upsert → indefinite retention of objection record) |
| **Right not to be subject to automated decision-making (Art. 22)** | F7 has no automated decision-making affecting members; admin review is human-mediated per FR-013 |

### DPO contact

- **Chamber DPO email**: `dpo@<chamber-domain>` (placeholder — to be
  confirmed per tenant; chamber bylaws designate DPO).
- **Regulatory contact**:
  - Thailand: PDPC (Office of the Personal Data Protection Committee) —
    `https://pdpc.or.th`
  - EU: relevant supervisory authority based on data subject location
    (e.g., IMY for Sweden — `https://www.imy.se`)

### Update history

| Date | Change | Author |
|---|---|---|
| 2026-04-29 | Initial F7 entry created (Batch D T034 spec scaffolding) | F7 implementation pass |

---

## F8 — Renewal Tracking + Smart Reminders

**Status**: SHIPS DARK — branch `011-renewal-reminders`; production flag-flip
at MVP-wide chamber go-live. This entry codifies the processing record at
Phase 9 (cross-cutting hardening) so the `/speckit.review` privacy gate can
verify the implementation matches the documented record before flag-flip.

### Controller

Same as F7 — the chamber tenant operating the Chamber-OS deployment.

### Processors

- **Vercel Inc.** — hosting platform (Singapore region). SCC-covered.
- **Neon** — PostgreSQL database (Singapore region). SCC-covered.
- **Upstash** — Redis rate-limit cache (Singapore region). SCC-covered.
- **Resend Inc.** — transactional email API for renewal reminders + admin
  alerts. **F8 reuses the F1+F4 transactional Resend surface** —
  separate from the F7 Broadcasts API + suppression list. Renewal
  reminders are operational notifications (not marketing), classified
  under PDPA §24 paragraph 2 (necessary for performance of contract /
  membership obligation), distinct from F7's marketing-consent regime.
- **cron-job.org** — external HTTP scheduler triggering 5 F8 cron
  endpoints (`/api/cron/renewals/dispatch-coordinator`,
  `/api/cron/renewals/at-risk-recompute-coordinator`,
  `/api/cron/renewals/lapse-cycles-on-grace-expiry-coordinator`,
  `/api/cron/renewals/reconcile-pending-reactivations-coordinator`,
  `/api/cron/renewals/tier-upgrade-evaluate-coordinator`). Bearer-auth
  only; no payload data. Not a processor under GDPR Art. 28 (no PII
  flows through cron-job.org — only Bearer header + URL path).

### Categories of data subjects

- **Members** of the chamber tenant whose membership is in scope for
  renewal (active, awaiting_payment, or in grace period).
- **Lapsed members** for the post-lapse pending-reactivation flow
  (FR-005c) — limited to the 30-day reactivation window.
- **Admin + manager users** of the chamber tenant (auditable activity
  on at-risk outreach + tier-upgrade actions + escalation tasks).

### Categories of personal data

| Field | Source | Sensitivity |
|---|---|---|
| `members.member_id`, `members.company_name`, `members.contact_name`, `members.primary_contact_email` | F3 (existing) | PII |
| `members.expires_at`, `members.joined_at`, `members.last_activity_at` | F3 + F8-derived | activity metadata |
| `members.email_unverified` (F8-added) | Resend bounce-event ingest via F1 webhook | derived signal |
| `members.risk_score`, `members.risk_score_band`, `members.risk_score_factors` (F8-added) | F8 8-factor heuristic recompute | **systematic evaluation per PDPA §32 / GDPR Art. 22** — DPIA required |
| `members.risk_snoozed_until` (F8-added) | Admin snooze action | operational state |
| `renewal_cycles.frozen_plan_price_thb`, `period_from`, `period_to` | F4 + F8-derived | financial metadata |
| `renewal_reminder_events.dispatched_at`, `step_id`, `recipient_email` | Resend dispatch | dispatch audit |
| `at_risk_outreach.notes`, `channel`, `outcome` | Admin/manager outreach record | operational + free-text PII |
| `tier_upgrade_suggestions.evidence` (turnover, paid-invoice volume) | F2 + F4 aggregates | financial signal |
| `renewal_escalation_tasks.notes` | Admin task record | operational + free-text PII |

**No special categories (Art. 9 / PDPA §26)** are processed by F8.

### Purpose of processing

1. **Renewal reminder dispatch** (FR-010, FR-011, FR-014) — operational
   communication of upcoming membership expiry; lawful basis is
   performance of contract (PDPA §24 ¶2 / GDPR Art. 6(1)(b)).
2. **Renewal pipeline dashboard** (FR-046, SC-003) — admin oversight
   of operational state; lawful basis is legitimate interest (chamber
   admin function) under GDPR Art. 6(1)(f); PDPA §24 ¶3 (legitimate
   interest of controller).
3. **At-risk member detection** (FR-029, FR-030) — systematic evaluation
   of natural persons. **Triggers PDPA §32 / GDPR Art. 22 obligations**:
   the 8-factor formula is **rule-based + transparent** (no ML / black
   box); the score is **human-reviewable** by admins; the score does
   **not** produce automated decisions affecting members directly —
   admin manual outreach is the only effect. Member can opt out of
   reminders → kills score signal effectively. Lawful basis is
   legitimate interest (member retention) under Art. 6(1)(f); the
   transparency + opt-out mechanism + DPIA + no-automated-decision
   structure satisfies Art. 22 constraints.
4. **Tier upgrade suggestion** (FR-037, FR-038, FR-039) — admin-mediated
   suggestion based on F4 paid-invoice volume + F2 declared turnover.
   No automated effect; admin acceptance triggers a member-notification
   email + manual verification task. Lawful basis: legitimate interest.
5. **Escalation task queue** (FR-043, FR-044) — operational task queue
   for admin follow-up on at-risk members. Lawful basis: legitimate
   interest.

### Recipients of personal data

- **Member** of the renewing membership (recipient of reminder email
  via Resend transactional, dispatched from `BROADCASTS_FROM_EMAIL`
  domain).
- **Chamber admin + manager users** (recipients of admin-pipeline view,
  at-risk widget, tier-upgrade suggestions, escalation tasks).
- **No third-party recipients** (no marketing list export, no analytics
  cookie, no advertiser).

### Cross-border data transfers

Same as F7 — Singapore (Vercel + Neon + Upstash) under SCC + UK adequacy
decision + Thailand PDPA §28 cross-border consent (members consent at
membership-onboarding via F1 invitation flow). cron-job.org is EU-based
(no PII flows; Bearer-only).

### Retention periods

| Data | Retention | Source |
|---|---|---|
| `renewal_cycles` rows (status='cancelled') | **5 years** | Constitution v1.4.0 default for non-tax-document audit |
| `renewal_reminder_events` | **5 years** | dispatch-audit baseline |
| `at_risk_outreach` rows | **5 years** | operational record per outreach |
| `tier_upgrade_suggestions` rows | **5 years** | suggestion audit |
| `renewal_escalation_tasks` rows | **5 years** | task audit |
| `audit_log` rows for F8 events (64 event types) | **5 years** | all F8 events default 5y per `src/modules/renewals/application/ports/renewal-audit-emitter.ts` `F8_AUDIT_RETENTION_YEARS` constant |
| `members.risk_score*` columns | **continuously recomputed weekly** — the column reflects current state only; historical scores not retained except via audit-log entries (`at_risk_score_recomputed`, `at_risk_score_threshold_crossed`) |

### Technical + organisational measures (TOMs)

- **Postgres RLS + FORCE on every F8 table** — Constitution Principle I
  clause 3: `tenant_id = current_setting('app.current_tenant')` policy
  enforced; `runInTenant(ctx, fn)` is the ONLY entry point for F8 use
  cases. Cross-tenant integration test at
  `tests/integration/renewals/tenant-isolation.test.ts` (50 probes ×
  9 F8 tables) is a Review-Gate blocker.
- **Application-layer cross-tenant probes** — every mutating F8 use-case
  emits `renewal_cross_tenant_probe` audit on cross-tenant attempt
  (defence-in-depth alongside RLS). Per-member analogue:
  `renewal_cross_member_probe`.
- **F8 RBAC matrix (FR-052a)** — admin-only mutations except
  `manager_exception` for at-risk outreach record. Manager 403 emits
  `f8_role_violation_blocked` audit. Defence-in-depth at route layer +
  pinned by `tests/unit/lib/renewals-route-helpers.test.ts`.
- **Pino redact paths** — `member.email`, `renewal_token`,
  `renewal_link`, `RENEWAL_LINK_TOKEN_SECRET*`, `payment_method`,
  `card.*` per FR-049. Logger-level redaction; PII never reaches
  log aggregator.
- **F3 archival cascade** (Phase 10 follow-up — currently scoped at
  Phase 9 plan) — when F3 archives a member, F8 cancels all in-flight
  renewal cycles, escalation tasks, tier-upgrade suggestions. Audit
  trail retained per retention; live state cleared.
- **READ_ONLY_MODE handling** — every F8 cron coordinator + every state
  changing F8 route returns 503 (proxy layer) or 200+skipped
  (coordinator layer) when `READ_ONLY_MODE=true`. Disaster-recovery
  failsafe per Constitution § Reliability.
- **Cron-secret rotation** — see [`docs/runbooks/secret-rotation.md`](../runbooks/secret-rotation.md) §B for the dual-key rotation procedure on
  `RENEWAL_LINK_TOKEN_SECRET_PRIMARY` + `_FALLBACK`.
- **Kill-switch** — `FEATURE_F8_RENEWALS=false` halts all F8 surfaces in
  ≤30s. Granular `FEATURE_F8_AT_RISK_DISABLED=true` toggles only the
  at-risk surfaces. Both verified in
  `tests/integration/renewals/kill-switch-granular.test.ts`
  (scheduled for Phase 9 follow-up).

### Data subject rights — exercise procedures

| Right | Procedure |
|---|---|
| **Right to access (Art. 15 / §30)** | Member portal `/portal/profile` + audit-log query covers all F8-derived data including `risk_score*`, renewal-cycle history, reminder dispatch log |
| **Right to rectification (Art. 16 / §32)** | F3 admin edit covers member + contact fields; F8-derived `risk_score*` recomputes weekly (no manual edit required) |
| **Right to erasure (Art. 17 / §33)** | F3 archive triggers F8 cascade (Phase 10) — cycles cancelled, tasks closed, suggestions dismissed, outreach records retained per audit retention with PII redacted on member-erase request |
| **Right to restrict processing (Art. 18 / §33)** | Member can opt out of renewal reminders via `/portal/preferences/renewals` (FR-016) — sets `members.renewal_reminders_opted_out=true`, dispatcher skips |
| **Right to data portability (Art. 20)** | F1+F2+F3 portable export covers member + plan + contact data; F8 cycle + reminder history accessible via member portal |
| **Right to object (Art. 21)** | Same as restrict — opt-out toggle terminates reminder processing |
| **Right not to be subject to automated decision-making (Art. 22)** | F8 at-risk score is **not** an automated decision affecting the member — score is admin-facing only; admin manual outreach is the only effect; member can opt out of reminders to remove the input data; the formula is rule-based and explicable. DPIA documents the Art. 22 analysis. |

### DPO contact

Same as F7.

### Update history

| Date | Change | Author |
|---|---|---|
| 2026-05-09 | Initial F8 entry created (Phase 9 / T257) | F8 Phase 9 implementation pass |

---

## F6 — EventCreate Integration

**Status**: Phase 3 IMPLEMENTED — ingest path live behind
`FEATURE_F6_EVENTCREATE` kill-switch. Branch `012-eventcreate-integration`.
This entry codifies the processing record (Issue H-PDPA-3 from
full-scope review 2026-05-12) — introduces **Zapier (US)** as a NEW
cross-border processor not present in F1–F8.

### Controller

The **chamber** (SweCham for the first tenant) is the controller of
attendee personal data. The chamber:

- Owns the EventCreate account where attendees register
- Configures the Zapier Zap that POSTs to F6's webhook
- Surfaces the privacy notice to attendees at the EventCreate
  registration form (chamber responsibility per PDPA §23 + GDPR Art. 13;
  Chamber-OS is not the collector)
- Holds the lawful basis for ingestion (legitimate interest, PDPA §24(5)
  + GDPR Art. 6(1)(f) — chamber's record of who attended its events)

### Processor

**Chamber-OS** (platform) is the processor of attendee data on behalf
of the chamber. Sub-processor chain:

| Sub-processor | Role | Region | DPA / SCC Status |
|---|---|---|---|
| **Vercel Inc.** | Hosting + Fluid Compute + Vercel Observability (OTel ingestion for F6 spans + metrics) | Singapore (`sin1`) | Existing DPA covers F1–F8 hosting + observability; F6 ingest path same scope |
| **Neon, Inc.** | Postgres database | Singapore (`ap-southeast-1`) | Existing DPA covers F1–F8 PII columns; F6 `event_registrations` is the new column set |
| **Upstash, Inc.** | Redis rate-limiter | Singapore | Existing DPA — F6 only stores `f6-webhook:<tenant_slug>` rate-limit counters (no PII) |
| **Zapier, Inc.** ⚠ NEW | Middleware between EventCreate + Chamber-OS webhook | United States | **PENDING DPA — chamber action required pre-flag-flip** |

> **Note on error-tracking processors**: Chamber-OS does NOT currently integrate Sentry or any third-party APM. F6 error events (`f6_audit_emit_db_error`, `f6_audit_fallback_double_failure`) flow through pino structured logs ingested by Vercel Observability only. If Sentry (or equivalent) is added in a later phase, this table MUST be updated and the chamber DPA reviewed before flag-flip.

**Zapier DPA status — open action**:
- Zapier offers a standard DPA template at zapier.com/help/account/data-management/zapier-eu-gdpr-data-processing-agreement
- Chamber legal counsel MUST execute this DPA before flipping
  `FEATURE_F6_EVENTCREATE=true` in production
- Zapier's DPA includes SCCs (Standard Contractual Clauses) for
  EU→US transfer (Module 3: processor to sub-processor)
- For PDPA §28 (Thailand→US transfer), Zapier's DPA covers the
  "appropriate safeguards" requirement

### Categories of data subjects

| Subject | Examples |
|---|---|
| **Members' employees** | Diamond Partnership member's CEO attending a SweCham networking event |
| **Members' representatives** | Gold Partnership member's marketing manager |
| **Non-member attendees** | Walk-up attendees who registered without prior chamber relationship |

### Categories of personal data

| Field | Type | Source | Retention |
|---|---|---|---|
| `attendee_email` | Email address | EventCreate registration | Member-linked: 5y; Non-member: 2y → pseudonymise |
| `attendee_email_lower` | STORED generated column (lower-case email) | Derived from `attendee_email` | Same as parent column |
| `attendee_name` | Full name string | EventCreate registration | Same as `attendee_email` |
| `attendee_company` | Company name string (nullable) | EventCreate registration | Same as `attendee_email` |
| `matched_member_id` | FK to F3 `members` (UUID) | F6 4-rule match cascade | Link cleared on F3 member-erase; row otherwise retained per FR-032 |
| `matched_contact_id` | FK to F3 `contacts` (UUID) | F6 4-rule match cascade | Same as `matched_member_id` |

### Processing purpose

- **Membership benefit accounting** (FR-015 to FR-018): partnership-per-event
  + cultural-annual quota decrement on attendance
- **Member directory accuracy** (FR-014): admin relink unmatched attendees
  to existing members to maintain accurate member-engagement records
- **Audit trail of who attended** (FR-009): forensic record for chamber
  governance + dispute resolution

### Lawful basis

| Subject | Basis | Notes |
|---|---|---|
| Member-linked attendee (Thai resident) | PDPA §24(5) legitimate interest of chamber | Strong — attendee is a chamber stakeholder |
| Member-linked attendee (EU resident) | GDPR Art. 6(1)(f) legitimate interest of chamber | Same — passes balancing test |
| Non-member attendee (Thai resident) | PDPA §24(5) — narrower; chamber's interest is record-keeping for events | Acceptable but retention reduced to 2y vs 5y for members |
| Non-member attendee (EU resident) | GDPR Art. 6(1)(f) — narrower interest | Acceptable for record-keeping; pseudonymisation at 2y reduces retention impact |

### Cross-border transfers

| Path | Mechanism |
|---|---|
| Attendee → EventCreate (US) | Pre-existing — chamber's EventCreate use-case predates F6 |
| EventCreate (US) → Zapier (US) | Pre-existing — US↔US transfer |
| Zapier (US) → Vercel (SG) → Neon (SG) | **PDPA §28** "appropriate safeguards" — Zapier DPA + Vercel + Neon existing DPAs |
| Vercel (SG) ↔ Neon (SG) ↔ Upstash (SG) | Intra-region (Singapore) — no cross-border |

### Technical + organisational measures (TOMs)

| Measure | Implementation |
|---|---|
| **HMAC-SHA256 webhook auth** | Per-tenant secret, 5-min skew, 24h grace (FR-002 + FR-008) |
| **Body-size DoS guard** | 64 KiB pre-check + post-read cap (Issue C-FULL-1) |
| **Rate-limit per tenant** | 60 req/min via Upstash sliding window (FR-005); fail-open documented |
| **Idempotency 2 layers** | X-Request-ID receipt + composite unique index (FR-004 + FR-011) |
| **Strict-tx ACID** | FR-037 ingest atomicity + audit dual-write fallback |
| **Pino redact list** | `attendee_email`, `webhook_secret_active`, X-Chamber-Signature variants |
| **At-rest encryption** | Neon AES-256-GCM (existing TOM) |
| **RLS+FORCE on all 4 F6 tables** | Constitution Principle I clause 2 |
| **Audit log 5y retention** | PDPA §39 + GDPR Art. 30 |
| **Deterministic pseudonymisation** | SHA-256(salt || tenant_id || external_id) at 2y for non-member rows (FR-032; Phase 10 T113) |

### Data subject rights — F6 procedures

| Right | Procedure |
|---|---|
| **Right to access (Art. 15 / §30)** | Email DSR to DPO; SQL query in `docs/runbooks/f6-manual-erasure.md` § 2 returns all attendee rows for a given email |
| **Right to rectification (Art. 16 / §32)** | Admin relink (FR-014, Phase 9 T104) corrects mis-matched member |
| **Right to erasure (Art. 17 / §33)** | **Interim manual procedure**: `docs/runbooks/f6-manual-erasure.md` (Issue H-PDPA-2). **Future automated tool**: Phase 10 T110 admin UI |
| **Right to restrict processing (Art. 18 / §33)** | Chamber can disable tenant-wide ingest via admin wizard (`tenant_webhook_configs.enabled=false`, FR-033) |
| **Right to data portability (Art. 20)** | DSR export via DPO-driven manual SQL query; automation TBD |
| **Right to object (Art. 21)** | Attendee may request opt-out via DPO email; chamber disables the Zap for that attendee at EventCreate side |
| **Right not to be subject to automated decision-making (Art. 22)** | F6 match cascade is NOT an automated decision affecting the subject — admin relink is always possible; quota decrement is internal accounting, not a decision about the attendee |

### DPO contact

Same as F7.

### DPIA (Data Protection Impact Assessment)

- **Required**: GDPR Art. 35 — F6 processes non-member PII under
  legitimate interest with a NEW cross-border processor (Zapier) +
  automated matching (4-rule cascade)
- **Status**: PENDING — chamber DPO action required before flag-flip
- **Template**: `docs/compliance/dpia-template.md`

### Update history

| Date | Change | Author |
|---|---|---|
| 2026-05-12 | Initial F6 entry created (Issue H-PDPA-3 from full-scope review) | F6 fixit pass |

