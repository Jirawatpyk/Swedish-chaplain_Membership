# F4 Quickstart

**Feature**: F4 — Membership Invoicing & Thai-Tax Receipts
**Branch**: `007-invoices-receipts`
**Audience**: a developer (or Claude Code session) picking up F4 implementation for the first time.

## 1. Prerequisites

- F1 (Auth & RBAC) merged to `main` via PR #1.
- F2 (Membership Plans) review-ready on `002-membership-plans`.
- F3 (Members & Contacts) review-ready on `005-members-contacts`.
- Local dev setup per the root `CLAUDE.md § Commands` section (pnpm, dev on :3100, Neon Singapore via `.env.local`).
- Verified `pnpm typecheck && pnpm lint && pnpm test` passes on `main`.

## 2. Read the spec + plan in this order

1. `specs/007-invoices-receipts/spec.md` — 7 user stories, 33 FRs, 11 SCs, 5 Clarifications resolved. Start here.
2. `specs/007-invoices-receipts/plan.md` — this plan's Constitution Check, Technical Context, Project Structure, Complexity Tracking.
3. `specs/007-invoices-receipts/research.md` — why each technical choice was made.
4. `specs/007-invoices-receipts/data-model.md` — 5 tables, RLS, immutability trigger, state machine.
5. `specs/007-invoices-receipts/contracts/invoicing-api.md` — every endpoint + DTO + error code.
6. `specs/007-invoices-receipts/security.md` — (authored before `/speckit.tasks`) — 15-threat model + security checklist.
7. `docs/ux-standards.md § 15` — merge-blocker UX checklist.
8. `.specify/memory/constitution.md` — v1.4.0; Principle I clauses 1-5 are directly relevant.

## 3. New developer setup — Vercel + Neon + Blob

```bash
# 1. Link local repo to Vercel project
vercel link

# 2. Pull env vars (adds BLOB_READ_WRITE_TOKEN + CRON_SECRET on top of F1+F3 vars)
vercel env pull .env.local

# 3. Verify env is parseable
pnpm tsx -e "import { env } from './src/lib/env.ts'; console.log(Object.keys(env))"

# 4. Run F3 migrations locally (prereq for F4 FK to members)
pnpm drizzle-kit migrate

# 5. Run F4 migrations (0010_invoicing_tables + 0011_audit_log_f4_extension)
pnpm drizzle-kit migrate

# 6. Seed a tenant + member if your Neon DB is empty (reuses F1+F3 seed)
BOOTSTRAP_ADMIN_EMAIL=admin@swecham.example pnpm tsx scripts/seed-bootstrap-admin.ts
pnpm tsx scripts/seed-f3-demo-members.ts  # F3 helper, if present; else create via admin UI

# 7. Seed initial tenant_invoice_settings for SweCham
pnpm tsx scripts/seed-f4-invoice-settings.ts   # NEW — authored as task T014 in tasks.md

# 8. Seed E2E test users (ALREADY EXISTS from F1 — DO NOT duplicate)
node --env-file=.env.local --import tsx scripts/seed-e2e-user.ts
# Creates e2e-admin@swecham.test / e2e-manager@swecham.test / e2e-member@swecham.test / e2e-lockout@swecham.test
# Idempotent — re-runs reset passwords + unlock. Use these for all F4 E2E specs (DO NOT create new e2e users).
```

## 3a. E2E test execution — operational notes

**Dev server is assumed running on `http://localhost:3100`** during E2E runs. Do NOT spin up a new dev server from within Playwright config — reuse the running one.

**Always run Playwright with a single worker** for F4 E2E specs to avoid cross-spec contention on the `tenant_document_sequences` advisory lock + outbox table + shared E2E user accounts:

```bash
pnpm test:e2e --workers=1                     # ALL F4 specs — always single worker
pnpm test:e2e --grep "invoice-draft-issue" --workers=1
pnpm test:e2e --grep "@a11y" --workers=1      # axe-core runs
```

Rationale: F4 mutates sequence-counter state that is per-tenant; parallel workers race each other on advisory-lock acquisition and pollute each other's seq numbers. Tenant-isolation tests use two tenants specifically to test cross-tenant boundaries; running parallel workers inside one tenant would create flakes that do not reflect real-world conditions (SweCham has ≤ 5 admins issuing concurrently).

**Known-good account set** (from `scripts/seed-e2e-user.ts`):

| Email | Role | Use for |
|---|---|---|
| `e2e-admin@swecham.test` | admin | all F4 admin flows (draft, issue, pay, void, credit-note, settings) |
| `e2e-manager@swecham.test` | manager | manager read-only assertion (US1 AS4) |
| `e2e-member@swecham.test` | member | member portal flows (US3, US7 AS4) + cross-tenant probe target |
| `e2e-lockout@swecham.test` | member | **DO NOT USE for F4** — reserved for F1 lockout spec only |

F4 specs MUST NOT create additional seeded users — reuse the 4 above. If a scenario needs a second member (e.g., cross-tenant probe), create an ephemeral member via the `createMember` use case inside the spec setup, not via seed script.

## 4. The critical path you MUST read before writing code

**The transactional issuance path.** This is the single most compliance-critical surface in F4. Read in order:

1. `research.md § 2` (sequence allocator design).
2. `data-model.md § 2.5` (tenant_document_sequences schema).
3. `data-model.md § 2.1` (invoices immutability trigger).
4. `src/modules/invoicing/application/use-cases/issue-invoice.ts` (once written — skeleton authored in T030).
5. `tests/integration/invoicing/seq-number-atomicity.test.ts` (written first, red, per TDD; 8 chaos scenarios).

Do NOT attempt to implement issuance without the red test file in place.

## 5. Local smoke test flow

Once a draft + issue path is wired:

```bash
# Terminal 1 — dev server
pnpm dev

# Terminal 2 — watch vitest
pnpm test:watch

# Terminal 3 — Playwright
pnpm test:e2e --grep "invoice-draft-issue"
```

Manual flow in the browser at `http://localhost:3100`:

1. Sign in as admin (F1 session).
2. Open an existing member's page (F3 surface) — scroll to the new "Invoices" section.
3. Click "Issue invoice" — a draft form opens pre-populated with member's current tier + year.
4. Save as draft → draft persists with no sequence number.
5. Click "Issue" → confirmation dialog (typed phrase) → after confirm, observe:
   - HTTP request to `POST /api/invoices/[id]/issue` returns 200 with `document_number: "SC-2026-000001"`.
   - Browser downloads a freshly rendered bilingual PDF.
   - Member receives an auto-email (check Resend dashboard or local mail catcher).
   - F3 timeline shows `invoice_issued` event.
   - Admin invoice list shows status `issued` + overdue=false.
6. Click "Record payment" → fill form → observe status transitions to `paid`, receipt PDF download, second auto-email.
7. Click "Issue credit note" → pick partial amount → observe status `partially_credited` + new sequential CN number.

## 6. Running the Principle I tenant-isolation test (Review-Gate blocker)

```bash
# Red first — before implementing any repo:
pnpm test tests/integration/invoicing/tenant-isolation.test.ts
# Expect: fails compilation or assertion — good. Implement until green.

# Green gate:
pnpm test tests/integration/invoicing/tenant-isolation.test.ts  # must be 0 failures
```

The test creates two tenants with UUID-suffixed slugs, issues invoices + credit notes for each, and asserts zero cross-tenant visibility on all four F4 tables from both directions. A red result blocks the Review Gate.

## 7. Common gotchas

- **Never use `number` for money in Domain.** Always `Money` value object (satang BIGINT). The linter has a rule that flags direct `Money → number` conversions outside the Infrastructure adapter.
- **Never call `new Date()` inside a use case.** Always inject `ClockPort` so the 8-scenario year-boundary test can control time.
- **Never write to `audit_log` outside the issuing transaction.** The F3 pattern is to import `auditLog` schema directly in the repo and insert inside the same tx; see Complexity Tracking row in `plan.md`.
- **Never mutate a non-draft invoice.** The `BEFORE UPDATE` trigger will reject; surface that as a clean Domain error, not a Postgres exception.
- **Never rely on `ALTER TYPE ... DROP VALUE`.** Postgres doesn't support it. If you add a wrong audit event type, ship a forward-fix migration to stop emitting it.
- **Always render PDFs inside the issue/pay/void/credit-note transaction.** Async rendering breaks FR-003 Thai RD §87 compliance.
- **Always pass `TenantContext` as an explicit parameter to every use case.** Compile-error enforcement = design correctness.

## 8. What `/speckit.tasks` will produce next

After `plan.md` + artifacts are sealed, running `/speckit.tasks` will generate `tasks.md` with TDD-ordered implementation tasks. Expected shape (≈60-80 tasks):

1. T001-T010 — scaffolding (module dir, barrel, composition root, ESLint rule extension)
2. T011-T020 — DB migrations + RLS policies + seed script
3. T021-T025 — red tests authored (tenant-isolation, seq-atomicity, pdf-deterministic, credit-note-partial, outbox)
4. T026-T040 — Domain layer (value objects, state machine, policies)
5. T041-T055 — Application layer use cases + ports
6. T056-T065 — Infrastructure adapters (postgres-sequence-allocator, react-pdf-render-adapter, vercel-blob-adapter, resend-email-outbox-adapter)
7. T066-T075 — Presentation (admin routes, portal routes, F3 member-page integration)
8. T076-T082 — i18n keys + docs + security.md sign-off + retrospective

## 9. Definition of Done (F4)

- [ ] All 10 Constitution gates pass (re-checked post-implementation).
- [ ] Tenant-isolation integration test green (Principle I Clause 3 Review-Gate blocker).
- [ ] Seq-atomicity integration test green — all 8 chaos scenarios.
- [ ] Deterministic-PDF integration test green — `sha256` equality across re-renders.
- [ ] SC-001 … SC-011 validated (manual + automated where applicable).
- [ ] ≥6 `/speckit.review` passes + ≥2 `/speckit.staff-review` rounds (solo-maintainer substitute).
- [ ] `security.md` co-signed by the maintainer.
- [ ] `docs/observability.md § F4 Invoicing` runbook added.
- [ ] CLAUDE.md "Active Technologies" + "Recent Changes" updated.
- [ ] Retrospective written.

## 10. Where to ask when stuck

- Sequence-allocator correctness questions → `research.md § 2` + test the 8 scenarios.
- PDF determinism issues → pin font version, pin template version, re-check that Domain passes pure data (not timestamps) into templates.
- Cross-tenant leakage → `runInTenant` missing somewhere in the call chain; `DEBUG_RLS_STATE=1` will loud-fail in dev.
- Constitution compliance → `.specify/memory/constitution.md § Development Workflow & Quality Gates`.
