# Implementation Plan: Contact Recipient Rules — Primary-only money emails + secondary contacts as marketing recipients

**Branch**: `108-contact-recipient-rules` | **Date**: 2026-09-04 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/108-contact-recipient-rules/spec.md`
**Evidence companion**: `docs/contacts-primary-secondary-gap-analysis.md` (H1, H2, G1–G9 with
file:line) — the plan closes every item there except G3 (kept by decision D4).

## Summary

Make the two SweCham contact rules true without exception. **Tier A** — every money email
(receipt, void notice, credit note, resends) and the address handed to the payment processor
resolve the member's **current** primary contact at enqueue time instead of the frozen
invoice snapshot; the "no primary" state is audited and visible; a dormant recipient
override is deleted; the portal resend response stops disclosing the primary's address.
**Invariant** — "exactly one primary contact" is enforced on every contact mutation in the
application and at commit by deferred DB constraint triggers, and unarchive must designate a
primary. **Tier B** — member-based broadcast audiences fan out to every eligible contact
(primary + secondaries) of **active** members, minus suppressions, a new per-contact opt-out
(staff or self) and all contacts of the sender; opt-out applies to every segment; audiences
are keyset-paginated with no silent truncation, one ceiling, a resumable Resend push, and a
truthful compose-time count; unsubscribes gain contact attribution. **Operations** — a new
`contacts.marketing` right, a permanent Marketing audience page (also the FR-027a pre-flight
surface), member-page badges/toggle, and a portal self-toggle. Delivery in four PRs
(A → B → D → C) with the audience change behind a temporary flag flipped only after the
staff pre-flight review. Prod is live with real members and money.

## Technical Context

**Language/Version**: TypeScript 5.7+ strict (`strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`); Node 22 LTS — unchanged
**Primary Dependencies**: Next.js 16 App Router · React 19 · Drizzle ORM · next-intl ·
shadcn/ui (`Switch`, table primitives) · Resend Broadcasts API (existing gateway) · Stripe
`^22` (existing gateway). **Zero new npm dependencies** (Constitution X)
**Storage**: Neon Postgres `ap-southeast-1` (Drizzle, hand-written SQL). DDL: `contacts` +3
nullable columns + 1 partial index (0294) · `marketing_unsubscribes.contact_id` (0296) · two
deferred constraint triggers on `contacts`/`members` with a data pre-check (0293) · three
`audit_event_type` values (0292, 0295) · two nullable `broadcasts` columns for the provider
import job (0297). No new table, no column drops, no enum widening beyond audit events
**Testing**: Vitest unit/contract · live-Neon integration (dev branch; race ×100, trigger
rehearsal, 20k-contact pagination, resumable push) · Playwright + axe (`--workers=1`) ·
static gates incl. a new `check:money-recipient`
**Target Platform**: Vercel `sin1` (prod live at `swecham.dxtspace.com`); native Vercel Cron
(`dispatch-scheduled` / `dispatch-batches` / `split-large-broadcasts` / `reconcile-stuck-sending`,
GET, UTC, `maxDuration = 300`)
**Project Type**: Web application — existing modular monolith (`src/modules/*` bounded
contexts: invoicing, payments, members, broadcasts, auth; App Router presentation)
**Performance Goals**: money-email enqueue adds one indexed contact read (p95 < 20 ms);
recipient count p95 < 400 ms at 5,000 and < 3 s at 20,000 contacts (SC-004); toggle API
p95 < 400 ms; Marketing audience page LCP < 2.5 s at 50 rows; audience push ≤ 240 s per
cron tick, resumable
**Constraints**: live money path — tax-document buyer identity stays frozen (only delivery
address goes live); no PII in logs or audit payloads (ids + hashes only); actor role always
the session role (`check:actor-role-truth`); tenant isolation two-layer for every new query
(`runInTenant` tx + RLS FORCE); the provider audience is built with Resend's asynchronous
Contacts Import API (one import per broadcast, polled across cron ticks — research R9; the
installed SDK 4.8 lacks the method, so the adapter calls the endpoint directly); flag OFF
must be behaviour-identical except the `status = 'active'` narrowing
**Scale/Scope**: 4 invoicing use cases + 1 payments use case rewired (47 test files carry
the affected deps types) · 1 permission key (41→42 pinned) · 1 staff page + 1 nav item +
4 API routes (2 admin, 1 portal, 1 member) · 1 resolver rewrite (4 callers + memo wrapper) ·
6 migrations · 3 audit events (F3 35→37, F4 +1) · ~40 i18n keys ×3 locales · 4 PRs + 1
follow-up (flag deletion) · 3 verify-before-task items (V1 prod counts, V2 Resend duplicate
semantics, V3 enum-guard multi-statement)

## Constitution Check

*GATE: evaluated against Constitution v1.4.2 (all 10 principles) — pre-Phase-0 PASS,
re-checked post-Phase-1 design (see § Post-Design Re-check).*

**NON-NEGOTIABLE gates**:

- [x] **I. Data Privacy & Security** — New processing: per-contact marketing preference
      (staff/self opt-out with actor + timestamp) and contact-level unsubscribe attribution.
      Lawful basis documented (spec Clarifications D3/Q2: B2B contacts, TH PDPA §24(5) /
      GDPR Art. 6(1)(f), Art. 14 notice already modelled, Art. 21 objection via unsubscribe
      + the new self-toggle); purpose = audience management. Data minimisation: audience
      page shows name/email/state only (marketing fenced from `pii_sensitive` by T057);
      audit payloads carry ids and `source`, never addresses; count endpoints return
      numbers only. RBAC: page gated `contacts.read`, toggle `contacts.marketing`, admin
      count `broadcasts.write`, portal routes own-contact only; denials audited. Tenant
      isolation: every new repo method threads the `runInTenant` tx; new columns sit under
      existing RLS FORCE; trigger function filters by the row's `tenant_id`; cross-tenant
      probes get integration tests (FR-052). OWASP: broken access control (new surfaces
      gated + baseline-pinned), IDOR on toggle (contact must belong to tenant; portal to
      `ownContactId`), rate limits on count + toggle, no email in responses to portal
      users (FR-005). PDPA/GDPR reviewer signs at the plan/review gate (spec Q2).
- [x] **II. Test-First Development** — Each PR starts RED: contract test
      `money-email-recipient-inventory` (SC-001), race ×100 + trigger rehearsal (SC-002),
      audience 1:N/status/opt-out integration (SC-003), pagination-20k (SC-004), toggle
      route contract + RBAC pins. Coverage: Domain 100% (contact marketing union, policy,
      ceiling); new use cases `setContactMarketingOptOut`, `resolveMoneyRecipient`,
      `listMarketingAudience`, undelete-designate pinned 100% line/branch in
      `vitest.config.ts` (security-critical: PII access + money recipient); resolver
      branches ≥ 80% with the flag parameterised (both legs).
- [x] **III. Clean Architecture** — Domain additions are pure (`MarketingOptOut` union,
      `audienceCeiling`, `MoneyRecipient`); Application ports widened
      (`RecipientLocalePort`, `MembersBridgePort`, `ContactRepo`) with adapters in
      Infrastructure; cross-module calls go through public barrels (payments → members
      barrel; broadcasts → members barrel as today). The one seam that would cycle
      (members needs a suppression lookup owned by broadcasts) is composed in `src/lib/`
      — see Complexity Tracking #3 (composition-layer note, not a deviation). Presentation
      calls use cases only.
- [x] **IV. Payment Security (PCI DSS)** — Payment path change is metadata only: the
      email passed as `billing_details.email` becomes the primary contact's. No card data
      touched; SAQ-A scope unchanged; Elements/Payment Intents unchanged. Audit events on
      the payment path unchanged; the new `primary_contact_missing` refusal is a typed
      permanent error before any processor call. `pci-saqa-guardian` reviews PR-A.

**Core principle gates**:

- [x] **V. Internationalization (SV/EN/TH)** — ~40 new keys (audience page, badges,
      banner, portal toggle, compose estimate note rewrite + self-exclusion hint, three
      audit labels with real Thai script, nav + breadcrumb) in EN/TH/SV; `check:i18n` in
      gates; `audit-event-label-coverage` asserts Thai script. No currency/date surfaces;
      timestamps rendered via existing locale formatters (BE display-only).
- [x] **VI. Inclusive UX (Mobile First + WCAG 2.1 AA)** — Audience table reuses the
      members-directory pattern (320 px stacking, `TablePagination`, filter chips); marketing
      state badge = text + icon (never colour-alone); `Switch` labelled with contact name,
      state announced; `RestorePrimaryDialog` and any dialog carry `finalFocus`; count region
      `aria-live="polite"`; axe sweeps on the new page, member detail, portal profile,
      compose. `enterprise-ux-designer` pass on every UI PR.
- [x] **VII. Performance & Observability** — Budgets in Technical Context; new metrics
      `broadcasts.audience_resolved_total`, `audience_pages_total`,
      `audience_import_status`, `recipient_count_ms`; existing
      `invoicing.auto_email_skipped{reason}`; structured logs with member-id hashes;
      runbook `docs/runbooks/broadcast-audience-build.md`; `docs/observability.md` updated.
      Keyset pagination (1,000/page) bounds memory; partial index backs the audience query.
- [x] **VIII. Reliability** — Error paths enumerated per contract (no-recipient →
      audit + skip, never a fallback; page failure in pagination → error, never `[]`;
      suppressed → 409; race → 409 at commit; unarchive without primary → 409 with remedy).
      Transactions: recipient resolve + enqueue + audit in one tenant tx (or the port's own
      tx on resend); designate-primary + unarchive atomic; audience snapshot + progress
      stamps per tick; deferred constraint triggers = DB-level defence-in-depth (IX.4).
      Idempotency: toggle same-state = `unchanged`; audience push idempotent per
      `(audience, email)`; existing Stripe idempotency keys unchanged. Audit entries:
      `auto_email_skipped_no_recipient`, `contact_marketing_opted_out/in`, existing
      unsubscribe events gain `contact_id`, `member_primary_contact_changed` on designate.
- [x] **IX. Code Quality Standards** — TS strict, ESLint, Conventional Commits, `[Spec Kit]`
      prefixes. Money (A, C), PII + RBAC (B, D) are security-sensitive ⇒ ≥2 reviewers ⇒
      solo-maintainer substitute invoked → Complexity Tracking #1 (five checks enumerated,
      co-sign footer per checklist). New static gate `check:money-recipient` with positive
      control joins pre-push.
- [x] **X. Simplicity (YAGNI)** — Reuse over new: widen an existing live-read port instead
      of a new one; reuse `addContact` for the unarchive remedy; clone existing table/route/
      toggle patterns; three columns + one index instead of a preferences table; two audit
      events with a `source` payload instead of four. Accepted temporary complexity: the
      cutover flag with a scheduled deletion (Complexity Tracking #2). Replacing the serial
      per-contact push with one provider import per broadcast is simpler, not more complex:
      2–3 API calls instead of thousands, and no per-recipient working table (research R9).

## Project Structure

### Documentation (this feature)

```text
specs/108-contact-recipient-rules/
├── spec.md              # Feature spec (3 clarification sessions, 2026-09-04)
├── plan.md              # This file
├── research.md          # Phase 0 — R1..R15 decisions + pinned repo facts + V1..V3 verify items
├── data-model.md        # Phase 1 — Domain unions, DDL for 0292..0297, states, permissions, flag
├── quickstart.md        # Phase 1 — per-PR test loops, manual verification, cutover checklist
├── contracts/
│   ├── money-email-recipient.md    # Tier A resolution rule, widened port, F5 port, routes, gate
│   ├── broadcast-audience.md       # Tier B resolver pipeline, ceiling, resumable push, count endpoints
│   └── contact-marketing-api.md    # toggle routes, audience page, member detail, undelete designate
├── checklists/requirements.md      # spec quality checklist (complete)
└── tasks.md             # Phase 2 (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

```text
src/modules/invoicing/
├── application/ports/recipient-locale-port.ts        # + getMemberEmailRecipient (required)
├── application/lib/resolve-money-recipient.ts        # NEW — MoneyRecipient rule (member/non_member/no_recipient)
├── application/use-cases/{record-payment,void-invoice,issue-credit-note,resend-pdf}.ts
│                                                     # live resolve; guards; override deleted
├── application/ports/audit-port.ts                   # + auto_email_skipped_no_recipient (5y)
└── infrastructure/adapters/{recipient-locale-adapter,member-identity-adapter}.ts
                                                      # one live read; removed_at IS NULL

src/modules/payments/
├── application/ports/billing-recipient-port.ts       # NEW
├── application/use-cases/initiate-payment.ts         # actorEmail removed; resolves via port
└── infrastructure/{billing-recipient-adapter.ts,di.ts}   # members barrel → getMemberPrimaryContact

src/modules/members/
├── domain/contact.ts                                 # + MarketingOptOut union, contactMarketing()
├── domain/marketing-reason.ts                        # NEW — 10 non-receipt reason codes (FR-031b)
├── domain/policies/primary-contact-invariant.ts      # unchanged; now WIRED
├── application/ports/contact-repo.ts                 # + listByMemberInTx, setMarketingOptOutInTx
├── application/ports/marketing-suppression-lookup-port.ts   # NEW (impl in src/lib)
├── application/use-cases/contact-crud.ts             # invariant check in-tx; remove guard
├── application/use-cases/undelete-member.ts          # + designatePrimaryContactId, contactRepo
├── application/use-cases/set-contact-marketing-opt-out.ts   # NEW (staff|self)
├── application/use-cases/list-marketing-audience.ts  # NEW (paged, filtered)
├── application/ports/audit-port.ts                   # + 2 events (35→37)
└── infrastructure/db/{schema-contacts,drizzle-contact-repo,drizzle-member-repo}.ts
                                                      # columns; removeInTx predicate; findBroadcastRecipientContacts (keyset)

src/modules/broadcasts/
├── domain/audience-ceiling.ts                        # NEW — 5,000 | 50,000
├── application/ports/members-bridge-port.ts          # + getContactsBySegment, filterMarketingOptedOut; ContactRecipient
├── application/use-cases/resolve-segment-recipients.ts   # 1:N pipeline, audienceMode, ceiling param, droppedByPreference
├── application/use-cases/{validate-custom-recipients,submit-broadcast,dispatch-scheduled-broadcast,unsubscribe-recipient}.ts
├── application/use-cases/build-audience-tick.ts      # NEW — submit one contact import, poll, send when complete
├── application/ports/broadcasts-gateway-port.ts      # + createContactImport / getContactImport
├── infrastructure/resend/resend-broadcasts-gateway.ts # raw multipart fetch for /contacts/imports (SDK 4.8 gap)
├── infrastructure/{members-bridge,tick-memoized-members-bridge,broadcasts-deps}.ts   # errors propagate; memo; flag → mode
└── infrastructure/schema.ts                          # marketing_unsubscribes.contact_id; broadcasts.audience_import_* (0297)

src/modules/auth/domain/permissions/{permission-catalogue,role-bundles}.ts   # + contacts.marketing
src/lib/
├── contact-marketing-deps.ts                         # NEW — composition: suppression lookup (broadcasts barrel) for members use case
├── env.ts                                            # + FEATURE_CONTACT_MARKETING_RECIPIENTS (+ .env.example; check:env-example / env-boot)
└── nav-permissions.ts / src/config/nav.ts            # + Marketing audience item (guard contacts.read)

src/app/(staff)/admin/marketing/audience/{page,loading}.tsx + _components/   # NEW page (TableContainer both)
src/app/(staff)/admin/members/[memberId]/page.tsx     # billing badge, marketing badge/switch, no-primary banner
src/app/api/admin/contacts/[contactId]/marketing/route.ts       # NEW POST (contacts.marketing)
src/app/api/admin/broadcasts/recipient-count/route.ts           # NEW GET (broadcasts.write)
src/app/api/broadcasts/recipient-count/route.ts                 # NEW GET (member context)
src/app/api/portal/profile/marketing/route.ts                   # NEW PATCH (own contact)
src/app/api/portal/invoices/[invoiceId]/resend/route.ts         # body { ok } only
src/app/api/members/[memberId]/undelete/route.ts                # designate_primary_contact_id + 409 remedy
src/components/members/{marketing-state-badge,marketing-switch,restore-primary-dialog}.tsx   # NEW
src/components/broadcast/{compose-form,segment-picker}.tsx      # live count + self-exclusion hint
src/i18n/messages/{en,th,sv}.json                               # ~40 keys

drizzle/migrations/0292..0297_*.sql + meta/_journal.json        # see data-model.md
scripts/check-money-email-recipient.ts                          # NEW gate (pre-push) with positive control
scripts/inventory-primary-contact-invariant.ts                  # NEW read-only prod inventory (V1)
docs/runbooks/broadcast-audience-build.md                       # NEW (+ updates: cron-jobs, reconcile-stuck-sending, void-pdf-reconcile)
docs/go-live-readiness.md                                       # + Stripe "Successful payments" OFF at Live switch; pre-flight review record

tests/
├── unit/{invoicing,payments,members,broadcasts,auth/permissions,nav}/…
├── contract/{invoicing/money-email-recipient-inventory,rbac/*,members/contact-marketing,broadcasts/get-broadcasts-recipient-count}.test.ts
├── integration/{invoicing/*-live-recipient,members/primary-contact-{race,trigger},broadcasts/audience-*}.test.ts
├── helpers/{recipient-locale-fake,rbac-pinned-matrix,rbac-observed-baseline}.ts
└── e2e/{admin-marketing-audience,rbac-navigation,members-*,broadcast-compose-and-submit}.spec.ts
```

**Structure Decision**: Existing modular-monolith layout. The feature adds no module and no
dependency; it widens three Application ports, adds four use cases, one Domain value file,
one composition-root file, one staff page, four routes, six hand-written migrations, one
gate script and one runbook. Presentation changes are edits to existing pages plus one new
page cloned from the members directory pattern.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| **#1 — Principle IX: ≥2-reviewer rule on money (A, C), RBAC + PII (B, D) substituted by the solo-maintainer 5-check stack** | Single maintainer; no second human reviewer | Per PR, all five: (1) ≥3 `/speckit.review` passes with decreasing severity; (2) ≥1 `/speckit.staff-review` triangulated round (correctness + security + tests), second round mandatory on any BLOCKER/CRITICAL; (3) coverage per Principle II incl. live-Neon integration for every security-critical use case (live recipient ×4, initiate-payment, race, trigger, toggle, resolver); (4) DB-level defence-in-depth — deferred constraint triggers for the primary invariant, CHECK-correlated opt-out columns, RLS FORCE on any new table, the `check:money-recipient` gate with positive control; (5) post-remediation re-review by a fresh agent. Maintainer co-signs each security checklist with the v1.4.2 footer template. |
| **#2 — Principle X: temporary `FEATURE_CONTACT_MARKETING_RECIPIENTS` flag + `primary_only` resolver leg (PR-C → follow-up deletion)** | The audience change is the one behaviour a code rollback cannot undo once a send has gone out; FR-027a requires a staff pre-flight review before the first send under the new rule | Flip-on-merge was rejected: no operator gate between deploy and the first E-Blast to newly eligible contacts. The flag is read in one composition site, passed as a parameter (Domain pure), parameterised in tests (both legs), and its deletion is a named task after one clean week. |
| **#3 — Principle III (note, not a deviation): the members-module `MarketingSuppressionLookupPort` adapter is composed in `src/lib/contact-marketing-deps.ts`, not in `members-deps.ts`** | `setContactMarketingOptOut` must refuse "on" for a suppressed address, and suppression is owned by broadcasts, which already imports the members barrel (`members-bridge.ts`) | Implementing the adapter inside `members-deps.ts` would create a members↔broadcasts barrel cycle (066 barrel-cycle class, breaks tsx scripts and client bundles). `src/lib` is the sanctioned composition layer (Principle III "barrel-rule-exempt by constitution", precedent `events-csv-import-deps.ts`). Duplicating the suppression read inside members was rejected: two readers of one GDPR record drift. |
| **#4 — Development-workflow: migration 0293 carries a data pre-check that fails the deploy if any active member already violates the invariant** | Prod migrates automatically on deploy; a trigger created over violating rows would make every later contact write on those members fail | A silent backfill (auto-promote a contact) was rejected: it silently chooses who receives money emails. Instead V1 (read-only prod inventory) is a named operator task BEFORE PR-B merges, and the pre-check is the technical enforcement that the task actually ran. |

## Post-Design Constitution Re-check (after Phase 0 + Phase 1 artefacts)

Re-evaluated 2026-09-04 after generating research.md, data-model.md, contracts/ (3),
quickstart.md: no new violations. Phase-1 artefacts add no dependency and no module; the
migration 0297 adds two nullable columns on `broadcasts` under its existing RLS policy (the
earlier working-table idea was dropped after Resend's Contacts Import API was verified —
research R9, corrected 2026-09-04). The import-based audience build is a reliability
requirement surfaced by research, not speculative scope: the serial push cannot finish 5,000
contacts inside the 300 s function budget even at the documented 10 req/s. The four Complexity Tracking entries are the
complete deviation set. **GATE: PASS.**

## Phase Outputs

- **Phase 0**: [research.md](./research.md) — no open NEEDS CLARIFICATION; three
  verify-before-task items (V1 prod invariant/secondary counts, V2 Resend duplicate-contact
  semantics, V3 enum-guard multi-statement) are pinned to the tasks that depend on them.
- **Phase 1**: [data-model.md](./data-model.md) ·
  [contracts/money-email-recipient.md](./contracts/money-email-recipient.md) ·
  [contracts/broadcast-audience.md](./contracts/broadcast-audience.md) ·
  [contracts/contact-marketing-api.md](./contracts/contact-marketing-api.md) ·
  [quickstart.md](./quickstart.md) · agent context updated via
  `.specify/scripts/powershell/update-agent-context.ps1 -AgentType claude`.
- **Phase 2**: tasks.md — produced by `/speckit.tasks`, not by this command. Suggested
  task grouping: PR-A (R1–R3, R14 gate, 0292) · PR-B (R4, R5, 0293, V1) · PR-D (R6, R7,
  0294, 0295, audience page, portal toggle) · PR-C (R8–R12, 0296, 0297?, V2, V3, spec-010 /
  005 / 007 / 014 / 016 AMENDMENT blocks) · follow-up (flag + `primary_only` leg deletion).
