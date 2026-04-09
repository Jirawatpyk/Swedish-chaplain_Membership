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

## Recommended Feature List (9 features)

Based on the 8 entities in the workbook plus the cross-cutting infrastructure needed.

> **Note on F3**: `members` and `contacts` are two separate entities in the data
> model (1 member : N contacts) but are **one feature** at the spec / UX level —
> contacts have no independent lifecycle and are always edited in the context of
> their parent member. Clean Architecture (Principle III) still applies: Domain
> layer keeps `Member` and `Contact` as distinct aggregates with their own
> repositories and services; only the *feature/spec* is merged to avoid YAGNI
> overhead (Principle X).

| #  | Feature                                   | Depends on | Touches Entities                              | Sensitive? |
|----|-------------------------------------------|------------|-----------------------------------------------|------------|
| F1 | Auth & RBAC                               | —          | (users, roles, sessions)                      | ⚠ Yes      |
| F2 | Membership Types Catalog (read + admin)   | F1         | membership_types                              | No         |
| F3 | **Member & Contact Management** (CRUD + search) | F1, F2 | members, **contacts**                        | ⚠ PII      |
| F4 | Membership Invoicing (MB invoices + PDF)  | F1, F3     | invoices, invoice_items                       | ⚠ Finance  |
| F5 | Online Payment (Stripe/Omise integration) | F1, F4     | payments, invoices                            | 🔒 PCI     |
| F6 | Event Management (CRUD, calendar)         | F1         | events                                        | No         |
| F7 | Event Registration & Ticketing            | F1, F3, F4, F6 | event_registrations, invoices             | ⚠ PII+Finance |
| F8 | Renewal Tracking & Reminders              | F1, F3, F4 | (view over invoices), email                   | ⚠ PII      |
| F9 | Admin Dashboard & Audit Log Viewer        | F1, all    | all read, audit_log                           | ⚠ All PII  |

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

| Order | Feature | `/speckit.specify` branch name | Reviewers |
|-------|---------|-------------------------------|-----------|
| 1     | **F1 — Auth & RBAC** | `001-auth-rbac` | ≥2 (security) |
| 2     | **F2 — Membership Types Catalog** | `002-membership-types` | ≥1 |
| 3     | **F3 — Member & Contact Management** | `003-members-contacts` | ≥2 (PII) |
| 4     | **F4 — Membership Invoicing + PDF** | `004-mb-invoicing` | ≥2 (finance+TH tax) |

**Phase 1 ships when**: an admin can log in, create a member with its contacts,
issue a membership invoice, mark it paid, and download a Thai-tax-compliant PDF.
That is a complete replacement for the Excel workbook's core daily workflow.

**Estimated scope**: **4 specs** (down from 5 after merging F3+F4), each ~1–2 weeks
of work if done sequentially; faster in parallel after F1 is merged.

---

### 🚀 Phase 2 — **Self-service & Automation**

**Goal**: Members can pay themselves online; events and registrations move into the
system; renewal reminders go out automatically.

**Success criteria**:
- Members can renew online without admin intervention
- Events are tracked end-to-end (create → register → invoice → attend)
- Renewal dashboard shows real-time status; reminders fire automatically

| Order | Feature | Branch name | Reviewers |
|-------|---------|-------------|-----------|
| 5     | **F5 — Online Payment** | `005-payment` | **≥2 (PCI + security checklist)** |
| 6     | **F6 — Event Management** | `006-events` | ≥1 |
| 7     | **F7 — Event Registration & Ticketing** | `007-event-registration` | ≥2 (PII+finance) |
| 8     | **F8 — Renewal Tracking & Reminders** | `008-renewal` | ≥2 (PII) |

**Phase 2 ships when**: a member receives a renewal email, clicks a link, pays online
via card/PromptPay, and gets a tax receipt PDF — all without admin involvement.

**⚠ PCI scope reminder**: F6 MUST stay SAQ-A eligible (hosted fields / redirect to
processor). No raw card data touches our servers.

---

### 📊 Phase 3 — **Admin Polish & Visibility**

**Goal**: Give admin staff the dashboards, reports, and oversight tools to run the
chamber efficiently.

**Success criteria**:
- Real-time KPI dashboard (members/invoices/events/revenue)
- Audit log fully queryable
- Data exports for accounting

| Order | Feature | Branch name | Reviewers |
|-------|---------|-------------|-----------|
| 9     | **F9 — Admin Dashboard & Audit Log Viewer** | `009-admin-dashboard` | ≥2 (reads all PII) |

*(Phase 3 may be broken into sub-specs if F9 proves too large: `009a-kpi-dashboard`,
`009b-audit-log`, `009c-export`.)*

**Phase 3 ships when**: the board/treasurer can pull any report they need without
asking a developer.

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
