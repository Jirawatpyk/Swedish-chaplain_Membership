# Auto-Invoice (auto-draft + admin review) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daily cron pre-fills renewal *drafts* for enrolled members inside their billing-cycle lead window; a treasurer works an "auto-drafted renewals" queue and per row clicks **Issue + Send**, **Issue silently**, or **Discard** — the §-era bill number and any email are minted only on the human's Issue click.

**Architecture:** Stance **A3 (auto-draft + admin review)**. A new fifth renewals cron (coordinator → worker → use-case) creates `status='draft', origin='auto_renewal'` invoices via a **create-half** bridge method — no number, no PDF, no email. The queue-issue action `issueAutoDraftedRenewal` routes the mint through Sub-project #1's already-merged `issueMembershipBill` composition (auto-void of superseded bills), guarded by a **content-based pre-issue check** (member+plan_year, any status) that is the primary duplicate-§86/4 barrier. Follows the existing **3-tx create→issue→link** topology (F4 owns its own tx; renewals owns `renewal_cycles`). Ships behind a **three-key dark-ship** (env flag + tenant setting + per-member opt-in), all default-off.

**Tech Stack:** TypeScript 5.7 strict · Next.js 16 App Router (Vercel-native cron, `GET = POST`) · Drizzle + Neon Postgres (RLS) · Vitest (unit + live-Neon integration) · next-intl (EN/TH/SV). **Zero new npm dependencies.**

**Spec:** `docs/superpowers/specs/2026-07-17-auto-invoice-design.md` (rev-3). **Hard-dependency #1 (`106-void-on-reissue`) is MERGED to main** — `issueMembershipBill` composition, per-member asymmetric `(created_at,id)<` void match, and `FEATURE_VOID_ON_REISSUE` flag are all live.

## Global Constraints

- **Branch:** a fresh `NNN-auto-invoice` off updated `main` (includes #1). Spec dir `specs/NNN-auto-invoice/` optional; this plan is the source of truth.
- **Three-key dark-ship, all default-off:** `FEATURE_AUTO_INVOICE` (env) · `tenant_invoice_settings.auto_invoice_enabled` (DB) · `members.auto_invoice_enrolled_at` (per-member). No behaviour in prod until all three are set. Independent of `FEATURE_F8_RENEWALS`.
- **Zero email at cron time.** Drafts store `autoEmailOnIssue = false` **explicitly, never null** (`issue-invoice.ts:857-858` resolves `?? settings.autoEmailEnabled`, default `true` — a null silently emails). Only "Issue + Send" sets email on.
- **`planYear` is never client-supplied and never stored on `renewal_cycles`** — always `deriveFiscalYear(cycle.periodFrom)` (`@/lib/fiscal-year`). It is a §86/4 tax-document field.
- **No new renewal-cycle status, no new invoice status.** No cron-created cycle rows (`createNextCycleOnPaid` owns succession at payment).
- **Cross-context imports go through barrels** (`@/modules/renewals`, `@/modules/invoicing`, `@/modules/members`) — ESLint `no-restricted-imports`. New use-cases/repo methods/bridge methods must be barrel-exported before a route or sibling module imports them.
- **Tenant-scoped writes thread `tx` from `runInTenant`**, never the global `db` singleton (silent RLS bypass). Use-cases use `deps.clock.now()`, never `new Date()`/`Date.now()`.
- **Migration discipline:** `pnpm db:migrate` (→ dev Neon) + `pnpm test:integration` on the touched suite **before** committing schema+code together. Money-path tests are **failing-first, live Neon**.
- **i18n:** EN canonical + **TH mandatory (Thai script)** + **SV (must differ from EN)**. Audit-label coverage is **build-failing** via `tests/unit/insights/audit-event-label-coverage.test.ts`, NOT caught by `check:i18n`.
- **Timestamps:** ISO 8601 UTC storage; Buddhist Era display-only. Cron schedules in `vercel.json` are **UTC** (Asia/Bangkok = UTC−7).
- **Pre-push:** touching `src/modules/renewals/**` or `src/modules/invoicing/**` triggers the per-module integration gate. `SKIP_INTEGRATION_PREPUSH=1` only if the full suite is slow/flaky and your specific tests pass (CI is the backstop). Run `pnpm typecheck` as the final gate before each commit.

---

## File Structure

**New files**
- `drizzle/migrations/0259_auto_invoice_columns_and_audit.sql` — 4 tables' columns + `invoice_origin` enum + 2 `audit_event_type` values.
- `src/modules/renewals/application/use-cases/auto-draft-due-renewals.ts` — cron worker body (draft creation).
- `src/modules/renewals/application/use-cases/issue-auto-drafted-renewal.ts` — queue-issue action (owns `renewal_cycles`).
- `src/modules/renewals/application/use-cases/prune-auto-drafts.ts` — housekeeping (discard stale drafts).
- `src/modules/renewals/application/use-cases/reconcile-issued-orphans.ts` — housekeeping (re-link burned-number orphans).
- `src/app/api/cron/renewals/auto-draft-coordinator/route.ts` + `.../auto-draft/[tenantId]/route.ts` + `.../prune-auto-drafts/route.ts` + `.../reconcile-issued-orphans/route.ts`.
- `src/app/(staff)/admin/invoices/_components/auto-renewal-queue-actions.tsx` — per-row Issue/Send/Discard dialogs.
- `src/app/api/invoices/[invoiceId]/issue-auto-drafted/route.ts` + `.../discard-auto-draft/route.ts`.
- `src/modules/members/application/use-cases/bulk-enrol-auto-invoice.ts`.

**Modified files** (exact anchors in each task): `schema-invoices.ts` · `schema-renewal-cycles.ts` · `schema-members.ts` · `schema-tenant-invoice-settings.ts` · `renewal-audit-emitter.ts` · `drizzle-renewal-audit-emitter.ts` · `src/modules/auth/infrastructure/db/schema.ts` · `src/lib/env.ts` · `src/lib/metrics.ts` · `issue-invoice.ts` · `f4-invoicing-bridge.ts` (port) + `...bridge-drizzle.ts` (adapter) · `renewal-cycle-repo.ts` (port) + `drizzle-renewal-cycle-repo.ts` · `renewals-deps.ts` · `src/modules/renewals/index.ts` (barrel) · `list-invoices.ts` + `invoice-repo.ts` + `drizzle-invoice-repo.ts` · admin invoices `page.tsx` + `invoice-filters.tsx` + `invoice-table.tsx` · members `bulk-action-bar.tsx` + `/api/members/bulk/route.ts` + member `[memberId]/page.tsx` · `drizzle-dispatch-candidate-repo.ts` · `vercel.json` · `docs/runbooks/cron-jobs.md` · `src/i18n/messages/{en,th,sv}.json`.

---

## Task 1: Schema migration + Drizzle columns

**Files:**
- Create: `drizzle/migrations/0259_auto_invoice_columns_and_audit.sql`
- Modify: `src/modules/invoicing/infrastructure/db/schema-invoices.ts` (enum near :46, column near :96); `src/modules/members/infrastructure/db/schema-members.ts` (near :170); `src/modules/renewals/infrastructure/schema-renewal-cycles.ts` (near :72); `src/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings.ts` (near :80, CHECK via `(table) => [ ... ]` at :129)
- Modify: `drizzle/migrations/meta/_journal.json` (append `idx: 260`, `tag: "0259_auto_invoice_columns_and_audit"`)
- Test: `tests/integration/invoicing/auto-invoice-schema.test.ts`

**Interfaces:**
- Produces: `invoiceOriginEnum` (`'manual' | 'auto_renewal'`), `invoices.origin`, `members.autoInvoiceEnrolledAt`, `renewalCycles.autoDraftInvoiceId`, `tenantInvoiceSettings.autoInvoiceEnabled | autoInvoiceLeadDaysRolling | autoInvoiceLeadDaysCalendar | autoInvoicePageSize`.

- [ ] **Step 1: Write the migration SQL** (mirror `0255` CREATE TYPE + `0252` idempotent CHECK):

```sql
-- 0259_auto_invoice_columns_and_audit.sql
CREATE TYPE "invoice_origin" AS ENUM('manual', 'auto_renewal');--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "origin" "invoice_origin" NOT NULL DEFAULT 'manual';--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "auto_invoice_enrolled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "renewal_cycles" ADD COLUMN "auto_draft_invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant_invoice_settings" ADD COLUMN "auto_invoice_enabled" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "tenant_invoice_settings" ADD COLUMN "auto_invoice_lead_days_rolling" integer NOT NULL DEFAULT 30;--> statement-breakpoint
ALTER TABLE "tenant_invoice_settings" ADD COLUMN "auto_invoice_lead_days_calendar" integer NOT NULL DEFAULT 31;--> statement-breakpoint
ALTER TABLE "tenant_invoice_settings" ADD COLUMN "auto_invoice_page_size" integer NOT NULL DEFAULT 200;--> statement-breakpoint
ALTER TABLE "tenant_invoice_settings" DROP CONSTRAINT IF EXISTS "tenant_invoice_settings_auto_lead_days_ck";--> statement-breakpoint
ALTER TABLE "tenant_invoice_settings" ADD CONSTRAINT "tenant_invoice_settings_auto_lead_days_ck" CHECK ("auto_invoice_lead_days_rolling" BETWEEN 1 AND 120 AND "auto_invoice_lead_days_calendar" BETWEEN 1 AND 120);--> statement-breakpoint
ALTER TABLE "tenant_invoice_settings" ADD CONSTRAINT "tenant_invoice_settings_auto_page_size_ck" CHECK ("auto_invoice_page_size" BETWEEN 1 AND 5000);
```
(The two `audit_event_type` `ADD VALUE`s land in Task 2's edit to the SAME file — keep them in this migration; author them in Task 2 to keep the audit lockstep atomic. Enum `ADD VALUE` runs in `run-migrations.ts`'s autocommit pre-pass, so co-locating is safe.)

- [ ] **Step 2: Add Drizzle columns.** In `schema-invoices.ts` after `invoiceSubjectEnum` (:46): `export const invoiceOriginEnum = pgEnum('invoice_origin', ['manual', 'auto_renewal']);` then in the column block near `status` (:96): `origin: invoiceOriginEnum('origin').notNull().default('manual'),`. In `schema-members.ts` near :170: `autoInvoiceEnrolledAt: timestamp('auto_invoice_enrolled_at', { withTimezone: true }),`. In `schema-renewal-cycles.ts` near `linkedInvoiceId` (:72): `autoDraftInvoiceId: uuid('auto_draft_invoice_id'),`. In `schema-tenant-invoice-settings.ts` near :80: `autoInvoiceEnabled: boolean('auto_invoice_enabled').notNull().default(false),`, `autoInvoiceLeadDaysRolling: integer('auto_invoice_lead_days_rolling').notNull().default(30),`, `autoInvoiceLeadDaysCalendar: integer('auto_invoice_lead_days_calendar').notNull().default(31),`, `autoInvoicePageSize: integer('auto_invoice_page_size').notNull().default(200),` and the CHECK in the `(table) => [ ... ]` array (:129).

- [ ] **Step 3: Write the failing integration test** `tests/integration/invoicing/auto-invoice-schema.test.ts` (mirror an existing invoicing integration test's tenant harness):

```ts
it('new columns exist with correct defaults + lead-days CHECK', async () => {
  const tenant = await createTestTenant('auto-inv-schema');
  await seedTenantFiscal({ tenant, invoiceNumberPrefix: 'SC', receiptNumberPrefix: 'RC' });
  // default origin = 'manual' on a fresh draft-shaped invoice row
  const [inv] = await runInTenant(tenant.ctx, (tx) =>
    tx.select({ origin: invoices.origin }).from(invoices).limit(1));
  // settings defaults
  const [s] = await runInTenant(tenant.ctx, (tx) =>
    tx.select({
      enabled: tenantInvoiceSettings.autoInvoiceEnabled,
      rolling: tenantInvoiceSettings.autoInvoiceLeadDaysRolling,
      calendar: tenantInvoiceSettings.autoInvoiceLeadDaysCalendar,
      page: tenantInvoiceSettings.autoInvoicePageSize,
    }).from(tenantInvoiceSettings).where(eq(tenantInvoiceSettings.tenantId, tenant.ctx.slug)));
  expect(s).toMatchObject({ enabled: false, rolling: 30, calendar: 31, page: 200 });
  // CHECK rejects out-of-range lead days
  await expect(runInTenant(tenant.ctx, (tx) =>
    tx.update(tenantInvoiceSettings).set({ autoInvoiceLeadDaysCalendar: 200 })
      .where(eq(tenantInvoiceSettings.tenantId, tenant.ctx.slug)))).rejects.toThrow();
  await tenant.cleanup();
});
```

- [ ] **Step 4: Run migration + test.** `pnpm db:migrate` then `pnpm test:integration tests/integration/invoicing/auto-invoice-schema.test.ts` → PASS.
- [ ] **Step 5: `pnpm typecheck` then commit.** `git add drizzle/ src/modules/*/infrastructure/db/ src/modules/renewals/infrastructure/schema-renewal-cycles.ts tests/integration/invoicing/auto-invoice-schema.test.ts && git commit -m "feat(auto-invoice): schema — invoice_origin + enrolment/settings columns (mig 0259)"`

---

## Task 2: F8 audit events (`renewal_auto_drafted` + `renewal_auto_draft_discarded`) — 8-place lockstep

**Files (all 8 places — recon confirmed the spec's list of 7 omits places 7 & 8):**
- Modify: `src/modules/renewals/application/use-cases/../application/ports/renewal-audit-emitter.ts` (tuple :233 + assertion :241,243 + optional payload shapes :313-1287 + `cron_kind` union :1142-1148 + `kind_specific` :1196-1201)
- Modify: `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-audit-emitter.ts` (`F8_ENUM_SHIPPED_TUPLE` :251)
- Create: `drizzle/migrations/0260_auto_invoice_audit_events.sql` (2× `ALTER TYPE ADD VALUE`) + `_journal.json` entry (0259 is already applied to dev — a NEW migration, not an append)
- Modify: `tests/unit/renewals/application/ports.test.ts:63` (`70`→`72`)
- Modify: `tests/contract/renewals-audit-port.contract.test.ts:65` (title) + `:75` (`toHaveLength(70)`→`72`)
- Modify: `src/modules/auth/infrastructure/db/schema.ts` (`auditEventTypeEnum` tuple before :428 — **NOT** `DB_ONLY`)
- Modify: `scripts/lib/enum-migration-guard.ts:92-102` (`REQUIRED_ENUM_VALUES.audit_event_type` +2)
- Modify: `src/lib/metrics.ts` (`coordinatorAuditEmitFailed` :2328-2337 + `coordinatorSkippedReadOnly` :3204-3205 — add `'auto_draft'`)
- Modify: `src/i18n/messages/{en,th,sv}.json` (`audit.eventType` — 2 keys each)
- Test: `tests/integration/renewals/auto-draft-audit-completeness.test.ts`

**Interfaces:**
- Produces: `F8AuditEventType` gains `'renewal_auto_drafted' | 'renewal_auto_draft_discarded'`; `cron_dispatch_orchestrated.payload.cron_kind` gains `'auto_draft'`.

- [ ] **Step 1: Add the two literals to the catalogue tuple** `renewal-audit-emitter.ts` (after `'payment_on_terminated_member',` at :232): `'renewal_auto_drafted',` `'renewal_auto_draft_discarded',`. Bump `_AssertF8AuditEventCount` `extends 70`→`72` (:241) and the error string `expected 70`→`72` (:243). Add typed payload shapes to `F8AuditPayloadShapes` (mirror `renewal_lapse_deferred_invoice_not_due` :1262-1267):
```ts
readonly renewal_auto_drafted: {
  readonly cycle_id: CycleId; readonly member_id: MemberId;
  readonly plan_year: number; readonly frozen_price_thb: string;
  readonly coverage_from: string; readonly coverage_to: string;
};
readonly renewal_auto_draft_discarded: {
  readonly cycle_id: CycleId; readonly member_id: MemberId;
  readonly invoice_id: string; readonly reason: 'manual' | 'superseded_on_issue' | 'pruned_left_window';
};
```
Add `'auto_draft'` to the `cron_kind` union (:1142-1148) and a `kind_specific` arm `| { readonly kind: 'auto_draft'; readonly errors: number; readonly drafted?: number; readonly skipped?: number }` (:1196-1201).

- [ ] **Step 2: Add both to `F8_ENUM_SHIPPED_TUPLE`** (`drizzle-renewal-audit-emitter.ts` before :251, after `'payment_on_terminated_member',`). These ship wired in this same feature → SHIPPED, not `_F8_ENUM_DEFERRED`. (Omitting this is the exact `pinoFallback` prod-throw the spec warns of.)

- [ ] **Step 3: Create a NEW migration `0260_auto_invoice_audit_events.sql`** (0259 is already applied to dev, so append is wrong — a fresh migration is applied by `db:migrate`). Append its `_journal.json` entry (next `idx`, `+100000ms` `when` cadence):
```sql
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_auto_drafted';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_auto_draft_discarded';
```

- [ ] **Step 4: Update the count assertions + enum tuples + guard + metrics unions.** `ports.test.ts:63` → `toBe(72)`. `renewals-audit-port.contract.test.ts:65` title `72`, `:75` `toHaveLength(72)`. `schema.ts` `auditEventTypeEnum` tuple before `]);` (:428): add both literals. `enum-migration-guard.ts` `REQUIRED_ENUM_VALUES.audit_event_type`: add both. `metrics.ts` `coordinatorAuditEmitFailed` (:2337) + `coordinatorSkippedReadOnly` (:3205): add `| 'auto_draft'`.

- [ ] **Step 5: Add i18n labels (all 3 locales, real translations).** In `audit.eventType` (`en.json` ~:5640): `"renewal_auto_drafted": "Renewal draft auto-created"`, `"renewal_auto_draft_discarded": "Renewal auto-draft discarded"`. `th.json`: `"renewal_auto_drafted": "สร้างร่างใบแจ้งหนี้ต่ออายุอัตโนมัติ"`, `"renewal_auto_draft_discarded": "ยกเลิกร่างใบแจ้งหนี้ต่ออายุอัตโนมัติ"`. `sv.json`: `"renewal_auto_drafted": "Förnyelseutkast skapat automatiskt"`, `"renewal_auto_draft_discarded": "Automatiskt förnyelseutkast kasserat"`.

- [ ] **Step 6: Write the failing live-Neon completeness test** `auto-draft-audit-completeness.test.ts` — proves both events persist through `emitInTx` (mocks cannot catch the `pinoFallback`-throw class):
```ts
it('both new F8 events persist via emitInTx (pgEnum + F8_ENUM_SHIPPED)', async () => {
  const tenant = await createTestTenant('auto-draft-audit');
  const deps = makeRenewalsDeps(tenant.ctx.slug);
  await runInTenant(tenant.ctx, (tx) =>
    deps.auditEmitter.emitInTx(tx,
      { type: 'renewal_auto_drafted', payload: { cycle_id: asCycleId(randomUUID()), member_id: asMemberId(randomUUID()), plan_year: 2027, frozen_price_thb: '12000.00', coverage_from: '2027-01-01', coverage_to: '2027-12-31' } },
      { tenantId: tenant.ctx.slug, actorUserId: null, actorRole: 'cron', correlationId: 'test', requestId: 'test' }));
  const [row] = await runInTenant(tenant.ctx, (tx) =>
    tx.select().from(auditLog).where(and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.eventType, 'renewal_auto_drafted'))));
  expect(row).toBeDefined();
  await tenant.cleanup();
});
```
- [ ] **Step 7: Run the gates.** `pnpm db:migrate` → `pnpm typecheck` → `pnpm test tests/unit/renewals/application/ports.test.ts tests/contract/renewals-audit-port.contract.test.ts` → `pnpm check:audit-counts` → `pnpm test tests/unit/insights/audit-event-label-coverage.test.ts` → `pnpm test:integration tests/integration/renewals/auto-draft-audit-completeness.test.ts`. All GREEN.
- [ ] **Step 8: Commit.** `git commit -m "feat(auto-invoice): F8 audit events renewal_auto_drafted/_discarded + cron_kind auto_draft (8-place lockstep, 70→72)"`

---

## Task 3: `FEATURE_AUTO_INVOICE` env flag

**Files:** Modify `src/lib/env.ts` (schema :449 area + `features` object :1004). Test: `tests/unit/lib/env-auto-invoice.test.ts`.

**Interfaces:** Produces `env.features.autoInvoice: boolean` (default `false`).

- [ ] **Step 1: Failing test** — `env-auto-invoice.test.ts`: unset var → `false`; `FEATURE_AUTO_INVOICE='true'` → `true` (mirror an existing env flag test).
- [ ] **Step 2: Implement.** Add `FEATURE_AUTO_INVOICE: booleanFromString.default(false),` to the schema object; add `autoInvoice: raw.FEATURE_AUTO_INVOICE,` to `features` (after `voidOnReissue:` ~:1004).
- [ ] **Step 3: Run test → PASS. Step 4: typecheck + commit** `feat(auto-invoice): FEATURE_AUTO_INVOICE env flag (default off)`.

---

## Task 4: `autoEmailOverride` param on the issue path

**Files:** Modify `src/modules/invoicing/application/use-cases/issue-invoice.ts` (`issueInvoiceSchema` :116-142, resolution :857-858). Test: `tests/integration/invoicing/issue-auto-email-override.test.ts`.

**Interfaces:**
- Consumes: `issueMembershipBill` forwards `IssueInvoiceInput` verbatim (recon — no signature change there).
- Produces: `IssueInvoiceInput` gains `autoEmailOverride?: boolean`; resolution becomes `input.autoEmailOverride ?? draft.autoEmailOnIssue ?? settings.autoEmailEnabled`. Threads through `issueMembershipBill` and the bridge automatically.

- [ ] **Step 1: Failing integration test** (draft persisted `autoEmailOnIssue=false`; tenant `auto_email_enabled=true`):
  - issue with `autoEmailOverride: undefined` → **0** outbox rows (respects the explicit draft `false`).
  - issue with `autoEmailOverride: true` → exactly **1** outbox row. (Mirror `issue-membership-bill.test.ts` outbox-assert harness with the email adapter mocked to count enqueues.)
- [ ] **Step 2: Run → FAIL** (param not accepted / ignored).
- [ ] **Step 3: Implement.** Add `autoEmailOverride: z.boolean().optional(),` to `issueInvoiceSchema`. Change :857-858 to `const shouldAutoEmail = input.autoEmailOverride ?? draft.autoEmailOnIssue ?? settings.autoEmailEnabled;`.
- [ ] **Step 4: Run → PASS. Step 5: typecheck + commit** `feat(invoicing): autoEmailOverride issue param (threads through issueMembershipBill)`.

---

## Task 5: Bridge methods `draftInvoiceForRenewal` + `issueExistingDraftForRenewal`

**Files:** Modify `src/modules/renewals/application/ports/f4-invoicing-bridge.ts` (interface :125-129 + input/result types :30-123); `src/modules/renewals/infrastructure/ports-adapters/f4-invoicing-for-renewal-bridge-drizzle.ts` (object literal). Test: `tests/integration/renewals/f4-bridge-draft-issue.test.ts`.

**Interfaces:**
- Produces (port):
```ts
draftInvoiceForRenewal(input: {
  readonly tenantId: string; readonly memberId: string; readonly planId: string;
  readonly planYear: number; readonly frozenPlanPriceThb: ThbDecimal;
  readonly membershipCoverage?: CreateInvoiceDraftInput['membershipCoverage'];
  readonly actorUserId: string; readonly requestId: string | null;
}): Promise<{ status: 'drafted'; invoiceId: string } | { status: 'draft_failed'; errorCode: RenewalInvoiceErrorCode; detail: string }>;

issueExistingDraftForRenewal(input: {
  readonly tenantId: string; readonly invoiceId: string; readonly actorUserId: string;
  readonly autoEmailOnIssue: boolean; readonly requestId: string | null;
}): Promise<IssueInvoiceForRenewalResult>;  // reuse the existing 'issued' | 'issue_failed' union
```
- Consumes: `createInvoiceDraft` (create-half), `issueMembershipBill` (issue-half, passing `autoEmailOverride: input.autoEmailOnIssue`), `billFirstDocumentNumber`, `makeCreateInvoiceDraftDeps`/`makeIssueMembershipBillDeps` (all `@/modules/invoicing` barrel).

- [ ] **Step 1: Failing integration test** — `draftInvoiceForRenewal` → a `status='draft', origin='auto_renewal', autoEmailOnIssue=false` invoice with **no** `bill_document_number_raw`/PDF/outbox; then `issueExistingDraftForRenewal({autoEmailOnIssue:false})` on that draft → `status:'issued'`, number minted, 0 outbox; with `autoEmailOnIssue:true` → 1 outbox. (Note: `origin='auto_renewal'` is set by the *use-case* Task 7, not the bridge — the bridge's `createInvoiceDraft` call cannot set origin; **the draft-creation use-case stamps `origin` in the same tx via a follow-up update, OR** add an `origin` passthrough to `createInvoiceDraft`. **Decision: add `origin?: 'manual'|'auto_renewal'` to `createInvoiceDraftSchema` (default omitted→'manual' at insert) — one column, mirrors `autoEmailOnIssue`.** Fold this into Task 5 Step 3.)
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Add `origin` to `createInvoiceDraftSchema` + `insertDraft` (`create-invoice-draft.ts`). Add both methods to the port interface and the adapter object literal. `draftInvoiceForRenewal` = the `createInvoiceDraft(...)` half of `issueInvoiceForRenewal` (spread `membershipCoverage` with the `exactOptionalPropertyTypes` omit-guard; pass `origin:'auto_renewal'`, `autoEmailOnIssue:false`). `issueExistingDraftForRenewal` = `issueMembershipBill(makeIssueMembershipBillDeps(tenantId), { tenantId, actorUserId, requestId, invoiceId, autoEmailOverride: input.autoEmailOnIssue })` then map to the `issued`/`issue_failed` union, surfacing `supersedeWarnings` + `billFirstDocumentNumber(issued) ?? ''`.
- [ ] **Step 4: Run → PASS. Step 5: typecheck + grep `tests/` for bridge stubs** (`grep -rn "issueInvoiceForRenewal" tests/`) to update any stale stub (port-method-stale-stub class), run the renewals module suite, **commit** `feat(auto-invoice): bridge draftInvoiceForRenewal + issueExistingDraftForRenewal`.

---

## Task 6: `listCyclesEligibleForAutoDraft` repo method

**Files:** Modify `src/modules/renewals/application/ports/renewal-cycle-repo.ts` (add signature near `listCyclesEligibleForAwaitingPayment`); `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts` (impl mirroring :1002-1035). Test: `tests/integration/renewals/list-eligible-auto-draft.test.ts`.

**Interfaces:**
- Produces: `listCyclesEligibleForAutoDraft(args: { readonly nowIso: string; readonly leadDaysRolling: number; readonly leadDaysCalendar: number; readonly pageSize: number }): Promise<{ readonly cycles: readonly RenewalCycle[]; readonly nextCursor: null }>` — bound to tenant via the repo factory.
- Eligibility (spec §5.1): `status IN ('upcoming','reminded') AND expires_at > nowIso AND expires_at <= nowIso + (members.billing_cycle='calendar' ? leadDaysCalendar : leadDaysRolling) days AND members.archived_at IS NULL AND members.status <> 'archived' AND members.auto_invoice_enrolled_at IS NOT NULL AND NOT EXISTS (a live membership invoice for member+plan_year: status IN ('draft','issued','paid','partially_credited','credited'))`. Join `members` on `(tenant_id, member_id)`.

- [ ] **Step 1: Failing integration test** — seed 4 members: (a) enrolled rolling cycle expiring in 20d → **included**; (b) enrolled but with a live `issued` membership invoice for the plan_year → **excluded** (dedup); (c) not enrolled (`auto_invoice_enrolled_at IS NULL`) → excluded; (d) enrolled calendar cycle expiring in 35d with `leadDaysCalendar=31` → excluded (outside window), then re-query with a 40d-out `nowIso` to include. Assert `cycles` membership by id.
- [ ] **Step 2: Run → FAIL. Step 3: Implement** the Drizzle query (own `runInTenant`, join members, the `NOT EXISTS` correlated membership-invoice subquery keyed on `deriveFiscalYear`-equivalent plan_year — since `plan_year` is derived, the subquery matches `invoices.member_id = cycle.member_id AND invoices.invoice_subject='membership' AND invoices.status IN (...)` scoped to the fiscal year of `cycle.period_from` via `invoices.plan_year = EXTRACT-fiscal(period_from)`; compute the target plan_year in TS from each row is not possible in a set query → filter the member-scoped live-bill EXISTS and let the use-case do the per-cycle plan_year re-check under lock). Keep single-page (`nextCursor: null`), `ORDER BY expires_at ASC LIMIT pageSize`.
- [ ] **Step 4: Run → PASS. Step 5: typecheck, update repo stubs in `tests/`, commit** `feat(auto-invoice): listCyclesEligibleForAutoDraft eligibility query`.

---

## Task 7: `auto-draft-due-renewals` use-case (cron worker body)

**Files:** Create `src/modules/renewals/application/use-cases/auto-draft-due-renewals.ts`; barrel-export in `src/modules/renewals/index.ts` (mirror `enterAwaitingPaymentOnExpiry` :662-669). Test: `tests/integration/renewals/auto-draft-due-renewals.test.ts`.

**Interfaces:**
- Consumes: `deps.cyclesRepo.listCyclesEligibleForAutoDraft` (T6), `deps.cyclesRepo.acquireCycleLockInTx`, `deps.cyclesRepo.findByIdInTx`, `deps.f4InvoicingBridge.draftInvoiceForRenewal` (T5), `deps.auditEmitter.emitInTx`, `deps.clock`.
- Produces: `autoDraftDueRenewals(deps: RenewalsDeps, input: { tenantId: string; correlationId: string }): Promise<Result<{ drafted: number; skipped_existing: number; skipped_opt_out: number; skipped_terminated: number; errors: number; cyclesProcessed: number }, ...>>`. Invariant (exhaustive-switch pin): `drafted + skipped_* + errors === cyclesProcessed`.

- [ ] **Step 1: Failing integration test** (live Neon), mirroring `enter-awaiting-payment-on-expiry.ts` TOCTOU per-cycle shape:
  - enrolled due member → exactly **1** `draft`, `origin='auto_renewal'`, coverage window `[periodTo, addMonthsUtc(periodTo, frozenPlanTermMonths)]`, `frozen_price` = cycle's `frozenPlanPriceThb`, `autoEmailOnIssue=false` explicit, **no** number/PDF/outbox; a `renewal_auto_drafted` audit row exists.
  - **re-run** → no second draft (dedup: the live draft now matches the EXISTS check).
  - a member who became terminated (lapsed-portal-scope) → `skipped_terminated`, no draft.
  - **batch isolation**: stub the bridge to reject for one member mid-batch → that member counts `errors`, others still drafted; invariant holds.
- [ ] **Step 2: Run → FAIL. Step 3: Implement** the batch loop + `processOne` (per-cycle `runInTenant`: `acquireCycleLockInTx('renewals:autodraft' is the WORKER-route lock; here use the per-cycle `renewals:<tenant>:<cycle>` lock) → `findByIdInTx` re-read → re-validate `status IN upcoming|reminded` → derive `planYear = deriveFiscalYear(cycle.periodFrom)` → re-check no live membership invoice for member+planYear → membership-access re-assert (terminated/suspended → `skipped_terminated`) → `classifyMembershipPayment` coverage-omit gate → `draftInvoiceForRenewal({..., membershipCoverage:{kind:'window',fromIso:cycle.periodTo.slice(0,10),toIso:addMonthsUtc(cycle.periodTo,cycle.frozenPlanTermMonths).slice(0,10)}})` → on `status:'drafted'` optionally stamp `renewal_cycles.auto_draft_invoice_id` + `emitInTx renewal_auto_drafted` in the same tx → return the outcome bucket). Per-cycle `try/catch` fault isolation, exhaustive switch.
- [ ] **Step 4: Run → PASS. Step 5: typecheck + commit** `feat(auto-invoice): auto-draft-due-renewals worker use-case`.

---

## Task 8: Auto-draft cron routes (coordinator + worker) + `vercel.json`

**Files:** Create `src/app/api/cron/renewals/auto-draft-coordinator/route.ts` (mirror `enter-awaiting-payment-coordinator/route.ts`) + `src/app/api/cron/renewals/auto-draft/[tenantId]/route.ts` (mirror `enter-awaiting-payment/[tenantId]/route.ts`). Modify `vercel.json` (1 row: coordinator only). Test: `tests/integration/renewals/auto-draft-cron.test.ts` + a contract test for bearer/flag-off.

**Interfaces:**
- Consumes: `gateCronBearerOrRespond`, `env.features.f8Renewals && env.features.autoInvoice`, `env.flags.readOnlyMode`, `makeRenewalsDeps`, `autoDraftDueRenewals` (T7).
- Coordinator emits `cron_dispatch_orchestrated { cron_kind: 'auto_draft', kind_specific: { kind:'auto_draft', errors, drafted, skipped } }`.

- [ ] **Step 1: Failing tests.** (a) Coordinator with no bearer → 401. (b) `FEATURE_AUTO_INVOICE=false` (both keys) → `200 {skipped:true}`, nothing created. (c) `readOnlyMode` → `200 {skipped}`. (d) Worker with valid bearer + flags on → drafts the cohort, returns counters.
- [ ] **Step 2: Run → FAIL. Step 3: Implement** both routes. Coordinator: `runtime='nodejs'`, `dynamic='force-dynamic'`, `export const GET = POST`, gate → flag short-circuit (`if (!env.features.f8Renewals || !env.features.autoInvoice) return 200 {skipped}`) → readOnly short-circuit → `correlationId=uuidv7()` → `withActiveSpan` → `Promise.allSettled([env.tenant.slug].map(fetch worker with Bearer))` → map to `PerTenantResult[]` → `makeRenewalsDeps().auditEmitter.emit(cron_dispatch_orchestrated, {cron_kind:'auto_draft', ...})` in try/catch. Worker: bearer → flag guard → `tenantId===env.tenant.slug else 400` → regenerate `correlationId` → `runInTenant` → advisory lock `` sql`SELECT pg_advisory_xact_lock(hashtextextended(${`renewals:autodraft:${tenantId}`}, 0))` `` → `autoDraftDueRenewals(deps, {tenantId, correlationId})` → 200 counters. Add the `vercel.json` row `{ "path": "/api/cron/renewals/auto-draft-coordinator", "schedule": "0 22 * * *" }` (05:00 ICT, before the 06:00 dispatch chain). Worker is NOT registered.
- [ ] **Step 4: Run → PASS. Step 5: typecheck + commit** `feat(auto-invoice): auto-draft cron (coordinator + worker) + vercel.json`.

---

## Task 9: `issueAutoDraftedRenewal` use-case (queue action — the core)

**Files:** Create `src/modules/renewals/application/use-cases/issue-auto-drafted-renewal.ts`; barrel-export. Test: `tests/integration/renewals/issue-auto-drafted-renewal.test.ts` (incl. the **paid-race ship-blocker** test).

**Interfaces:**
- Consumes: content-guard read (live membership invoice for member+plan_year), `deps.f4InvoicingBridge.issueExistingDraftForRenewal` (T5), `deps.cyclesRepo.transitionStatus` (accepts `linkedInvoiceId` — flip `awaiting_payment` + stamp link in one CAS), `deps.cyclesRepo.acquireCycleLockInTx`, draft-discard (own tx, `requireStatus:'draft'`), `deps.auditEmitter`.
- Produces: `issueAutoDraftedRenewal(deps, input: { tenantId; invoiceId: string; actorUserId: string; sendEmail: boolean; requestId: string | null }): Promise<Result<{ invoiceId; invoiceNumber; supersedeWarnings: readonly string[] }, IssueAutoDraftError>>` where `IssueAutoDraftError` includes `duplicate_live_bill | member_terminated | draft_not_found | issue_failed | cycle_not_found`.

**Topology (3-tx create→issue→link, mirrors `confirm-renewal.ts`; the draft already exists):**

- [ ] **Step 1: Failing tests** (live Neon):
  - **Issue silently** (`sendEmail:false`, tenant `auto_email_enabled=true`) → number minted, cycle `awaiting_payment` + `linked_invoice_id` set, `createNextCycleOnPaid` untouched, **0** outbox.
  - **Issue + Send** (`sendEmail:true`) → exactly **1** locale-correct outbox row; empty-recipient → skipped-with-warning.
  - **Terminated-after-draft** → member terminated post-draft → Issue is **blocked inside the use-case** (`member_terminated`), not just the query.
  - **Content pre-issue guard (paid-race — SHIP BLOCKER)** → an orphan/unlinked bill B1 `paid` for member+plan_year exists → Issue on the draft is **refused** (`duplicate_live_bill`); no second §86/4.
  - **Draft-discard** → an orphan sibling `status='draft'` for member+plan_year is discarded on issue (own-tx, `requireStatus:'draft'`); a concurrently-promoting draft is not clobbered.
  - **Orphan recovery** → issue succeeds, link tx forced to fail once → the idempotent link retry re-links; no duplicate.
- [ ] **Step 2: Run → FAIL. Step 3: Implement:**
  - **tx1** (`runInTenant`, per-cycle lock): re-read the draft + its cycle; derive `planYear = deriveFiscalYear(cycle.periodFrom)`; re-assert membership access (terminated/suspended → `member_terminated`); **content guard** = `NOT EXISTS live membership invoice for (member, plan_year) IN {draft,issued,paid,partially_credited,credited} EXCLUDING this draft` → else `duplicate_live_bill`.
  - **issue** (outside tx): `issueExistingDraftForRenewal({ invoiceId, autoEmailOnIssue: input.sendEmail, ... })`; non-`issued` → map error.
  - **tx2** (`runInTenant`, per-cycle lock): `transitionStatus({ from: cycle.status, to: 'awaiting_payment', linkedInvoiceId: invoiceId })` (flip + stamp in one CAS; converge on `CycleTransitionConflictError` by re-reading — if already `awaiting_payment` linked to this invoice, no-op). **Decision on `renewal_entered_awaiting_payment`:** rely on `invoice_issued` (from the F4 issue path) for the audit trail and do NOT emit `renewal_entered_awaiting_payment` (avoids expanding its closed `'cron'|'confirm'` source union) — the transition itself is captured by `linked_invoice_id` + `invoice_issued`. Emit nothing new here beyond what F4 emits.
  - **tx3** (own tx, post-issue): draft-discard — `DELETE ... WHERE origin='auto_renewal' AND status='draft' AND member+plan_year AND id <> issuedId` (no-ops safely if a concurrent tx is promoting) → emit `renewal_auto_draft_discarded { reason:'superseded_on_issue' }` per discarded row.
  - **link retry**: if tx2 `linkInvoice`/`transitionStatus` fails, retry once idempotently; a persistent failure returns success-with-warning (the burned-number orphan is caught by Task 11's reconcile cron).
- [ ] **Step 4: Run → PASS (paid-race test is a hard gate). Step 5: typecheck + commit** `feat(auto-invoice): issueAutoDraftedRenewal (content-guard + 3-tx + draft-discard)`.

---

## Task 10: `issue/route.ts` refusal of an auto-renewal / cycle-linked membership draft

**Files:** Modify the generic invoice issue route/use-case entry (`src/app/api/invoices/[invoiceId]/issue/route.ts` or the issue server action). Test: `tests/contract/issue-route-auto-renewal-refusal.contract.test.ts`.

**Interfaces:** Consumes `invoices.origin`. Produces a typed error (`origin_auto_renewal_use_queue`) → the renewals queue; a non-renewal membership draft is unaffected.

- [ ] **Step 1: Failing contract test** — POST a `status='draft', origin='auto_renewal'` membership invoice to the generic issue route → typed refusal (not issued via bare `issueInvoice`); a `origin='manual'` membership draft → issues normally.
- [ ] **Step 2: Run → FAIL. Step 3: Implement** the guard at the route/use-case boundary (`if (draft.origin === 'auto_renewal') return err('origin_auto_renewal_use_queue')`). Enforcement, not UI-hiding.
- [ ] **Step 4: Run → PASS. Step 5: typecheck + commit** `feat(auto-invoice): issue route refuses auto_renewal drafts (use the queue)`.

---

## Task 11: `prune-auto-drafts` + `reconcile-issued-orphans` housekeeping crons

**Files:** Create use-cases `prune-auto-drafts.ts` + `reconcile-issued-orphans.ts` (+ barrel exports); routes `src/app/api/cron/renewals/prune-auto-drafts/route.ts` + `.../reconcile-issued-orphans/route.ts` (mirror the single-route `prune-consumed-tokens/route.ts` template — no fan-out, no `[tenantId]`, may omit the advisory lock since writes are idempotent). Modify `vercel.json` (2 rows). Test: `tests/integration/renewals/auto-draft-housekeeping.test.ts`.

**Interfaces:** Both idempotent, `GET=POST`, `200 {skipped}` when flags off/readOnly.

- [ ] **Step 1: Failing tests** — (a) prune: a `origin='auto_renewal' status='draft'` invoice whose cycle left `upcoming|reminded` (member self-renewed / lapsed) → discarded, emits `renewal_auto_draft_discarded { reason:'pruned_left_window' }`; idempotent (2nd run no-op); throw-path (one row errors → others still pruned). (b) reconcile: an `origin='auto_renewal' status='issued'` invoice whose cycle has `linked_invoice_id IS NULL` → re-linked; idempotent; a never-relinked orphan is caught here (not left to unlinked-settlement).
- [ ] **Step 2: Run → FAIL. Step 3: Implement** both use-cases + routes + the 2 `vercel.json` rows (`prune-auto-drafts` daily, `reconcile-issued-orphans` daily; pick UTC slots in the renewals block within the 40-cron budget — 32 used + auto-draft (1) + these (2) = 35).
- [ ] **Step 4: Run → PASS. Step 5: typecheck + commit** `feat(auto-invoice): prune-auto-drafts + reconcile-issued-orphans crons`.

---

## Task 12: §5.8a reminder handoff — scoped `dueTrackCycleIds` extension

**Files:** Modify `src/modules/renewals/infrastructure/drizzle/drizzle-dispatch-candidate-repo.ts` (`listDueTrackCandidates` :401-500 — add an **isolated** cycle-linked conjunct/read, do NOT touch the :414-436 floor). Test: `tests/integration/renewals/due-track-auto-issue-handoff.test.ts` + the quiet-window converse `#9c`.

**Interfaces:** Adds cycles with `linked_invoice_id IS NOT NULL AND status='issued'` (membership bill) to the due-track candidate set (→ `dueTrackCycleIds`), **without** widening the `[expiry, due+7)` quiet window for cycles *without* an issued bill.

- [ ] **Step 1: Failing tests** — (a) handoff: a member auto-issued via Task 9 → the cycle is `awaiting_payment` with a live issued membership bill → the ladder email step stands down (in `dueTrackCycleIds`) and due-track takes over at due+7/+30 (one stream). (b) **#9c quiet-window unchanged**: a cycle *without* an issued bill still observes `[expiry, due+7)` — assert `findDueTrackStepsDue` returns `[]` and the ladder is NOT suppressed (mirror `due-track-dispatch.test.ts` case F/H + `due-track.test.ts:21-22`, and keep `due-track-candidates.test.ts` floor/exclusion pins green).
- [ ] **Step 2: Run → FAIL. Step 3: Implement** the scoped signal: add the cycle-linked condition as its own conjunct/OR-branch that only *adds* qualifying cycles, leaving the `period_from − 60d` floor and the `findDueTrackStepsDue` `7|30` offsets untouched. (Optional I5 mitigation — a fresh per-candidate read in `dispatch-renewal-cycle.ts:372-399` — is out of scope unless the same-pass double-touch proves real; note it, don't build it.)
- [ ] **Step 4: Run → PASS (both the handoff AND the unchanged-quiet-window pins). Step 5: typecheck + commit** `feat(auto-invoice): scoped due-track handoff (cycle has live issued bill); quiet window preserved`.

---

## Task 13: Admin review queue — filtered view + drift/staleness display

**Files:** Modify `list-invoices.ts` (schema :56-103, thread :112-133), `invoice-repo.ts` (`listPaged` opts :122-151), `drizzle-invoice-repo.ts` (`listPaged` — `eq(invoices.origin, ...)`), admin invoices `page.tsx` (filter parse :178-227, spread :239-268, `includeDrafts` :181, row-VM :421-505), `invoice-filters.tsx` (gated behind `env.features.autoInvoice`). Modify `src/i18n/messages/{en,th,sv}.json` (`admin.invoices.autoRenewalQueue.*`). Test: `tests/integration/invoicing/list-invoices-origin-filter.test.ts` + a page render test.

**Interfaces:** Produces an `origin?: 'manual'|'auto_renewal'` filter through list-invoices → repo; a queue view forcing `includeDrafts:true` when `origin='auto_renewal'`; per-row `queueMeta` (drift flag, bill-year≠coverage-year note, staleness age, `supersedeWarnings` placeholder).

- [ ] **Step 1: Failing test** — `listInvoicesPaged({ origin:'auto_renewal', status:'draft' })` returns only auto-renewal drafts (assert BUG-015 `includeDrafts` is forced for the queue). Drift: seed a cycle whose `frozenPlanPriceThb` ≠ current catalogue price → row VM has `driftFlagged:true`.
- [ ] **Step 2: Run → FAIL. Step 3: Implement** the filter end-to-end (schema/port/repo/page), the queue view gated on `env.features.autoInvoice`, and server-side `queueMeta` in the row-VM (drift via exact-satang inequality vs `loadPlanFrozenFields('offer')` catalogue price; staleness via `now − created_at`; bill-year≠coverage-year note when `deriveFiscalYear(issueDate)` ≠ coverage window year). Add i18n strings.
- [ ] **Step 4: Run → PASS + `pnpm check:i18n`. Step 5: typecheck + commit** `feat(auto-invoice): admin auto-renewal review queue (filter + drift/staleness display)`.

---

## Task 14: Queue actions — Issue + Send / Issue silently / Discard

**Files:** Create `src/app/api/invoices/[invoiceId]/issue-auto-drafted/route.ts` (→ `issueAutoDraftedRenewal`, `sendEmail` from body) + `src/app/api/invoices/[invoiceId]/discard-auto-draft/route.ts` (→ delete draft + `renewal_auto_draft_discarded { reason:'manual' }`). Create `auto-renewal-queue-actions.tsx` (per-row `DropdownMenu` mirroring `invoice-more-menu.tsx` + `ConfirmationDialog`). Wire into `invoice-table.tsx` Actions cell (admin-gated). i18n `admin.invoices.autoRenewalQueue.actions.*`. Test: contract tests for both routes + a component interaction test.

**Interfaces:** Consumes `issueAutoDraftedRenewal` (T9). Both routes admin-gated (`requireAdminContext`, `resource:'invoices:write'`), Idempotency-Key, POST.

- [ ] **Step 1: Failing contract tests** — issue-auto-drafted route: non-admin → 403; valid admin + `sendEmail:false` → issues silently (0 outbox); `sendEmail:true` → 1 outbox; a `duplicate_live_bill` from the use-case → 409 typed. discard route: admin → draft deleted + audit; non-draft → 409.
- [ ] **Step 2: Run → FAIL. Step 3: Implement** both routes + the row-action dialog component (Issue+Send / Issue silently / Discard; `supersedeWarnings` surfaced in a success toast; confirm via generic `ConfirmationDialog`, `closeOnConfirm:false`). Hide Issue on already-issued rows (`if visibleCount===0 return null`).
- [ ] **Step 4: Run → PASS. Step 5: typecheck + commit** `feat(auto-invoice): queue row actions (Issue+Send / Issue silently / Discard) + routes`.

---

## Task 15: Enrolment bulk action + member-profile badge

**Files:** Create `src/modules/members/application/use-cases/bulk-enrol-auto-invoice.ts` (+ barrel export). Modify `src/app/(staff)/admin/members/_components/bulk-action-bar.tsx` (`BulkAction` :31 += `'enrol_auto_invoice'`, button :180-201), `src/app/api/members/bulk/route.ts` (dispatch — atomic `bulkAction`-style UPDATE `auto_invoice_enrolled_at = now()` for non-terminated members, per-member skip buckets for already-enrolled/terminated), member `[memberId]/page.tsx` (read-only badge in the `PageHeader badge` slot :786-796). i18n `admin.members.bulk.actions.enrol_auto_invoice` + errors + confirm strings (all 3 locales). Test: `tests/integration/members/bulk-enrol-auto-invoice.test.ts` + route contract.

**Interfaces:** Produces `bulkEnrolAutoInvoice(deps, { tenantId; memberIds; actorUserId }): Promise<{ enrolled: number; skipped_already: number; skipped_terminated: number }>`.

- [ ] **Step 1: Failing tests** — bulk-enrol 3 members (one already enrolled, one terminated, one fresh) → `{ enrolled:1, skipped_already:1, skipped_terminated:1 }`; the fresh member's `auto_invoice_enrolled_at` is set. Route: non-admin → 403; cap enforced; idempotent via Idempotency-Key.
- [ ] **Step 2: Run → FAIL. Step 3: Implement** the use-case (tenant-scoped UPDATE, skip terminated via lapsed-portal-scope, skip already-enrolled), the bulk-bar button (generic `ConfirmationDialog`, non-destructive), the route dispatch arm, and the read-only "Auto-invoice enrolled" badge.
- [ ] **Step 4: Run → PASS + `pnpm check:i18n`. Step 5: typecheck + commit** `feat(auto-invoice): bulk enrol members + profile badge`.

---

## Task 16: Observability gauges + feed site

**Files:** Modify `src/lib/metrics.ts` (`renewalsMetrics` — add counters + gauges mirroring `reminderSent` :2845 and `observeMembershipSuspendedCountGauge` :3105). Add a gauge feed helper to the auto-draft coordinator route (mirror `dispatch-coordinator/route.ts:53-139`). Test: `tests/unit/lib/metrics-auto-invoice.test.ts`.

**Interfaces:** Produces `renewalsMetrics.autoDraftCreated(tenant)`, `autoDraftSkipped(tenant, reason)`, `autoDraftErrors(tenant)`, `observeAutoDraftQueueSizeGauge(tenant, n)`, `observeAutoDraftOldestAgeGauge(tenant, seconds)`.

- [ ] **Step 1: Failing test** — each counter/gauge emits its expected instrument name + `{tenant}` label (mirror `metrics-w009-renewals.test.ts` + `__test__readGaugeValues`).
- [ ] **Step 2: Run → FAIL. Step 3: Implement** the `safeMetric`-wrapped counters + hand-rolled lazy observable gauges (bare-tenant-key, per `observeMembershipSuspendedCountGauge`). Add the coordinator feed helper: one aggregate SQL under `runInTenant` (`COUNT(*) FILTER (origin='auto_renewal' AND status='draft')` + `EXTRACT(EPOCH FROM now()-min(created_at))`), best-effort try/catch, never blocks the cron.
- [ ] **Step 4: Run → PASS. Step 5: typecheck + commit** `feat(auto-invoice): queue-size + oldest-draft-age gauges + counters`.

---

## Task 17: Wiring, runbook, and dark-ship verification sweep

**Files:** Modify `src/modules/renewals/infrastructure/renewals-deps.ts` (confirm the new bridge methods + `listCyclesEligibleForAutoDraft` are reachable via `cyclesRepo`/`f4InvoicingBridge`; wire any new use-case deps), `src/modules/renewals/index.ts` (barrel — all new use-cases exported), `docs/runbooks/cron-jobs.md` (catalogue table :48-77 + `vercel.json` mapping :716-749 + a `## Auto-draft renewals` detail section with the **three-key enable procedure** and the **SC-year ≠ coverage-year** note). Test: `tests/integration/renewals/auto-invoice-dark-ship.test.ts` + advisory-lock disjointness + cross-tenant.

- [ ] **Step 1: Failing tests** — (a) **flag-off / read-only**: with all three keys off, the coordinator + worker create nothing (`200 {skipped}`), and `issueAutoDraftedRenewal` still works if called directly (the queue action is gated only at the route/UI, not the use-case). (b) **advisory-lock disjointness**: `renewals:autodraft:*` does not contend with `renewals:<tenant>:<cycle>` / `renewals:dispatch:` / `invoicing:` (assert by construction + a concurrency probe). (c) **cross-tenant**: eligibility + issue are tenant-scoped; a peer tenant is never drafted/issued.
- [ ] **Step 2: Run → FAIL where wiring is missing. Step 3: Implement** the deps/barrel wiring; write the runbook section (three-key procedure: `FEATURE_AUTO_INVOICE` env → `tenant_invoice_settings.auto_invoice_enabled` → bulk-enrol cohort; the SC-year≠coverage-year note; add the 3 new `vercel.json` rows to the mapping table, note 32→35 of 40).
- [ ] **Step 4: Run the full touched suites** — `pnpm typecheck && pnpm lint && pnpm test tests/unit/renewals tests/unit/invoicing && pnpm check:i18n && pnpm check:audit-counts && pnpm test:integration tests/integration/renewals tests/integration/invoicing`. Green.
- [ ] **Step 5: Commit** `feat(auto-invoice): wiring + runbook + dark-ship verification sweep`.

---

## Ship gate (before flipping `FEATURE_AUTO_INVOICE` in prod)

Not a task — a release checklist (spec §12): (0) all migrations applied on dev + failing-first money-path tests green on live Neon, **#1 landed** (done); (1) the mandatory `billing_cycle` admin-review pass (a filtered Members view + bulk-correct — reuse Task 15's bulk stack); (2) shadow: per-tenant `auto_invoice_enabled` + 2–3 member opt-in pilot, verify queue populates, zero emails, dedup + state-gate + gauges; (3) opt-in the calendar cohort ahead of a real ~Dec-1 batch, monitor queue-age alerts + prune; (4) steady state. The **paid-race content-guard test (Task 9)** is the hard ship-blocker.

---

## Self-Review (author checklist — completed)

**Spec coverage:** §5.1 cron→T7/T8; §5.2 draft-only→T5/T7; §5.3 queue→T13/T14; §5.4 idempotency/guard/discard/tx→T9; §5.5 orphan recovery→T9/T11; §5.6 cadence config→T1; §5.7 three-key + enrol UX→T3/T1/T15; §5.8 coexist + issue/route refusal→T10; §5.8a reminder handoff→T12; §5.9 email policy→T4/T7/T9; §5.10 drift flag→T13; §6 boundaries→T5/T17; §7 schema+audit→T1/T2; §7.1 i18n→T2/T13/T14/T15; §8 observability→T16/T17; §9 #1 dependency→T5/T9; §10 tests→each task's Step 1; §11 risks→covered; §12 rollout→ship-gate; §13 decisions→encoded.

**Type consistency (fixed inline):** `sendEmail` (T9 use-case) ↔ `autoEmailOnIssue` (T5 bridge) ↔ `autoEmailOverride` (T4 issue-invoice) — the boolean flows `sendEmail → autoEmailOnIssue → autoEmailOverride`; naming intentionally differs per layer (renewals verb / bridge noun / F4 param) and is documented at each interface. `origin='auto_renewal'` set via `createInvoiceDraft` passthrough (T5), not a post-hoc update. `planYear` always derived (never stored) — consistent across T6/T7/T9. `renewal_auto_draft_discarded.reason` union `'manual' | 'superseded_on_issue' | 'pruned_left_window'` defined once (T2) and used in T9/T11/T14.

**Placeholder scan:** none — every task Step 1 has concrete assertions, every implementation step cites exact anchors from recon.
