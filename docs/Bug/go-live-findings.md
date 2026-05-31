# Go-Live Audit Findings — Stage 1 (specialist code audit)

**Run**: 2026-05-31 · `go-live-audit` workflow — 199 agents · 18.5M tokens · ~110 min.
**Raw (all 250)**: `docs/Bug/go-live-findings-raw.json`. **Posture**: Launch-minimal.
**Branch**: `015-admin-dashboard`. Every P0/P1 below adversarially verified.

## Stage 2 progress (2026-05-31)

**All 4 P0 fixed + committed** on `015-admin-dashboard`:
- ✅ **S1-P0-2 + S1-P0-3** — Clean-Arch guardrail reinstated (source-scan arch-test) + member-count query moved to infrastructure. `[Spec Kit] fix(arch)` `d1ecaa52`.
- ✅ **S1-P0-1 (+ S1-P1-11)** — raw attendee email redacted from audit payloads (hash / domain-only). `[Spec Kit] fix(events)` `bfdeb193`.
- ✅ **S1-P0-4 (+ S1-P1-1)** — renewal email CTA wired to the signed redeem-link (dormant route now live). `[Spec Kit] fix(renewals)` `80b2ef50`.

**P1 batch — remaining (19):** S1-P1-2/3 (renewal nav links + email unsubscribe — rest of Cluster A), S1-P1-13 (auth infra-value imports — in arch-test KNOWN_BACKLOG), + clusters B/C/D/E/G/H/I/J. Next.

## Counts

| | P0 | P1 | P2 | P3 |
|---|----|----|----|----|
| raw | 12 | 27 | 152 | 59 |
| **actionable** | **4** | **21** | 152 (backlog) | 59 (backlog) |
| `[PASS]` (compliance confirmations, not issues) | 8 | 6 | — | — |

> The thai-tax-compliance-auditor returned 8 P0 + 6 P1 as **`[PASS]`** — i.e. it
> verified F4 (§87 no-gaps, BE display-only, VAT arithmetic, §86/4 fields, RLS,
> Clean Arch, bilingual PDF, retention) is **correct**. Those are good news, not work.

---

## 🔴 P0 — launch blockers (4 real)

| ID | Theme | Finding | File | Decision |
|----|-------|---------|------|----------|
| S1-P0-1 | PII | **Raw attendee email stored in `audit_log` payload** for `attendee_non_member` events (PDPA data-minimisation) | `events/.../process-attendee-in-tx.ts:467` | **escalate** → hash (16-char SHA-256), helper already exists |
| S1-P0-2 | Clean Arch | **ESLint flat-config shadowing silently DISABLES the `drizzle-orm` import ban** for members + invoicing application layers — the guardrail itself is off, so violations slip in | `eslint.config.mjs:433-474` vs `:136-203` | auto-fix (merge blocks via `files` selector) |
| S1-P0-3 | Clean Arch | Application use case imports `drizzle-orm` + schema table directly (value imports) | `members/application/use-cases/count-active-members-on-plan.ts:25,28` | auto-fix (extract port) |
| S1-P0-4 | Renewal flow | **Renewal-reminder email CTA points to `/portal/account`, not the renewal flow — primary action dead-ends** | `renewals/.../dispatch-one-cycle.ts:774` + `retry-failed-reminders.ts:205` | **escalate** → point at signed redeem-link route |

## 🟠 P1 — must-fix before launch (21 real)

### Cluster A — F8 Renewal self-service is unwired (the biggest theme)
| ID | Finding | File | Decision |
|----|---------|------|----------|
| S1-P1-1 | Signed-token renewal **redeem-link route + HMAC signer are dead code** — nothing builds the token URL | `app/api/portal/renewal/redeem-link` | **escalate** (activates with P0-4 fix) |
| S1-P1-2 | Renewal flow `/portal/renewal/[memberId]` + opt-out `/portal/preferences/renewals` have **zero inbound UI links** — unreachable except by direct URL | `config/nav.ts:244-303` | post-launch-backlog |
| S1-P1-3 | Renewal reminder email has **no opt-out/unsubscribe link**, yet the opt-out page exists (FR-016) | `renewals/.../base-renewal-layout.tsx:104` | post-launch-backlog |

### Cluster B — F9 Dashboard / insights gaps (specced but missing)
| ID | Finding | File | Decision |
|----|---------|------|----------|
| S1-P1-4 | **FR-004 quota insights never computed** — only `at_risk_followup` fires; `unused_eblast_quota` + `underused_event_tickets` never built | `insights/.../compute-dashboard-snapshot.ts:105` | auto-fix |
| S1-P1-5 | **FR-001 unused/under-delivered benefits absent** — `underDeliveredBenefitCount` hardcoded 0 | `compute-dashboard-snapshot.ts:125` | auto-fix |
| S1-P1-6 | Dashboard **At-risk count (3 bands) drills into a list filtered to 1 band** — critical members hidden from drill-down | `insights/.../member-source-adapter.ts:28` | auto-fix |

### Cluster C — Admin journey bugs
| ID | Finding | File | Decision |
|----|---------|------|----------|
| S1-P1-7 | **Audit-log event-type filter omits ~80% of event types** (member/invoice/broadcast/renewal/plan/event) | `app/(staff)/admin/audit/page.tsx:44` | auto-fix |
| S1-P1-8 | **Invoice 'Overdue' filter returns zero rows** — overdue is read-time-derived, never a stored status; `eq(status,'overdue')` matches nothing | `app/(staff)/admin/invoices/_components/invoice-filters.tsx:35` | auto-fix |
| S1-P1-9 | Invoicing **`list()` cursor predicate inverted** vs sort order — pages 2+ return wrong rows | `invoicing/.../drizzle-invoice-repo.ts:360` | auto-fix |

### Cluster D — Role / RBAC
| ID | Finding | File | Decision |
|----|---------|------|----------|
| S1-P1-10 | **Read-only manager sees write affordances** (Edit/Archive/Add-Contact/Invite/Promote/Remove) that dead-end at the API | `app/(staff)/admin/members/[memberId]/page.tsx` | auto-fix |

### Cluster E — PII / GDPR
| ID | Finding | File | Decision |
|----|---------|------|----------|
| S1-P1-11 | `attendee_matched_member_contact` audit event stores **full raw matched-contact email** | `events/.../process-attendee-in-tx.ts:426` | auto-fix (domain-only) |
| S1-P1-12 | **GDPR archive missing address fields** added in migration 0195 (line1/2/city/province/postal) — portability incomplete | `insights/.../gdpr-archive-source-adapter.ts` | auto-fix |

### Cluster F — Clean Arch (enforcement)
| ID | Finding | File | Decision |
|----|---------|------|----------|
| S1-P1-13 | Auth application use cases import infrastructure **VALUES** (`MalformedHashError`, `retryAfterSeconds`) not just types | `auth/application/change-password.ts:44,46` | auto-fix |

### Cluster G — Audit completeness / cron
| ID | Finding | File | Decision |
|----|---------|------|----------|
| S1-P1-14 | **`lockout_cleared` cron not registered in `vercel.json`** → SC-004 audit-completeness broken (functional lockout still works inline) | `vercel.json` | auto-fix (one line) |
| S1-P1-15 | **`data_export_expired` audit event never emitted** by the sweep cron | `app/api/cron/insights/process-export-jobs/route.ts:88` | auto-fix |

### Cluster H — Members / data integrity
| ID | Finding | File | Decision |
|----|---------|------|----------|
| S1-P1-16 | **FR-009a: `tax_id` not enforced required** for Corporate/Partnership tiers (Thai tax needs it) | `members/.../create-member.ts:53`, `update-member.ts:37` | auto-fix |
| S1-P1-17 | Bulk **`send_portal_invite` is an audit-only stub** — no invitations actually dispatched | `members/.../bulk-action.ts:306` | auto-fix |

### Cluster I — i18n / a11y / UX polish
| ID | Finding | File | Decision |
|----|---------|------|----------|
| S1-P1-18 | Plan detail renders **benefit-matrix enum values in English for TH/SV** | `app/(staff)/admin/plans/[year]/[planId]/page.tsx:224` | auto-fix |
| S1-P1-19 | NumberField **`<Label>` not linked to `<Input>`** via `htmlFor` — WCAG 1.3.1/4.1.2 | `components/plans/benefit-matrix-editor.tsx:71` | auto-fix |
| S1-P1-20 | PaymentTimeline timestamp uses bare `toLocaleString` (**no explicit Asia/Bangkok tz**) — drifts under UTC server | `app/(staff)/admin/invoices/[invoiceId]/_components/payment-timeline.tsx:101` | auto-fix |

### Cluster J — Error handling
| ID | Finding | File | Decision |
|----|---------|------|----------|
| S1-P1-21 | `reject-broadcast.ts` **bare `catch {}` swallows ALL throws** as `broadcast_concurrent_action_blocked` (hides Neon/FK/RLS errors) | `broadcasts/.../reject-broadcast.ts:129` | auto-fix |

---

## ⚠️ Escalations — need operator decision (per § 3.1)

These were flagged because they touch product behaviour / scope sequencing.
**RESOLVED 2026-05-31 (operator):**
1. **PII hashing (S1-P0-1 / S1-P1-11)** → ✅ **FIX** — hash/domain-only redaction in audit payloads.
2. **Renewal redeem-link (S1-P0-4 + S1-P1-1)** → ✅ **WIRE NOW** — activate the signed redeem-link.
3. **F8 renewal cluster (A)** → ✅ **IN SCOPE — complete the full loop** (CTA→redeem-link, nav/inbound links, email unsubscribe). S1-P1-2/3 are launch, not post-launch.

**Stage 2 order**: start with the 4 P0 (operator: "เริ่ม P0 ก่อน"). P0-2 (ESLint guardrail) first — re-enabling the ban surfaces any other hidden import violations.

## ⚠️ P1-16 — tax_id-required: RULE DECIDED, code-enforcement DEFERRED (focused task)

**Operator decision (2026-05-31): rule = `memberTypeScope === 'company'`** (companies
need a tax ID; the Individual/Thai-Alumni person tiers do not). **Gate = invoice-issue**
(Thai law requires the buyer's tax ID on the tax-invoice document; `issue-invoice.ts`
loads `member.snapshot.tax_id` already, but not the plan's memberTypeScope).

**Why code-enforcement is deferred to a focused task (not Stage-2):** during
implementation we found `tax_id`-optional is a **deeply embedded assumption** —
`create-member`'s canonical `goodInput()` and 11+ member fixtures create company
members with no tax_id, and invoicing fixtures then issue invoices for them.
Enforcing at ANY gate triggers a broad cross-suite fixture sweep + adding
memberTypeScope to the member-identity view. That sweep is its own deliberate
task, not a rushed batch (would otherwise scatter ~15 fixture edits).

**Launch is still covered**: the Stage-3 member importer REQUIRES tax_id for
company members (`docs/member-import-spec.md` § 3) — so the real SweCham data is
tax-compliant at entry even before the code gate lands. Defense-in-depth code
enforcement at invoice-issue = post-Stage-2 focused task.

(superseded analysis below kept for context.)

## ⚠️ P1-16 — tax_id-required: original escalation analysis

The finding recommended requiring `tax_id` when `plan.planCategory` is
corporate/partnership. But **every** plan's `planCategory` is one of those two
(`plan-lookup-port.ts:23`), and the "corporate" category includes the
**Individual** + **Thai Alumni** tiers — which are PEOPLE, not companies, and do
not have a company tax ID. So the naive check would wrongly force tax_id on
individual members and break ~10 test fixtures. The correct rule is likely
`memberTypeScope === 'company'`, OR (more aligned with Thai law) enforce at
**invoice-issue** time (a tax invoice needs the buyer's tax ID; `issue-invoice.ts`
currently has no such check). **Escalated** — operator to confirm which members
must carry a tax_id and at which gate. Not implemented in Medium-C.

## 🆕 P1-9b — invoice cursor keyset incomplete (discovered Stage 2, P2 post-launch)

While fixing S1-P1-9 (cursor `gt`→`lt`), found a deeper issue: `list()` keysets on
a **random-UUID `invoiceId`** while sorting `desc(issueDate), desc(invoiceId)`.
The `lt` fix corrects direction and is correct within a single issueDate / single
page, but across multiple issueDates at >1 page it can skip/duplicate rows. This
feeds the F9 insights adapter, which pages the full set to sum revenue / count
overdue (`invoice-source-adapter.ts`) — so totals could drift **once a tenant
exceeds PAGE=100 invoices in scope**. **Dormant at launch** (SweCham ~131 members
→ <100 invoices/page → cursor never engages). **P2 — fix post-launch** with a
composite `(issueDate, invoiceId)` keyset + NULLS handling for drafts. Documented
in `drizzle-invoice-repo.ts` list().

## 📋 P2 / P3 — backlog (211, full list in raw JSON)

Not launch-blocking. P2 by module: events 18 · invoicing 15 · broadcasts 15 · auth 13 · members 13 · insights 12 · presentation 12 · plans 11 · renewals 11 · payments 10 · pdpa 7 · (others). Triage into post-launch waves during Stage 2.

## ✅ Compliance confirmations (good news)

F4 Thai-tax (8 P0 + 6 P1 PASS): §87 no-gaps numbering, BE display-only, VAT BigInt arithmetic, §86/4 + §86/10 fields, RLS+FORCE, Clean Arch domain purity, fiscal-year Asia/Bangkok, bilingual Sarabun PDF, audit completeness + retention. PCI + Thai-tax surfaces are **clean**.
