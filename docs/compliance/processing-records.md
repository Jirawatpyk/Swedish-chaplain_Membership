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

