# Feature Phases Plan — SweCham / TSCC Membership System

> Derived from `docs/database-analysis.md` and aligned with the project Constitution
> at `.specify/memory/constitution.md` (**v1.2.0** as of 2026-04-09). This document
> is the **roadmap** for which feature to run through `/speckit.specify` first,
> second, and so on. All 6 open decisions have been resolved — see
> **Decisions (Resolved)** section below.

---

## ✅ Decisions (Resolved — 2026-04-09)

All six open questions have been answered by the user. These decisions are now
authoritative; subsequent specs must align with them.

### R1 — Repo rename: **APPROVED** (manual follow-up)

`Swedish chaplain_membership` → **`swecham-membership`** (or `swedish-chamber-membership`).

**Action**: Cannot be automated from inside the active working directory (it IS the
working directory). User action required:

1. Close this Claude Code session and any open editor windows in the folder
2. Rename folder in Windows Explorer / `mv` in shell
3. Rename the GitHub remote repo if one exists (`gh repo rename`)
4. Update git remote URL: `git remote set-url origin <new-url>`
5. Reopen Claude Code in the new directory

Tracked in bottom risks table as R6 for visibility.

### R2 — Languages: **SV + EN + TH** (3 locales)

- **EN** = default / fallback (build fails on missing EN string)
- **TH** = mandatory for tax-compliant invoices & receipts (Thai Revenue Department
  requirement); also required for `th-TH` users (Thai admin staff)
- **SV** = required for Swedish member self-service and communication
- Constitution **amended from v1.1.0 → v1.2.0** in this session to reflect this.
- Thai Buddhist calendar (BE) is **display-only**; storage is ISO 8601 UTC Gregorian.

### R3 — Hosting region: **Thailand primary**

- Primary: Thailand region from the chosen cloud provider (nearest APAC if no TH
  region is directly available — with written justification).
- Cross-border transfers of EU data subjects' data (Swedish member contacts) MUST
  rely on a lawful GDPR transfer mechanism (SCCs / adequacy / explicit consent).
- **Both PDPA and GDPR apply** — design for the stricter rule on every field.
- Constitution v1.2.0 updated to reflect Thailand-primary residency.

### R4 — Target users & personas: **Admin staff + Manager + Member self-service**

Three personas, three roles (minimum):

| Role       | Who                              | Core capabilities                                        |
|------------|----------------------------------|----------------------------------------------------------|
| `admin`    | Operations staff                 | Full CRUD on members, contacts, invoices, events, config |
| `manager`  | Senior staff / treasurer / board | **Read-only access to financial reports & dashboards**; cannot edit |
| `member`   | Company primary contacts (self-service) | View/edit own company profile, view invoices, pay online, register for events |

**Implications for F1 (Auth & RBAC)**:
- 3 roles minimum (`admin`, `manager`, `member`); super-admin may be added later
- Two login surfaces: **admin/manager** (staff portal) and **member** (self-service portal)
- Email + password for MVP; OAuth/MFA can come in Phase 2+
- Per Principle IX, auth module requires **≥2 reviewers** at Review Gate

### R5 — Payment processor: **Stripe** (recommended)

**Rationale for Stripe over Omise / 2C2P**:

| Criterion                      | Stripe                     | Omise                          | Winner |
|--------------------------------|----------------------------|--------------------------------|--------|
| THB support                    | ✅ Native                  | ✅ Native                      | Tie    |
| PromptPay QR (Thai requirement)| ✅ Supported (since 2023)  | ✅ Supported                   | Tie    |
| Developer experience           | ⭐ Industry-leading        | Good but smaller community     | Stripe |
| TypeScript SDK + docs          | ⭐ Best-in-class           | OK                             | Stripe |
| SAQ-A compliance (hosted fields)| ✅ Stripe Elements         | ✅ Omise.js                    | Tie    |
| Test environment               | ⭐ Excellent               | Good                           | Stripe |
| Thai RD e-tax invoice direct   | ❌ (we build ourselves)    | ✅ (built-in)                  | Omise  |
| Webhooks & reconciliation      | ⭐ Best-in-class           | Good                           | Stripe |

**Decision**: **Stripe**. The e-tax invoice gap is acceptable because we're already
building server-side PDF invoice generation in F4 (Thai + English), so Stripe's lack
of RD integration doesn't matter — we just need the processor to handle the card
flow. If Thai RD e-tax direct integration later becomes a hard requirement, we can
add Omise as a secondary rail.

**Locked into**:
- Stripe Payment Intents + Stripe Elements (hosted fields) → preserves SAQ-A
- Webhook-driven reconciliation for `invoices.payment_status`
- Stripe test mode for all non-prod environments

### R6 — Excel data migration: **NOT required on day 1**

- No day-1 import tooling needed for F3 (Member & Contact Management)
- Admin staff will re-enter current active members as needed OR continue using
  Excel in parallel until the new system has enough coverage to replace it
- **Implication**: F3 spec should NOT include a bulk-import user story for MVP.
  An optional CSV import can be added in a later phase or as a one-off utility.
- Caveat: we may still want a **one-off migration script** during cutover, but that
  is operational tooling, not a product feature — keep it out of the spec.

---

## 📌 2026-04-11 Strategic Update — SaaS Pivot + Scope Revisions

Between the original plan and today, several discoveries changed the roadmap:

1. **SaaS vision** — platform will serve **multiple chambers**, not just SweCham.
   Multi-tenant-aware architecture from F2 onwards. See
   [`saas-architecture.md`](./saas-architecture.md).
2. **2026 Membership Package PDF** — authoritative tier data. Excel-derived
   analysis was inaccurate. See
   [`membership-benefits-analysis.md`](./membership-benefits-analysis.md).
3. **F6/F7 rescoped** — SweCham uses **EventCreate** (external platform).
   F6 becomes Event Integration (Zapier webhook import), F7 is re-used for
   **Email Broadcast / E-Blast** (missing paid benefit). See
   [`event-integration-analysis.md`](./event-integration-analysis.md) and
   [`email-broadcast-analysis.md`](./email-broadcast-analysis.md).
4. **21 smart features catalogued** — 6 in MVP, 15 in post-MVP roadmap. See
   [`smart-chamber-features.md`](./smart-chamber-features.md).
5. **F1 shipped** via PR #1 — auth + RBAC live. Remaining 9 core + 4 SaaS features.
6. **`docs/database-analysis.md` deleted** — Excel-derived, inaccurate. Analyzer
   script (`.specify/scripts/analyze_excel.py`) preserved as reusable tool.

---

## Recommended Feature List (10 core + 4 SaaS = 14 features)

All F2+ features are **multi-tenant aware, single-tenant deployed** (MTA+STD)
per `saas-architecture.md`. Every row has `tenant_id` defaulting to `'swecham'`.

> **Note on F3**: `members` and `contacts` are two separate entities in the data
> model (1 member : N contacts) but are **one feature** at the spec / UX level —
> contacts have no independent lifecycle and are always edited in the context of
> their parent member. Clean Architecture (Principle III) still applies.
>
> **⚠ F2 → F3 carry-overs** (read before `/speckit.specify` for F3):
> `specs/002-membership-plans/deferred-to-f3.md` lists F2 acceptance scenarios
> that were consciously deferred because they depend on F3-scope entities
> (members table, member invoices, benefit inheritance). Currently tracked:
> **D1 — US3 AS4 Partnership bundle-change warning**. Every F3 spec session
> MUST grep this file and either (a) fold each pending item into the F3 spec
> or (b) explicitly reject it with a rationale added to the "Resolved in F3"
> section of that file. Do not delete the file until every pending row is
> closed.

### Core features (F1-F9)

| #  | Feature                                             | Depends on | Sensitive? |
|----|----------------------------------------------------|------------|------------|
| F1 | **Auth & RBAC** ✅ **SHIPPED via PR #1**            | —          | ⚠ PII      |
| F2 | **Membership Plans Catalog** (per-tenant benefits, 2-layer corporate + partnership) | F1 | No         |
| F3 | **Member & Contact Management** (CRUD, search, turnover/age rules) | F1, F2 | ⚠ PII |
| F4 | **Membership Invoicing + Thai-tax PDF** (pro-rate, registration fee, VAT per tenant) | F1, F3 | ⚠ Finance |
| F5 | **Online Payment** (Stripe + PromptPay, member self-service renewal) | F1, F4 | 🔒 PCI |
| F6 | **🔄 EventCreate Integration** (was Event Management — rescoped: Zapier webhook → attendee import → benefit quota tracking) | F1, F3, F2 | ⚠ PII |
| F7 | **🆕 Email Broadcast / E-Blast** (paid benefit delivery via Resend Broadcasts, quota tracking) | F1, F3, F2 | ⚠ PII |
| F8 | **Renewal Tracking + Smart Reminders** ⏳ REVIEW-READY (Phase 10 closed 2026-05-10; PR pending) (tier-aware, at-risk detection, auto-upgrade suggestions) | F1, F3, F4 | ⚠ PII |
| F9 | **Admin Dashboard + Directory + Timeline + Audit Viewer** (benefit usage, engagement score, smart insights, GDPR export) | F1, all | ⚠ All PII |

### SaaS layer (F10-F13)

| #  | Feature | Depends on | When |
|----|---------|------------|------|
| F10 | **Tenant Onboarding** (self-service signup, provisioning, tenant switcher) | F1-F9 | After MVP validation + first external customer interest |
| F11 | **SaaS Billing** (Stripe Subscriptions for tenants — separate from F5 tenant-to-member billing) | F10 | Alongside F10 |
| F12 | **White-label Branding** (per-tenant logo, colours, custom domain, email templates, SSO) | F10, F11 | After first 3-5 tenants |
| F13 | **Super-Admin Console** (manage all tenants, impersonation, MRR dashboard, GDPR ops) | F10-F12 | When tenant count > 10 |

**Notes on sensitivity markers** (maps to Constitution gates):

- **⚠ PII** → GDPR/PDPA scope, **Principle I**, ≥2 reviewers at Review gate
- **⚠ Finance** → audit trail mandatory, **Principle VIII**
- **🔒 PCI** → **Principle IV** (NON-NEGOTIABLE), tokenization only, ≥2 reviewers,
  SAQ-A scope preserved
- **All F2+ features**: tenant-scoped via Postgres RLS per `saas-architecture.md`

**Branch vs Phase numbering note**: Branch `nnn-name` numbers do NOT always match
F## phase numbers in this plan. Specifically: `003-nav-menu`, `004-page-layout-standard`,
and `006-layout-container-tier2` are **ad-hoc UI-infrastructure features** shipped
outside the F1-F13 business-feature sequence — they unblock future business features
by standardizing navigation, page layout, and content-type-based width containers.
F3 Member shipped on branch `005-members-contacts`. F4 Invoicing shipped on branch
`007-invoices-receipts` (PR #12). **Canonical F5 Online Payment is REVIEW-READY on
branch `009-online-payment`** as of 2026-04-27 (Phase 9 polish complete: 17 audit
event types, 4 new tables, Stripe Elements + PromptPay, SAQ-A preserved, full
observability + 9 alert rules + retention-backfill Review-Gate blocker landed).
Do not confuse the informal label "F5 Layout" (branch 006) with canonical F5
(Online Payment) — the retrospective for branch 006 explicitly flags this ambiguity.

**Notes on sensitivity markers** (maps to Constitution gates):

- **⚠ PII** → GDPR/PDPA scope, **Principle I**, ≥2 reviewers at Review gate.
- **⚠ Finance** → audit trail mandatory, **Principle VIII**.
- **🔒 PCI** → **Principle IV** (NON-NEGOTIABLE), tokenization only, ≥2 reviewers,
  security checklist required, SAQ-A scope must be preserved.

---

## Phase Breakdown

### 🎯 Phase 1 — **MVP (Replace the Excel workbook)**

**Goal**: Admin staff can stop using Excel for day-to-day membership and invoice work.
Manual payment entry is fine at this stage — online payment comes in Phase 2.

**Success criteria**:
- All 131 existing members (+ their 164 contacts) can be migrated or re-entered
- Admin can issue membership invoices (MB type) and mark them paid
- Admin can generate Thai-tax-compliant PDF invoices
- No more Excel for core operations

| Order | Feature | `/speckit.specify` branch name | Status | Reviewers |
|-------|---------|-------------------------------|--------|-----------|
| 1     | **F1 — Auth & RBAC** | `001-auth-rbac` | ✅ Shipped (PR #1) | ≥2 (security) |
| 2     | **F2 — Membership Plans Catalog** | `002-membership-plans` | ✅ Review-ready | ≥1 |
| 3     | **F3 — Member & Contact Management** | `005-members-contacts` | ✅ Review-ready | ≥2 (PII) |
| 4     | **F4 — Invoices & Receipts (Thai tax)** | `007-invoices-receipts` | ✅ Review-ready | ≥2 (finance+TH tax) |

**Phase 1 ships when**: an admin can log in, create a member with its contacts,
issue a membership invoice, mark it paid, and download a Thai-tax-compliant PDF.
That is a complete replacement for the Excel workbook's core daily workflow.

**Estimated scope**: **4 specs** (down from 5 after merging F3+F4), each ~1–2 weeks
of work if done sequentially; faster in parallel after F1 is merged.

---

### 🚀 Phase 2 — **Self-service, Automation & Value Delivery**

**Goal**: Members can pay themselves online, receive E-Blasts they paid for,
renewals auto-track with smart reminders.

**Success criteria**:
- Members can renew online without admin intervention (F5)
- E-Blast benefit actually delivered (F7) — paid benefit obligation fulfilled
- Renewal dashboard shows real-time status with smart reminders (F8 + smart #2 #3)
- EventCreate webhook integration working (F6)

| Order | Feature | Branch name | Reviewers |
|-------|---------|-------------|-----------|
| 5     | **F5 — Online Payment (Stripe + PromptPay)** | `005-payment` | **≥2 (PCI + security checklist)** |
| 6     | **F7 — Email Broadcast / E-Blast** 🆕 | `006-email-broadcast` | ≥2 (PII + email deliverability) |
| 7     | **F8 — Renewal Tracking + Smart Reminders** ⏳ REVIEW-READY | `011-renewal-reminders` (PR pending) | ≥2 (PII) — solo-maintainer 5-stack substitute satisfied (20 review rounds) |
| 8     | **F6 — EventCreate Integration** 🔄 (rescoped) | `008-event-integration` | ≥2 (PII + webhook security) |

**Phase 2 ships when**: a member receives a renewal email, clicks a link, pays
online via PromptPay, gets a tax receipt PDF, and receives their Premium-tier
E-Blasts — all without admin involvement.

**⚠ PCI scope reminder**: F5 MUST stay SAQ-A eligible (Stripe Elements hosted
fields). No raw card data touches our servers.

**Smart features delivered in Phase 2**:
- #2 At-Risk Detection (F8)
- #3 Smart Renewal Reminders (F8)
- #1 Benefit Usage Dashboard backend (F7 contributes the e-blast data)

---

### 📊 Phase 3 — **Admin Polish, Smart Intelligence & Directory**

**Goal**: Give admin staff the smart dashboards, reports, and oversight tools
to run the chamber efficiently. Ship differentiator smart features.

**Success criteria**:
- Benefit Usage Dashboard live for every member (smart #1)
- Timeline view per member (smart #8)
- Engagement Score + Activity Feed (smart #15, #17)
- Partnership Compliance Tracker (smart #18)
- Directory E-Book generator + optional online directory (smart #20)
- GDPR self-service export (smart #21)
- Audit log fully queryable

| Order | Feature | Branch name | Reviewers |
|-------|---------|-------------|-----------|
| 9     | **F9 — Admin Dashboard + Directory + Timeline + Audit** | `009-admin-dashboard` | ≥2 (reads all PII) |

*(Phase 3 may be broken into sub-specs if F9 proves too large: `009a-kpi-dashboard`,
`009b-audit-log`, `009c-directory`, `009d-timeline`.)*

**Phase 3 ships when**: the board/treasurer can pull any report they need
without asking a developer, and members can see their own benefit usage
without contacting admin.

**Smart features delivered in Phase 3**:
- #1 Benefit Usage Dashboard (UI layer)
- #8 Timeline View per Member
- #15 Engagement Score
- #16 Auto Tier Upgrade Suggestions
- #17 Activity Feed / Notifications
- #18 Partnership Compliance Tracker
- #19 Smart Suggestions / Proactive Alerts
- #20 Public Member Directory
- #21 GDPR Self-Service Export

---

### 🌍 Phase 4 — **SaaS Launch** (post-MVP, when external tenant interest confirmed)

**Goal**: Turn the single-tenant system into a multi-tenant SaaS platform that
other chambers can sign up for.

**Success criteria**:
- A second chamber (e.g., JCC Japanese Chamber) can self-serve sign up
- Their data is fully isolated from SweCham (Postgres RLS verified by test)
- They can customise plans, branding, payment processor
- SaaS subscription billing works (Stripe Subscriptions)
- First external customer pays us

| Order | Feature | Branch name | Reviewers |
|-------|---------|-------------|-----------|
| 10    | **F10 — Tenant Onboarding** (signup wizard, provisioning, tenant switcher) | `010-tenant-onboarding` | ≥2 (multi-tenant isolation) |
| 11    | **F11 — SaaS Billing** (Stripe Subscriptions, tier limits, dunning) | `011-saas-billing` | ≥2 (PCI + billing) |
| 12    | **F12 — White-label Branding** (logo, colours, custom domain, email templates) | `012-white-label` | ≥1 |
| 13    | **F13 — Super-Admin Console** (manage tenants, impersonation, MRR) | `013-super-admin` | ≥2 (security — impersonation) |

**Phase 4 ships when**: Chamber-OS can be marketed publicly as a SaaS product
with at least one paying external tenant beyond SweCham.

---

### 🎨 Phase 5 — **Expert UX Enhancements** (optional, post-launch polish)

**Goal**: Ship the remaining 6 Expert UX smart features that elevate the
product from "good" to "best-in-class".

| Feature | Purpose |
|---|---|
| #9 Global Undo / Time Travel | Never lose data to accidental clicks |
| #10 Natural Language Search | "show me all premium members no events 90 days" |
| #11 Keyboard Shortcuts Reference (?) | Discoverability for power features |
| #12 Saved Filters / Segments | Power user productivity |
| #13 CSV / Excel Import | Fast onboarding for new tenants |
| #14 Real-Time Updates (SSE) | Multi-admin collaboration |

These features ship incrementally based on customer feedback and priority.
None are blocking for MVP or initial SaaS launch.

---

### 🎨 Phase 5B — **Design System Completion** (post-`004-page-layout-standard` polish)

Three small on-demand follow-ups that close the remaining ~15% UI-consistency
gap left by `004-page-layout-standard`. None blocking for MVP or any business
feature.

| Feature | Scope | Trigger |
|---|---|---|
| **Motion System** | Animation duration/easing tokens platform-wide, `prefers-reduced-motion` audit + fallbacks | When motion-heavy feature lands (e.g., F9 Dashboard) |
| **Visual System Completion** | Icon size scale, shadow elevation scale, spacing canonical usage | On-demand when new component needs a scale not yet tokenised |
| **Dark Mode Token Completeness** | Every `004-page-layout-standard` token gets explicit `.dark {}` variant | When dark-mode usage data justifies + any degraded visual reported |

---

## Dependency Graph

```
                    F1 (auth/rbac)
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
    F2 (types)      F3 (members      F6 (events)
                     + contacts)         │
          │              │               │
          └──────┬───────┤               │
                 ▼       ▼               │
            F4 (MB invoices) ◄───────────┘
                 │
       ┌─────────┼─────────┐
       ▼         ▼         ▼
  F5 (payment) F7 (event  F8 (renewal
                 regs)       tracking)
                 │            │
                 └─────┬──────┘
                       ▼
                   F9 (dashboard)
```

**Critical path**: F1 → F3 → F4 is the tightest chain. Everything else can go in
parallel once those three are in.

---

## Recommendation — What to Run First

### ✅ Start with `/speckit.specify` for **F1 — Auth & RBAC** (`001-auth-rbac`)

**Why first**:

1. **Every other feature depends on it** — no shortcuts, no stubs. RBAC is required
   by Constitution Principle I for every protected route.
2. **It's the security foundation** — fixing auth later causes rewrites; getting it
   right at the start is cheap.
3. **It's testable independently** — sign-in, sign-out, password reset, and role
   assignment form a complete MVP slice on their own.
4. **Reviewers required: ≥2 (security)** — gets the team used to the security-
   sensitive review flow early.

**Concrete scope for F1** (derived from R4 decision):

- **Three roles**: `admin`, `manager`, `member`
  - `admin`: full CRUD on all modules (once added)
  - `manager`: read-only on financial reports and dashboards; cannot mutate
  - `member`: self-service — view/edit own company profile, view own invoices
- **Two portals**:
  1. **Staff portal** (`/admin`) — `admin` + `manager` sign in here
  2. **Member portal** (`/portal`) — `member` signs in here
- **Auth methods for MVP**: email + password only. OAuth/SSO and MFA are Phase 2+.
- **Password policy**: min 12 chars, breach-check via HaveIBeenPwned k-anonymity API,
  no complexity rules (NIST guidance). Final values decided in **Clarify gate**.
- **Session strategy**: **server-side sessions** (DB-backed, HTTP-only cookies) —
  easier to revoke, simpler audit trail, aligns with Principle VIII. JWT is rejected
  for the MVP (harder to revoke, leaks scope). Justify any deviation in Clarify.
- **PII surfaces**: email address, hashed password, last login time, IP (for audit
  only), role assignment, member_id link (for `member` role).
- **Audit log events** (Principle VIII): sign-in success, sign-in failure, sign-out,
  password reset request, password change, role change, account lock/unlock.

**Explicitly OUT of scope for F1** (YAGNI — Principle X):

- ~~OAuth / SSO / social login~~
- ~~MFA / TOTP / WebAuthn~~
- ~~Impersonation / "sign in as" for support~~
- ~~API tokens / machine-to-machine auth~~
- ~~SCIM / directory sync~~
- ~~Password breach monitoring (background rescans)~~

These can be added in later phases once F1 is stable.

**Open questions for Clarify gate** (NOT decided yet):

- Email delivery provider for password reset (Resend, Postmark, SES, SMTP)?
- Rate-limit strategy for sign-in endpoint (IP-based, account-based, both)?
- Lockout policy: after N failed attempts → lockout for M minutes vs progressive delay?
- Member portal sign-up: invite-only (admin creates member first, sends invite) or
  open self-registration? **Recommendation**: invite-only for MVP — aligns with
  the existing Excel workflow where admin creates the member row.
- Password reset token TTL (15 min? 1 hour?)
- Session TTL (sliding vs absolute)?

---

## How to Proceed

When you're ready, say the word and I will:

1. Run the `before_specify` hook (`/speckit.git.feature`) to create branch `001-auth-rbac`
2. Run `/speckit.specify` with a focused prompt for **F1 — Auth & RBAC**
3. Work through Clarify → Plan → Checklist → Tasks → Analyze → Implement → Verify →
   Review → Release following Constitution v1.1.0's 10-gate workflow
4. Ship F1, then repeat for F2, F3, …

If you want to change the order, split/merge features, or add a feature I missed,
tell me and I'll update this plan first before starting specs.

---

## Risks & Decisions Log (Resolved)

All items below resolved 2026-04-09. See **Decisions (Resolved)** section above for
full rationale. Leaving this table for traceability.

| #  | Risk / Decision                          | Resolution                                          | Status |
|----|------------------------------------------|-----------------------------------------------------|--------|
| R1 | TH language vs SV/EN in Constitution     | SV + EN + TH; Constitution amended to v1.2.0        | ✅ Closed |
| R2 | Payment processor choice                 | Stripe (native PromptPay + best DX, SAQ-A)          | ✅ Closed |
| R3 | Hosting region (EU vs TH)                | Thailand primary; PDPA + GDPR both apply            | ✅ Closed |
| R4 | Self-service vs admin-only               | Both: `admin`, `manager`, `member` roles            | ✅ Closed |
| R5 | Excel data migration strategy            | Not required day 1; re-enter as needed              | ✅ Closed |
| R6 | Repo rename `chaplain` → `chamber`       | Approved; **manual action required from user**     | ⏳ Pending manual |

---

## Post-MVP Observability Backlog

Items below surfaced during F8 Phase 7 (Auto Tier-Upgrade Suggestions) reviews
where the metric counter is the **single signal** today and a Vercel alert
rule + on-call runbook + admin replay tooling is desired but deferred to
post-MVP. Reference these IDs from source-code JSDocs (`POST-MVP-OBS-N`)
instead of vague "future work" prose.

| ID | Surface | Counter / Signal | Deferred Deliverables | Priority |
|----|---------|------------------|------------------------|----------|
| POST-MVP-OBS-7 | F8 manual-plan-change listeners + post-paid tier-upgrade-apply audit | `manualPlanChangeListenerFailed{listener,tenant_id}` + `rescheduleAuditEmitFailed{audit_type}` (R4 IMP-8; no tenant label — emit is fire-and-forget per-event) + `tierUpgradeApplyPostPaidFailed{tenant}` (note: F8 counters use mixed `tenant` and `tenant_id` label keys; verify against `src/lib/metrics.ts` before authoring queries) + `level=fatal` log line w/ `errorId='F8.APPLY_TIER.POST_PAID_AUDIT_EMIT_FAILED'` | (a) Vercel alert rule on each counter (sustained `>0` for 5 min) + alert on `level=fatal` log lines; (b) on-call runbook entry under `docs/runbooks/` describing the diagnostic steps when these counters spike; (c) admin replay tooling (UI button on tier-upgrade detail page that re-runs the apply use-case manually for a given suggestion in `accepted_pending_apply` whose cycle terminated without firing the post-paid hook) | Medium — manual grep on Vercel dashboards is the interim mitigation; counters and structured logs DO fire today |

Add new `POST-MVP-OBS-N` rows here as needed. Source comments should cite
this table (e.g. `POST-MVP-OBS-7 in docs/phases-plan.md`).
