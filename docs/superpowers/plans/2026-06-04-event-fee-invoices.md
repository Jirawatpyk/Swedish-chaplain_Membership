# Event-Fee Invoices (v1 — standard 7% VAT) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Issue Thai-tax-compliant invoices/receipts for **event ticket fees**, for members AND non-member attendees, by generalising the F4 invoice with an `invoice_subject` discriminator (Approach A). v1 = **standard 7%-inclusive VAT only**.

**Architecture:** One `invoices` table, `invoice_subject ∈ {membership, event}`; `member_id`/`plan_id`/`plan_year` become nullable; the buyer is the existing `member_identity_snapshot` (auto from F3 for matched members, manual for non-members). Membership-coupled code (`issueInvoice` line guard, member-lock, tax-id gate) becomes subject-aware. VAT is computed inclusive (back-calc, half-away-from-zero) reusing `Money`.

**Tech Stack:** TypeScript strict, Drizzle (Postgres RLS), `@react-pdf/renderer`, Next.js App Router, next-intl (EN/TH/SV), Vitest + fast-check + Playwright.

**Spec:** `docs/superpowers/specs/2026-06-04-event-fee-invoice-design.md` (v5). **Out of scope (fast-follows, spec §9):** VAT-exempt §81, group/company-pay.

**Conventions for every task below:** run `pnpm typecheck && pnpm lint` before each commit; integration tests hit live Neon via `.env.local`; commit messages use `[Spec Kit]`/`feat:`/`test:` per the commit-msg hook; F4 = security/PII/tax surface → the final PR needs ≥2 reviewers + the thai-tax-compliance auditor + a security checklist.

---

## File Structure

**Create:**
- `src/modules/invoicing/domain/value-objects/vat-inclusive.ts` — `splitVatInclusive` (pure).
- `src/modules/invoicing/application/ports/event-registration-lookup-port.ts` — port.
- `src/modules/invoicing/infrastructure/adapters/event-registration-lookup-adapter.ts` — adapter (F6 barrel).
- `src/modules/invoicing/application/use-cases/create-event-invoice-draft.ts` — use-case.
- `src/app/api/invoices/event-draft/route.ts` — create-event-draft route.
- `src/app/api/cron/invoicing/redact-expired-event-buyers/route.ts` — PII redaction cron.
- `src/app/(staff)/admin/invoices/new/_components/event-fee-form.tsx` — event-fee form section (client).
- `src/app/(staff)/admin/invoices/new/_components/event-attendee-picker.tsx` + skeleton.
- Drizzle migrations: `NNNN_event_fee_line_kind.sql` (non-tx enum add) + `NNNN_event_invoices.sql` (tx).
- Tests: see each task.

**Modify:**
- `src/modules/invoicing/domain/invoice-line.ts` — add `'event_fee'` kind.
- `src/modules/invoicing/domain/invoice.ts` — nullable fields + `invoiceSubject`/`vatInclusive`/`eventId`/`eventRegistrationId`; `enforceOneMembershipLine` → `enforceOneSubjectLine`.
- `src/modules/invoicing/infrastructure/db/schema-invoices.ts` — nullable + new columns + CHECK + partial index.
- `src/modules/invoicing/infrastructure/repos/drizzle-invoice-repo.ts` — `rowsToInvoice` mapper + `insertDraft`.
- `src/modules/invoicing/application/ports/invoice-repo.ts` — `insertDraft` port shape.
- `src/modules/invoicing/application/use-cases/issue-invoice.ts` — subject-aware (3 couplings).
- `src/modules/invoicing/application/use-cases/issue-credit-note.ts` — nullable member_id audit + email guard.
- `src/modules/invoicing/application/use-cases/get-invoice-for-payment.ts` — `memberId: string | null`.
- `src/modules/invoicing/application/ports/audit-port.ts` — add `event_buyer_pii_redacted` + 10y retention (NOT MemberTimelinePayload).
- `src/modules/invoicing/infrastructure/pdf/templates/invoice-template.tsx` — `event_fee` line description.
- `src/components/.../invoice-table.tsx` + `invoice-filters.tsx` — buyer column / Event chip / type filter.
- `src/app/(staff)/admin/invoices/new/page.tsx` + `_components/invoice-form.tsx` — type selector + `?eventRegistrationId` deep-link.
- F6 `registrations-repository.ts` (+ barrel) — add `findByIdInTx`.
- `src/i18n/messages/{en,th,sv}.json` — new keys.
- `src/lib/metrics.ts` / pino REDACT_PATHS — `primary_contact_email`.
- `docs/runbooks/cron-jobs.md`, `docs/compliance/processing-records.md`.

---

## Phase 1 — VAT inclusive domain core (FIRST, per the build-order decision)

### Task 1: `splitVatInclusive` pure helper

**Files:**
- Create: `src/modules/invoicing/domain/value-objects/vat-inclusive.ts`
- Test: `tests/unit/invoicing/domain/vat-inclusive.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { splitVatInclusive } from '@/modules/invoicing/domain/value-objects/vat-inclusive';

describe('splitVatInclusive (half-away, reuses Money)', () => {
  it('AS-VAT-01: 1070 THB incl @7% → subtotal 1000.00, vat 70.00', () => {
    const { subtotal, vat } = splitVatInclusive(Money.fromSatangUnsafe(107_000n), 700n);
    expect(subtotal.satang).toBe(100_000n);
    expect(vat.satang).toBe(7_000n);
  });

  it('invariant: subtotal + vat === total for all totals (fast-check)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10_000_000_00n }), (totalSatang) => {
        const total = Money.fromSatangUnsafe(totalSatang);
        const { subtotal, vat } = splitVatInclusive(total, 700n);
        expect(subtotal.add(vat).satang).toBe(total.satang);
      }),
    );
  });

  it('boundary satang (107, 214, 321) reconcile exactly', () => {
    for (const t of [107n, 214n, 321n]) {
      const { subtotal, vat } = splitVatInclusive(Money.fromSatangUnsafe(t), 700n);
      expect(subtotal.add(vat).satang).toBe(t);
    }
  });
});
```

- [ ] **Step 2: Run test — verify it FAILS**

Run: `pnpm vitest run tests/unit/invoicing/domain/vat-inclusive.test.ts`
Expected: FAIL — `splitVatInclusive` not exported.

- [ ] **Step 3: Implement (reuse Money's half-away `multiplyByFraction` + `subtract`)**

```ts
// src/modules/invoicing/domain/value-objects/vat-inclusive.ts
import { Money } from './money';

/**
 * Back-calculate the VAT-exclusive subtotal + VAT from a VAT-INCLUSIVE total
 * (event ticket prices are all-in). `rateBps` = VAT rate in basis points
 * (700n = 7%). subtotal = total × 10000/(10000+rateBps) rounded half-away-from-
 * zero (Money.multiplyByFraction), vat = total − subtotal (derived → the
 * invariant subtotal+vat===total holds exactly). Pure, no I/O.
 */
export function splitVatInclusive(
  total: Money,
  rateBps: bigint,
): { subtotal: Money; vat: Money } {
  if (rateBps < 0n) throw new Error('splitVatInclusive: rateBps must be >= 0');
  const subtotal = total.multiplyByFraction(10_000n, 10_000n + rateBps);
  const sub = total.subtract(subtotal);
  if (!sub.ok) throw new Error('splitVatInclusive: subtotal exceeds total');
  return { subtotal, vat: sub.value };
}
```

- [ ] **Step 4: Run test — verify it PASSES**

Run: `pnpm vitest run tests/unit/invoicing/domain/vat-inclusive.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: typecheck + lint + commit**

```bash
pnpm typecheck && pnpm lint
git add src/modules/invoicing/domain/value-objects/vat-inclusive.ts tests/unit/invoicing/domain/vat-inclusive.test.ts
git commit -m "feat(invoicing): splitVatInclusive VAT-inclusive back-calc (half-away, F-event)"
```

### Task 2: `'event_fee'` line kind + `enforceOneSubjectLine`

**Files:**
- Modify: `src/modules/invoicing/domain/invoice-line.ts:12`
- Modify: `src/modules/invoicing/domain/invoice.ts` (`enforceOneMembershipLine` → `enforceOneSubjectLine`)
- Test: `tests/unit/invoicing/invoice-state-machine.test.ts` (or the file owning the guard test) + a new `tests/unit/invoicing/domain/enforce-one-subject-line.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/invoicing/domain/enforce-one-subject-line.test.ts
import { describe, it, expect } from 'vitest';
import { enforceOneSubjectLine } from '@/modules/invoicing/domain/invoice';
// build minimal lines via the existing makeInvoiceLine helper (see invoice-line.ts)

describe('enforceOneSubjectLine', () => {
  it('membership: exactly one membership_fee → ok', () => {
    expect(enforceOneSubjectLine('membership', [/* one membership_fee line */]).ok).toBe(true);
  });
  it('event: exactly one event_fee → ok', () => {
    expect(enforceOneSubjectLine('event', [/* one event_fee line */]).ok).toBe(true);
  });
  it('event with zero event_fee → err no_event_fee_line', () => {
    const r = enforceOneSubjectLine('event', [/* a membership_fee line */]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('no_event_fee_line');
  });
  it('event with two event_fee → err multiple_event_fee_lines', () => {
    const r = enforceOneSubjectLine('event', [/* two event_fee lines */]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('multiple_event_fee_lines');
  });
});
```
*(Fill the line fixtures using the existing `makeInvoiceLine`/line shape in `invoice-line.ts` — read it for the exact constructor.)*

- [ ] **Step 2: Run — FAIL** (`enforceOneSubjectLine` not exported; `'event_fee'` not a kind).

Run: `pnpm vitest run tests/unit/invoicing/domain/enforce-one-subject-line.test.ts`

- [ ] **Step 3: Implement (atomic — NF-D)**

In `invoice-line.ts:12`:
```ts
export const INVOICE_LINE_KINDS = ['membership_fee', 'registration_fee', 'event_fee'] as const;
```
In `invoice.ts`, replace `enforceOneMembershipLine` with:
```ts
export function enforceOneSubjectLine(
  subject: 'membership' | 'event',
  lines: readonly InvoiceLine[],
): { ok: true } | { ok: false; error: 'no_membership_line' | 'multiple_membership_lines' | 'no_event_fee_line' | 'multiple_event_fee_lines' } {
  if (subject === 'event') {
    const n = lines.filter((l) => l.kind === 'event_fee').length;
    if (n === 0) return { ok: false, error: 'no_event_fee_line' };
    if (n > 1) return { ok: false, error: 'multiple_event_fee_lines' };
    return { ok: true };
  }
  const n = lines.filter((l) => l.kind === 'membership_fee').length;
  if (n === 0) return { ok: false, error: 'no_membership_line' };
  if (n > 1) return { ok: false, error: 'multiple_membership_lines' };
  return { ok: true };
}
```
Update the single existing caller in `issue-invoice.ts` (handled in Task 7) and any membership test referencing `enforceOneMembershipLine`.

- [ ] **Step 4: Run the new test + the existing line/state-machine tests — PASS.**

Run: `pnpm vitest run tests/unit/invoicing/domain/ tests/unit/invoicing/invoice-state-machine.test.ts`

- [ ] **Step 5: typecheck + lint + commit**

```bash
pnpm typecheck && pnpm lint
git add src/modules/invoicing/domain/invoice-line.ts src/modules/invoicing/domain/invoice.ts tests/unit/invoicing/
git commit -m "feat(invoicing): event_fee line kind + subject-aware enforceOneSubjectLine"
```

---

## Phase 2 — Data model (Domain type + schema migration)

### Task 3: Invoice Domain type — nullable + discriminator (B2)

**Files:** Modify `src/modules/invoicing/domain/invoice.ts` (the `Invoice` interface).

- [ ] **Step 1:** read the current `Invoice` interface; change `memberId/planId: string` → `string | null`, `planYear: number` → `number | null`; add `readonly invoiceSubject: 'membership' | 'event'`, `readonly vatInclusive: boolean`, `readonly eventId: string | null`, `readonly eventRegistrationId: string | null`.
- [ ] **Step 2:** `pnpm typecheck` — expect errors at every site reading these fields (mapper, use-cases). This is the worklist for Tasks 4-8.
- [ ] **Step 3:** commit the type change only after the mapper (Task 4) compiles, to keep `main` green — so **defer the commit to Task 4**.

### Task 4: Migrations + schema + repo mapper (B2 + NF-D + migration split)

**Files:**
- Create migration A (non-tx): `ALTER TYPE invoice_line_kind ADD VALUE IF NOT EXISTS 'event_fee';`
- Create migration B (tx): nullable `member_id/plan_id/plan_year`; add `invoice_subject invoice_subject_enum NOT NULL DEFAULT 'membership'` (+ `CREATE TYPE invoice_subject_enum AS ENUM('membership','event')`), `event_id uuid`, `event_registration_id uuid`, `vat_inclusive boolean NOT NULL DEFAULT false`; FK `event_registration_id → event_registrations`; CHECK (subject↔required fields); partial unique index; backfill (defaults cover it).
- Modify `schema-invoices.ts`, `drizzle-invoice-repo.ts` (`rowsToInvoice`), `invoice-repo.ts` (`insertDraft`).
- Test: `tests/integration/invoicing/event-invoice-schema.test.ts`

- [ ] **Step 1: Write the failing integration test** — insert a `subject='event'` invoice row with `member_id NULL` + `event_registration_id` set; assert it persists + `rowsToInvoice` maps `invoiceSubject='event'`, `memberId=null`; assert the CHECK rejects `subject='membership'` with null member_id; assert the partial unique index rejects a 2nd non-void event invoice for the same registration.
- [ ] **Step 2:** generate migrations (`pnpm drizzle-kit generate`), split the enum `ADD VALUE` into its own non-tx migration file (it cannot run in a transaction). Apply: `pnpm drizzle-kit migrate`.
- [ ] **Step 3:** update `schema-invoices.ts` (drop `.notNull()` on member_id/plan_id/plan_year; add the 4 columns + the `check()` + the partial unique index in the table builder), `rowsToInvoice` (map the new fields; `memberId: row.memberId ?? null`), `insertDraft` port + impl (accept the new fields).
- [ ] **Step 4: Run** `pnpm drizzle-kit migrate && pnpm vitest run tests/integration/invoicing/event-invoice-schema.test.ts` (live Neon) — PASS. Then `pnpm typecheck` — Task 3 type errors at the mapper now resolve; remaining errors are in use-cases (Tasks 5-8).
- [ ] **Step 5: commit** (schema + domain type + mapper together — per F4-R8 migration discipline):
```bash
pnpm typecheck   # mapper compiles; use-case errors are expected, fixed next tasks — OR gate this commit behind Task 7 if main must stay fully green
git add drizzle/migrations src/modules/invoicing/{domain/invoice.ts,infrastructure/db/schema-invoices.ts,infrastructure/repos/drizzle-invoice-repo.ts,application/ports/invoice-repo.ts} tests/integration/invoicing/event-invoice-schema.test.ts
git commit -m "feat(invoicing): generalise invoices for event subject (nullable member/plan + discriminator)"
```
> **Note:** if `main`-must-stay-green is enforced, do Tasks 3-7 on the feature branch and only the FINAL state is green; the per-task commits are intermediate (acceptable on a feature branch, not on main).

---

## Phase 3 — Event registration lookup (port, tx-threaded, cross-tenant) — H1

### Task 5: `EventRegistrationLookupPort` + F6 `findByIdInTx` + cross-tenant test

**Files:**
- Modify F6 `registrations-repository.ts` (+ barrel) — add `findByIdInTx(tx, tenantId, registrationId)` (mirror `InvoiceRepo.findByIdInTx`; thread `tx`).
- Create `event-registration-lookup-port.ts` + `event-registration-lookup-adapter.ts`.
- Test: `tests/integration/invoicing/event-registration-lookup-cross-tenant.test.ts`

- [ ] **Step 1: Write the failing cross-tenant integration test** — seed registration in tenant A; call `eventRegistrationLookupAdapter.findById(txOfTenantB, tenantB, regId)` inside `runInTenant(tenantB, …)`; assert `Result.err` (RLS) + a `registration_cross_tenant_probe` audit event is emitted. Also assert in-tenant `findById` returns `{ attendeeName, attendeeEmail, ticketPriceThb, paymentStatus, matchStatus, memberId|null, eventId, pseudonymised }`.
- [ ] **Step 2:** Run — FAIL (port/adapter absent).
- [ ] **Step 3:** Define the port (`findById(tx: unknown, tenantId: string, registrationId: string): Promise<Result<EventRegistrationView, RepoError>>`); add F6 `findByIdInTx` (tx-threaded, RLS-scoped); implement the adapter via the F6 barrel, threading the caller's `tx` (no fresh pool connection); emit the probe audit on cross-tenant miss.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** typecheck + lint + commit `feat(invoicing): EventRegistrationLookupPort (tx-threaded) + F6 findByIdInTx + cross-tenant guard`.

---

## Phase 4 — Create event invoice draft (use-case) — B1c/B4/H4/H6

### Task 6: `createEventInvoiceDraft`

**Files:** Create `create-event-invoice-draft.ts`; create `MAX_EVENT_INVOICE_SATANG` const (e.g. in `invoice.ts` or a constants file); Test `tests/unit/invoicing/create-event-invoice-draft.test.ts` + an integration test.

> **VAT model = Model B (see spec §3c CORRECTED):** the `event_fee` line stores the **VAT-INCLUSIVE total** (ticket price), `quantity=1`. The draft leaves invoice `subtotal`/`vat`/`total` **null** (exactly like the membership draft) — the VAT split happens at ISSUE (Task 7), NOT at draft. Do **not** call `splitVatInclusive` here. `ticketPriceThb` from the F6 lookup is **integer THB** → multiply by 100 for satang.
> **Pattern:** mirror `create-invoice-draft.ts` exactly — it uses `deps.invoiceRepo.withTx(async (tx) => …)` (NOT raw `runInTenant`), reads settings in-tx, builds `makeInvoiceLine`, calls `deps.invoiceRepo.insertDraft(tx, {…})`, emits an `invoice_draft_created` audit. Reuse that skeleton.

- [ ] **Step 1: Write failing unit tests** covering: matched member → buyer auto from F3 (uses `memberIdentity.getForIssue` stub, `memberId` set); non-member → manual buyer (`memberId` null); `ticket_price_thb` 0/null AND no `amountOverride` → `no_fee_free_event`; pseudonymised registration → `attendee_erased`; `amountOverride` 0/neg/`MAX+1` → `invalid_amount`; non-member bad `tax_id` (`'12'`) → `invalid_tax_id_format`; non-member empty address → `invalid_buyer_snapshot`; company member with null tax_id → `tax_id_required`; registration not found in tenant (lookup `ok(null)`) → `registration_not_found` + emits `registration_cross_tenant_probe` audit; happy path → one `event_fee` line with `unitPrice = inclusive total` (ticketPriceThb×100 or override), `vat_inclusive=true`, `invoiceSubject='event'`, invoice `subtotal/vat/total` NULL, `memberId` set for matched / null for non-member.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement** the use-case (`create-event-invoice-draft.ts`):
  - `MAX_EVENT_INVOICE_SATANG = 100_000_000` (1M THB) constant.
  - zod input: `eventRegistrationId: uuid`, `actorUserId`, `tenantId`, `requestId?`, `amountOverride: z.number().int().min(1).max(MAX_EVENT_INVOICE_SATANG).optional()`, optional `buyer` (non-member: `legal_name z.string().min(1).max(500)`, `address z.string().min(1).max(1000)`, `tax_id z.string().regex(/^\d{13}$/).nullable()`, `primary_contact_name`, `primary_contact_email`).
  - `deps.invoiceRepo.withTx(async (tx) => …)`:
    1. `deps.eventRegistrationLookup.findById(tx, tenantId, eventRegistrationId)` → on `err` → `lookup_failed`; on `ok(null)` → emit `registration_cross_tenant_probe` audit (NEW F4 audit type — add in 4 places: domain const + pgEnum + audit-event.test + completeness.test) + return `registration_not_found`.
    2. guards: `reg.pseudonymised` → `attendee_erased`; `inclusiveSatang = amountOverride ?? (reg.ticketPriceThb == null ? null : reg.ticketPriceThb * 100)`; if `inclusiveSatang == null || inclusiveSatang <= 0` → `no_fee_free_event`; bounds → `invalid_amount`.
    3. buyer snapshot: matched (`reg.matchedMemberId !== null`) → `deps.memberIdentity.getForIssue(tx, tenantId, reg.matchedMemberId)` (company tier with null tax_id → `tax_id_required`), `memberId = reg.matchedMemberId`; non-member → `buyer` required (else `buyer_required`), `makeMemberIdentitySnapshot({legal_name, tax_id, address, primary_contact_name, primary_contact_email})` (catch `InvalidMemberIdentitySnapshotError` → `invalid_buyer_snapshot`; pre-validate `tax_id` regex → `invalid_tax_id_format`), `memberId = null`.
    4. one `event_fee` line: `makeInvoiceLine({ kind:'event_fee', unitPrice: Money.fromSatangUnsafe(BigInt(inclusiveSatang)), quantity:'1.0000', proRateFactor:null, descriptionTh/En = event name + CE date, position:1 })`.
    5. `deps.invoiceRepo.insertDraft(tx, { tenantId, invoiceId, memberId, planId:null, planYear:null, invoiceSubject:'event', eventId: reg.eventId, eventRegistrationId, vatInclusive:true, draftByUserId: actorUserId, autoEmailOnIssue:null, memberIdentitySnapshot: <buyer snapshot>, lines })` — confirm `insertDraft` accepts `memberIdentitySnapshot` at draft (it may be set at issue for membership; check the port — if it doesn't, store the buyer snapshot via the issue path and pass it through the draft's identity field per the port shape).
    6. Dedup: rely on the partial unique index `invoices_event_registration_uniq` — catch Postgres `23505` → `duplicate`. (A pre-`SELECT … FOR UPDATE` is optional; the unique index is the authoritative guard.)
    7. emit `invoice_draft_created` audit — branch: `memberId === null` → non-timeline branch (payload `Record<string,unknown>` with `event_registration_id`, `event_id`, `invoice_subject:'event'`); else timeline branch with `member_id`.
- [ ] **Step 4:** Run unit + integration (matched + non-member, live Neon — seed an F6 registration) — PASS.
- [ ] **Step 5:** typecheck + lint + commit.

---

## Phase 5 — Subject-aware issue path (B1, B5, NF-B, NF-A audit)

### Task 7: `issueInvoice` subject-aware

**Files:** New migration `NNNN_event_invoice_non_draft_check.sql` (BLOCKER — see Step 0); Modify `issue-invoice.ts` (~L202-209 member-lock, ~L222-228 tax-id gate, ~L233 line guard); Test: extend `tests/integration/invoicing/audit-coverage.test.ts` or a new `issue-event-invoice.test.ts`.

> **Contract note (from Task 2):** `enforceOneSubjectLine` returns `Result<void, InvoiceTransitionError>` where errors are objects `{ code: 'no_event_fee_line' }` / `{ code: 'multiple_event_fee_lines', count }` — read `linesCheck.error.code`, NOT `linesCheck.error`. (The plan's earlier string-union sketch is superseded by the real `Result` contract.)
> **Forward deps from Task 6b (honor these):**
> - **Non-member buyer snapshots are PRE-PINNED at draft** in `member_identity_snapshot` (there is no member to re-read). At issue, for an event invoice with `memberId === null`, READ the existing draft snapshot and validate it is non-null — do NOT try to resolve a member. For matched-member event invoices (`memberId !== null`), pin at issue from the member like membership.
> - **Doc-type gate (§86/4 — thai-tax):** the issued document type must follow the buyer's TIN: buyer `tax_id` present (matched company OR non-member who supplied a TIN) → **tax invoice (ใบกำกับภาษี)**; buyer `tax_id` null (non-member individual without TIN) → **receipt (ใบเสร็จรับเงิน)**, NOT a full tax invoice. Confirm the existing doc-type derivation (already generic per spec §3) keys off the buyer snapshot `tax_id` and works for the non-member-null case; add an integration assertion for both (non-member with TIN → tax invoice; without → receipt).

- [ ] **Step 0 (BLOCKER — drizzle-review B-1): relax `invoices_non_draft_has_snapshots` for the event subject.** The LIVE CHECK (migration 0024) requires the FULL snapshot/numbering set (16 fields) on every non-draft row, including `pro_rate_policy_snapshot` + `net_days_snapshot` — which event invoices do NOT populate (pro-rating is membership-only). Without this, the FIRST event invoice issue throws Postgres `23514`. Write a NEW migration (do NOT edit applied 0201) that `DROP CONSTRAINT IF EXISTS invoices_non_draft_has_snapshots` + re-`ADD` it carving out the event subject. **Audit ALL 16 fields against what `createEventInvoiceDraft` (Task 6) actually populates** before writing the new predicate — keep `member_identity_snapshot IS NOT NULL` required (event invoices DO populate it as the buyer snapshot), make `pro_rate_policy_snapshot`/`net_days_snapshot` (+ any other membership-only field) conditional on `invoice_subject='membership'`. Keep `fiscal_year`/`sequence_number`/`document_number`/`pdf_*` required for BOTH (event invoices are §87-numbered + PDF'd). Apply via `pnpm db:migrate` + add a regression integration test (issue-shaped event row with null pro-rate fields passes; null member_identity_snapshot still fails). Sync the Drizzle `check()` builder in `schema-invoices.ts` to the new predicate.
- [ ] **Step 1: Write failing integration test** — issue an `event`/non-member draft (member_id null) → succeeds, allocates the next INV §87 number, pins the buyer snapshot, emits `invoice_issued` via the **non-timeline** audit branch (member_id null), does NOT crash on the member-lock, and does NOT trip `invoices_non_draft_has_snapshots` (proves Step 0).
- [ ] **Step 2:** Run — FAIL (current `enforceOneMembershipLine` + unconditional member-lock + tax-id gate + un-relaxed CHECK).
- [ ] **Step 3: Implement:** (a) replace the `enforceOneMembershipLine` call with `enforceOneSubjectLine(draft.invoiceSubject, draft.lines)` (read `.error.code`); (b) `if (draft.memberId !== null) { …member FOR UPDATE lock + archive guard… }` else validate the pinned buyer snapshot; (c) remove the company-tier tax-id gate here (now enforced at draft, Task 6); (d) **VAT computation branch (Model B — the core correctness fix):** find where issue-invoice computes `subtotal`/`vat`/`total` from the lines (currently `subtotal = Σ lines; vat = calculateVat(subtotal, vatRate); total = subtotal + vat`). Branch on `draft.vatInclusive`: when **true** → `total = Σ lines` (the event_fee line IS the inclusive amount), then `{ subtotal, vat } = splitVatInclusive(total.satang, rateBps)` (import from the invoicing barrel; `rateBps` = the tenant `vat_rate` × 10000 as bigint, same rate source membership uses); when **false** → existing exclusive math unchanged. Add a property/integration test asserting `total === inclusive ticket price` exactly for several amounts incl. a known mismatch case (e.g. 100.04 THB → 10004 satang exact, NOT 10005). (e) audit emit: branch — `member_id === null` → emit `invoice_issued` through the `Exclude<F4AuditEventType, F4MemberTimelineAuditEventType>` branch (payload `Record<string,unknown>` with `event_registration_id` + `contact_email_sha256` omit-when-empty); else timeline branch as today.
- [ ] **Step 4:** Run — PASS (+ existing membership issue tests stay green).
- [ ] **Step 5:** Add a **TS compile-test** assertion (a `// @ts-expect-error` test) that a non-member emit does NOT type-check against `MemberTimelineAuditPayload`. typecheck + lint + commit.

### Task 8: `issueCreditNote` + `getInvoiceForPayment` + audit-port (B5, NF-B, B6)

**Files:** Modify `issue-credit-note.ts` (~L557 payload, ~L580 email), `get-invoice-for-payment.ts:65` (`memberId: string | null`), `audit-port.ts` (add `event_buyer_pii_redacted` event type — domain const + pgEnum + `audit-event.test` + `completeness.test` + 10y in `F4_AUDIT_RETENTION_YEARS`).

- [ ] **Step 1:** failing tests — credit-note an event (non-member) invoice → `credit_note_issued` via non-timeline branch + no crash; `getInvoiceForPayment` maps a non-member event invoice (`memberId: null`); `audit-event.test` + `completeness.test` expect the new `event_buyer_pii_redacted` count.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** implement: credit-note audit branch on `member_id===null`; guard `if (recipientEmail) enqueue`; widen `InvoiceForPayment.memberId: string | null` + skip the F3 ownership check in `initiate-payment` when null; add `event_buyer_pii_redacted` (4 places + 10y).
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** typecheck + lint + commit.

---

## Phase 6 — PDF (event_fee line)

### Task 9: `invoice-template.tsx` event_fee line

**Files:** Modify `invoice-template.tsx`; Test: `tests/integration/invoicing/event-invoice-pdf-golden.test.ts` (render-input golden, mirror `credit-note-pdf-golden.test.ts`).

- [ ] **Step 1: Failing golden test** — render an event invoice (matched-member buyer, AS-VAT-01 amounts) → assert the line description = event name + CE date (YYYY-MM-DD), the `event_fee` line amount = `1,070.00` (the inclusive Model-B line), the summary subtotal 1,000.00 / VAT 70.00 / total 1,070.00, a "VAT included / ราคารวมภาษีมูลค่าเพิ่มแล้ว" annotation present for `vat_inclusive` invoices, doc-type label per tax-id.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** in the line-rendering, when `kind==='event_fee'` show `descriptionTh/En` (event name + CE date — the use-case already stored CE ISO). The `event_fee` line amount renders the stored inclusive `unitPrice` (Model B); add a `vat_inclusive` annotation row near the summary clarifying the line price already includes VAT (so line 1,070 + subtotal 1,000 + VAT 70 reads correctly on a Thai VAT-inclusive tax invoice). Membership-only fields guarded by the line kind / subject. (Buyer/seller/§86/§87/doc-type already generic + shipped.)
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** commit.

---

## Phase 7 — UX (type selector, attendee picker, non-member buyer, list)

> Follow existing patterns: `invoice-form.tsx` (form), `searchable-combobox.tsx` (picker), `invoice-table.tsx`/`invoice-filters.tsx` (list), `docs/ux-standards.md` (skeleton/toast/dialog/a11y). Add i18n keys to all three locales each task; run `pnpm check:i18n`.

### Task 10: `/new` invoice-type selector + routing + deep-link
- Modify `new/page.tsx` (+ `invoice-form.tsx`): a radiogroup `● Membership ○ Event fee` (default membership). When Event → render `<EventFeeForm>` (Task 11), hide member/plan fields. Support `?eventRegistrationId=<id>` (UUID-guard, copy `UUID_RE.test()` from `new/page.tsx:46`) → preset Event + attendee. **Admin-only** (manager → existing `notFound()`/RBAC gate). Add i18n keys `admin.invoices.new.type.*`. Test: contract test for the route gate + a11y.

### Task 11: `EventFeeForm` + `EventAttendeePicker` + non-member buyer
- Create `event-fee-form.tsx` (client) + `event-attendee-picker.tsx` + `EventAttendeePickerSkeleton`. Steps: event select → attendee picker (rows: name · `Badge` match · price · payment_status; 3 empty states: none / all-invoiced / all-erased) → buyer (matched: read-only F3 auto-fill; non-member: freeform legal_name + address textarea[required] + tax_id[optional `^\d{13}$`] + contact, per-field inline errors + aria) → amount (pre-fill ticketPriceThb editable, bounded) → live VAT-inclusive preview → doc-type badge (`role="status"`). Loading: **shape-neutral `loading.tsx`** + client Suspense for the picker + `useMinDelay(300)`. Submit → `POST /api/invoices/event-draft` (Task 12). Soft-duplicate → AlertDialog (Cancel default + "Issue anyway"), keys `admin.invoices.eventFeeForm.duplicateDialog.*`. i18n all keys × 3. Test: component + `@a11y`/`@i18n` E2E.

### Task 12: `POST /api/invoices/event-draft` route
- Create the route: admin gate + zod (mirror `createEventInvoiceDraftSchema`, defense-in-depth incl. `amountOverride` bounds) → `createEventInvoiceDraft`. Contract test for 200 / 400 invalid_amount / 403 manager / 422 no_fee / duplicate.

### Task 13: invoices-list display
- Modify `invoice-table.tsx`: `memberName`→buyer (header key `…columns.buyer`); **non-member rows = plain text (no `/admin/members/{null}` link)**, matched rows keep the link; `Badge variant="secondary"` `[Event]` chip on event rows + muted event-name subtitle; `invoice-filters.tsx` add type filter (All/Membership/Event). i18n keys `…list.columns.buyer`, `…list.subjectChip.event(+Aria)`. Test: list renders an event row without a broken link.
- [ ] **Index (drizzle-review R-1):** when adding the event-scoped query (type filter / future "invoices for event X"), add a partial index in a NEW migration: `CREATE INDEX IF NOT EXISTS invoices_tenant_event_id_idx ON invoices (tenant_id, event_id) WHERE event_id IS NOT NULL;` + the matching Drizzle `index()` in `schema-invoices.ts`, and an `EXPLAIN` integration assertion that the event-id filter uses an index scan (deferred here from Task 3+4 as YAGNI until the query exists).

---

## Phase 8 — Auto-email, audit, PII redaction, compliance (B6, B7, H5)

### Task 14: transactional auto-email (event, empty-guard)
- In the issue auto-email path: recipient = matched member contact OR non-member `attendeeEmail`; **guard empty** (skip + `pino.warn` + audit `auto_email_skipped_no_contact`); use the **F4 transactional Resend path** (never F7 broadcasts). For `subject='event' AND member_id IS NULL` add the conditional privacy-notice footer (keys `admin.invoices.emailFooter.eventNonMember.*` × 3). Contract test asserts the transactional path. Add `primary_contact_email` to the invoicing pino `REDACT_PATHS`.

### Task 15: PII redaction cron (B7)
- Create `POST /api/cron/invoicing/redact-expired-event-buyers` (Bearer `CRON_SECRET`, retry-OFF, `gateCronBearerOrRespond`). Predicate: `invoice_subject='event' AND member_id IS NULL AND status<>'draft' AND issue_date < now() − interval '10 years'`. Action: tombstone `member_identity_snapshot` PII (`[REDACTED]`/`''`) preserving `*_satang`/`document_number`/dates; emit `event_buyer_pii_redacted` per row. Runbook entry in `docs/runbooks/cron-jobs.md`. Integration test: a >10y row gets tombstoned, a <10y row untouched, financial fields preserved.

### Task 16: compliance docs (B7 ship-gate)
- `docs/compliance/processing-records.md`: add the event-fee-invoice RoPA entry (purpose, categories, basis, retention 10y, recipients). F6 attendee privacy notice (`events.privacyNotice.*` × 3) gains the tax-receipt secondary purpose. (Doc-only; no test; required before /speckit.ship.)

---

## Self-Review (run after the plan; checklist for the author)

1. **Spec coverage:** every spec §1-§9 v1 item maps to a task — VAT core (T1), line-kind/guard (T2), schema/domain (T3-4), port+cross-tenant (T5), draft+validation (T6), issue/credit/payment/audit (T7-8), PDF (T9), UX type-selector/form/list (T10-13), email/audit/redaction/RoPA (T14-16). Fast-follows (exempt §81, group-pay) intentionally absent.
2. **Placeholder scan:** later UX/PDF tasks reference exact pattern files (`invoice-form.tsx`, `searchable-combobox.tsx`, `credit-note-pdf-golden.test.ts`) rather than re-deriving boilerplate — acceptable per "follow established patterns"; the engineer reads the cited file. Foundational tasks (T1-T9, T15) carry full code/TDD.
3. **Type consistency:** `enforceOneSubjectLine` (T2) signature reused in T7; `EventRegistrationView` (T5) consumed in T6; `createEventInvoiceDraftSchema` (T6) mirrored in T12; `InvoiceForPayment.memberId: string|null` (T8) — consistent.

---

## Governance
F4 = security/PII/tax surface → final PR: **≥2 reviewers** + thai-tax-compliance auditor (confirm §86/§87 + VAT-inclusive numbers + AS-VAT-01) + security checklist. Runs through the Spec Kit gate sequence; §3a/§3e (issueInvoice changes, cross-module read) recorded in `plan.md` Complexity Tracking.
