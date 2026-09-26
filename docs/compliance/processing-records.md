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

**Last reviewed**: 2026-09-24 (F119 PR-2 — the E-Blast member-approval round: versions, decisions, notes and reasons, the hand-off emails and their staff recipients, `broadcast-versions.json`, the widened erasure reach; T162, the precondition of `FEATURE_EBLAST_MEMBER_APPROVAL`. Previous review 2026-09-22 — F119 PR-1 — E-Blast inline images, the Vercel Blob image tier, the test copy and the chamber postal address; authored before PR-1 merges because PR-1 carries no feature flag. Before that 2026-09-16 — F114 member change requests / approval workflow, per FR-040)

> **AUTHORED 2026-06-21 (COMP-1 US3-E)**: the **F3 — Members & Contacts** core
> RoPA and the **COMP-1 — Member Erasure (Art. 17 / §33)** processing-activity
> record are now authored below (closing the design § US3-E exit dependency,
> incl. the H-2 Resend sub-processor erasure-limitation language).
>
> **TODO**: F1 (Auth & RBAC) and F5 (Online Payment) sections are part of
> the Constitution-mandated compliance backlog and NOT yet authored. The
> **F4 (Invoices & Receipts)** RoPA is partially authored: the
> **event-fee non-member-buyer sub-scope** (issuing §86/4 / §105 documents
> to non-member event buyers + the 10-year PII-redaction cron) IS
> documented below (added 2026-06-04 for branch `054-event-fee-invoices`),
> but the **membership-invoicing F4 RoPA** (member buyers, credit notes,
> tenant invoice settings, sequential numbering) remains backlog. All
> outstanding sections MUST be authored before the next
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
F1 deployment = Thai-Swedish Chamber of Commerce / SweCham). Each
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
  event_attendees.email — served by the F6 `event_attendees_last_90d`
  bridge since F6 shipped).
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
| **Sender terms acknowledgement** | `members.broadcasts_acknowledged_at` (Q15 banner: the SENDING member acknowledges the E-Blast rules — not recipient consent) | Indefinite retention while member row exists |
| **Suppression / objection** | `marketing_unsubscribes.email_lower` + reason (recipient_initiated\|hard_bounce\|complaint\|admin_added) | **Indefinite retention** per GDPR Art. 21 + PDPA §32 |
| **Operational** | `broadcasts.subject`, `broadcasts.body_html` (sanitised), `broadcasts.body_source` (Tiptap raw), `broadcasts.from_name`, `broadcasts.reply_to_email` | Member-authored content; sanitised at Application boundary (FR-002a strict-allowlist DOMPurify) |

**No special categories (Art. 9 / PDPA §26)** are processed by F7 —
no health, religion, political opinion, racial origin, sexual
orientation, biometric, or genetic data. Member tier codes are
business categorisation, not special-category PII.

### Purpose of processing

- **Marketing communications — SENDER side** under contract performance
  per **PDPA §24** + **GDPR Art. 6(1)(b)** — chamber membership tiers
  contractually include an annual quota of E-Blasts (1–15 per year
  across paying tiers). The processing of the SENDING member's data
  (quota, approval, delivery results) is necessary to deliver the
  contractually promised benefit.
- **Marketing communications — RECIPIENT side** under legitimate
  interest per **GDPR Art. 6(1)(f)** + Recital 47 and **PDPA §24(5)**
  (108 PR-D, 2026-09-06; supersedes the single contract-basis line above
  for recipients — the contract binds the member COMPANY, not the person
  who receives the email). Legitimate-interest assessment (spec 108 D3):
  recipients are the member company's primary and secondary contacts
  acting in a B2B professional capacity, in an existing relationship
  with the chamber; every contact was added by the member's own primary
  contact or by staff under an Art. 14 attestation; every broadcast
  carries one-click unsubscribe — the universal channel; a contact who has a
  portal login can additionally object there (self opt-out), and ANY contact
  can ask staff to switch it off (staff opt-out). A secondary contact never
  invited to the portal has the unsubscribe link and the staff channel, not
  the portal one. Every objection is honoured at dispatch across every
  audience kind, and a contact's OWN objection follows the ADDRESS if the
  contact row is deleted and re-created. **Residual (108
  privacy review M-1)**: the Art. 14 / PDPA §23 notice to a secondary
  contact is ATTESTED by staff at add time (`art14_attested`) and is not
  yet delivered by the system; the portal invite-colleague path records
  no attestation. PR-C's flag flip (1:N audience) MUST NOT happen until
  either the system sends a notice to a new secondary on first marketing
  contact, or the FR-027a pre-flight step verifies the attestation per
  contact.

  **Gate EVALUATED 2026-09-08 10:45 (Asia/Bangkok) — satisfied VACUOUSLY.**
  A read-only inventory of production
  (`scripts/inventory-primary-contact-invariant.ts`, counts only, no PII)
  returned **150 members / 150 primary contacts / 0 secondary contacts / 0
  `marketing_unsubscribes` / 0 invariant violations**. With no secondary
  contact in existence there is no data subject the chamber has not
  informed, and the FR-027a pre-flight page renders an empty list. The gate
  is therefore met — by the absence of the population it protects, not by a
  notice being sent. Recorded with the count rather than as "n/a" because
  the finding is a measurement and measurements expire.

  **This evaluation LAPSES the moment SweCham's secondary-contact import
  lands** — an imported marketing list is by definition a population that
  gave its addresses to someone other than the chamber, which is exactly
  what Art. 14 governs. Before the first marketing send after that import,
  re-run the inventory and satisfy this gate the real way: either ship the
  first-contact notice, or attest per contact through the FR-027a pre-flight.
  Sign-off surface: `docs/go-live-readiness.md` § 6.9; full record:
  `specs/108-contact-recipient-rules/reviews/cutover.md` § 2–3.
- **OPEN (2026-09-26, PDPA/GDPR review):** the `event_attendees_last_90d`
  segment also reaches recent event attendees who are NOT member-company
  contacts (`event_registrations.matched_member_id` NULL). The LIA above
  covers member-company contacts only. Decision pending: restrict the
  segment to matched members, or extend the LIA (PDPA §24(5); for natural
  persons in Sweden also ePrivacy / Marknadsföringslagen §19). The member
  banner now states that attendees receive E-Blasts.
- **Per-contact marketing preference** (108 PR-D, 2026-09-06) — a NEW
  processing activity: `contacts.marketing_opt_out_at` /
  `marketing_opt_out_source` (`staff` | `self`) /
  `marketing_opt_out_by_user_id`, plus the audit events
  `contact_marketing_opted_out` / `contact_marketing_opted_in` (ids +
  source + actor role only, never an address). Purpose: audience
  management and honouring an objection (GDPR Art. 21 / PDPA §32). Basis:
  legal obligation to honour the objection (Art. 6(1)(c)) + the
  legitimate interest above (Art. 6(1)(f)). Recipients of this datum:
  none outside the controller. Access: `contacts.read` holders view the
  state (admin, super_admin, marketing, manager read-only);
  `contacts.marketing` holders change it (admin, super_admin, marketing —
  never manager). Precedence: the person's own unsubscribe > their own
  opt-out > a staff opt-out > receiving; staff cannot lift the person's
  own objection (FR-025 AMENDMENT).
- **Sender terms acknowledgement** (amended 2026-09-26, PDPA/GDPR review
  conditions) — the Q15 banner CTA records `broadcasts_acknowledged_at`:
  the SENDING member acknowledges who receives E-Blasts, that every
  E-Blast carries an unsubscribe link and that opt-outs apply
  automatically. It is accountability evidence (GDPR Art. 5(2)) for the
  sender side, NOT recipient consent: recipients are processed on
  legitimate interest (above) and no consent basis is claimed. The banner
  previously told members that recipients "have agreed"; that copy was
  withdrawn.
- **Statutory compliance** — `broadcast_deliveries` retention serves
  PDPA §39 / GDPR Art. 30 record-of-processing obligation. Audit-log
  retention serves Constitution Principle VIII reliability + financial-
  records-related events.

### Recipients of personal data

- **Chamber members + their primary contacts** — recipients of the
  broadcast emails dispatched by F7.
- **Resend Inc. (processor)** — receives the broadcast HTML body +
  recipient list at dispatch time; transmits the email; reports
  delivery events back via webhook. It also **retains each recipient
  address as a team-level contact record** that outlives both the
  ephemeral audience and the member's erasure — see the retention table
  and residual 8a. Measured 2026-09-09, not assumed.
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
| `broadcasts` rows + `broadcast_deliveries` rows | **5 years** (Constitution v1.4.0 default for non-tax-document audit; a row's own `retention_years` may say 10) — **enforced by the retention-sweep cron (0310)**: `/api/cron/broadcasts/retention-sweep`, daily 20:50 UTC, deletes a CLOSED E-Blast once its anchor + `retention_years` has passed. The anchor is the moment it closed — `sent_at`, `partial_delivery_accepted_at`, `failed_to_dispatch_at`, `rejected_at` or `cancelled_at` by status, falling back to `stage_entered_at`; `stage_entered_at` for `expired_no_member_response`; **never `updated_at` directly**. One inherited exception: migration 0308 backfilled `stage_entered_at = COALESCE(submitted_at, updated_at)`, so a terminal row from before 0308 whose own anchor column is NULL **and** whose `submitted_at` is NULL anchors on the `updated_at` it carried at 0308 (check query in `docs/runbooks/cron-jobs.md` § F7 retention-sweep; expected 0 on the `updated_at` path; to be measured on prod before the first expiry). A row whose Resend audience is still live is held until `cleanup-audiences` reaps it. **Before a row is deleted, its Resend copy is deleted** (the Resend broadcast object holds the HTML body and a name that identifies the member and the tenant): the row's own `resend_broadcast_id` and any per-batch `broadcast_batch_manifests.provider_broadcast_id`, outside any transaction; a copy confirmed gone (or already 404 / 410) lets the row go, and a transient failure (5xx / 429 / network) keeps the row — and the key — for the next run. **Residual — Resend's copy of a SENT E-Blast outlives our row.** Resend documents that a queued or sent broadcast cannot be deleted; on that refusal our row is **deleted anyway** (maintainer decision, 2026-09-25) and counted `provider_copy_retained_at_processor` (no ids). For a sent E-Blast, therefore, the Resend broadcast object — its HTML body and its name, which identifies the member and the tenant — persists under **Resend's own retention** after our row is gone: unreachable from our side (the only key is deleted with the row), and covered by the Resend DPA + SCCs (§ Cross-border data transfers above). **Not measured:** `DELETE /broadcasts/{id}` has been exercised on a draft only; the runbook item (`docs/runbooks/cron-jobs.md` § F7 retention-sweep, "Resend copies") is to measure the answer for a sent broadcast and to confirm Resend's retention for broadcast objects before the first E-Blast expires (~2031). The deliveries, versions, decisions and batch manifests go with the parent by ON DELETE CASCADE; its images are stamped for the daily image sweep in the same transaction. Evidence: one counts-only `broadcast_retention_swept` audit row per tenant per run (no ids, no content — counts, the kept-copy counts and the oldest / newest anchor of the rows deleted, so an auditor can check nothing younger than the period was removed) and `broadcast_image_removed { reason: 'retention_expired' }` per image. **The E-Blast's audit rows outlive it:** no job deletes `audit_log` rows, so the rows that name a swept E-Blast's `broadcast_id` / `related_member_id` (its submission, decisions, image rows, the `retention_expired` rows themselves) stay for their own retention (next rows) — ids and metadata, not the content. **Two readers silently lose a swept send:** the member timeline's broadcast arm (the 0196 view reads `broadcasts`) and the GDPR export's `listMemberBroadcasts` (`gdpr-archive-source-adapter.ts`) — after the sweep an Art. 15 / 20 export no longer lists an E-Blast older than its retention, which is the intended effect of the deletion. **`partially_sent` never ages out:** it is not terminal, and nothing has produced it — or closed it — since 108 Phase 9 deleted the batch path (`ca51f59a1`); the population is frozen at what existed then, and only an operator's status move bounds it (runbook count, to be measured on prod). `marketing_unsubscribes.source_broadcast_id` is left pointing at a deleted E-Blast by design — the suppression row is indefinite (next row) | F7 has no §87/3 / §86/10 obligation; standard 5y matches operational + record-of-processing baseline |
| `marketing_unsubscribes` rows | **Indefinite** | GDPR Art. 21 right to object — once a recipient unsubscribes, the suppression record MUST persist forever to honour future processing avoidance |
| `members.broadcasts_acknowledged_at` | **Indefinite** while member row exists | Sender terms acknowledgement (accountability, Art. 5(2)) — not consent — deleted alongside member on Art. 17 erasure; admin SHOULD reset to NULL on F12 white-label terms change to force re-acknowledgement |
| `members.broadcasts_halted_until_admin_review` | **Indefinite** while member row exists | Q14 SC-005 (b) auto-halt operational state |
| `contacts.marketing_opt_out_{at,source,by_user_id}` (108 PR-D) | **Life of the contact row**, KEPT through the Art. 17 scrub (no PII: a timestamp, an enum and a user id) | Kept because it carries no PII and the audit trail (`contact_marketing_opted_out` / `_in`) is the authoritative record of the objection. It does NOT survive as a suppression: the scrub stamps `removed_at`, the dispatch filter reads live rows only, and the preference is bound to the contact ROW, not the address — a re-added address is re-marketed unless it is on `marketing_unsubscribes`, which is the only address-keyed, indefinite suppression (see its row above). The `self` case's `by_user_id` is the data subject's own user id and is swept together with `linked_user_id` when F1 user erasure lands (108 privacy review L-3) |
| `audit_log` rows `contact_marketing_opted_out` / `contact_marketing_opted_in` (108 PR-D) | **5 years** | Constitution default; payload carries `member_id` / `related_member_id`, `contact_id`, `source`, `actor_role` — no address (FR-053a) |
| `audit_log` rows for F7 events (70 live event types) | **5 years**, except **`member_acknowledged_broadcasts_terms` — 10 years** | F7 events default to 5y (`f7RetentionFor` in `src/modules/broadcasts/application/ports/audit-port.ts`; the column default). The one exception is the E-Blast terms acknowledgement: the `audit_log_default_retention_for_f4_tax_docs` trigger promotes it to 10y (originally justified as GDPR Art. 7 demonstrable consent, which no longer applies — the event records a sender terms acknowledgement, not consent; **OPEN 2026-09-26**: re-justify or return it to the 5y F7 default in a new migration; migration 0084, current body `0257_payment_on_terminated_member_audit.sql` line 60). No job deletes `audit_log` rows on either period today — the period is the declared retention, and these rows outlive a swept E-Blast (row above) |
| Resend Broadcasts API send logs | Resend default (90 days) | Provider retention; not under chamber control |
| **Resend contact records ("Global Contacts")** | **Indefinite — survives both audience deletion and member erasure** | One record per team, not per audience (research § R16). The erasure cascade detaches the contact from the audience; measured 2026-09-09 (U1), that leaves the contact readable at `GET /contacts/{email}`. Not under chamber control and **not currently erased** — see residual 8a for why the audience-less delete is not called and what closing it needs. |

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
| **Right to object (Art. 21 / PDPA §32)** | Every E-Blast carries Resend's hosted unsubscribe link (footer merge tag) and Resend's `List-Unsubscribe` / `List-Unsubscribe-Post` headers; both are mirrored from Resend `contact.updated` into `marketing_unsubscribes` (channel `resend_hosted`). Our signed `/unsubscribe/[token]` (GET page + RFC 8058 POST) records the same row (`page_get` / `one_click_post`), and anyone can email the monitored privacy inbox (`TENANT_PRIVACY_CONTACT_EMAIL`) for free manual removal within 2 business days (`manual`, runbook `broadcast-manual-unsubscribe.md`). Scope is tenant + email, retained indefinitely as the objection record |
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
| 2026-09-06 | 108 PR-D: recipient-side basis split out as legitimate interest (LIA from spec 108 D3); new activity "per-contact marketing preference" + its two audit events; Art. 14 attestation residual recorded as a PR-C gate condition (privacy review H-1 / M-1) | 108 PR-D review cycle 12 |

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
| 2026-05-16 | F6.1 amendment: add CSV import primary path + Vercel Blob error-CSV tier (staff-review B-5/H-7) | staff-review pass |

---

## F6.1 — CSV Import Primary Path + EventCreate Format Adapter (amendment to F6)

**Status**: Staff-review T061 staged 2026-05-16. Engineering complete; awaiting DPO sign-off + flag-flip.
**Scope**: Amends the F6 record above with the 4 new data items + 1 new processor activity introduced by `013-csv-import-eventcreate-format`.

### New processing activities

| Activity | Lawful basis | Retention | Recipients | TOMs |
|---|---|---|---|---|
| CSV upload + parse + per-row insert into `event_registrations` | PDPA §24 legitimate interest / GDPR Art. 6(1)(b) for paid attendees / Art. 6(1)(f) for free attendees | 2y (non-member rows) / indefinite (member roster); audit 5y | Vercel (hosting), Neon (DB) | Admin-only RBAC, RLS+FORCE on csv_import_records, per-(tenant,event) advisory lock, 5/hr rate-limit |
| Attendee-fingerprint storage (FR-019a) | PDPA §24 legitimate interest / GDPR Art. 6(1)(f) | 30 days (sweep window) | Vercel, Neon | SHA-256 first-16-hex truncation — not reversible to plaintext email |
| PDPA consent classification (FR-009) | PDPA §24 legitimate interest / GDPR Art. 6(1)(f) | Indefinite (boolean only, no raw text per Art. 5(1)(c) minimisation) | Vercel, Neon | Classification at import time; raw text NEVER persisted |
| Error-CSV blob storage | PDPA §24 legitimate interest / GDPR Art. 6(1)(f) | 30 days hard TTL via daily sweep cron | Vercel Blob (sin1) | `addRandomSuffix:true` capability-token URL; access audit on every download via `csv_import_error_csv_downloaded` event |

### New data items stored

| Storage | Data category | Subject category | New as of F6.1? |
|---|---|---|---|
| `csv_import_records` (NEW table, migration 0139) | Operational metadata + counts + outcome + blob URL + fingerprint | Admin (actor only) — no attendee PII; PII lives in linked event_registrations | YES |
| `event_registrations.attendee_pdpa_consent_acknowledged BOOLEAN NULL` (migration 0140) | Classification | Attendee | YES (column) |
| `csv_import_records.attendee_fingerprint TEXT` (16-hex) | Pseudonymised identifier | Attendee (aggregate) | YES |
| Vercel Blob `tenants/{slug}/csv-import-errors/{recordId}.csv-{randomSuffix}` | Failed CSV rows VERBATIM | Attendee | YES (storage tier) |

### Vercel Blob processor amendment

Existing F6 record already lists Vercel as hosting + OTel processor. F6.1 expands the **Vercel Inc. processor** scope to include Vercel Blob storage of error-CSV bytes (30-day TTL). No new DPA required — covered under the existing F1–F8 Vercel DPA (F4 invoice PDF already uses Vercel Blob).

**Public-blob design caveat**: Vercel Blob non-Enterprise tier uses `access:'public'` (no true private bucket). The error CSV URL acts as a capability token (random suffix) and is enforced server-side at the route handler. See `docs/runbooks/eventcreate-csv-import.md § 3.0` + DPIA F6.1 risk row 1. DPO sign-off documents this accepted residual risk.

### New audit event types

| Event type | Severity | Purpose | Retention |
|---|---|---|---|
| `csv_import_error_csv_downloaded` | info | PII access record — every signed-URL access by admin (Art. 30 GDPR) | 5y |
| `csv_import_cross_tenant_probe` | critical | Tenant-isolation breach attempt (Constitution Principle I clause 4) | 5y |
| `csv_import_event_mismatch_overridden` | warn | Forensic record when admin overrides FR-019b safety-net warning | 5y |

### Data subject rights amendments

| Right | F6.1 procedure |
|---|---|
| Erasure (Art. 17 / §33) | Cascades to error-CSV Blobs per `docs/runbooks/f6-manual-erasure.md § F6.1` (staff-review H-5). Operator queries `csv_import_records WHERE error_csv_expires_at > NOW()` for the affected event + run-time-range, `del()` the matching Blob URLs, emits `csv_import_error_csv_manually_erased` audit. Also clears DB columns. |
| Access (Art. 15 / §30) | Existing F6 procedure covers attendee row export. F6.1 csv_import_records contains only operational metadata + counts (no attendee PII outside the linked event_registrations); not exported separately. |

---

## F4 — Event-Fee Invoices (non-member buyer)

**Status**: IMPLEMENTED — branch `054-event-fee-invoices`. Event-fee
invoice issuance + the 10-year PII-redaction cron are live behind the
existing `FEATURE_F4_INVOICING` kill-switch.
**Scope**: This entry documents ONLY the **event-fee** sub-scope of F4 —
issuing a Thai-tax document to a **non-member event buyer** (a natural
person / company representative who is NOT an F3 member) and the
scheduled 10-year erasure of that buyer's PII. The **membership-invoicing
F4 RoPA** (member buyers, credit notes, sequential numbering, tenant
invoice settings) is a separate, still-backlog section (see top-of-file
TODO). This entry codifies the record so the `/speckit.review` privacy
gate can verify the implementation matches the documented processing.

This section documents **two distinct processing activities**:

1. **Issuance** — capturing non-member buyer PII to issue a §86/4 tax
   invoice / §105 receipt for an event-ticket fee.
2. **Retention-managed erasure** — the daily redaction cron that
   tombstones the buyer PII + purges the PDF blob after the 10-year
   statutory window. PDPA §39 / GDPR Art. 30 expect the
   retention-management mechanism itself to be recorded.

### Controller

Same as F7 — the chamber tenant operating the Chamber-OS deployment
(single-tenant F1 deployment = Thai-Swedish Chamber of Commerce /
SweCham / TSCC). For an event-fee invoice the chamber is the controller
of the buyer's identity data: it decides to issue the tax document and
holds the statutory obligation to retain it.

### Processors

- **Vercel Inc.** (US-incorporated; deployment region `sin1` Singapore)
  — application hosting + function execution + **Vercel Blob storage of
  the issued tax-document PDF(s)** (invoice + receipt). Covered by the
  existing F1–F8 Vercel DPA + SCCs (F4 invoice PDF already uses Vercel
  Blob — no new DPA required).
- **Neon, Inc.** (US-incorporated; deployment region `ap-southeast-1`
  Singapore) — Postgres database holding the `invoices` row +
  `member_identity_snapshot` buyer PII. Existing DPA + SCCs.
- **Resend Inc.** (US-incorporated) — **transactional** invoice/receipt
  auto-email (the optional buyer copy). F4 reuses the F1+F4
  transactional Resend surface (operational notification, NOT the F7
  Broadcasts marketing surface). Existing DPA + SCCs.
- **Upstash, Inc.** (Singapore) — Redis rate-limit cache. Existing DPA;
  no buyer PII (only rate-limit counters).
- **cron-job.org** — external HTTP scheduler triggering the daily
  `POST /api/cron/invoicing/redact-expired-event-buyers` redaction
  sweep. Bearer `CRON_SECRET` only; **no PII flows through cron-job.org**
  (only the Bearer header + URL path). Not a processor under GDPR
  Art. 28.

No new processor is introduced by the event-fee sub-scope — all four
data processors are already covered by existing F1–F8 DPAs.

### Categories of data subjects

- **Non-member event attendees / event-fee invoice buyers** — natural
  persons who purchased an event ticket and require a tax document but
  are NOT chamber members (`invoices.member_id IS NULL`,
  `invoice_subject = 'event'`).
- **Company representatives of a buyer organisation** — the named
  primary contact of a company buyer (a natural person).

### Categories of personal data

All buyer PII is captured into the invoice `member_identity_snapshot`
JSONB column at issue time (an immutable point-in-time snapshot) and the
same PII is **printed on the issued PDF**:

| Category | Field (in `member_identity_snapshot`) | Notes |
|---|---|---|
| **Identity** | `legal_name` | Buyer's legal name (natural person or company) — printed on the document |
| **Tax identity** | `tax_id` | 13-digit Thai TIN (nullable — present → §86/4 tax invoice; absent → §105 receipt) |
| **Contact** | `primary_contact_name` | Named representative (natural person) |
| **Contact** | `primary_contact_email` | Buyer email — destination of the optional auto-email; printed/used for delivery only |
| **Address** | `address` | Buyer billing address — printed on the document |

**No special categories (Art. 9 / PDPA §26)** are processed — no health,
religion, political opinion, racial origin, biometric, or genetic data.
A buyer TIN is a tax-administration identifier, not a special category.

### Purpose of processing

Issue a **Thai-tax-compliant event-fee document** for the buyer's
event-ticket fee:

- **§86/4 tax invoice** (ใบกำกับภาษี) when the buyer supplies a TIN — the
  Revenue Code requires a tax invoice carrying both parties' tax IDs.
- **§105 receipt** (ใบเสร็จรับเงิน) when the buyer has no TIN — a plain
  official receipt with no buyer TIN field.

The doc-type gate is in the issuance use-case (membership invoices
require a buyer TIN; event invoices downgrade to a receipt when the
buyer has none). The buyer-identity capture is **necessary to satisfy
the statutory tax-document content requirement** — it is not optional
enrichment.

### Lawful basis

**Legal obligation** — **Thai Revenue Code §86/4** (tax-invoice content)
+ **§87/3** (10-year retention of tax documents); **GDPR Art. 6(1)(c)**
(processing necessary for compliance with a legal obligation to which
the controller is subject). The retention itself rests additionally on
**GDPR Art. 5(1)(e)** (storage limitation) + **PDPA §28** — the data is
kept no longer than the statutory window, then erased by the cron below.

### Recipients of personal data

- **The buyer** (the data subject) — receives the issued tax document,
  and, if the chamber enables the auto-email, a copy via Resend
  transactional email to `primary_contact_email`.
- **Vercel Blob (processor)** — stores the issued PDF(s) at rest
  (Singapore region). The PDF carries the same printed buyer PII.
- **Chamber admins** (controller-role staff) — issue + view the document
  in the admin portal.
- **Thai Revenue Department** — the statutory recipient of the retained
  tax document on audit (the reason for the 10-year retention).
- **Chamber DPO + legal counsel** — may access any processing record
  for compliance review.

### Cross-border data transfers

Same as F7 — **Singapore** (Vercel `sin1` / Neon `ap-southeast-1` /
Upstash). Thailand → Singapore is covered by **Thailand PDPA §28**
cross-border provisions; Swedish/EU buyer data subjects are covered by
**GDPR Standard Contractual Clauses (SCCs)** with Vercel + Neon +
Upstash. The optional Resend transactional auto-email transits Resend's
regional infrastructure under its existing DPA + SCCs. No new
cross-border path is introduced by the event-fee sub-scope.

### Retention periods

| Resource | Retention | Authority |
|---|---|---|
| `invoices` row + `member_identity_snapshot` buyer PII (event-subject, non-member) | **10 years from issue date** | Thai RD §87/3 (tax-document retention) — buyer PII tombstoned at the 10-year boundary by the cron below; the financial record (numbering, amounts) is preserved permanently as the §87/3 statutory document |
| Issued tax-document PDF blob(s) (invoice + receipt) | **10 years from issue date** | Same §87/3 — PDF **bytes** purged at the boundary; the `pdf_blob_key` / `receipt_pdf_blob_key` reference columns are retained as the document identifier |
| `audit_log` row `event_buyer_pii_redacted` | **10 years** | `F4_AUDIT_RETENTION_YEARS['event_buyer_pii_redacted'] = 10` — the erasure event keeps the §87/3 forensic window (the RD must see WHICH fields were minimised WHEN); **payload carries field NAMES only, never the erased PII values** |

### Erasure mechanism (retention-managed erasure — distinct processing activity)

After the 10-year statutory window elapses, the daily cron
`POST /api/cron/invoicing/redact-expired-event-buyers` performs the
storage-limitation erasure (GDPR Art. 5(1)(e) + Art. 17; PDPA §28). For
every eligible row (`invoice_subject = 'event'` AND `member_id IS NULL`
AND `status <> 'draft'` AND `issue_date < now() - 10 years` AND the
snapshot is not already tombstoned) it:

1. **Tombstones the 5 buyer-PII fields** in `member_identity_snapshot`
   (`legal_name`, `address`, `primary_contact_name` → `'[REDACTED]'`;
   `primary_contact_email` → `''`; `tax_id` → `NULL`), preserving the
   JSONB structure so the non-draft `member_identity_snapshot IS NOT
   NULL` CHECK still holds and **every financial / numbering column is
   left untouched** (the §87/3 record is preserved).
2. **Purges the PDF blob(s)** — deletes the invoice + receipt PDF
   **bytes** from Vercel Blob (the same buyer PII is printed on them, so
   DB-only tombstoning would be incomplete erasure). Reference columns
   are kept as the document identifier. Blob delete is **best-effort +
   non-fatal**: a failure logs `errKind` only (no PII) + bumps the
   `invoicing_event_buyer_pii_redacted_total{outcome=error}` metric for
   manual cleanup; it never rolls back the authoritative DB tombstone.
3. **Emits `event_buyer_pii_redacted`** audit (10-year retention; payload
   carries field NAMES + invoice_id + purged blob KEYS, **never the
   erased PII values**) in the SAME transaction as the tombstone —
   atomic.

**Idempotent**: the eligibility predicate excludes already-tombstoned
rows (`legal_name <> '[REDACTED]'`), so re-running only processes
still-unredacted rows; retry-OFF on cron-job.org — the daily tick is the
natural retry. **Membership invoices are NOT touched** (their buyer is a
real F3 member governed by the F3/F9 member-lifecycle + GDPR-export
surfaces).

### Technical + organisational measures (TOMs)

**Technical**:

- **Tenant isolation (NON-NEGOTIABLE)** — Constitution v1.4.0 Principle I:
  the `invoices` table has Postgres `ENABLE` + `FORCE ROW LEVEL
  SECURITY` + tenant-isolation policy. The redaction cron mutates each
  tenant's rows inside `runInTenant(ctx, tx)` so RLS + the
  `app.current_tenant` GUC apply per tenant; only the cross-tenant
  tenant-LIST read bypasses RLS (owner role, no GUC) as a maintenance
  path gated by `CRON_SECRET`.
- **Immutability trigger + GUC-gated PII-erasure path** —
  `invoices_enforce_immutability` (migration 0019, amended 0205) locks
  `member_identity_snapshot` (and every financial / numbering column)
  the moment a row leaves `draft`, so the §87/3 financial record cannot
  be altered. The redaction cron is the ONLY code path that sets
  `SET LOCAL app.allow_pii_redaction = 'true'` (auto-resets at
  tx-end); under that GUC the amended trigger permits **only**
  `member_identity_snapshot` to change — every other column still
  `RAISE`s. This is the sole, narrowly-scoped exemption to invoice
  immutability.
- **Append-only audit trail** — `event_buyer_pii_redacted` (10y) records
  the erasure; the `audit_log` BEFORE UPDATE/DELETE triggers prevent
  tampering.
- **Log redaction** — pino `REDACT_PATHS` includes
  `primary_contact_email` (snake + camel + nested forms) and
  `member_identity_snapshot` / `memberIdentitySnapshot`, so buyer PII
  never reaches the log aggregator. Cron error logs carry `errKind`
  (constructor name) only — never SQL fragments or column values.
- **Bearer-gated cron** — the redaction sweep authenticates with a
  constant-time `verifyCronBearer(authorization, CRON_SECRET)`; an
  unauthenticated call returns 401 with no data access.
- **Encryption** — TLS in-flight (Vercel managed certs); Neon at-rest
  AES-256 (DB + Blob).

**Organisational**:

- **Spec Kit `/speckit.review` privacy gate** before ship.
- **Annual data-protection report** to the chamber bylaws committee.
- **Incident response + cron runbooks** under `docs/runbooks/` —
  redaction-cron operations in
  `docs/runbooks/cron-jobs.md § F4 redact-expired-event-buyers`,
  including the blob-delete-failure manual-cleanup alert bound to the
  `…{outcome=error}` metric.
- **PDPA §23 / GDPR Art. 13/14 privacy-notice footer** — the optional
  auto-email that delivers the non-member buyer's invoice copy includes
  a multilingual footer (`EventNonMemberFooter`, `copy.ts` Task 14) in
  EN + TH + SV. The footer discloses that the buyer's PII was processed
  solely to issue the §86/4 / §105 tax document and will be retained
  for 10 years per §87/3, satisfying the Art. 13/14 "at time of
  collection" transparency obligation.
- **Solo-maintainer substitute** (Constitution v1.4.0 Principle IX +
  Governance) governs the review workflow when no second human reviewer
  is available.

### Data subject rights — exercise procedures

Non-member buyers have **no member portal account**, so DSRs are handled
manually by the DPO (there is no self-service surface for a non-member).

| Right (GDPR / PDPA equivalent) | Procedure |
|---|---|
| **Right to access (Art. 15 / §30)** | Manual DSR to the DPO; SQL query on `invoices WHERE invoice_subject='event' AND member_id IS NULL` for the buyer's email/name returns the stored `member_identity_snapshot`. |
| **Right to rectification (Art. 16 / §31)** | An issued tax document is **immutable by law** (§86/4 + immutability trigger). A correction is handled the §86/10 way — issue a credit note / corrected document, not an in-place edit. |
| **Right to erasure (Art. 17 / §32)** | The **automated storage-limitation erasure** is the daily redaction cron at the 10-year boundary (tombstone + blob purge, above). **Before** that boundary, erasure is constrained by the §87/3 legal-retention obligation (GDPR Art. 17(3)(b) — retention required for compliance with a legal obligation overrides erasure until the statutory window elapses); the DPO documents this lawful-basis-to-retain in any pre-window erasure request. |
| **Right to restrict processing (Art. 18 / §33)** | Art. 18 requests for an individual buyer are handled via a manual DPO procedure (no self-service surface). The §87/3 legal-obligation basis means restriction can apply to **optional downstream uses** (e.g. the auto-email copy) but **NOT** the core 10-year tax retention — the chamber cannot restrict what Thai law mandates it keep. The `FEATURE_F4_INVOICING=false` kill-switch halts all new event-invoice issuance tenant-wide; it is an **emergency operational control**, not a per-subject restriction mechanism. |
| **Right to object (Art. 21 / §32)** | Limited — processing rests on a legal obligation (Art. 6(1)(c)), not legitimate interest, so the Art. 21 objection right does not apply to the statutory retention; the auto-email copy can be declined (the chamber simply does not enable it / does not send). *(Note: Thai PDPA §32 covers both the erasure right [Art. 17, row above] and the objection right [Art. 21, this row] — the §32 citation appearing in both rows is correct.)* |

### DPO contact

Same as F7.

### Update history

| Date | Change | Author |
|---|---|---|
| 2026-06-04 | Initial F4 event-fee sub-scope entry created — issuance + 10-year redaction cron (branch `054-event-fee-invoices`, Task 16) | F4 event-fee implementation pass |

---

## F3 — Members & Contacts (core member data)

**Status**: SHIPPED — branch `005-members-contacts`. This is the **foundational
member-data processing record**: the chamber's directory of member legal
entities and their natural-person contacts. The COMP-1 erasure record (next
section) governs the Art. 17 / §33 lifecycle of this data.

### Controller

The chamber tenant operating the Chamber-OS deployment (single-tenant F1
deployment = Thai-Swedish Chamber of Commerce / SweCham / TSCC). The chamber
is the controller of its members' and contacts' identity data.

### Processors

No processor is unique to F3 — all are the shared F1–F8 set:

- **Vercel Inc.** (US-incorporated; region `sin1` Singapore) — application
  hosting + function execution. Existing DPA + SCCs.
- **Neon, Inc.** (US-incorporated; region `ap-southeast-1` Singapore) — Postgres
  holding the `members` + `contacts` rows. Existing DPA + SCCs.
- **Upstash, Inc.** (Singapore) — Redis rate-limit cache; no member PII (only
  rate-limit counters). Existing DPA.
- **Resend Inc.** (US-incorporated) — **transactional** email only for F3
  (member-invitation + email-verification + email-change messages). This is the
  F1+F4 transactional Resend surface (operational), NOT the F7 Broadcasts
  marketing surface. Existing DPA + SCCs.

### Categories of data subjects

- **Chamber members** — legal-entity members; the natural-person data subjects
  are the *primary contacts* and *secondary contacts* of those entities.
- **Primary + secondary contacts** — natural persons whose name, email, phone,
  and (optional) role title / date of birth are stored in `contacts`, plus the
  primary contact's email mirrored on `members.primary_contact_email`.

### Categories of personal data

| Category | Field | Notes |
|---|---|---|
| **Identity (entity)** | `members.company_name` | Member legal name — NOT NULL free-text. `src/modules/members/infrastructure/db/schema-members.ts` |
| **Identity (natural person)** | `contacts.first_name`, `contacts.last_name` | NOT NULL free-text. `schema` contacts |
| **Contact** | `members.primary_contact_email`, `contacts.email`, `contacts.phone` | Email normalised lower-case; `contacts_tenant_email_uniq` partial unique index on `lower(email) WHERE removed_at IS NULL` |
| **Business quasi-identifier** | `members.legal_entity_type`, `members.tax_id`, `members.website`, `members.turnover_thb`, `members.founded_year`, `members.description` | `turnover_thb` + `founded_year` are GDPR-Recital-26 re-identification risks at small-chamber scale — scrubbed on erasure (see COMP-1 record) |
| **Address** | `members.address_line1`, `address_line2`, `city`, `province`, `postal_code` | Postal address of the member entity |
| **Membership** | `members.plan_id`, `members.plan_year`, `members.member_number` | `member_number` is the per-tenant human-readable display id (`SCCM-NNNN`) |
| **Derived / behavioural (F8)** | `members.risk_score`, `risk_score_band`, `risk_score_factors`, `risk_score_last_computed_at`, `risk_snoozed_until` | F8 8-factor retention heuristic — see the F8 RoPA for the Art. 22 / §32 DPIA analysis |
| **Free-text operational** | `members.notes`, `members.blocked_from_auto_reactivation_reason`, `contacts.role_title`, `contacts.date_of_birth` | Admin/staff free-text + contact attributes — can name/email the subject |
| **Non-identifying state** | `members.status`, `country` (ISO-3166-1 alpha-2), `preferred_locale` (en/th/sv), the registration dates, the consent/opt-out timestamps | Retained on erasure (see COMP-1 record) |

**No special categories (Art. 9 / PDPA §26)** are processed by F3 — no health,
religion, political opinion, racial origin, biometric, or genetic data. Member
tier codes + turnover are business categorisation, not special-category PII.

### Purpose of processing

- **Membership administration** — maintaining the chamber's member directory +
  contact records is **necessary for performance of the membership contract**
  (PDPA §24 ¶2 / GDPR Art. 6(1)(b)).
- **Member directory + engagement** — admin oversight of the member base
  (legitimate interest, PDPA §24(5) / GDPR Art. 6(1)(f)).
- **Tier eligibility signals** — `turnover_thb` / `founded_year` inform plan-tier
  eligibility + the F8 tier-upgrade suggestion (legitimate interest).

### Lawful basis

Performance of contract (the membership) for the core directory data; legitimate
interest for the admin directory + the F8-derived signals (DPIA documents the
F8 Art. 22 analysis). The business quasi-identifiers are member-supplied at
onboarding.

### Recipients of personal data

- **Chamber admin + manager users** — the admin members directory, the
  command-palette search, member detail/edit.
- **The member's own contacts** — the member self-service portal (`/portal/**`).
- **Resend Inc. (processor)** — receives a contact email at invitation /
  verification / email-change time (transactional).
- **Chamber DPO + legal counsel** — may access any record for compliance review.

### Cross-border data transfers

Same as F7 — **Singapore** (Vercel `sin1` / Neon `ap-southeast-1` / Upstash):
Thailand → Singapore under **PDPA §28** cross-border provisions; Swedish/EU
contacts under **GDPR SCCs** with Vercel + Neon + Upstash. The hosting-region
choice is the documented **F1 hosting deviation** (Constitution § Compliance —
"Thailand primary, or nearest APAC with written justification"; no major cloud
has a TH region — see `specs/001-auth-rbac/plan.md` Complexity Tracking).

### Retention periods

| Resource | Retention | Authority |
|---|---|---|
| `members` + `contacts` rows (active member) | **Indefinite while the membership exists** | Contract performance; the row is NOT hard-deleted (the FK web — invoices/payments/registrations/broadcasts reference it — forbids hard-delete), it is **anonymised in place** on Art. 17 erasure (see COMP-1 record) |
| `audit_log` rows for F3 events | **5 years** | Constitution Principle VIII (≥5y for finance / auth / PII-access records); `audit_log.retention_years DEFAULT 5`, CHECK `IN (5,10)` (migration 0039) |

### Technical + organisational measures (TOMs)

- **Tenant isolation (NON-NEGOTIABLE)** — `members` + `contacts` have Postgres
  `ENABLE` + `FORCE ROW LEVEL SECURITY` + `tenant_id = current_setting(...)`
  policy; `runInTenant(ctx, tx)` is the only entry point. Cross-tenant
  integration test is a Review-Gate blocker (Principle I).
- **Append-only audit log** — F3 mutations emit audit events; the `audit_log`
  BEFORE UPDATE/DELETE triggers prevent tampering.
- **Pino log redaction** — `member.email`, `email`, `primary_contact_email`
  (snake + camel + nested) are in `REDACT_PATHS`; contact PII never reaches the
  log aggregator.
- **Encryption** — TLS in-flight (Vercel managed certs); Neon at-rest AES-256.

### Data subject rights — exercise procedures

| Right (GDPR / PDPA) | Procedure |
|---|---|
| **Access (Art. 15 / §30)** | F9 GDPR data-export — member self-service `POST /api/portal/account/data-export` + admin on-behalf `POST /api/admin/members/[id]/data-export` (enqueue `gdpr_member_archive` → ZIP). |
| **Rectification (Art. 16 / §31)** | Member portal self-edit `/portal/edit` (whitelisted fields); admin edit `/admin/members/[memberId]/edit` → `PATCH /api/members/[memberId]` (diff-tracked audit); single-field `PATCH …/inline-edit`. |
| **Erasure (Art. 17 / §33)** | The **COMP-1 member-erasure** flow — admin-only `POST /api/members/[memberId]/erase` (US3-A) → `eraseMember` cascade → see the COMP-1 record below + `docs/runbooks/member-erasure.md`. |
| **Restrict processing (Art. 18 / §34)** | Per-member operational halts (F7 `broadcasts_halted_until_admin_review`, F8 renewal opt-out); tenant-wide kill-switches per feature. *(PDPA §34 is the restriction-of-use right; §33 is erasure — distinct sections.)* |
| **Portability (Art. 20)** | Same F9 export surface as Art. 15 (portable ZIP). |
| **Object (Art. 21 / §32)** | Marketing: one-click F7 unsubscribe (`marketing_unsubscribes`, indefinite suppression). |
| **No automated decision-making (Art. 22)** | F3 itself makes no automated decision; the F8 risk score is admin-facing only (DPIA documents the analysis). |

### DPO contact

Same as F7.

### Update history

| Date | Change | Author |
|---|---|---|
| 2026-06-21 | Initial F3 Members & Contacts core RoPA authored (COMP-1 US3-E) | COMP-1 US3-E pass |

---

## COMP-1 — Member Erasure (GDPR Art. 17 / PDPA §33)

**Status**: SHIPPED — the erasure lifecycle (`eraseMember`,
`src/modules/members/application/use-cases/erase-member.ts`) is live across US1
(core) + US2a–d (per-module cascades + reconciler) + US3-A (admin trigger) +
US3-B (10-year tax-document redaction) + US3-C (sub-processor propagation) +
US3-D (DPO evidence log). This entry records the **erasure itself as a distinct
processing activity** — the retention-management + data-subject-right mechanism
for the F3 member data above (PDPA §39 / GDPR Art. 30 expect the erasure
mechanism to be recorded, as with the F4 retention-managed erasure).

### Controller

Same as F3 — the chamber tenant.

### Processors

No new processor. The erasure **propagates to** the existing sub-processors:
Vercel/Neon (the controller-copy scrub), Vercel Blob (US3-B tax-PDF byte purge),
**Resend** (US3-C audience-contact removal — best-effort, see below), and
**Stripe** (a **pure no-op** — there is no member↔Stripe-customer model; F5
holds only payment-method tokens, no member-keyed customer record;
`specs/009-online-payment/` models no Stripe Customer aggregate).

### The erasure model — anonymise-in-place

A member's FK web (invoices, payments, event registrations, broadcasts) **forbids
a hard delete**, so erasure **anonymises the member + contacts in place** and
leaves a pseudonymous stub row. On erasure (`scrubPiiInTx` /
`scrubPiiForMemberInTx`):

| Action | Fields |
|---|---|
| → `'[erased]'` sentinel (`ERASED_SENTINEL`, `members/domain/erasure-sentinels.ts`) | `members.company_name`, `contacts.first_name`, `contacts.last_name` (NOT NULL free-text) |
| → per-row `erased+<contact_id>@erased.invalid` (`ERASED_EMAIL_*`) | `contacts.email` (NOT NULL; the sentinel leaves the `lower(email)` partial-unique index, no collision) |
| → `NULL` | `members.legal_entity_type`, `tax_id`, `website`, `description`, `notes`, **`turnover_thb`, `founded_year`** (business quasi-identifiers — Recital 26), the full address (`address_line1/2`, `city`, `province`, `postal_code`); `contacts.phone`, `date_of_birth`, `role_title`; the F8 risk cluster (`risk_score`, `risk_score_band`, `risk_score_factors`, `risk_score_last_computed_at`, `risk_snoozed_until`); the blocked-auto-reactivation cluster (flag→FALSE, actor + reason → NULL, to satisfy the consistency CHECK) |
| `removed_at`-stamped + `is_primary`→FALSE | every `contacts` row (exits the `one_primary_per_member` + `primary_not_removed` CHECKs) |
| `erased_at`→ erasure timestamp | `members.erased_at` (the operational marker enabling the US2d reconciler sweep via the partial index `members_erased_at_idx`) |
| **KEPT (non-identifying — re-identification analysis, design §3)** | `member_id`/`member_number`/`tenant_id` (opaque without the scrubbed `members.*`), `plan_id`/`plan_year`, the registration + audit dates, `status`, `country` (ISO alpha-2), `preferred_locale`, the consent/opt-out timestamps |
| **KEPT (deliberate — Art. 17 survival hazard)** | `contacts.linked_user_id` — NOT nulled, so the F1 linked-login erasure work-list (`listAllLinkedUserIdsForMemberInTx`, reads off `removed_at`-stamped rows) can re-drive a previously-failed login on a reconciler pass; nulling it would leave the credential alive forever |

The member + contact scrub + the in-tx F7 delivery tombstone +
(US3-C) the sub-processor-audience capture all run in **one atomic
`runInTenant` transaction** — a partial scrub can never commit.

### Lifecycle (the A–D processing flow)

1. **A — admin trigger (US3-A).** Admin-only `POST /api/members/[memberId]/erase`
   (manager/member → 404): typed-phrase confirm + reason
   (`gdpr_erasure_request` | `pdpa_deletion_request`) + **Art. 12 identity
   attestation** (`identity_verified` = true + `verification_method` ∈
   {`verified_account_login`, `in_person`, `email_confirmation_loop`,
   `official_document`} + optional note). These are recorded once in the
   originating `member_erasure_requested` audit (never on a reconciler re-drive).
2. **B — durable request + atomic scrub (US1).** A `member_erasure_requested`
   audit is emitted in its own committed tx (the **Art. 12 / §30 clock-start**);
   then the atomic scrub tx (above) + session revocation + invitation
   soft-consume + email-change-token invalidation + pending-outbox cancel + the
   in-tx F7 delivery tombstone.
3. **C — post-commit cascades.** **BLOCKING** (any failure withholds
   `member_erased` → the US2d reconciler retries): **F1** linked-login
   anonymisation (US2a — email/password/display anonymised, sessions revoked),
   **F7** broadcast CONTENT scrub (US2b — authored subject/body → `'[redacted]'`),
   **F6** event-registration hard-delete + quota credit-back (US2c), **F8**
   in-flight renewal-cycle + broadcast cancellation. **NON-BLOCKING** (never
   withholds `member_erased`): **US3-C** sub-processor propagation (Resend
   best-effort + Stripe no-op).
4. **D — completion + operational.** `member_erased` (the completion proof) is
   emitted **only when every blocking cascade reports clean**. The **US2d
   reconciler** cron re-drives any half-run (`erased_at` set, no `member_erased`).
   The **US3-B** cron redacts the member's tax documents at the 10-year boundary
   (below). The **US3-D** evidence log (`/admin/compliance/erasure-log`) surfaces
   the proof for the DPO.

### Lawful basis

The data subject's **right to erasure** — GDPR Art. 17 / PDPA §33. The **10-year
tax-document retention** (below) is the **Art. 17(3)(b)** override (retention
required for compliance with a legal obligation — Thai RD §87/3) and applies
only to the F4 tax-document copy until the statutory window elapses.

### Retention periods (erasure audit trail)

| Audit event | Retention | Authority |
|---|---|---|
| `member_erasure_requested`, `member_erased` (F3) | **5 years** | Constitution Principle VIII default (`audit-port.ts`) |
| `subprocessor_erasure_propagated` (F3, migration 0228) | **5 years** | F3 default — records the Resend/Stripe propagation outcome (ids + outcome counts only, **no PII**) |
| `user_erased` (F1) | **5 years** | F1 audit convention (tenant-NULL per F1 identity convention — see the US3-D evidence log) |
| `event_buyer_pii_redacted` (F4) | **10 years** | `F4_AUDIT_RETENTION_YEARS['event_buyer_pii_redacted'] = 10` — keeps the §87/3 forensic window; **payload carries field NAMES only, never erased PII values** |
| **The member's F4 tax documents** | **10 years from issue date**, then PII-redacted | Thai RD §87/3 — the **US3-B** member-invoice cron (`/api/cron/invoicing/redact-expired-member-invoices`, gate `member_id IS NOT NULL AND erased_at IS NOT NULL AND issue_date < now()−10y`) tombstones the buyer snapshot + purges the PDF bytes (incl. credit notes, anchored on their own issue_date) at the boundary, emitting the **shared `event_buyer_pii_redacted` audit type** (deliberately reused by both the event-buyer cron and this member-invoice cron); the financial / numbering record is preserved permanently |

### Sub-processor erasure propagation (US3-C) — RoPA exit dependency (H-2)

> **Resend (sub-processor):** best-effort-once erasure propagation
> (audience-contact removal on member erasure), un-enumerable historical
> audiences out of automated reach, manual remediation on failure within the
> Art. 12(3) / §30 response window.

This is the documented compensating control that makes the **non-blocking**
US3-C cascade Art. 17(2) / Art. 19 compliant (security-engineer + DPO sign-off,
plan-review 2026-06-20). The full operational procedure + the
`member_subprocessor_erasure_total{resend_outcome}` alert are in
`docs/runbooks/member-erasure.md`. **Stripe** propagation is a pure no-op (no
member↔customer model).

### Documented residuals (accepted limitations — design known-limitations)

The controller-copy erasure is durable + atomic. These residuals are **accepted
by design** with the stated compensating control; the DPO must be aware of them
when answering a DSR:

| # | Residual | Why accepted / compensating control |
|---|---|---|
| 1 | **Backup / PITR snapshots** hold pre-erasure data | Re-erased only **if/when a restore is performed**; erasure does not rewrite completed snapshots. Restore-runbook re-runs the erasure. |
| 2 | **Already-downloaded F9 GDPR-export ZIPs** | Out of reach once on the subject's device — erasure cannot delete a downloaded file. |
| 3 | **`marketing_unsubscribes.email_lower` retained whole** (memberId→NULL, never deleted) | The **Art. 21 / §32 suppression invariant** ("we will not contact this email again") must remain enforceable post-erasure — the plaintext is an intentional, lawful residual. |
| 4 | **`audit_log` historical free-text payloads** may carry legacy PII | Append-only (immutability trigger) — cannot be modified/deleted; held under the **forensic / record-of-processing basis** (Art. 30 / §39). Forward-fix: new erasure audits write **no PII**. |
| 5 | **NULL-`matched_member_id` event registrations** | A fuzzy/unlinked F6 registration the system never matched to the member is unreachable by the fan-out — remediate by hand on a DSR. |
| 6 | **Old-address broadcast deliveries / outbox mail** — a contact's email was *edited off* its row before erasure (peer-collision sub-case) | A contact **archived** before erasure is now tombstoned: the in-tx redaction set is **all** the member's contact emails (any `removed_at`) **minus** any address a *peer* holds via a LIVE contact (COMP-1 review **FIX-3**), and the `notifications_outbox` cancel carries a two-pronged cross-member ownership guard (**FIX-4**). The residual is narrowed to (a) an address that was UPDATE-edited off every contact row (no longer discoverable) and (b) the deliberate **peer-collision exclusion** — an address a peer still holds live is left un-redacted to avoid cross-member over-deletion. |
| 7 | **Cross-author `custom_recipient_emails`** (peer-collision edge only) | The erased member's email is now **element-wise redacted** out of OTHER authors' custom recipient lists tenant-wide, keyed on the same peer-excluding email set as the tombstone (COMP-1 review **FIX-9**). Residual narrowed to the deliberate peer-collision exclusion: an email that is ALSO a peer's LIVE contact is left in place to avoid over-redacting the peer's legitimate target. |
| 8 | **Resend historical / un-enumerable audiences** (US3-C #H-2 above) | Best-effort-once; manual remediation within the §30 window. |
| 8a | **Resend "Global Contacts" survive erasure — MEASURED, not inferred** | The erasure cascade calls `DELETE /audiences/{id}/contacts/{email}`, which **detaches** rather than deletes. Measured 2026-09-09 (108 Phase 9 review U1) against the live account: the call answers `{"deleted": true}` and the audience-scoped read then 404s, **while an audience-less `GET /contacts/{email}` still returns the contact at 200**. The provider's own response is what made this invisible for as long as it was. Per research § R16 a contact is one record per team that survives an audience delete, so the address persists at the processor indefinitely and is **not under chamber control**. An audience-less `DELETE /contacts/{email}` was measured in the same run to delete for real (read-back 404) and is implemented as `deleteContactGlobally`, but it is **deliberately not called by the cascade**: the Resend account is shared by every tenant, so two tenants whose members share an address share ONE contact record, and deleting it during tenant A's erasure would destroy tenant B's record together with the Resend-side `unsubscribed` flag that `on_conflict=upsert` exists to preserve — trading an Art. 17 residual for an Art. 21 regression on an uninvolved person. Closing this properly requires a cross-tenant "is this address held by any live member anywhere" check, which is an architectural decision. **OPEN — owner: solo maintainer (Jirawatpyk). Opened 2026-09-09. Review by 2026-12-09 (90 days) or on the event below, whichever is sooner.** ⚠️ **The protective trade is VACUOUS in production today, measured not assumed: prod holds exactly ONE tenant** (`SELECT DISTINCT tenant_id FROM members` → `swecham`; there is no `tenants` table). There is no tenant B, so tenant A's Art. 17 right is currently withheld to protect an Art. 21 flag belonging to nobody. It is nevertheless NOT closed by simply calling the global delete: the platform is Multi-Tenant Aware by design (MTA+STD), a cross-tenant integration test already enforces the safe behaviour, and "correct because we only have one tenant" is the class of thing that breaks silently on tenant #2. **Revisit condition: the second live tenant, or a per-tenant Resend account — whichever comes first.** **Instructing the processor — NOT yet attempted.** The zero-cost measure here is to INSTRUCT Resend to delete the contact record, and no such instruction has been sent; that is an action item on this residual, not a limitation of it. Legal basis: **Art. 28(3)(a)** (the processor processes only on the controller's documented instructions) together with **Art. 28(3)(e)** (the processor assists the controller in responding to data-subject-rights requests), and **PDPA s.33** for the Thai data subjects, who are the majority here. *(Round 4 M-2 — this cited **Art. 28(3)(g)**, which is the duty to delete or return all personal data **after the end of the provision of services**; it is a contract-termination obligation and has not been triggered. The action item was right and the citation named the wrong duty, in a document written to be read by a regulator. The same paragraph was framed GDPR-only while the code and `docs/runbooks/member-erasure.md` cite PDPA s.33.)* Until closed, a DSR answer must say the address may remain in the processor's contact store. |
| 9 | **Sentinel vocabulary divergence** (`'[erased]'` F1/F3 vs `'[redacted]'` F7) | Clean-Architecture prevents F7 importing F3's constant; a single-token PII-oracle must check both. Cosmetic, no leak. |

### Technical + organisational measures (TOMs)

- **Atomic + tenant-scoped scrub** — the member + contact PII scrub (+ the in-tx
  F7 delivery tombstone + the US3-C audience capture) runs in ONE
  `runInTenant(ctx, tx)` transaction under Postgres RLS + FORCE on `members` /
  `contacts`; a partial scrub can never commit. The cross-tenant integration test
  is a Review-Gate blocker (Principle I).
- **FAIL-LOUD in-tx reads** — the audience-derivation + delivery-tombstone reads
  throw → the whole erasure rolls back (the member stays un-erased + re-drivable)
  rather than committing an incomplete scrub.
- **Append-only audit, NO PII in payload** — `member_erasure_requested` /
  `member_erased` / `subprocessor_erasure_propagated` / `user_erased` /
  `event_buyer_pii_redacted` are append-only (the `audit_log` BEFORE UPDATE/DELETE
  triggers); every NEW erasure audit carries **ids + outcome counts + field NAMES
  only — never the erased PII values**.
- **GUC-gated tax-redaction exemption** — the US3-B / F4 redaction crons are the
  ONLY code path that sets `SET LOCAL app.allow_pii_redaction = 'true'` (tx-scoped,
  auto-reset); under it the invoice/credit-note immutability trigger permits ONLY
  the buyer snapshot + the purge marker to change — every financial / numbering
  column still `RAISE`s.
- **US3-D deliberate tenant-NULL read is scoped + tested** — the evidence log's one
  app-layer RLS exception (reading the tenant-NULL `user_erased` rows under the
  PERMISSIVE `audit_log` policy) is bounded to the member's OWN linked-user ids and
  DROPPED entirely when that set is empty (security FIX-1), with a cross-tenant
  gate-blocker integration test (FIX-2).
- **Log redaction + Bearer-gated crons** — pino `REDACT_PATHS` covers member /
  contact email + `member_identity_snapshot`; the US2d reconciler + the US3-B
  redaction cron authenticate with a constant-time `CRON_SECRET` Bearer check.
- **Solo-maintainer substitute** (Constitution Principle IX) — automated review +
  DB-level defence-in-depth substitute the ≥2-reviewer rule for this PII surface.

### Cross-border data transfers

Same as F3 (Singapore + PDPA §28 + GDPR SCCs). The US3-C Resend propagation
**reduces** data at an existing recipient — no new transfer or sub-processor.

### Data subject rights — exercise procedures

This record IS the Art. 17 / §33 erasure mechanism. The DPO operates it via the
US3-A admin UI + the `docs/runbooks/member-erasure.md` procedure; the **US3-D
evidence log** (`/admin/compliance/erasure-log`) is the accountability proof
(requested + completion + the F1 `user_erased` proof + the tax-redaction +
sub-processor outcomes + a half-run/overdue badge). The **Art. 12 / §30
one-month deadline** runs from the `member_erasure_requested` timestamp.

### DPO contact

Same as F7.

### Update history

| Date | Change | Author |
|---|---|---|
| 2026-06-21 | Initial COMP-1 Member Erasure processing-activity record authored — lifecycle A–D, scrub matrix, retention, US3-C H-2 exit dependency, documented residuals (COMP-1 US3-E) | COMP-1 US3-E pass |
| 2026-06-21 | Whole-feature `/code-review` fixes folded in — residuals #6/#7 **narrowed** (FIX-3 pre-archived-contact tombstone via peer-excluding all-contact set, FIX-4 outbox two-pronged cross-member ownership guard, FIX-9 cross-author custom-list element-wise redaction); also closed: non-member event credit-note cross-cron §87/3 redaction gap (FIX-1), `members.erased_at` made sticky across reconciler re-drives (FIX-2), reconciler legal-basis = earliest request to match the DPO log (FIX-8), DPO credential-proof dedupe per-login (FIX-7) | COMP-1 review-fixes (branch 084) |


---

## 016 — Staff Role Administration + Marketing Scope (RBAC v2)

**Status**: LIVE. Shipped PR #323/#324; production cutover completed
2026-08-11 (`docs/runbooks/rbac-v2-cutover.md` § 9). PR 4 made the
`marketing` role assignable and swept navigation onto the permission model.

This record covers TWO processing activities that RBAC v2 either introduced
or materially changed:

1. **Staff role administration** — creating, promoting, demoting and
   disabling staff accounts, and the audit trail that makes those acts
   accountable. Pre-016 this existed with three roles; 016 widened it to
   five and narrowed who may perform it.
2. **Marketing scope** — a new internal population with READ access to member
   and contact records, and WRITE authority over two communication channels:
   `broadcasts.write` + `broadcasts.send` (compose, approve and dispatch mass
   email to the full member list) and `events.write` (CSV attendee import,
   which CREATES personal-data records for non-member attendees). Those write
   paths are themselves recorded under F7 and F6/F6.1; what this record adds is
   who now holds them.

   Two consequences are named rather than left implied. `approve-broadcast` has
   no author-≠-approver check, so a marketing operator can approve their own
   send; and `audit.read` is super-admin-only, so no `admin` can review what was
   sent. That segregation-of-duties gap is a documented residual.

### Controller

Unchanged: the chamber tenant operating the deployment (SweCham / TSCC in
the single-tenant F1–F9 deployment). See F7 § Controller.

### Processors

No new processor. Role administration is entirely first-party: Neon
(`ap-southeast-1`) stores `users.role` and `audit_log`; Resend delivers the
invitation email that carries the intended role. Both are already recorded
under F1/F7 with the same contractual basis.

### Categories of data subjects

- **Staff operators** — the natural persons holding a Chamber-OS staff
  account (`super_admin`, `admin`, `manager`, `marketing`). They are the
  data subjects of the role-administration activity: their name, work email
  and role history are processed.
- **Members and their contacts** — the data subjects of the marketing read
  scope. No new category: these are the F3 subjects, now visible to one
  additional internal role.

### Categories of personal data

Role administration: staff display name, work email, role, account status,
`last_sign_in_at`, and the `audit_log` rows recording each change (actor,
target, before/after role, timestamp, request id, source IP).

Marketing scope: the F3 member + contact fields **minus date of birth**.
Stated precisely, because "minus the `members.pii_sensitive` set" reads as a
substantial carve-out and the real one is a single column — that key gates
exactly `contacts.date_of_birth`, and there is no wider "DoB-class" set.
Marketing therefore DOES receive, on `members.read`: company name and legal
entity type, tax ID, postal and billing address, turnover and registered
capital, free-text notes, and each contact's name, email and phone. That is a
defensible scope for a communications role — but it IS the scope, and this
record now says so.

Date of birth is withheld from marketing on **every** staff egress, by three
different keys. There is no single chokepoint; an earlier draft of this record
said there was, which understated how many places must stay correct:

| Egress | Gate | marketing |
|---|---|---|
| `GET /api/members/[memberId]?include=date_of_birth` | `members.pii_sensitive` | denied |
| member edit form (`/admin/members/[id]/edit`) | `members.write` | denied |
| members-backup CSV (`GET /api/admin/members/export.zip`) | `members.bulk` | denied |
| staff-initiated GDPR member archive | `members.bulk` | denied |
| private-artefact download proxy | role allow-list | denied |

Both subsumption invariants — `members.bulk ⊆ members.pii_sensitive` and
`members.write ⊆ members.pii_sensitive` — are enforced in
`tests/unit/auth/permissions/role-bundles.test.ts`, so a bundle change granting
bulk export or edit access without field-level PII access fails CI instead of
silently shipping dates of birth.

Finance data is absent rather than hidden, in two places: the dashboard payload
omits revenue, receivables and overdue figures for a viewer without
`insights.finance` (T054/T056), and the member timeline drops invoice and
payment rows for a viewer without `invoicing.read`. The second gate was added
during the review of this record — the timeline route is gated on
`members.read`, which marketing holds, and was serving `amount_satang` and F4
document totals.

### Purpose of processing

Role administration: access control and accountability — ensuring each
operator holds only the permissions their function requires (data
minimisation, GDPR Art. 5(1)(c) / PDPA §22), and that every change to those
permissions is attributable.

Marketing read scope: composing and targeting member communications
(E-Blast) and event administration — the same purposes already recorded
under F7 and F6, performed by a dedicated role instead of by an
over-privileged `admin`.

### Legal basis

Role administration: legitimate interests (GDPR Art. 6(1)(f)) in securing
the controller's systems, and legal obligation (Art. 6(1)(c)) for the audit
records that evidence access control.

Marketing read scope: unchanged from F7/F6 — the member relationship
(Art. 6(1)(b)) plus legitimate interests in chamber administration. **No new
purpose, category, recipient, transfer or automated decision-making is
introduced**, which is the basis for the DPIA answer below.

### DPIA assessment (privacy checklist CHK035)

**No DPIA is required for adding the `marketing` role.**

GDPR Art. 35(1) triggers on processing "likely to result in a high risk".
**Thailand's PDPA imposes no equivalent DPIA obligation** — there is no Thai
counterpart to Art. 35; the relevant Thai duties here are §37 (security
measures) and §41 (DPO oversight), both already discharged. An earlier draft of
this record asserted a PDPA "equivalent trigger", which would have been a
visible error to its primary Thai reader.

Against Art. 35(3) none of the three mandatory triggers applies: no systematic
and extensive evaluation producing legal effects, no large-scale Art. 9
special-category processing, no large-scale systematic monitoring of a public
area. Against the EDPB WP248 criteria the change scores at most one, and the
threshold is two. Adding an internal access role:

- introduces **no new category** of personal data — marketing sees a strict
  SUBSET of what `admin` already saw, with the DoB-class fields removed;
- introduces **no new purpose** — the E-Blast and event purposes are already
  recorded under F7/F6;
- introduces **no new recipient and no new transfer** — the data does not
  leave the existing processors or regions;
- involves **no Art. 22 automated decision-making** producing legal or
  similarly significant effects. Profiling in the Art. 4(4) sense DOES occur —
  marketing holds `insights.engagement`, which reaches F8's at-risk scoring and
  F9's engagement insights — and is assessed under the existing F8/F9 records.
  The earlier "no profiling" wording was too broad to survive a regulator
  reading it as a term of art;
- and, as supporting colour rather than as the test: it is **risk-reducing on
  balance**, existing so communications work happens without the money, audit,
  user-administration and erasure surfaces `admin` carries. That is not the
  Art. 35 question — which asks whether the processing is high-risk, not
  whether it improves on the status quo — and it is contingent on the role
  actually displacing over-privileged `admin` use, which this record cannot
  evidence. The Art. 35(3) / WP248 analysis above is the operative reasoning.

The existing F3 + F7 assessments therefore remain sufficient. Re-assess if
marketing later gains a write path over member records, or if the role is
ever granted to a party outside the controller's own staff.

### Last-super-admin erase refusal vs erasure rights (privacy checklist CHK041)

The system refuses to erase or disable the LAST account holding `super_admin`.
There are two distinct cases behind that one guard, and only the first is the
one an earlier draft of this record described.

**Case A — a staff operator asks for their own account to be erased.** The
refusal is a staff-continuity guard, not a GDPR Art. 17 / PDPA §33 denial: the
account is a staff operator's, processed for access control, not a member's
record. The controller's overriding ground under Art. 17(1)(c) / Art. 21(1) is
its own Art. 32 obligation — access control and the Art. 5(2) accountability
trail cannot be maintained with zero administrators. The request is fulfilled
by first putting a successor in place, then erasing.

The successor path, stated accurately: **promotion, not the bootstrap script.**
`scripts/seed-bootstrap-admin.ts` refuses whenever a `super_admin` row exists in
ANY status, which is by definition true in this scenario — the earlier draft
cited it as the escape hatch and it would have returned exit code 2. The two
real paths are:

1. the outgoing super_admin promotes a successor from `/admin/users` before
   departing (`users.manage` is super-admin-only, so no one else can);
2. if that person is unavailable — the realistic ex-employee case — the
   operator break-glass path: a direct `UPDATE users SET role='super_admin'` in
   the Neon console, which MUST be recorded in the DPO log with the request it
   serves.

Naming the break-glass step is what makes this defensible. A record that cites
a script which returns a refusal is not.

**Case B — a MEMBER's erasure cascade is blocked.** `eraseUser` exists
primarily as the COMP-1 cascade (F3 member → F1 login), so the realistic firing
of this guard is a member exercising Art. 17 whose contact is linked to the last
administrative login (`users_last_admin_protection`, surfaced as
`erase-user-last-admin` and explicitly not auto-recoverable by the reconciler).
Here the blocked subject is a data subject with no employment-retention
counterweight, and Art. 17(3) contains no operational-continuity exemption.

The erasure is therefore **deferred, not refused**. The Art. 12 / §30 one-month
clock runs from `member_erasure_requested`, and the remediation is to re-link
that contact to a different login or promote a successor — minutes of work, no
code deploy, **provided a super_admin is available to act**. Where the last
holder is themselves the requesting subject or is unavailable, the break-glass
path above applies and must be executed inside the Art. 12 window.

Both cases are audited, so the intervening interval is evidenced.

### Recipients of personal data

No new recipients. Role changes are visible to holders of `audit.read`, which
D4 narrowed to `super_admin` only.

**Denials are recorded but not currently readable in the product** — a
documented residual, not a control this record may claim. `permission_denied`
rows are appended by `src/lib/rbac.ts` without a tenant, while every audit
reader leads with `eq(auditLog.tenantId, ctx.slug)`, so `/admin/audit` offers a
filter for an event type it can never return. The rows exist in `audit_log` and
are reachable by direct query; the accountability trail is therefore intact for
a DPO with database access and absent from the operator UI. Tracked for the
follow-up that threads the tenant slug onto the F1 denial event.

Stated carefully, because two earlier drafts got this wrong in opposite
directions. The first called it a reduction; the cutover log contradicts that —
Migration C promoted both incumbent human admins and a break-glass identity was
pre-minted, so the human holder count is **3** where it was 2. The second then
said "no existing recipient was removed", which is also false: `manager` held
`audit.read` on the legacy leg for both the page and the CSV export
(`tests/helpers/rbac-observed-baseline.ts` records `manager: 'allow'` on each),
and D4 removed it.

So: the manager population LOST audit access at the cutover, the administrator
population GREW by one break-glass identity, and the capability now constrains
future grants because a newly created `admin` does not receive it.

### Cross-border data transfers

Unchanged: Neon `ap-southeast-1` (Singapore) + Upstash Singapore + Vercel
`sin1`, under the PDPA §28 and GDPR SCC basis recorded for F1. RBAC v2
moves no data across a border.

### Retention periods

Role-change audit rows are **classified** for 5-year retention via
`audit_log.retention_years`, unchanged by 016. The `permission_denied` event
type added by 016 carries the same 5-year classification. Tax-document events
keep their 10-year classification (F4 / RD §87/3) — 016 altered no retention
value.

**Enforcement is a documented residual.** `retention_years` is a stored
classification column; no purge job acts on it. The three sweepers under
`src/app/api/internal/retention/` cover EventCreate pseudonymisation, error-CSV
blobs and idempotency keys, and `vercel.json` schedules only those three. Under
Art. 30(1)(f) an *envisaged* time limit is what the record must state, so
declaring 5 years is legitimate — implying it is applied would not be.

**Staff account records** (display name, work email, role, status,
`last_sign_in_at`) have no separate limit: a departed operator's account is
disabled at offboarding and anonymised through the same `eraseUser` path as any
other subject, on request or at the controller's initiative. Retention of the
disabled row between those two events is bounded by nothing automated today —
the same residual as above, recorded here rather than left as an omission.

### Technical + organisational measures (TOMs)

- **Positive permission model**: a 40-key catalogue with per-role bundles as
  pure Domain data; a role grants only what its bundle names, so a new role
  starts with nothing rather than with everything it was not explicitly
  denied.
- **Two-layer enforcement**: page and API guards (`requirePagePermission` /
  `requireApiPermission`) plus the Application-layer projections that keep
  withheld data out of the payload entirely (dashboard finance split,
  activity-feed redaction, DoB egress).
- **Navigation cannot over-offer**: every sidebar and command-palette entry
  declares the same permission its destination guards on, asserted by
  reading both sources (`tests/unit/nav/nav-permission-parity.test.ts`,
  `tests/unit/components/command-palette/palette-permission-parity.test.ts`).
- **Static gates in CI**: `check:staff-page-guard` (47 pages),
  `check:api-route-guard` (119 routes), and `check:authorization-role-reads`
  (no unmarked role literal on a decision surface).
- **Accountability**: every denial emits `permission_denied` to `audit_log`
  and increments `rbac_permission_denied_total`; reading guidance is in
  `docs/observability.md` § 4.6.
- **Least privilege on the sensitive surfaces**: `users.manage`,
  `audit.read`, `settings.invoicing` and the erasure keys are
  super-admin-only (D4).

### Data subject rights — exercise procedures

Staff operators exercise access/rectification through the DPO, who reads
the account and its `audit_log` history. Erasure of a staff account follows
the last-super-admin rationale above. Member and contact rights are
unchanged and continue to run through the COMP-1 record.

### DPO contact

Same as F7.

### Update history

| Date | Change | Author |
|---|---|---|
| 2026-08-12 | Record authored for 016 RBAC v2 — staff role administration + marketing member-read scope; DPIA answer (CHK035) and last-SA-erase vs Art. 17 rationale (CHK041) recorded; cross-ref to `docs/runbooks/rbac-v2-cutover.md` | 016 PR 4 (T060) |
| 2026-08-12 | **Corrected before sign-off** following the PR-4 privacy review, which found six claims the implementation contradicted. (1) DoB was described as having a single chokepoint; there are five egresses on three keys, and the two subsumption invariants that hold them are now named. (2) "the other DoB-class fields" described an empty set while the fields marketing DOES receive — tax ID, addresses, notes, contact email/phone — went unlisted. (3) CHK041 cited `seed-bootstrap-admin.ts` as the successor path; that script refuses whenever a super_admin exists, i.e. exactly this scenario. Replaced with promotion + a named operator break-glass step. (4) CHK041 addressed only the staff-operator case; the guard's realistic firing is a MEMBER's Art. 17 cascade, now recorded as deferral with the Art. 12 clock and its remediation. (5) The record claimed a reduction in audit-log recipients; Migration C promoted both incumbents, so the count went 2→3 and what narrowed is future grants. (6) 5-year retention was stated as applied; it is a classification with no purge job, now recorded as a residual. Also: the PDPA was said to have a DPIA trigger (it has none), "no profiling" was too broad (Art. 4(4) profiling occurs via `insights.engagement`; what is absent is Art. 22), and the title and scope understated the bundle's `broadcasts.send` / `events.write` authority. | 016 PR 4 review |

---

## F114 — Member Change Requests (member-proposed changes under staff approval)

**Status**: SHIPPED DARK → **being switched on for SweCham on 2026-09-16** — branch
`114-member-change-approval` (PR-1 #360, PR-2 #366, PR-3 #367). The platform flag
`FEATURE_MEMBER_CHANGE_APPROVAL` is live on production since 2026-09-16 12:18; the per-tenant
switch (`tenant_member_settings.member_change_approval_enabled`) is what starts the processing
for a chamber. **This record MUST exist before that switch goes on** (spec FR-040) — it was
authored for that purpose. Authority: `specs/114-member-change-approval/spec.md` (FR-001…FR-040),
`contracts/notifications-and-audit.md`, `quickstart.md` § 3 cutover + rollback matrix,
`docs/observability.md` § 27, `docs/runbooks/member-change-requests.md`.

### What the processing is

When the chamber's approval switch is on, a member contact's edit to a **Group B** field of the
member record (company name, website, description, registered / billing address, and the contact's
own name, phone and job title — spec § Group B; tax id, legal entity type and the other Group C
fields stay staff-only)  is **not written to the record**. It is
stored as a *change request* — one pending request per submitting person — reviewed by a staff
user holding `members.write`, who approves or rejects it **field by field** with a reason for
any rejection. Approved fields apply to the member / contact record inside the same transaction;
the submitting person is emailed the outcome; every request and decision is kept as an
accountable history visible to staff and to the person who submitted it. When the switch is off,
the F3 immediate self-service edit path applies unchanged.

### Controller

The chamber tenant operating the Chamber-OS deployment (single-tenant deployment = Thai-Swedish
Chamber of Commerce / SweCham / TSCC). The chamber is the controller of the proposed data and of
the decision history.

### Processors

The shared F1–F9 set, no new processor:

- **Vercel Inc.** (`sin1`) — hosting + route handlers; the per-tenant gauges cron.
- **Neon, Inc.** (`ap-southeast-1`) — Postgres holding `member_change_requests` +
  `member_change_request_fields` (migrations 0300–0302), the `notifications_outbox` rows of the
  two new notification types, and the `audit_log` rows of the five new event types.
- **Upstash, Inc.** (Singapore) — Redis: the per-actor *attempt* buckets on the change-request
  routes (keys carry the tenant slug + the user's uuid — a pseudonymous id, 600 s TTL — the
  house convention, e.g. the F3 marketing-preference limiter) and the `Idempotency-Key` record
  of a submit (ids + outcome only; no proposed value, since PR-2). The 10-per-24 h cap itself
  is counted from the durable request table, not from Redis (SC-013).
- **Resend Inc.** (US) — **transactional** email only: the staff notification
  (`member_change_request_submitted_staff`, to every active reviewer, one per submitting person
  per hour) and the member outcome email (`member_change_request_decided_member`). The email
  bodies name the member, the submitter and each field's old and proposed value (spec SC-002);
  they are rendered at send time from ids and never stored as bodies. Existing DPA + SCCs.

### Categories of data subjects

- **Member contacts** (primary and secondary) who submit a change request — the submitter's
  identity (user id, contact id, role at submission) is part of the record.
- **Member contacts whose data is proposed** — a primary contact may propose company-level
  changes; a contact may propose changes to their own name / phone / role title only (FR-004:
  the contact's email-language preference and the email-change / invite / marketing flows are
  outside this activity).
- **Staff reviewers** (admin / super_admin) — the deciding user's id is recorded on the request
  (`decided_by`); a deactivated reviewer keeps the attribution (FR-026).

### Categories of personal data

| Category | Field | Notes |
|---|---|---|
| **Proposed values (the payload)** | `member_change_request_fields.seen_value`, `proposed_value` (jsonb) | The "as seen" and "as proposed" value of each Group B field — company name, website, description, registered + billing address, the contact's first / last name, phone, role title. Tax id, legal entity type, country, founded year, turnover and the money / tier fields are Group C (staff-only) and never appear here. `affects_tax_documents` flags the fields that feed §86/4 buyer blocks. The same validation rule set as a staff edit (FR-014). |
| **Identity of the actors** | `submitted_by_user_id`, `submitted_by_contact_id`, `submitter_role_at_submission`, `decided_by` | ids only; the display name is joined at read time. |
| **Free-text operational** | `decision_reason`, `decision_note` (staff) | The rejection reason is shown to the member (FR-020); the note is staff-only. Both bounded. |
| **Lifecycle state** | `state`, `scope`, `outcome` per field, `submitted_at`, `decided_at`, `withdrawn_at`, `withdrawn_reason`, `replaced_by_request_id`, `staff_notified_at`, `outcome_acknowledged_at` | Non-identifying. |
| **Audit** | `audit_log` events `member_change_request_{submitted,decided,withdrawn,rate_limited}`, `member_change_approval_setting_changed` | Payloads carry **ids, field KEYS and outcomes only** — never a value, a reason text or an email (`contracts/notifications-and-audit.md`); `actor_role` is the session role, never a literal. |
| **Notification context** | `notifications_outbox.context_data` | ids only (tenant, request, member, submitter, reviewer, field keys); the dispatcher re-reads the request under the tenant transaction at send time (research § V3). |

**No special categories (Art. 9 / PDPA §26)** — the Group B field set contains none. No
automated decision (Art. 22): every outcome is a staff decision.

### Purpose of processing

1. **Reviewing member-proposed changes before they apply** — keeping the member register
   accurate and the tax-document buyer block (company name, billing address — the fields flagged
   `affects_tax_documents`) under staff control (spec FR-001, FR-019, FR-022; SC-012: no issued tax document changes as a result of an
   approval).
2. **Keeping an accountable history** of who proposed what, who decided it and why (FR-026,
   FR-027; US4).
3. **Notifying** the reviewers of a submission and the submitter of the outcome (FR-011, FR-020).

### Lawful basis (spec FR-040)

- **Performance of the membership contract** — GDPR Art. 6(1)(b) / PDPA §24(3): the member is
  entitled to keep its register entry current and the chamber is obliged to maintain it.
- **Legitimate interest of the chamber in an accurate member register and a reviewable change
  history** — GDPR Art. 6(1)(f) / PDPA §24(5): balancing — the data is the member's own
  register data that the member itself proposes; the review adds a staff decision and a
  bounded reason; the person sees the outcome and the reason and can withdraw a pending
  proposal at any time (US5); no profiling, no automated decision.
- **Transparency** — the submission form carries the Art. 13 / PDPA §23 notice with a link to
  the chamber's privacy policy (`TENANT_PRIVACY_POLICY_URL`, FR-010).

### Recipients of personal data

- **Chamber reviewers** (`admin`, `super_admin`) — the queue `/admin/change-requests`, the
  review page, the member-record section; the staff notification email.
- **Managers / marketing users** — read-only (`members.read`): the queue and the history, the
  dashboard count and the nav badge (count + oldest age only), never the decision controls.
- **The submitting person** — their own request history on `/portal/change-requests`
  (own-request scope: the person's own requests plus company-level ones, FR-029/FR-030), the
  pending / decision banners, the outcome email.
- **Resend Inc. (processor)** — receives the two transactional emails.
- **Chamber DPO + legal counsel** — for compliance review.

### Cross-border data transfers

Same as F3 — **Singapore** (Vercel `sin1` / Neon `ap-southeast-1` / Upstash SG): Thailand →
Singapore under **PDPA §28**; Swedish / EU contacts under **GDPR SCCs** with Vercel, Neon and
Upstash; Resend under its DPA + SCCs. The documented F1 hosting deviation applies.

### Retention periods

| Resource | Retention | Authority |
|---|---|---|
| `member_change_requests` + `member_change_request_fields` | **For the life of the member record** — the history is the accountability record (FR-026/027). On **member erasure (COMP-1)** the erasure scrub replaces every value, reason and note with the `[erased]` sentinel, closes pending rows as `withdrawn / erasure` and cancels (deletes) the queued outbox rows — the row skeleton (ids, states, timestamps) stays as the erasure evidence (FR-030; `change-requests-erasure-scrub.test.ts`). | Contract + legitimate interest; COMP-1 record |
| `notifications_outbox` rows of the two F114 types | **COMP-1 outbox retention** — a SENT `member_change_request_decided_member` row keeps the subject's address frozen at enqueue under the existing outbox purge cron (`/api/cron/outbox-purge`); pending rows for an erased member are deleted by the scrub | COMP-1 record |
| `audit_log` rows (five F114 events) | **5 years** | Constitution Principle VIII; `audit_log.retention_years DEFAULT 5` |
| Upstash attempt buckets / idempotency records | **600 s / the idempotency window** (ids only) | Operational |

### Technical + organisational measures (TOMs)

- **Two-layer tenant isolation (NON-NEGOTIABLE)** — both tables carry `ENABLE` + `FORCE ROW
  LEVEL SECURITY` with the `tenant_id = current_setting('app.current_tenant')` policy (0300);
  every read / write runs under `runInTenant`; the live two-tenant test
  (`change-requests-tenant-isolation.test.ts`) covers reads, decisions **and the tenant-setting
  write**; a cross-tenant probe by id is refused and audited (`member_cross_tenant_probe`).
- **Least privilege** — seeing needs `members.read`, deciding and flipping the switch need
  `members.write`; the switch itself is audited `{ previous, next, actor_role }`.
- **Data minimisation in the side channels** — audit payloads, outbox context, logs, OTel spans
  (`members.change_request.*`) and metric labels carry ids / field keys / outcomes only; no
  proposed value, reason, email or user id reaches a log line or a span attribute
  (`docs/observability.md` § 27.5; the span test feeds a secret reason and asserts its absence).
- **Integrity of decisions** — decide is one transaction (apply + audit + email row) with a
  `FOR UPDATE` lock; "first committed transition wins" (FR-017); approved values pass the same
  validation as a staff edit; issued tax documents are never rewritten (SC-012).
- **Abuse limits** — one pending request per submitting person (partial unique index); the
  durable 10-per-24 h cap counted from the request table (holds with Redis down); per-actor
  attempt buckets on the by-id routes; `Idempotency-Key` on submit; every state-changing route
  refused under `READ_ONLY_MODE` (FR-036); no Server Actions (FR-038, guarded by an
  architecture test).
- **Availability of the review** — the queue and the dashboard count the pending work; the
  `members_change_request_oldest_age_seconds` gauge pages at 14 days so no proposal ages past
  half of the one-month data-subject-request clock (FR-037; `docs/observability.md` § 27.3).
- **Two rollback layers without a code change** — the tenant switch (seconds; pending rows stay
  decidable, FR-032) and the platform flag (routes 404, rows retained; FR-039).

### Data subject rights — exercise procedures

| Right (GDPR / PDPA) | Procedure |
|---|---|
| **Access (Art. 15 / §30)** | The F9 GDPR archive gains `change-requests.json` — **scoped to the requester** (the person's own requests plus company-level ones, FR-029) — for both the member self-service and the staff on-behalf export; the person also sees the same history on `/portal/change-requests`. |
| **Rectification (Art. 16 / §31)** | **This activity IS the rectification path** for Group B fields while the switch is on: the person proposes, staff decide field by field, a rejection carries a reason and the person may resubmit (US3). Group A (the contact's email-language preference) and the email-change flow stay immediate (FR-004). |
| **Erasure (Art. 17 / §33)** | The COMP-1 member-erasure flow runs the change-request scrub inside its atomic transaction (FR-030): values / reasons / notes → `[erased]`, pending → `withdrawn / erasure` with one audit row each, queued outbox rows deleted; see `docs/runbooks/member-erasure.md`. |
| **Restrict (Art. 18 / §34)** | Withdrawing a pending request (US5); the chamber can stop the activity for everyone with the tenant switch (FR-031/032). |
| **Portability (Art. 20)** | The same `change-requests.json` in the portable ZIP. |
| **Object (Art. 21 / §32)** | Not applicable — no marketing, no profiling; the person controls whether to submit at all. |
| **No automated decision (Art. 22)** | Every outcome is a staff decision with a recorded actor; the system applies nothing on its own. |

### DPIA

Not triggered under the `dpia-template.md` criteria: no special-category data, no large-scale
or systematic monitoring, no automated decision, no new processor, no new transfer — the
activity re-routes an existing self-service edit through a human review and keeps a history.
Recorded here for the annual review.

### DPO contact

Same as F7.

### Update history

| Date | Change | Author |
|---|---|---|
| 2026-09-16 | Record authored for F114 before the SweCham tenant switch (spec FR-040 precondition); cross-refs to the cutover record `specs/114-member-change-approval/reviews/cutover.md` | F114 cutover (T114) |

---

## F119 — E-Blast Writing Tool, PR-1: inline images, image storage tier, test copy + brand postal address (amendment to F7)

**Status**: **UNFLAGGED — live on merge.** PR-1 of branch `119-eblast-approval-workflow`
(migration `0304`). The member-approval round is gated by
`FEATURE_EBLAST_MEMBER_APPROVAL`, but the **writing-tool upgrade (US3) and the screen
fixes (US6) are deliberately NOT behind it** (spec § Feature flag / kill-switch) — there
is no flag to hold this processing back, so this record is authored for the **merge
date**, not for a later cutover. Setting an env var is itself a production deploy; a
record that waits for the flag would be a record that was false the day the processing
started.
**Scope**: amends the **F7 — Email Broadcast (E-Blast)** record above with exactly the
four items PR-1 introduces — (a) the `broadcast_images` table, (b) the **Vercel Blob
`sin1`** storage tier for the image bytes, (c) the E-Blast **test copy**, and (d) the
**chamber postal address** rendered in every E-Blast footer. Nothing here changes the F7
recipient-side lawful basis, the audience model, the suppression list or any
cross-border path. Authority: `specs/119-eblast-approval-workflow/spec.md` § Personal
data, `data-model.md` §§ 4 + 6, `drizzle/migrations/0304_eblast_images_and_brand.sql`.

### New processing activities

| Activity | Lawful basis | Retention | Recipients | TOMs |
|---|---|---|---|---|
| **Inline image upload + storage** — one `broadcast_images` row per upload plus the image bytes in Vercel Blob (`upload-inline-image.ts`) | **Contract** — GDPR Art. 6(1)(b) / PDPA §24 ¶2: the annual E-Blast quota is a contractually promised membership benefit and an illustrated E-Blast is how that benefit is delivered. Not consent, and not the recipient-side legitimate interest that governs who is sent to | **Follows the parent E-Blast**; blobs are deleted by the daily sweep once nothing references them — the sweep is bounded at **200 rows per arm per tick**, so a backlog clears over successive daily ticks, not within a flat 24 h; rows are stamped on draft discard, draft prune, member erasure, rejection and withdrawal (F119 PR-2, T081 — `reject-broadcast.ts`, `cancel-broadcast.ts`), and the retention sweep's deletion of the parent E-Blast (0310, `retention_expired`) — note that **draft discard is API-only today** (`DELETE /api/broadcasts/draft/[id]`; the portal has no Discard button, ROUND-3 #13) — § F119 PR-2 below | Vercel Blob (`sin1`) + Neon; and — because the image is embedded in the sent email — **every recipient's mail client, which fetches the blob URL unauthenticated** | RLS + FORCE on `broadcast_images` with the canonical 0064 policy; upload is gated per surface — a **member** uploads only to a draft they own (`requireMemberContext` + the ownership check; another member's row → 404 + `broadcast_cross_member_probe`), **staff** need `broadcasts.write` (marketing / admin / super_admin — **never** `manager`); 5 MB cap + 4-MIME allowlist; **ClamAV fail-closed before any byte reaches storage** (rejected uploads are never persisted); **EXIF / GPS / XMP / IPTC / ICC stripped by a server-side `sharp` re-encode, with the SHA-256 and the stored `byte_size` both computed on the re-encoded bytes**; content-addressed key; per-actor write bucket; `broadcast_image_uploaded` audited in the SAME tenant tx as the row (ids, hash, size, MIME — **never the blob URL**) |
| **Image reclamation (the daily sweep)** — a retention-management activity in its own right, recorded as such for the same reason as the F4 redaction cron (`reclaim-orphaned-images.ts`, `/api/cron/broadcasts/prune-expired-drafts`, 04:30 UTC) | **GDPR Art. 5(1)(e)** storage limitation + **Art. 17** — the mechanism that makes "not reachable" mean "gone" | Runs daily; a marked row's bytes are deleted on the first tick where **no live row of either `owner_kind` shares the `content_hash`** (the last-reference rule) | Vercel Blob only | One transaction per row so one bad blob never blocks the batch; a delete that throws leaves the row for the next tick and audits nothing (a row is never removed twice), and since F7-1 is counted (`rowsFailed` in the tick body, logged at `error`) and metered (`broadcasts_image_sweep_row_failed_total{tenant}`, alert on two consecutive daily ticks) so a persistent fault cannot read as a clean tick; `broadcast_image_removed { blob_deleted, blob_disposition, reason, actor_role: 'system' }` in the same tx; an **orphan arm** (`listOrphaned` — live rows anti-joined against `broadcasts` and `broadcast_templates`) so a future hard-delete path that forgets to stamp cannot strand bytes; and, before any byte is deleted, a tenant-scoped `isBlobReferencedByContent` EXISTS over `broadcasts.body_html` / `body_source` and the templates' body **keeps** a blob that live content still points at — and, since ROUND-2 S-3, keeps the ROW too: it is un-stamped back into the live set rather than removed, because a removed row is reachable by nothing afterwards (no marked arm, no orphan arm, no erasure stamp) while the bytes go on being served. Nothing was removed, so **no `broadcast_image_removed` row is written** and there is no `sweep_referenced` reason; the durable signal is `broadcasts_image_sweep_retained_total{tenant}` plus the `broadcasts.image_sweep.retained_still_referenced` log line |
| **E-Blast test copy** — a single verification send to the requesting actor's own inbox (`send-test-copy.ts`) | **Contract** — Art. 6(1)(b) / PDPA §24 ¶2: verifying the rendering of the benefit before it is delivered. No new lawful basis is needed because no new data subject is processed | No durable copy of the message is stored (no outbox row, no version); the `broadcast_test_copy_sent` audit row **5 years**; Resend's own send log at the provider's default 90 days | **The requesting actor only.** The audience is never a recipient; no member or contact address is read for a test copy | Recipient resolved **server-side from the session** — a body-supplied address never reaches the use case; localised `[Test]` subject prefix held in code, not in the message JSON, so a missing i18n key can never send an unmarked test; the identical sanitiser + design-block rules as a real send; 10 per user per hour; the audit payload carries a **`recipient_hash`**, never the address |
| **Chamber brand settings** — one primary colour + the chamber postal address per tenant (`set-brand-settings.ts`, `tenant_broadcast_settings.brand_*`) | **Legitimate interest** — Art. 6(1)(f) / PDPA §24(5): identifying the sender of a mass email to its recipients. See § Chamber postal address below: the address itself is **organisational data, not personal data** | Life of the tenant's settings row; the `broadcast_brand_settings_changed` audit row **5 years** | The chamber's own staff (the Brand page) and, for the address and colour, **every recipient of every E-Blast** | Write needs the existing E-Blast settings permission; the write and its audit share one tenant tx (a failed emit rolls the write back); the WCAG AA 4.5:1 contrast refusal is Application + Domain; **the logo is never written here** — it is READ from `tenant_invoice_settings.logo_blob_key`, which stays `settings.invoicing` (super-admin only) |

> **Merge gate — VERIFIED 2026-09-22.** This record was authored while two of the controls
> it states were still in flight, and it carried a gate saying so. **Both have since landed
> and were re-verified against the working tree before this line was written**; the gate is
> kept rather than deleted so a reviewer can see what it required and what closed it.
> **(1) The EXIF/GPS strip** (finding **F2-3**) — `ImageReencoderPort`
> (`application/ports/image-reencoder-port.ts`) implemented by
> `infrastructure/sharp-image-reencoder.ts`, wired **REQUIRED, never optional** in
> `makeUploadInlineImageDeps`; proven against real libvips in
> `tests/unit/broadcasts/infrastructure/sharp-image-reencoder.test.ts` (6 cases green,
> including a JPEG carrying EXIF Copyright/Make and IFD3 GPS whose output has neither an
> EXIF block nor an APP1 `Exif\0\0` marker). **(2) The `deleted_at` stamping** (finding
> **F2-1 / F2-2**) — the shared `markOwnerImagesRemoved` helper called from the draft-discard
> route, the prune use case and, as `markDeletedForMember`, the member-erasure content
> scrub, each **inside the caller's own transaction**; plus the sweep's new orphan arm.
> Green on live Neon in `tests/integration/broadcasts/eblast-image-lifecycle.test.ts`
> (4 cases: upload → discard → sweep; a referenced blob survives; erasure stamps the erased
> member and not a peer; the orphan arm reaps). A RoPA states what the deployed system
> does — this is the line where that was checked, and it now reads as satisfied.

### New data items stored

| Storage | Data category | Subject category | New as of F119 PR-1? |
|---|---|---|---|
| `broadcast_images` (NEW table, migration 0304) | Lifecycle + operational metadata: `owner_kind` ∈ {`broadcast`,`template`}, `owner_id`, `content_hash` (SHA-256 **of the re-encoded bytes**), `blob_url`, `blob_key`, `mime_type`, `byte_size` (post-re-encode), `uploaded_by_user_id`, `created_at`, `deleted_at` | The **uploading user** (`uploaded_by_user_id`) — **the member** (portal compose, `POST /api/broadcasts/inline-image-upload`) or **staff** (`POST /api/admin/broadcasts/[id]/images`); both surfaces exist in PR-1. **The row itself holds no subject PII**; whatever personal data exists is in the image BYTES, which the row only points at | YES (table) |
| Vercel Blob `broadcasts/images/{tenant}/{sha256}.{ext}` (`sin1`) | The image **bytes verbatim** — may depict or name natural persons (event photography, headshots, a scanned page, a signature block) | Any person depicted in or named by an uploaded image | YES (storage tier for this content type) |
| `tenant_broadcast_settings.brand_primary_color`, `brand_postal_address`, `brand_updated_at`, `brand_updated_by_user_id` (migration 0304) | Chamber configuration (colour + postal address ≤ 300 chars) + the **staff actor id** of the last change | Chamber (a legal entity, not a data subject); the staff actor for `brand_updated_by_user_id` | YES (columns) |
| `audit_log` payload `broadcast_test_copy_sent.recipient_hash` | Truncated SHA-256 (16 hex) of the lowercased requester address — **pseudonymous**, and the only representation of that address anywhere in the trail | The staff or member user who asked for the test copy | YES |

### Vercel Blob processor amendment (image bytes)

The F6.1 amendment already widened the **Vercel Inc.** processor scope to Vercel Blob
(error-CSV bytes, 30-day TTL) and F4 stores the tax-document PDFs there. F119 PR-1 adds a
**third content type** to the same processor in the same region (`sin1` Singapore) — the
E-Blast inline images. **No new DPA and no new SCC** are required: this is the existing
F1–F9 Vercel DPA + SCCs, and the PDPA §28 / GDPR-SCC cross-border basis recorded for F7 is
unchanged. No new sub-processor is introduced by PR-1.

**Public-blob design caveat**: as with the F6.1 error CSV, the non-Enterprise Vercel Blob
tier has no private bucket — the image is written with `access:'public'`. Unlike the error
CSV it does **not** even carry a random suffix: `addRandomSuffix:false` with the
content-addressed key `broadcasts/images/{tenant}/{sha256}.{ext}`
(`src/modules/broadcasts/infrastructure/vercel-blob-image-storage.ts`), because re-uploading
the same bytes must be idempotent. The resulting URL is therefore **unauthenticated and
guessable-by-possession**: anyone holding the link — a forwarded E-Blast, a mail-client
cache, a corporate mail gateway, a web-archived newsletter — can fetch the bytes with no
session, and the URL stays live until the sweep deletes it. **This is a design constraint,
not a misconfiguration**: a mail-client user agent cannot present a Bearer token or follow a
server-signed URL, so an image embedded in an email MUST be an unauthenticated GET (the same
rationale as the F4 invoice logo). The control is therefore possession of an unguessable
URL, not authorisation — a DSR answer must say so plainly.

**Transparency to the uploader (PDPA §23 / GDPR Art. 13)**: the member is told this
**before choosing a file**, not afterwards — the compose uploader renders
`portal.broadcasts.compose.imageUpload.publicLinkNotice` (EN + TH + SV) stating that the
image is stored at a public web link, is sent to everyone who receives the E-Blast, and can
be opened by anyone holding the link. A residual the data subject is warned about before
they create it is a different thing from one they discover later.

**EXIF / GPS metadata — stripped before storage (SHIPPED)**: every accepted image is
**re-encoded server-side through `sharp`** before a byte reaches Blob, so an uploaded phone
photo cannot carry the photographer's coordinates, device serial or capture timestamp out to
every recipient of the E-Blast and into a permanently public URL. `sharp` drops EXIF, XMP,
IPTC and ICC on re-encode unless `keepMetadata()` / `withMetadata()` is called, and neither
appears in the adapter; `.rotate()` reads the EXIF orientation tag and **bakes it into the
pixels first**, so stripping the tag cannot leave a member's picture sideways. Same control
and same library as the F4 invoice-logo re-encode (`sharp-image-reencode-adapter.ts`) and
the F9 insights logo (`sharp-logo-adapter.ts`). Three properties matter to this record:
the re-encode sits **after** the ClamAV verdict and **before** the hash, so the stored
`content_hash` and `byte_size` are those of the **stripped** bytes and `storage.put` never
sees the original; GIF and WebP are decoded `{ animated: true }` so a member's animated
banner is not silently frozen by the privacy control; and a declared MIME that does not
match the decoded format is refused **fail-closed** (`decode_failed`), because the declared
type is what the blob key extension and the recipient's mail client act on.

### Residual risk — public-blob tier (F6.1 DPIA risk-row format)

| Risk | Likelihood × Severity | Mitigation | Residual |
|---|---|---|---|
| Vercel Blob `access:'public'` exposes an E-Blast inline image to anyone holding the URL, for the life of the image (non-Enterprise tier limitation; an email client cannot authenticate, so the unauthenticated GET is required by the medium) | M × M | Content-addressed key — guessing one requires a SHA-256 preimage of the tenant's own bytes; EXIF/GPS stripped by the server-side `sharp` re-encode so the bytes disclose no location, device or capture time; 5 MB + 4-MIME allowlist and ClamAV fail-closed **before** any byte is stored; upload gated per surface (own-draft ownership for a member; `broadcasts.write`, never `manager`, for staff); the member is warned **before** choosing a file that the link is public and reaches every recipient (`…imageUpload.publicLinkNotice`, EN/TH/SV); the reference is removed immediately on discard / prune / erasure / rejection / withdrawal (F119 PR-2, T081) / retention expiry of the parent E-Blast (0310) and the bytes deleted by the daily sweep, which reaps at most **200 rows per arm per tick** (marked + orphaned), so a backlog clears over successive daily ticks rather than within any single 24 h window; every upload and removal audited | **M (accepted — same class and same footing as the F6.1 error-CSV blob residual; DPO sign-off recorded here)** |
| Image bytes uploaded **before migration 0304** have no `broadcast_images` row at all — the table is **not backfilled**, by decision — so no lifecycle mechanism reaches them, and the ONLY thing that attributes such a blob to a member is the `body_html` the erasure cascade is about to redact — **or that the 0310 retention sweep is about to delete** with the whole E-Blast row | L × L | Recorded rather than guessed: reconstructing owners from historical HTML **at erasure time** would attribute one member's bytes to another, which is a worse privacy outcome than the exposure it would close. These blobs are therefore **never swept**, and they are equally **protected from deletion** — if the same bytes are re-uploaded and acquire a row, the sweep's `isBlobReferencedByContent` check keeps them while any live E-Blast or template body still points at the URL. **The attribution window closes at redaction**, so the DSR procedure enumerates them from `body_html` as a numbered PRE-cascade step (`docs/runbooks/member-erasure.md` step 2a), records the keys on the ticket and deletes them from the Blob store by hand afterwards — residual (e) in that runbook's step 7. **The retention sweep closes the same window for every pre-0304 E-Blast it deletes**, erasure or not, so the cron runbook (§ F7 retention-sweep, "Pre-0304 image blobs") runs the same enumeration over the rows about to expire before the first one does (~2031). The population is finite and enumerable from the Blob store — the same shape as COMP-1 residual #5 (NULL-`matched_member_id` registrations) | **L (accepted — bounded, pre-0304 only)** |
| A **post-0304** row's owner is hard-deleted by a path that forgets to stamp `deleted_at`, stranding the bytes at a public URL that no code path can reach | L × M | **Closed structurally, not by discipline.** The six known paths stamp inside their own transaction (discard, prune, erasure, rejection and withdrawal — F119 PR-2, `reject-broadcast.ts` / `cancel-broadcast.ts` — and the 0310 retention sweep), and the daily sweep's **orphan arm** anti-joins live rows against `broadcasts` and `broadcast_templates`, so a row whose owner no longer exists is reaped whether or not anyone remembered to stamp it. `broadcast_images.owner_id` carries no FK (two possible parents), which is exactly why the anti-join, rather than a cascade, is the backstop | **L** |

### New audit event types (migration 0304)

| Event type | Severity | Purpose | Retention |
|---|---|---|---|
| `broadcast_image_uploaded` | info | Record of an image byte-write — ids, `content_hash`, `byte_size`, `mime_type`, `owner_kind`/`owner_id`, `actor_role`; **never the blob URL**. Emitted RAW (not best-effort) in the row's own tx: a failed emit rolls the row back | 5y |
| `broadcast_image_removed` | info | Record of a reference removal or a byte deletion — carries `blob_deleted`, a `content_hash`, and (sweep rows only, F7-1) a `blob_disposition` stating what happened to the bytes: `deleted`, `kept_shared_row` (another live row shares the hash) or `reclaimed_by_sibling` (an earlier row of the same tick already deleted them — previously mis-audited as "kept") — and a `reason`: `draft_discarded`, `draft_pruned`, `member_erased`, `rejected`, `withdrawn` and `retention_expired` (the six stamping sites, each emitted in the same transaction as the state change) and `sweep` / `sweep_orphaned` (the two sweep outcomes that actually remove a row). A blob KEPT because live content still embeds it emits **no row at all** (ROUND-2 S-3: nothing was removed, and the image keeps its `broadcast_images` row, un-stamped, so it stays in the live set — re-examined by the orphan arm when its owner is gone, but NOT automatically when its owner survives, as an erased member's redacted broadcast does; see the Erasure row below); the durable signal there is `broadcasts_image_sweep_retained_total{tenant}`. The withdrawal and rejection reasons (`withdrawn`, `rejected`) shipped with **F119 PR-2 (T081)** — § F119 PR-2 below; `retention_expired` with the 0310 retention sweep | 5y |
| `broadcast_test_copy_sent` | info | Record of a verification send — `related_member_id` (deliberately, even for a portal user, so the 0009 `last_activity_at` trigger does NOT fire), `broadcast_id`, `version_id`, `locale`, `actor_role` and `recipient_hash` | 5y |
| `broadcast_brand_settings_changed` | info | Record of a brand change — `{ previous, next, actor_role }`. **The one F119 payload that legitimately carries VALUES**, because a colour and a postal address are chamber configuration, not text a member wrote | 5y |

`f7RetentionFor` returns 5 for every F7 event — PR-1 produces no tax document, so none of
the four is a 10-year event (`audit-port.ts`).

### E-Blast test copy — recipient and audit discipline

- **Tier**: the **transactional** Resend surface (the shared F1/F4 `emailSender`), **never
  the F7 Broadcasts surface** — a test must not enter the marketing suppression list or the
  Broadcasts reputation pool. It is synchronous and non-durable: no `notifications_outbox`
  row, and no `notification_type` enum value was added for it.
- **Recipient = the requesting actor, and only them.** The address is resolved server-side
  from the session in both routes (`POST /api/broadcasts/test-copy` for a portal user,
  `POST /api/admin/broadcasts/test-copy` for staff under `broadcasts.write`); a
  body-supplied address never reaches the use case. **The audience is never a recipient of a
  test copy**, and no member or contact address is read to send one.
- **The audit row carries only a `recipient_hash`** — SHA-256 of the lowercased address,
  truncated to 16 hex. The address itself never enters the audit trail, in line with the
  F119 payload rule that free-text and contact values stay out of `audit_log`.

### Chamber postal address in the E-Blast footer

- Stored as `tenant_broadcast_settings.brand_postal_address` (migration 0304; free text,
  1–300 chars, line breaks allowed). NULL ⇒ the footer shows the chamber name only and the
  Brand page flags the address as missing.
- **It is organisational / brand data, not member PII** — it is the chamber's own address,
  as are the primary colour and the logo. It is nevertheless recorded here as a processing
  record because it is **transmitted to every recipient of every E-Blast**, which is a
  disclosure the record has to name (spec § Personal data requires exactly this).
- The only personal datum among the four brand columns is `brand_updated_by_user_id` (the
  staff actor id), plus the `broadcast_brand_settings_changed` audit.
- Brand chrome — logo, colour, address — is read **live at render time** and is never copied
  into a stored version, so changing the address rewrites nothing already sent: the address
  in a delivered E-Blast is whatever was configured at that send. A brand change therefore
  never voids an approval, and equally never retro-edits a disclosure already made.

### Data subject rights — F119 PR-1 amendments

| Right (GDPR / PDPA) | PR-1 procedure |
|---|---|
| **Access (Art. 15 / §30)** | The F9 GDPR archive (member self-service and staff on-behalf) carries **`broadcast-images.json`** (PR-1 follow-up, research R17): every `broadcast_images` row of every E-Blast the member originated, **live and stamped** (a stamped row is still the record of the upload), newest first, capped at 1,000 with the standard partial-export disclosure. Each entry holds the image id, the broadcast id, the content hash, MIME type, size, upload and deletion times; the **public blob URL only while the image is live** (a stamped image is marked for deletion and its URL is not re-published; the file itself may be kept if an identical image is still used elsewhere — see Erasure); **never the uploader** — the archive names no user. Chamber template images are not the member's and are not included. **Images of a discarded or expired draft are not listed**: discard and the draft prune hard-delete the E-Blast row first, and the export reaches images only through the member's E-Blasts, so in practice a stamped entry is an erasure-stamped one (erasure redacts the E-Blast rather than deleting it). Their removal is still in the archive — `audit-events.json` carries each `broadcast_image_removed` row (it keys `related_member_id`, one of the member-subset arms) — and the file is deleted on the next daily sweep tick. **The access export does not report bytes of the member's image still held by another owner's live row** (same `content_hash`): that disclosure — decision (e) below — is made on the erasure DSR ticket (`docs/runbooks/member-erasure.md` § Verifying step 4), not in the archive. The export category for the E-Blast approval round itself (`broadcast-versions.json`) is recorded in § F119 PR-2 below; it is in every archive from the PR-2 merge. |
| **Rectification (Art. 16 / §31)** | Not applicable to an image or to the brand address (neither is a member-record field). An incorrect image is replaced by editing the E-Blast; the old reference is removed and the bytes are swept under the last-reference rule. |
| **Erasure (Art. 17 / §33)** | The COMP-1 member-erasure cascade reaches the F7 broadcast CONTENT (subject / body → `'[redacted]'`); PR-1 adds the image leg — the `broadcast_images` row is stamped inside the erasure transaction and the bytes are deleted by the next daily sweep, **unless another live row of either `owner_kind` still shares the `content_hash`**, in which case the image is kept by design (an image still referenced elsewhere is not the erased member's alone). The stamp is `imagesRepo.markDeletedForMember(...)` inside the same transaction as the content redaction (`reason: 'member_erased'`), and it reaches **the erased member's rows only** — a peer's images are untouched, pinned by the live-Neon lifecycle test. Pre-0304 images are the documented residual above. **The public blob URL is unauthenticated, so a copy already fetched by a recipient's mail client or gateway is out of reach** — the same shape as COMP-1 residual #2 (already-downloaded export ZIPs), and a DSR answer must say so. **A kept file has two different outcomes, and they leave different evidence.** (1) *Another live row of either `owner_kind` shares the `content_hash`* (`live > 0`): the erased member's row IS removed and audited `broadcast_image_removed { reason: 'sweep', blob_deleted: false, blob_disposition: 'kept_shared_row' }`; the identical bytes stay for that other holder. (2) *No live row, but live content still embeds the URL*: **the row is not merely left behind — it is un-stamped back into the live set (ROUND-2 S-3), and no audit row records that**, because nothing was removed and an audit row saying otherwise would be untrue. The consequence for accountability is explicit: the trail shows `broadcast_image_removed { reason: 'member_erased' }` with no counter-event, while the database shows a live row and the bytes still served. **The state, not the trail, is the evidence** — `docs/runbooks/member-erasure.md` § Verifying step 4 carries the query that enumerates exactly which of the subject's images survived and which live content holds each one, and requires the count (including zero) on the DSR ticket. A DSR answer must disclose a non-zero count, the reason (another data subject's live content or a chamber template embeds the identical file), and how it is reclaimed: **an erasure-retained row is not re-examined automatically** — the sweep's orphan arm selects only rows whose OWNER is gone, and an erasure redacts the member's broadcast rather than deleting it, so the un-stamped row's owner survives; the runbook step surfaces it and it is reclaimed by hand once the holding content goes. The same step also counts the rows stamped but not yet swept (a backlog or a failing row takes later ticks than the next one; `broadcasts_image_sweep_row_failed_total`). **Decision (e), 2026-09-23** (delegated by the maintainer to Claude as a conservative default; the DPO may revise): a file whose identical bytes are still held by another owner's live row — outcome (1) above — COUNTS as still-served personal data of the erased member and MUST be disclosed on the DSR ticket with its count (including zero), the same as a retained row; runbook step 4 query (ii) derives it from the cascade's own `broadcast_image_removed` rows (`payload.content_hash`). |
| **Restrict (Art. 18 / §34)** | The F7.1a US2 image kill-switch halts all new uploads tenant-wide (503 at the route); the F7 master switch halts the whole surface. |
| **Portability (Art. 20)** | Unchanged in PR-1 — see Access. |
| **Object (Art. 21 / §32)** | Unchanged — objection is exercised against the SEND (one-click unsubscribe, `marketing_unsubscribes`), not against the image or the footer address. |
| **No automated decision (Art. 22)** | PR-1 makes none: an upload, a sweep, a test copy and a settings write are all actor-initiated or a fixed rule. |

### DPIA

Not triggered under `dpia-template.md`: no special-category data, no large-scale systematic
monitoring, no automated decision, **no new processor and no new cross-border path** — the
image tier is the existing Vercel Blob processor in the existing region, and the test copy
is the existing transactional Resend surface. The public-blob exposure is assessed as a
residual-risk row above rather than as an Art. 35 trigger, on the same footing as F6.1.
Re-assess if images are ever served to a non-recipient audience, if the Blob tier changes,
or if a member-facing upload path widens the population of uploaders beyond the chamber's
own staff and members.

### DPO contact

Same as F7.

### Relationship to T162 (the PR-2 RoPA task)

**T162 adds only the PR-2 columns on top of this amendment — it does not supersede it.**
PR-2 brings the member-approval round itself: the stored versions, the member decisions,
the free-text notes and rejection reasons, the five hand-off notification types and their
**staff recipients**, the `broadcast-versions.json` export category, and the erasure reach
across those new rows. Those are additions to the record below this line, not a rewrite of
it. The four items recorded here — `broadcast_images`, the Vercel Blob image tier and its
public-URL residual, the test copy, and the chamber postal address — belong to **PR-1**,
which ships **unflagged and live on merge**, and they must therefore stay true and in force
from the PR-1 merge date onwards, independently of whether
`FEATURE_EBLAST_MEMBER_APPROVAL` is ever set. A future reader who finds only T162's PR-2
text and concludes that the image and brand processing began with the flag flip would be
reading the record wrongly.

### Update history

| Date | Change | Author |
|---|---|---|
| 2026-09-23 | F119 PR-1 fix batch F7-1: the sweep's `broadcast_image_removed` gains `blob_disposition` (`deleted` / `kept_shared_row` / `reclaimed_by_sibling`) after a row whose bytes an earlier row of the same tick had deleted was audited "blob kept"; failed sweep rows are counted and metered; the Erasure row now separates the shared-row outcome (row removed, audited) from the retained outcome (row un-stamped, not audited), corrects "reclamation follows the first daily tick after that content goes" (an erasure-retained row is not re-examined automatically), and records **decision (e)** — identical bytes still held by another owner's live row are disclosed on the DSR ticket. The DPO option-A decision (2026-09-22) is unchanged | F119 PR-1 review, fix batch F7-1 |
| 2026-09-22 | **Reconciled against the landed code the same day**: the two merge-gate controls (EXIF/GPS `sharp` re-encode, finding F2-3; the `deleted_at` stamping on discard / prune / erasure, findings F2-1 / F2-2) are now recorded as **shipped and verified** rather than pending, with the sweep's orphan arm and its live-content reference check, the member-facing public-link notice (PDPA §23 / Art. 13), and the corrected fact that the **member** uploads from PR-1 as well as staff. The residual-risk rows were re-cut accordingly | F119 PR-1 privacy review (round 2) |
| 2026-09-22 | F119 **PR-1** amendment authored to close privacy finding **F2-4** (RoPA gap on an unflagged PR): the `broadcast_images` table and its lifecycle, the Vercel Blob `sin1` image tier with the public-URL residual-risk row and the EXIF-strip control, the transactional test copy (requester-only recipient, `recipient_hash` in the audit), and the chamber postal address transmitted in every E-Blast footer. Authored **before merge** because PR-1 carries no feature flag. T162 (PR-2) extends this record; it does not replace it | F119 PR-1 privacy review |

---

## F119 PR-2 — E-Blast member-approval round: versions, decisions, hand-off emails (amendment to F7 and to F119 PR-1)

**Status**: authored 2026-09-24 against branch `119-eblast-approval-workflow` at `1b06c1cd1`;
**verified unchanged at `42f540316`** (2026-09-24, T166 privacy review), pending the T166 fix
commits — none of which changes the processing recorded here except security finding S-H1, which
adds a read-only standing check of the member at schedule confirmation (a read of existing
membership state; no new datum, recipient or retention). Authored **before PR-2 merges**
(migration `0308`). This record is the **precondition of the flag flip**
(`quickstart.md` § 3.2 step 4): `FEATURE_EBLAST_MEMBER_APPROVAL` is not set until it lands.
**Scope**: exactly what spec § Personal data names for the approval round — the new purpose, the
new fields by name, the staff recipients of the hand-off emails, the chamber postal address in
every footer, the export category `broadcast-versions.json`, the erasure reach including the
notifications, and the retention of a sent outbox row. It **adds to** the F119 PR-1 record above
and to the F7 record; it replaces neither. Authority: `specs/119-eblast-approval-workflow/spec.md`
§ Personal data, `data-model.md` §§ 1–3, 7.3, `contracts/dashboard-and-notifications.md` §§ 2–3,
`drizzle/migrations/0308_eblast_member_approval.sql`.

**What is live on the PR-2 merge, before the flag** — recorded because the flag does not hold it
back:
- every submit (member or proxy) writes one `eblast_submitted_marketing` outbox row per marketing
  recipient — a **staff address** plus ids — and a member's whole-E-Blast withdrawal writes
  `eblast_member_decided_marketing` rows; the drainer does **not** send them while the flag is off,
  so they are stored, not delivered, until the flip;
- the member archive carries `broadcast-versions.json` (empty until a round exists);
- the erasure cascade's reach below;
- reject and cancel stamp the E-Blast's images (`broadcast_image_removed { reason: 'rejected' |
  'withdrawn' }`), so the bytes of a rejected or cancelled E-Blast are deleted by the next daily
  sweep — in today's flow as well.

Versions, decisions, notes and reasons come into existence only when marketing **starts a
formatted version**, which the flag gates (the `submitted → in_design` edge).

### New processing activities

| Activity | Lawful basis | Retention | Recipients | TOMs |
|---|---|---|---|---|
| **Review and member sign-off of E-Blast content; accountable version history** — marketing formats a member's E-Blast as numbered versions, sends each to the member, and the member approves, asks for changes or withdraws an approval (`start-formatted-version`, `save-formatted-version`, `send-version-to-member`, `record-member-decision`, `confirm-schedule`) | **Contract** — GDPR Art. 6(1)(b) / PDPA §24(3), the same basis as the F7 sender side: the annual E-Blast quota is a contractually promised benefit, and agreeing its content with the member is how it is delivered. The version history also serves accountability (SC-002: proving which version was sent and who on the member side approved it) | **Follows the parent E-Blast record** (the F7 retention, 5 years — **enforced by the retention-sweep cron, 0310**: when it deletes the E-Blast, its versions and decisions leave with it by ON DELETE CASCADE, the only DELETE their triggers admit); audit rows 5 years. Rows are never deleted while the E-Blast exists — the erasure path redacts them in place | The owning member company's portal users (their own E-Blasts only) and staff holding `broadcasts.read` (admin, super_admin, marketing, manager read-only). Nobody outside the controller | RLS + FORCE on both new tables (the 0064 policy); cross-tenant and cross-member probe tests; a sent version is frozen by a DB trigger (`sent_to_member_at` stamped); decisions are append-only (no update path; a DB trigger refuses UPDATE / DELETE except the redaction GUC and the parent cascade); a member reads only their own company's E-Blasts (another member's id → 404 + `broadcast_cross_member_probe`); the portal never shows a staff name ("the chamber"); **a staff user cannot give the member-side approval** — decided by the session role |
| **Hand-off notifications to staff** — "new E-Blast submitted", "member decided", and the day-23 / day-30 notices (`eblast_submitted_marketing`, `eblast_member_decided_marketing`, `eblast_approval_lifecycle { audience: 'staff' }`) | **Legitimate interest** — GDPR Art. 6(1)(f) / PDPA §24(5): running the chamber's own review workflow, addressed to its own staff at their work address. **Confirmed by the DPO 2026-09-24** (decision 4 below). **Balancing test**: *(i) necessity* — without the hand-off notices nobody learns that an E-Blast is waiting on them, the queue stalls, and the member's 30-day approval clock (FR-022) runs out on a request that was never picked up; polling the queue is the burden this feature exists to remove; *(ii) reasonable expectation* — a work email to a staff user about a task that is part of their own duties, on the chamber's transactional surface, is what an employee of the chamber expects; it is not marketing and it is not about the staff user as a person; *(iii) minimisation* — the email carries exactly the four facts FR-021b allows (the E-Blast subject, the member company name, the new stage, a link), never the body, the member's reason or note, marketing's note or the send times; the outbox row holds ids only, and the recipient is re-checked against the live roster at send time, so a user who has left or lost the role is not emailed. The staff member's interests do not override: the processing is confined to their work address and their role, and the roster residual (§ Residual risk below) concerns a *second tenant's* hand-off subjects, not the staff recipient's own data | Outbox row: pending until sent; a `sent` or `permanently_failed` row **90 days** (`outbox-purge`) | **The staff recipients** (below) and **Resend** (transactional processor) | `context_data` carries **ids and discriminators only**; the email is rendered at send time and carries **only** the E-Blast subject, the member company name, the new stage and a link — never the body, the member's reason or note, marketing's note or the send times (FR-021b); the recipient is re-checked against the live roster at send time |
| **Hand-off notifications to the member** — "version ready for your approval", "send time confirmed", the day-3 / day-7 reminders and the day-23 / day-30 notices (`eblast_version_sent_member`, `eblast_schedule_confirmed_member`, `eblast_approval_lifecycle { audience: 'member' }`) | **Contract** — GDPR Art. 6(1)(b) / PDPA §24(3), as the first row | As above | **The member's approval contact** — the contact linked to the portal login that submitted the E-Blast, else the member's primary contact, else the lowest-id active portal contact — in that contact's `preferred_language`; and **Resend** | Rendered at send time from ids, to the contact's **current** address; the member email names "the chamber", never a staff user; it carries the E-Blast subject, **marketing's note to the member** (free text ≤ 1,000), the proposed and confirmed send times, the timeline, and a link |
| **Approval lifecycle** — the daily reminder / warning / expiry tick (`expireStaleMemberApprovals`, Block 3 of `/api/cron/broadcasts/prune-expired-drafts`) | **Contract** — GDPR Art. 6(1)(b) / PDPA §24(3); FR-022 / FR-022a; a fixed rule, **not** an automated decision: it never approves, and the only outcome it can produce is closure (`expired_no_member_response`) after 30 days without a response, which the member is told of when the version is sent | Audit rows 5 years | As the two notification rows | System actor (`actor_role: 'system'`), `related_member_id` only |

### New data items stored

| Storage | Fields (by name) | Data category | Subject category |
|---|---|---|---|
| `broadcast_versions` (NEW, migration 0308) — the **versions** | `tenant_id`, `id`, `broadcast_id`, `version_no` (0 = the member's original, materialised when the first formatted version starts), `subject`, `body_html`, `body_source`, **`note_to_member`** (marketing's **note**, ≤ 1,000 chars), `authored_by_user_id`, `authored_by_role`, `sent_to_member_at`, `created_at`, `updated_at` | E-Blast content (may name or depict natural persons, as F7 content may), a free-text note, and the author's user id | The member's authors; the staff author (user id + role); any person named in the content or note |
| `broadcast_member_decisions` (NEW, migration 0308) — the **decisions** and the **reasons** | `tenant_id`, `id`, `broadcast_id`, `version_id`, `round`, `decision` ∈ {`approved`, `changes_requested`, `approval_withdrawn`}, **`reason`** (the member's **reason** for a change request or a withdrawal, 1–2,000 chars; the optional **approval note**, ≤ 500, in the same column), `decided_by_user_id`, `decided_by_contact_id`, `decided_at` | Who on the member side decided, when, and their free text | The deciding member contact / portal user; any person named in the reason |
| `broadcasts` (existing) — six new columns (0308) | `proposed_send_at`, `stage_entered_at`, `current_round`, `approved_version_id`, `member_reminder_stage`, `member_expiry_notified_at` | Workflow metadata; no new personal datum beyond the parent record | — |
| `broadcast_images` (PR-1 table) — **uploaded images** | unchanged columns; PR-2 adds the **staff upload onto an E-Blast being formatted** (`POST /api/admin/broadcasts/[id]/images` now also accepts `in_design`) | as the PR-1 record | as the PR-1 record — the uploading staff user; persons depicted |
| `notifications_outbox` — five new `notification_type` values | `to_email` (the recipient's address **frozen at enqueue**), `locale`, `context_data` (ids and discriminators only — `broadcastId`, `versionId`, `round`, `decision`, `kind`, `audience`, `recipientUserId`) | A staff or member contact address | The staff recipients; the member's approval contact |
| `audit_log` — ten new event types (0308) | `broadcast_version_started`, `broadcast_version_sent_to_member`, `broadcast_member_approved`, `broadcast_member_changes_requested`, `broadcast_member_approval_withdrawn`, `broadcast_member_approval_voided`, `broadcast_schedule_confirmed`, `broadcast_approval_reminder_sent`, `broadcast_approval_expiry_warned`, `broadcast_approval_expired` — payloads carry ids, rounds, `note_length` / `reason_length`, send times and `differs`; **never** the subject, body, note or reason text | Accountability record | The actor (member portal user, staff, or system) |

### Recipients — the staff recipients of the hand-off emails

The roster is computed at enqueue and **re-checked at send time**
(`src/lib/broadcast-marketing-deps.ts`): every **ACTIVE** user whose role the permission
evaluator grants `broadcasts.write`, **minus the admin tiers** (`admin`, `super_admin`) — today
that is the **`marketing`-role users**. When no such user is active, the **fallback** is every
active `broadcasts.write` holder — `admin`, `super_admin` and `marketing` — i.e. the **admins**
(FR-021a says "the tenant's admins"). `manager` and every other staff role are never emailed for a
hand-off. An empty roster notifies nobody and increments
`broadcasts_no_marketing_recipient_total`, which pages. `users` has no locale column, so staff
emails render in the platform default language.

**The roster is a platform-wide read, not a tenant-scoped one.** `users` has no `tenant_id` and no
RLS (F1's deliberate exception; staff accounts are cross-tenant by design,
`docs/saas-architecture.md` § 4), and `listActiveUsersByRole`
(`src/modules/auth/infrastructure/db/active-users-by-role-repo.ts`) reads it on the pool-global
`db`, filtered by status and role only. "The tenant's marketing users" therefore means **every
active marketing (or fallback admin) user on the deployment**. Under single-tenant deployment
(MTA+STD) the two sets are identical; the residual row below records what changes on the second
tenant. `specs/119-eblast-approval-workflow/research.md` § R15 records the design choice, and
F114's reviewer emails use the same read (`specs/114-member-change-approval/spec.md` § Assumptions
— "of the tenant is vacuous under single-tenant deployment … becomes `user_tenants`-scoped at
F10").

### Residual risk — cross-tenant staff roster (F6.1 DPIA risk-row format)

| Risk | Likelihood × Severity | Mitigation | Residual |
|---|---|---|---|
| **The hand-off roster is not tenant-scoped.** `listActiveUsersByRole` reads the cross-tenant `users` table on the global `db` (no `tenant_id`, no RLS), so with a **second live tenant** sharing this database, tenant A's `eblast_submitted_marketing` / `eblast_member_decided_marketing` / staff `eblast_approval_lifecycle` emails would be enqueued to — and delivered to — tenant B's marketing (or fallback admin) users as well, disclosing tenant A's **E-Blast subjects and member company names** (the FR-021b fields) to another controller's staff. The send-time re-check reads the same unscoped roster, so it does not catch this | **Today: nil** — measured, not assumed: prod holds exactly **one** tenant (`swecham`; the same measurement residual 8a records), so the platform-wide roster and the tenant's roster are the same set. **On tenant #2: M × M** | FR-021b minimisation (four facts, never body / reason / note); ids-only `context_data`; the roster is re-checked live at send; the transactional Resend surface (not marketing); `broadcasts_no_marketing_recipient_total` pages on an empty roster. None of these scopes the recipient set to the tenant — the mitigation that closes it is F10's `user_tenants` join (or a per-tenant role grant), which does not exist yet | **Accepted under single-tenant deployment (MTA+STD) only. OPEN — owner: solo maintainer (Jirawatpyk). Opened 2026-09-24 (T166 privacy review, condition C-1). Revisit condition: the second live tenant is onboarded, or F10 `user_tenants` lands — whichever comes first; onboarding a second tenant onto this database with this read unchanged is a Principle I breach, not a residual.** "Correct because we only have one tenant" is the class of thing that breaks silently on tenant #2 (residual 8a's wording, same footing); the F114 reviewer directory carries the same read and closes on the same event |

### Chamber postal address in every footer

Unchanged from the F119 PR-1 record above (§ Chamber postal address in the E-Blast footer): the
address is organisational data, stored in `tenant_broadcast_settings.brand_postal_address`, read
**live** at render time and printed in the footer of **every** E-Blast — and, with PR-2, in the
preview and the compare view the member signs off on. A brand change never voids an approval.

### Retention of the outbox rows

A **pending** `eblast_*` row lives until the drainer sends it — with the flag off, indefinitely
(held, not delivered), keeping a staff or member address in `to_email` for as long as it waits.
A flag-off that is a **retirement** rather than a pause therefore carries a purge step
(`specs/119-eblast-approval-workflow/quickstart.md` § 3.5 row 1), repeated while the flag stays
off because every submit keeps enqueuing. A **sent** (or `permanently_failed`) row is kept **90 days** by the existing
`outbox-purge` job and then deleted; for those 90 days it **keeps the recipient's address frozen at
enqueue** in `to_email`, while holding no content (`context_data` is ids only; the email was
rendered at send time and is not stored). The same rule already applies to every other outbox
type; it is recorded here because the member-addressed rows carry a member contact's address.

### Data subject rights — F119 PR-2 amendments

| Right (GDPR / PDPA) | PR-2 procedure |
|---|---|
| **Access (Art. 15 / §30)** | The F9 member archive gains **`broadcast-versions.json`** (T083, research R17): for every E-Blast the member originated, the **versions the member was shown** (oldest first) — `versionId`, `versionNo`, `authoredBy` (`member` \| `organisation`, never a staff id or name), `subject`, `bodyHtml`, `noteToMember`, `sentToMemberAt`, `createdAt` — and the member's **decisions** on them — `decisionId`, `versionId`, `round`, `decision`, `reason`, `decidedAt` (no decider identity). Threads run newest activity first; each list is capped at 1,000 rows (newest kept) with the standard truncation disclosure. An E-Blast approved as submitted has no version rows (its content is in `broadcasts.json`). After an erasure the rows appear with the `[redacted]` sentinels the erasure wrote — the archive shows what is held. **Three of the four DPO decisions below govern this export; all four were ruled 2026-09-24.** The member also sees the same history on `/portal/broadcasts/[id]`. |
| **Rectification (Art. 16 / §31)** | Not applicable to a sent version (it is the record of what was shown) or to a decision. A wrong note or reason is corrected by the next round or a withdrawal; the earlier row stays as history. |
| **Erasure (Art. 17 / §33)** | The COMP-1 cascade (`scrubBroadcastContentForMember`, one transaction with the F7 content redaction) now also: sets **every version's** `subject`, `body_html`, `body_source` — and `note_to_member` where one exists — to `'[redacted]'` for every E-Blast the member originated; sets **every non-NULL decision `reason`** to `'[redacted]'` (a NULL stays NULL — a sentinel would invent a note); and **deletes the member's pending `eblast_*` outbox rows**, including the staff-addressed ones only this leg can find. Rows are **kept**, redacted, so the SC-002 chain (which version was sent, who approved it) survives as ids. The counts land on `broadcast_content_redacted` (`versions_redacted`, `decision_reasons_redacted`, `notifications_cancelled`). In-progress E-Blasts in **any** new stage are cancelled by the existing cascade (the in-progress set now covers all six pre-send statuses). Images: stamped by the PR-1 leg (`member_erased`), bytes deleted **by the daily sweep only** — the next tick, 200 rows per arm per tenant, under the last-reference rule (see the PR-1 Erasure row). **Not reached**: a **sent** or failed outbox row keeps the address frozen at enqueue for up to 90 days (above); `decided_by_user_id` / `decided_by_contact_id` / `authored_by_user_id` stay as ids (the contact and user rows themselves are anonymised by the F3 / F1 cascades); the audit rows keep ids and lengths only; Resend's own send log follows the provider's default. Runbook: `docs/runbooks/member-erasure.md` § E-Blast approval round. |
| **Restrict (Art. 18 / §34)** | `FEATURE_EBLAST_MEMBER_APPROVAL` off stops **new** E-Blasts entering the round and holds every hand-off email at the drainer; rows already in the round stay completable (FR-034). The F7 master switch halts the whole surface. |
| **Portability (Art. 20)** | `broadcast-versions.json` is machine-readable JSON, see Access. |
| **Object (Art. 21 / §32)** | Unchanged — objection is exercised against the SEND. The hand-off emails are service messages about the member's own E-Blast, sent on the transactional Resend surface — not marketing, and not subject to the marketing suppression list. |
| **No automated decision (Art. 22)** | None. The day-30 closure is a fixed, announced rule that ends the request without deciding anything about the person; nothing is ever approved automatically (FR-014). |

### DPO decisions — ruled 2026-09-24 (from commit `1e5c1cf75`, T083 / T082; T166 privacy review)

These were built as conservative defaults and put to the DPO; the T166 privacy review
(2026-09-24) ruled on all four. Each is recorded so a DSR answer states it plainly and so it is
not re-litigated.

1. **The v0 `sentToMemberAt` is reported as `null` in the DSAR.** Version 0 is the member's own
   original. The database stamps it (`sent_to_member_at = submitted_at`) only so the version
   trigger freezes it; nobody "sent" it to the member, so the archive reports `null`.
   **Ruling (a): ACCEPT** — the stamp equals `submitted_at`, which `broadcasts.json` already
   discloses, so nothing is withheld.
2. **The unsent working copy is not in the DSAR.** A version marketing is still editing has not
   been shown to the member; it is the chamber's work in progress. It appears in the archive once
   it is sent. (It is reached by erasure regardless.) **Ruling (b): ACCEPT** — internal
   deliberation, derived from the exported v0, disclosed in the archive README, and reached by
   erasure. Spec § Personal data was amended the same day to say so.
3. **Blob bytes are removed only by the sweep.** The erasure removes the reference in its own
   transaction; the image file itself is deleted by the daily sweep on its next tick (200 rows per
   arm per tenant), and a file whose identical bytes another live row still uses is kept — the PR-1
   decision (e) disclosure applies. There is no immediate delete. **Ruling (c): ACCEPT** — this is
   the PR-1 decision (e) footing, not a new decision.
4. **The lawful basis for the staff hand-off emails** (added by T162, not from `1e5c1cf75`).
   Spec § Personal data names one basis for the approval round — performance of the membership
   contract — and this record applies it to the round and to the member-addressed emails. For the
   emails addressed to the chamber's **own staff** it records **legitimate interest** instead,
   because the staff member is not a party to the membership contract; the data is their work
   address and the E-Blast's subject and company. **Ruling (d): CONFIRMED — legitimate interest**
   (GDPR Art. 6(1)(f) / PDPA §24(5)), not contract, on the condition that the balancing test is
   recorded; it is, in the Lawful basis cell of the staff hand-off row above (necessity,
   reasonable expectation, minimisation).

### DPIA

Not triggered under `dpia-template.md`: no special-category data, no large-scale systematic
monitoring, no automated decision (the expiry is a fixed announced rule), **no new processor and
no new cross-border path** — the emails use the existing transactional Resend surface, the rows the
existing Neon database. Re-assess if the hand-off emails ever carry content, or if the audience of
a version widens beyond the owning member company.

### DPO contact

Same as F7.

### Update history

| Date | Change | Author |
|---|---|---|
| 2026-09-24 | **T166 privacy review conditions closed** (verdict APPROVE WITH CONDITIONS, no blocker). **C-1**: the staff roster is recorded as a platform-wide read of the cross-tenant `users` table, with a residual-risk row (accepted under single-tenant deployment; revisit on the second live tenant or F10 `user_tenants`). **C-2**: the legitimate-interest balancing test (necessity, reasonable expectation, minimisation) is recorded on the staff hand-off row, and the four DPO decisions are recorded as ruled — (a), (b), (c) ACCEPT, (d) legitimate interest CONFIRMED. **C-3**: the record is re-pinned — verified unchanged at `42f540316`, pending the T166 fix commits, which alter no processing here except S-H1's read-only standing check. Also: contract cited as PDPA §24(3) rather than bare §24 (L-6); the flag-off retention of a pending row now points at the retirement purge step (L-2) | F119 PR-2 (T166 privacy review) |
| 2026-09-24 | F119 **PR-2** amendment authored (T162, precondition of the flag): the approval-round purpose; `broadcast_versions` and `broadcast_member_decisions` by field; the staff and member recipients of the five hand-off emails; the outbox retention of a sent row; `broadcast-versions.json`; the erasure reach including pending notifications; the three DPO decisions from `1e5c1cf75` and a fourth — the legitimate-interest basis recorded for the staff hand-off emails. The PR-1 record's "PR-2, T081 — not yet shipped" lines now point here | F119 PR-2 (T162) |
