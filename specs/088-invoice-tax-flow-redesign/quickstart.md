# F4 Tax-Flow Redesign — Quickstart

**Feature**: 088 — Invoice / Receipt Tax-Flow Redesign (bill → ใบแจ้งหนี้)
**Branch**: `088-invoice-tax-flow-redesign`
**Audience**: a developer (or Claude Code session) picking up this feature for the first time.

> **One-paragraph orientation.** Today F4 issues a §86/4 **ใบกำกับภาษี / Tax Invoice at billing** and a **second** §86/4 (`receipt_combined`) at payment — two tax invoices per sale. For a service the VAT tax point (§78/1) is at **payment**, so this feature makes the pre-payment document a **non-tax ใบแจ้งหนี้ / Invoice** (own non-§87 `SC` bill number) and mints the single **ใบกำกับภาษี / ใบเสร็จรับเงิน** (§86/4 + §105ทวิ, `RC`, Original + Copy, dated at payment) only when money arrives. Membership dues are **VATable 7%** (RD ruling กค 0811/พ./2308) with **no withholding** on the payer (ม.65 ทวิ (13) + ท.ป.4/2528, ruling กค 0811/8542). Read `docs/superpowers/specs/2026-06-30-f4-invoice-receipt-tax-flow-redesign-design.md` (the 8-surface map with file:line refs) **before** touching code.

---

## 0. Read these in order before writing code

1. `specs/088-invoice-tax-flow-redesign/spec.md` — 7 user stories (US1/US2 = P1), FR-001…FR-021, SC-001…SC-007, 4 clarifications.
2. `specs/088-invoice-tax-flow-redesign/plan.md` — Constitution Check + Technical Context + Complexity Tracking (why the new `bill` stream is justified).
3. `docs/superpowers/specs/2026-06-30-f4-invoice-receipt-tax-flow-redesign-design.md` — **PRIMARY source.** The AS-IS file:line map, migrations, numbering re-architecture (§6), payment→receipt path (§7), credit notes (§8), Head-Office/Branch (§9), WHT footer (§10), tax-auditor traps (§16).
4. `docs/superpowers/specs/2026-06-30-f4-accountant-questions.md` — resolved tax basis + the 3 FACTS the accountant must confirm before ship.
5. `specs/088-invoice-tax-flow-redesign/research.md` + `data-model.md` (Phase 1 siblings) — decisions + the new columns / CHECK / index changes.
6. `.specify/memory/constitution.md` v1.4.2 — Principle I (tenant isolation), IV (PCI DSS — the payment path now mints the tax doc), Thai-tax §87 no-gaps.

---

## 1. Prerequisites

- F1–F8 on `main`; F4 (`007-invoices-receipts`) is the base this extends. Branch `088-invoice-tax-flow-redesign` checked out.
- Local dev per root `CLAUDE.md § Commands` — **pnpm** (not npm), dev on **:3100**, Node 22.
- `.env.local` points at the **`dev` Neon branch** (NOT prod — see `CLAUDE.md § Gotchas`; prod backup is `.env.local.bak.prod`). Integration tests refuse to run against prod (`tests/integration-setup.ts` blocklist guard).
- `vercel env pull .env.local` if you need the latest env. One new env var is introduced: **`FEATURE_088_TAX_AT_PAYMENT`** (T001; `booleanFromString`, **default `false`** — 088 ships dark). It gates BOTH the new bill→§87-at-payment flow AND the US8 `vat_treatment` zero-rate UI + render arm (G5), so US8 dark-launches independently of the P1 core. Flip it to `true` in Vercel env (alongside the SweCham settings flip in § 2.2) as the operator trigger; revert-the-flag + redeploy prior code + revert the settings flip is the rollback (NOT a DB down-migration — `ALTER TYPE … ADD VALUE 'bill'` + consumed §87 numbers are irreversible; plan § Rollout). The WHT note remains a DB column, never a literal or env value.

```bash
pnpm install
git branch --show-current      # expect: 088-invoice-tax-flow-redesign
pnpm typecheck && pnpm lint && pnpm test   # green baseline on the branch before you start
```

---

## 2. MIGRATION + CONFIG CUTOVER (do this before issuing ANY real document)

Two things must land together — the schema and the SweCham settings flip. **Steps 1+3 of `design.md §14` MUST ship together**: if `issue-invoice` keeps allocating a §87 `invoice` number while `record-payment` starts allocating a §87 `receipt` number, every sale mints **two** tax numbers (the exact duplicate-§86/4 this feature kills).

### 2.1 Apply the new migrations to the `dev` Neon branch

New DDL (≥3 migrations, next free index after `0229` — see `data-model.md`):
- `document_type` enum `+= 'bill'` (+ `'receipt_105'` if the D2 RC/RE split is taken).
- `invoices.bill_document_number_raw` + partial unique `(tenant_id, bill_document_number_raw) WHERE NOT NULL`; amended `invoices_draft_has_no_number` + `invoices_non_draft_has_snapshots` CHECKs (`schema-invoices.ts:247-286`).
- `members.is_head_office boolean NOT NULL DEFAULT true` + `branch_code char(5)`.
- `tenant_invoice_settings`: `wht_note_th` + `wht_note_en` (both NULL by default → no stray footer for other tenants) + `seller_is_head_office boolean NOT NULL DEFAULT true` + `seller_branch_code char(5)`.

```bash
pnpm db:generate               # if you edited Drizzle schema — generates the migration SQL
pnpm db:migrate                # applies to the dev Neon branch (.env.local); NOT prod
```

> **Gotcha (F4 R8 / migration-apply-before-commit):** any commit that adds a migration **and** code that references the new enum/column MUST run `pnpm db:migrate` then `pnpm test:integration` **before committing**. Unit-test mocks hide the schema gap — the failure only surfaces on live Neon.

### 2.2 Flip the SweCham `tenant_invoice_settings` row

The seeder (`scripts/seed-f4-invoice-settings.ts`) is `ON CONFLICT (tenant_id) DO NOTHING` and the row already exists → **re-seeding will NOT change it.** Use the settings form (US4) **or** a one-off `UPDATE`. Required values:

| column | value | why |
|---|---|---|
| `receipt_numbering_mode` | `'separate'` | mode is **always `'separate'`** now — the `'combined'` value + its number-reuse branch are **retired** (dropped from the accepted values / CHECK / form, fail-closed). The settings flip's **only remaining numbering job is the `RC` prefix** below |
| `receipt_number_prefix` | `'RC'` | the §86/4 tax-receipt series (already nullable, added migration 0142) — the sole surviving purpose of the settings flip |
| `wht_note_th` | แบบ A (below) | membership-only WHT note; seed = **แบบ A** (customer's wording), pending accountant sign-off vs แบบ B at the Review gate; never a code literal |
| `wht_note_en` | แบบ A (below) | EN counterpart of the แบบ A seed |
| `seller_is_head_office` | `true` | TSCC issues from head office (F2 answer; adjustable if the customer says otherwise) |
| `seller_branch_code` | `NULL` | head office ⇒ no branch code |

**WHT note — the seeded default is แบบ A** (customer's wording, typo-fixed). แบบ A is **legally imprecise** per `research.md §7/§11` (it uses the "entity income-tax-exempt" framing; the precise underlying basis is **ม.65 ทวิ (13) + ท.ป.4/2528** — the dues exclusion). So แบบ A is an **accountant sign-off item at the Review gate — แบบ A vs the precise แบบ B — before first issuance** (a **4th** sign-off item alongside the 3 tax FACTS in § 5). Do NOT change the seed to แบบ B unilaterally; ship แบบ A as the seed, pending sign-off. Editable tenant field.

- **TH (แบบ A)** — `หอการค้าไทย-สวีเดนได้รับการยกเว้นภาษีเงินได้ไม่ต้องหักภาษี ณ ที่จ่าย`
- **EN (แบบ A)** — `No deduction of withholding tax shall apply, as the income is exempt from income tax.`

**Preferred — via the settings form (US4):** sign in as admin → `/admin/invoices/settings` → set Receipt numbering = **Separate**, prefix = **RC**, paste the TH + EN WHT notes, seller = **Head office**. Save.

**Alternative — one-off `UPDATE`** (RLS-scoped, so it MUST set `app.current_tenant`; mirror the seeder's `set_config` pattern). Copy-pasteable scratch script:

```bash
cat > /tmp/cutover-088.ts <<'TS'
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
process.loadEnvFile?.('.env.local');
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.POSTGRES_URL_NON_POOLING ?? process.env.DATABASE_URL;
const TENANT = process.env.TENANT_SLUG ?? 'swecham';
const client = postgres(url!, { max: 1, ssl: 'require' });
const db = drizzle(client);
await db.execute(sql`SELECT set_config('app.current_tenant', ${TENANT}, TRUE)`);
await db.execute(sql`
  UPDATE tenant_invoice_settings SET
    receipt_numbering_mode = 'separate',
    receipt_number_prefix  = 'RC',
    seller_is_head_office  = TRUE,
    seller_branch_code     = NULL,
    wht_note_th = ${'หอการค้าไทย-สวีเดนได้รับการยกเว้นภาษีเงินได้ไม่ต้องหักภาษี ณ ที่จ่าย'},
    wht_note_en = ${'No deduction of withholding tax shall apply, as the income is exempt from income tax.'}
  WHERE tenant_id = ${TENANT}
`);
console.log('✓ 088 cutover applied for', TENANT);
await client.end();
TS
node --env-file=.env.local --import tsx /tmp/cutover-088.ts
```

> **Prod note:** prod is **test-data only** (wiped 2026-06-24) — no byte-stable / backward-compat constraint, so a clean numbering cutover is acceptable. On prod the same flip runs via the settings UI (or `db:migrate:prod` + the equivalent UPDATE against `.env.production`) **before the first real document is issued** — this is an operator gate, not code.

### 2.3 Populate `members.legal_entity_type` for the juristic members (data audit — before first issuance)

The §86/4 head-office / branch (`สำนักงานใหญ่ / Branch`) line is **fail-closed**: it renders only when the buyer is a VAT-registrant **juristic** person, gated on `members.legal_entity_type`. A **NULL** `legal_entity_type` → the branch line is silently **omitted** even for a genuine registrant. So before the first real document, run a one-off **data audit / populate** pass over the existing **131 members**: set `legal_entity_type` (juristic vs natural person) for every juristic member (mirror the RLS `set_config('app.current_tenant', …)` pattern from § 2.2). This is a data-cutover step, not code — but it is a **hard prerequisite**: skip it and every already-migrated corporate registrant loses its §86/4 สำนักงานใหญ่ line on their first receipt.

---

## 3. How to test each user story locally

Assumes the dev server is already running on `http://localhost:3100` (**the user runs `pnpm dev` themselves — do not start/kill it**). Sign in as `e2e-admin@swecham.test` (staff `/admin/sign-in`) and `e2e-member@swecham.test` (member `/portal/sign-in`); creds in `.env.local`. Always run Playwright with `--workers=1` (F4 mutates per-tenant sequence state — parallel workers race the advisory lock).

### US1 — non-tax bill → tax receipt at payment (P1)
1. `/admin/members/{id}` → Invoices → **Issue invoice** on a membership draft.
2. Verify the issued PDF: title **ใบแจ้งหนี้ / Invoice** (NOT ใบกำกับภาษี/Tax Invoice), a `SC-2026-NNNNNN` bill number, **no** `ต้นฉบับ / ORIGINAL` marker, **no** Revenue-Code §-citation footer. No §87 tax number is consumed (bill number is a disjoint, non-§87 series — SC-003).
3. Pay it **either** way:
   - **Online:** `/portal/invoices/{id}?pay=1` → Stripe test card `4242 4242 4242 4242` (any future expiry / CVC) **or** PromptPay (test-mode QR). See `/stripe:test-cards`.
   - **Offline:** admin → **Record payment**.
4. Verify exactly one **ใบกำกับภาษี / ใบเสร็จรับเงิน** with an `RC-2026-NNNNNN` §87 number, **dated at the payment date (Asia/Bangkok)** — not the bill's issue date (D7). A member who paid holds exactly **one** §86/4 doc (US1 AS4).

> **Online-path trap (design §7):** both the sync (`record-payment.ts`) and async (`render-receipt-pdf.ts`, gated by `FEATURE_F5_ASYNC_RECEIPT_PDF`) paths must recompute the receipt **kind** from `invoiceSubject` + buyer TIN. If only one is fixed, the async membership receipt renders as §105-only and loses the §86/4 identity — test whichever path is live.

### US2 — Original + Copy (P1)
- On the receipt PDF from US1: **2 pages** in one file — page 1 `ต้นฉบับ / ORIGINAL`, page 2 `สำเนา / COPY`, both showing the same `RC` number, one blob / one sha (§105ทวิ + §87/3 retention).

### US3 — §86/4 Head Office / Branch (P2)
- Set a VAT-registrant corporate member's branch on their record (admin-only field) → pay → buyer block shows `สาขาที่ NNNNN / Branch`. A registrant with no branch set → default `สำนักงานใหญ่ / Head Office`, issuance **not blocked**. An **individual (non-registrant)** buyer → **no** branch line (gate is `buyerIsVatRegistrant`, NOT `buyerHasTin` — a natural-person national ID is a TIN but has no head office/branch). Seller always shows TSCC head office.

### US4 — presentation polish (P2)
- Any document: amounts comma-grouped (`12,000.00`, deterministic/locale-independent), English amount-in-words **starts with a capital letter**, buyer block ordered **Name → Address → Tax ID → Head Office/Branch**, membership line = plan name + period (e.g. `Swecham Premium Corporate Membership fee 2026 / Period: Jan–Dec 2026`).

### US5 — tenant footer + WHT note (P2)
- **Membership** document footer shows the configured WHT note; the old `Rendered by Chamber-OS (§-citation)` line is **gone**. An **event-fee** document shows **no** WHT note (render gate = `invoice_subject='membership'`). A tenant with no note configured → clean footer, no stray text.

### US6 — credit notes target the receipt (P2)
- Attempt a credit note on an **unpaid** ใบแจ้งหนี้ → **rejected** (no §86/4 exists; nothing to reverse). Pay, then credit → the CN references the **`RC` receipt number** (not the bill) and the CREDITED annotation lands on the **receipt** blob. Crediting while the receipt PDF is pending/failed is blocked until it materialises (`receiptPdfStatus === 'rendered'` guard).

### US7 — event parity, §105 unchanged (P3)
- Event **with TIN**, billed pre-payment → same ใบแจ้งหนี้ → `RC` tax-receipt flow as membership. Event **without TIN** → §105 **ใบเสร็จรับเงิน** at payment (`RE` stream if D2 split), legal identity unchanged, inheriting only the presentation polish. **No WHT note on event documents.**

---

## 4. Full CI gate before commit

Reproduce the full pipeline locally before pushing. **Apply the migration and run `test:integration` on live Neon BEFORE committing** any schema-touching change — PDF "goldens" are text-extraction assertions (no stored binaries), so regenerating them = editing asserted strings/kinds against live Neon.

```bash
pnpm db:migrate                # dev Neon branch — apply the new migrations first
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n \
  && pnpm check:layout && pnpm check:fixme && pnpm check:template-seed \
  && pnpm test:integration && pnpm test:e2e
```

Notes:
- Run **`pnpm typecheck` as the FINAL gate after the LAST edit** — it is not in pre-push, and `.next/dev/types` can mask it while the dev server runs.
- Run the **full `pnpm lint`** in review gates — typecheck + vitest + `check:*` miss lint-only errors (e.g. `react-hooks/preserve-manual-memoization`).
- Adding a new audit event type is a **4-place** change: domain const + Drizzle `pgEnum` + `audit-event.test` count + `completeness.test` count (typecheck misses counts).
- Coverage: **100% branch on the security-critical use-cases** — §87 allocation at payment (`record-payment`, `issue-event-invoice-as-paid`), the credit-note creditability gate, the payment→receipt path.
- New tenant-isolation integration test (Principle I clause 3, Review-Gate blocker): two UUID-suffixed tenants, assert zero cross-tenant visibility on `invoices` / `members` / `tenant_invoice_settings` — red first, then green.
- New coverage the design calls out (§13): `RC` stream gap-free across mixed membership + event payments (SC-002); the `bill` number never enters `invoices_tenant_fiscal_seq_unique` (SC-003); receipt has both ต้นฉบับ + สำเนา (SC-004); branch line renders only for registrant buyers; capitalize-first `amount-to-english` unit test.

Hardest test breaks to regenerate (design §13): `revenue-code-citation.test.ts`, `footer-citation-golden.test.ts`, `event-invoice-pdf-golden.test.ts`, `e2e/invoice-draft-issue.spec.ts` AS3, `seq-interleaved-membership-event.test.ts`, `issue-invoice.test.ts`, `record-payment.test.ts`, `issue-as-paid.test.ts`.

---

## 5. SHIP GATE (Review-gate blockers)

This is a tax-law-sensitive, payment + PII surface → **≥2 reviewers**, one signing the security checklist, **plus a Thai-tax reviewer** at the Review gate. Route the diff through the `thai-tax-compliance-auditor` agent **and** a real accountant.

**Accountant must confirm 3 FACTS before ship** (the legal basis is already resolved — these are facts, not law):
1. **TSCC is VAT-registered** (revenue > 1.8M THB/yr) — the whole §86/4 flow depends on it.
2. **No fee tier is volume/business-based** — if any tier is tied to business volume it becomes ม.40(8) income and the payer **must** withhold, breaking the "no WHT" note.
3. **The WHT note is scoped to `invoice_subject='membership'` only** — never event / sponsorship / advertising (those may be withheld-on commercial income).

**Confirmed facts — do NOT re-litigate:** dues = VATable 7% (กค 0811/พ./2308); no WHT on dues (ม.65 ทวิ (13) + ท.ป.4/2528, กค 0811/8542) — basis is the **dues exclusion**, not "entity income-tax-exempt"; branch render gate = **VAT-registrant juristic buyer** (not `buyerHasTin`); WHT note scoped to **membership only**; the §105 RC/RE separate register is the working default but **OPTIONAL** (§87 gap-free is per-series, not required — accountant may merge). prod = test-data only (no byte-stable constraint).

**Definition of Done**
- [ ] All 10 Constitution gates re-checked post-implementation (plan.md Constitution Check).
- [ ] Migrations applied to `dev`; `test:integration` green on live Neon.
- [ ] Tenant-isolation integration test green (Principle I clause 3).
- [ ] SC-001…SC-007 validated (one §86/4 per paid sale; `RC` gap-free; bill outside the tax uniqueness index; Original+Copy; no surface labels the bill ใบกำกับภาษี/Tax Invoice; CN targets the receipt; WHT note membership-only + tenant-scoped).
- [ ] SweCham cutover applied (`separate` / `RC` / WHT TH+EN / seller head office) **before the first real document**.
- [ ] Accountant sign-off on the 3 FACTS **+ the WHT wording (แบบ A vs the precise แบบ B — 4th sign-off item, § 2.2)** + Thai-tax + security reviewer sign-off at the Review gate.
- [ ] i18n relabel done **in place** (values changed, key names kept → no `MISSING_MESSAGE`); EN/TH/SV parity via `check:i18n`.

## 6. Common gotchas (carry into implementation)

- **§87 obligation moved issue-time → payment-time.** Steps 1 (schema) + 3 (numbering) must land together, or every sale mints two tax numbers.
- **Payment-date fiscal year (trap G):** the `RC` allocation derives its fiscal year from the **payment date in Asia/Bangkok** — not `now()`, not the bill's issue date (a Dec payment recorded in Jan numbers into the Dec FY).
- **VAT math (trap I):** the membership `receipt_combined` keeps **VAT-EXCLUSIVE** math at payment; only event Model B uses `splitVatInclusive`. Do not let the payment-path receipt inherit event VAT-inclusive logic.
- **Tenant-scoped repos thread `tx` from `runInTenant`** — never the global `db` singleton (silent RLS bypass).
- **WHT note is a DB column, never a literal or env value** — it rides `tenant_invoice_settings` → `TenantIdentitySnapshot` (pinned at issue, immutable per FR-011) → template.
- **No §86/4 before payment** (edge case 3): issuing a tax invoice at billing pulls the §78/1 tax point back to issue — the bill must stay a non-tax ใบแจ้งหนี้.
