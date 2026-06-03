# Event-Fee Invoices & Receipts — Design Spec (v2)

**Date:** 2026-06-04 · **Revised:** 2026-06-04 (v2 after 6-specialist panel review)
**Status:** Draft — incorporates the panel review (`docs/Bug/event-invoice-spec-review.md`); pending re-review.
**Area:** F4 Invoicing (`src/modules/invoicing/**`) × F6 Events (`src/modules/events/**`)
**Approach:** A — generalise the existing invoice (single table + `invoice_subject` discriminator).

> **v2 changelog:** resolves all 8 blockers + 10 high findings from the panel.
> Key correction: `issueInvoice` is **NOT** subject-agnostic — it has hard
> membership couplings (§3a). Adds Domain-type changes, half-away-from-zero VAT
> math, `amountOverride` bounds, credit-note/audit/retention decisions, a Lawful
> Basis & Data Protection section, and the non-member form/list a11y spec.

---

## 1. Problem, Goal & Decisions

Today invoicing only issues **membership** fees (`createInvoiceDraft` derives
lines from a member's plan; `invoices.member_id/plan_id/plan_year` are `NOT
NULL`). **Goal:** issue Thai-tax-compliant invoices/receipts for **event ticket
fees**, for **members and non-member attendees**, reusing the F4 machinery (PDF
§86/§87, sequential numbering, status machine, credit notes, payments,
transactional email) — with the membership-specific couplings made subject-aware.

### Decisions
1. **Buyer scope:** members **and** non-member attendees → buyer decoupled from F3.
2. **Entry:** unified `/admin/invoices/new` with an invoice-type selector
   (Membership | Event fee) + an admin-only shortcut deep-link from the F6
   event-registration row.
3. **Granularity:** 1 invoice per event registration (1:1). *(Open Q1 — confirm
   with SweCham finance; group/company-pays-for-many is out of scope v1.)*
4. **Non-member buyer:** manual entry at creation; `tax_id` **optional**
   (present → ใบกำกับภาษี; absent → ใบเสร็จรับเงิน).
5. **Matched member:** auto-fill the full buyer identity from F3 incl. `tax_id`
   + composed address, read-only (snapshot at issue). Company member without a
   TIN is **rejected** at draft (`tax_id_required`, §86/4) — see §3.
6. **VAT:** `ticket_price_thb` is **VAT-inclusive**. Back-calc with
   **half-away-from-zero** (matching `money.ts`), see §3. *(Open Q2 — RC §81
   exempts some cultural/educational events; v1 hardcodes 7% + an admin
   "subject to 7% VAT" confirmation + exempt-event workaround, see §8.)*

---

## 2. Data Model (Approach A)

### `invoices` — DB schema (migrations; see split below)
| Column | Change | Why |
|--------|--------|-----|
| `member_id` | `NOT NULL` → **nullable** | non-member has no member row |
| `plan_id`, `plan_year` | `NOT NULL` → **nullable** | event has no plan |
| `invoice_subject` (**new**) | enum `('membership','event')` `NOT NULL DEFAULT 'membership'` | discriminator; backfill existing → `membership` |
| `event_id`, `event_registration_id` (**new**) | `uuid` nullable, FK → F6 | event link |
| `vat_inclusive` (**new**) | `boolean NOT NULL DEFAULT false` | membership=exclusive, event=inclusive |
| `member_identity_snapshot` | keep column name (decide rename at /speckit.plan — if kept, mandatory comment + retention-sweep inclusion, §7/B7) | repurposed as the **buyer snapshot** (member auto / non-member manual; L-03 empty-contact support fits) |

**CHECK:** `invoice_subject='membership'` ⇒ `member_id,plan_id,plan_year NOT NULL`;
`invoice_subject='event'` ⇒ `event_registration_id NOT NULL`.

**Partial unique index (dedup):**
`UNIQUE (tenant_id, event_registration_id) WHERE invoice_subject='event' AND status<>'voided'`.
NULL-is-distinct is intentional (membership rows have null `event_registration_id`).

### Domain type changes (B2 — NOT just DB)
The nullable/discriminator change ripples through **every layer**, all landing
together (TS `strict` + `exactOptionalPropertyTypes`):
- `invoice.ts` (Domain): `memberId/planId: string | null`, `planYear: number | null`,
  `invoiceSubject: 'membership'|'event'`, `vatInclusive: boolean`,
  `eventId/eventRegistrationId: string | null`.
- `InvoiceRow` (Drizzle inferred) + `rowsToInvoice` mapper.
- `InvoiceRepo.insertDraft` port + every caller reading those fields.
No fabricated UUIDs/empty-strings (type lie). Per F4-R8: migration applied +
`pnpm test:integration` green **before** committing schema+code.

### Migration split (non-transactional enum value)
- **Migration N (non-transactional):** `ALTER TYPE invoice_line_kind ADD VALUE
  'event_fee'` (+ any new audit pgEnum value) — `ADD VALUE` cannot run in a tx.
- **Migration N+1 (transactional):** nullable columns + `invoice_subject` +
  `event_id`/`event_registration_id` + `vat_inclusive` + CHECK + partial index +
  backfill (`membership`/`vat_inclusive=false`).

### Line kind
Add `'event_fee'` to `INVOICE_LINE_KINDS` (domain const) + DB enum. Event invoices
carry exactly one `event_fee` line (no pro-rate).

### `tenant_invoice_settings` — NO new columns
Reuses `vat_rate`, `currency_code`, seller identity, `invoice_number_prefix`
(+cadence) / `receipt_numbering_mode` / `credit_note_number_prefix` (event shares
the **invoice** §87 sequence — continuous INV-YYYY-NNNNNN, no separate prefix),
`default_net_days`, `logo_blob_key`, `auto_email_*`. **`pro_rate_policy` is NOT
applied** to `event_fee` lines.

---

## 3. Domain & Application

### (a) Changes to `issueInvoice` (B1 — it is NOT subject-agnostic)
`issue-invoice.ts` has three membership couplings that fire for every invoice and
must be made subject-aware (log as a Complexity-Tracking deviation):
1. **Line guard (~L233):** `enforceOneMembershipLine` → replace with Domain
   `enforceOneSubjectLine(subject, lines)` (zero imports): exactly one
   `membership_fee` for membership, exactly one `event_fee` for event; new errors
   `no_event_fee_line` | `multiple_event_fee_lines`.
2. **Member lock (~L202-209):** the unconditional
   `memberIdentity.getForIssue(tx, …, draft.memberId, {forUpdate:true})` →
   **skip when `draft.memberId === null`** (validate the pre-pinned buyer
   snapshot instead). Document the revised lock order (no member-lock step on the
   event path) for deadlock-safety review.
3. **§86/4 tax-id gate (~L222-228):** the company-tier `tax_id_required` check
   runs on live `memberIdentity` data → **move it to `createEventInvoiceDraft`**
   (gate on the buyer snapshot's `tax_id`, see below) so it can't be bypassed.

### (b) Changes to `issueCreditNote` (B5)
`issue-credit-note.ts` puts `member_id: loaded.memberId` into a
`F4MemberTimelineAuditEventType` payload (`member_id: string` required) and
auto-emails `primary_contact_email`. For event/non-member invoices:
- `credit_note_issued` payload → `member_id: string | null` + `event_registration_id`
  when null (see §audit B6).
- Auto-email guarded: `if (recipientEmail) …` (skip + warn + audit otherwise).

### (c) VAT-inclusive split (B3 — half-away-from-zero, bigint)
`splitVatInclusive(totalSatang: bigint, rateBps: bigint): { subtotal, vat }`:
```
subtotal = (totalSatang * 10000n + (10000n + rateBps)/2n) / (10000n + rateBps)   // half-away
vat      = totalSatang - subtotal                                                 // derived
```
- **Matches** `money.ts` half-away rounding (so a credit note re-deriving VAT via
  `multiplyByFraction` can't drift ±1 satang).
- **Invariant (fast-check):** `subtotal + vat === total` for all totals/rates,
  with boundary cases (107, 214, 321 satang where rounding modes diverge).
- **Storage:** the single `event_fee` line `unitPrice/total` = the **ex-VAT
  subtotal**; the invoice stores `subtotal` + `vat` (=`total−subtotal`) + `total`
  → the existing line→subtotal→VAT→total PDF table reconciles exactly.
  `vat_inclusive` records provenance only; it does not change stored amounts.
- **AS-VAT-01:** `ticket_price_thb=1070` → line `1,000.00` / VAT `70.00` / total
  `1,070.00` (encoded in the golden PDF test).

### (d) Use cases & ports
- **`createEventInvoiceDraft({ eventRegistrationId, buyer?, amountOverride? })`:**
  1. Read registration via **`EventRegistrationLookupPort.findById(tx, tenantId, id)`**
     (tx-threaded, mirrors `MemberIdentityPort`) — see §H1.
  2. Guards → typed errors: `no_fee_free_event` / `no_fee_comp_ticket`
     (split — partnership comp tickets legitimately have price 0),
     `attendee_erased` (pseudonymised), `duplicate` (active invoice exists —
     `SELECT … FOR UPDATE` on the index predicate; catch 23505 → typed
     `duplicate`, not a 500), `invalid_amount`, `tax_id_required`,
     `invalid_buyer_snapshot`.
  3. Amount: `total = amountOverride ?? ticket_price_thb`; `amountOverride` is
     **VAT-inclusive**, zod `.int().min(1).max(<ceiling, e.g. 1_000_000_00>)`
     (route-handler zod too — defense-in-depth) → `invalid_amount` on violation.
  4. Buyer snapshot (always populated; reject `invalid_buyer_snapshot` pre-persist):
     - matched member → `memberIdentityAdapter.getForIssue` (auto incl. tax_id +
       composed address); if `memberTypeScope==='company' && !tax_id` →
       `tax_id_required` (H6).
     - non-member → build from `buyer` (manual). Validation (H4):
       `legal_name z.string().min(1).max(500)`, `address .min(1).max(1000)`
       (freeform textarea, matches the single-string snapshot contract),
       `tax_id` = `z.string().regex(/^\d{13}$/).nullable()` (→ `invalid_tax_id_format`),
       contact name/email pre-filled from the registration `attendeeEmail`.
  5. One `event_fee` line (`proRateFactor = null`); `invoice_subject='event'`,
     `vat_inclusive=true`, `event_id`, `event_registration_id`.
- `issueInvoice` reused **with the §3a changes**; status machine, credit notes,
  payments (F5) reused keyed by `invoice_id`.

### (e) Clean Architecture & tenant isolation (H1)
`EventRegistrationLookupPort.findById(tx, tenantId, …)` lives in
invoicing/application; the adapter (invoicing/infrastructure) calls a **tx-threaded
`findById`** on F6's repo via the public barrel (extend F6's repo with a tx-threaded
method if absent — a port extension, not a barrel leak; threads the invoice
`runInTenant` tx so RLS holds + no TOCTOU on a fresh pool connection). Add the five
Principle-I sub-clauses (app-layer + db-layer + integration test + audit +
super-admin) and a cross-tenant integration test (`Result.err` +
`registration_cross_tenant_probe` audit) — Review-Gate blocker.

### (f) Audit taxonomy & retention (B6 — decided now)
**Reuse** `invoice_draft_created` / `invoice_issued` / `invoice_paid` /
`invoice_voided` / `invoice_pdf_resent` with `invoice_subject` in the payload (no
new enum migration). Payload variant: `member_id: string | null`,
`event_registration_id` required when `member_id` null. The issued/paid/voided/
pdf-resent set keeps **10-year** retention in `F4_AUDIT_RETENTION_YEARS` (Thai RD
§87/3) — verified by `check:audit-counts`. Any buyer email in a payload is
`sha256Hex(email).slice(0,16)`, never raw (consistent with F6 import-csv:387).
4-place update (domain const + pgEnum + audit-event.test + completeness.test)
captured for /speckit.tasks.

---

## 4. UX / Userflow

Single screen `/admin/invoices/new` + an invoice-type radiogroup (default
Membership, back-compat). **Progressive disclosure, no stepper.**

```
[Type]  ● Membership fee   ○ Event fee
── Event fee selected → progressive sections appear ──
[Event]    searchable select (F6): name + date
[Attendee] registrations of that event; row: name · badge[member/non_member/unmatched] · ticket_price · payment_status
[Buyer]    matched member → read-only F3 auto-fill "ออกในนามสมาชิก: <company>" (incl. tax_id + address)
           non-member     → freeform: legal name(pre-fill) · address textarea(required) · tax-id(optional, ^\d{13}$) · contact name+email(pre-fill)
[Amount]   ticket_price pre-filled (editable, bounded) · live VAT-inclusive preview: total X / subtotal Y / VAT 7% Z
           ☑ "ยืนยันว่า event นี้คิด VAT 7%" (Open Q2 / RC §81 guard)
           🏷️ doc-type: tax-id present → "ใบกำกับภาษี/ใบเสร็จ" ; absent → "ใบเสร็จรับเงิน"
[Create]   → existing invoice detail → preview PDF → issue → pay / credit-note
```

### Shortcut (admin-only)
F6 event-registration row → CTA "ออกใบกำกับ/ใบเสร็จ" →
`/admin/invoices/new?eventRegistrationId=<id>` (UUID-guarded server-side, copy
`UUID_RE.test()` from new/page.tsx:46). **Rendered admin-only** (manager → `notFound()`).
Command palette: add "New event fee invoice" → `?type=event`.

### Invoices list (`/admin/invoices`)
- `memberName` column → **"Buyer / ลูกค้า"** from buyer snapshot `legal_name`
  (member or non-member). New i18n keys `admin.invoices.list.columns.buyer`.
- **Buyer link:** matched-member rows link `/admin/members/{memberId}`; **non-member
  rows render plain text** (no link — avoids `/admin/members/null` 404).
- **Subject chip** `Badge variant="secondary"` = `[Event]` on event rows only
  (membership = no chip). Keys `…list.subjectChip.event` (+`.eventAria`).
- Muted subtitle on event rows = event name. **Type filter** (All/Membership/Event)
  in `invoice-filters.tsx`.

### States, forms & a11y (B8, per `docs/ux-standards.md` + WCAG 2.1 AA)
- `EventAttendeePickerSkeleton` (column-matched) + `loading.tsx` under
  `/admin/invoices/new` + `useMinDelay(300)` (no CLS).
- Three attendee-picker empty states: no-registrations / all-already-invoiced /
  all-erased (icon + title + CTA, EN/TH/SV).
- Buyer address = freeform textarea; per-field inline error copy (EN/TH/SV);
  `aria-required`/`aria-describedby`; doc-type badge `role="status"` (matched) /
  `aria-live="polite"` on the non-member tax-id-typing path.
- Soft-duplicate AlertDialog: title/description/Cancel(default)+"Issue anyway",
  i18n keys `admin.invoices.eventFeeForm.duplicateDialog.*`; `AS-DEDUP-01`
  (void → re-issue without warning).
- All labels/errors EN/TH/SV.

---

## 5. PDF Rendering

Reuse `invoice-template.tsx`:
- `event_fee` line description = event name + **event date as CE ISO-8601
  (YYYY-MM-DD)** in both stored TH/EN (H7 — BE is display-only; the renderer
  converts to BE at presentation via the existing issue-date helper).
- Buyer/seller blocks, §86/§87, doc-type label, amount-in-words — existing logic
  (buyer snapshot generic; §86 address + L-01/L-03 already shipped).
- Membership-only fields guarded by `invoice_subject`.
- Auto-email: **F4 transactional Resend path** (`RESEND_API_KEY`) — **never** the
  F7 broadcasts path (a marketing unsubscribe must not suppress a tax document);
  recipient = matched member's contact OR non-member `attendeeEmail`; **guard
  empty email** (skip + warn + audit `auto_email_skipped_no_contact`). Add a
  conditional privacy-notice footer (EN/TH/SV) for `invoice_subject='event' AND
  member_id IS NULL` (first-contact, see B7).

---

## 6. Lawful Basis & Data Protection (B7 — NEW, non-member PII)

Non-member buyer identity (legal_name, address, tax_id, contact name/email) is a
**new PII collection path** stored in the pinned snapshot.
- **Per-field basis:** legal_name/address/tax_id → **legal obligation** (Thai RD
  §86/§87 / PDPA §24(1) / GDPR Art. 6(1)(c)); contact name/email → contract /
  document delivery.
- **Secondary-use of F6 attendee data:** pre-fill from F6 (collected under
  event-admin legitimate interest) is a new purpose → rely on the §86/§87 legal
  obligation as the compatible secondary basis **and** update the F6 privacy
  notice (EN/TH/SV) to add the tax-receipt purpose.
- **Retention/erasure:** a **10-year-from-issue scheduled redaction job**
  tombstones `member_identity_snapshot` PII on `member_id IS NULL` event invoices
  (preserving `*_satang` + `document_number`) — added to §2, §7, and the retention
  table. (Non-member snapshots have no F3 archive cascade.)
- **DSR:** refuse erasure during §87/3 retention (Art. 17(3)(b)); offer Art. 18
  restriction on contact fields; manual Art. 15/20 for accountless non-members.
- **RoPA:** `docs/.../processing-records.md` updated before /speckit.ship.
- **Redaction:** confirm `primary_contact_email` is in the invoicing pino
  `REDACT_PATHS`.

---

## 7. Edge Cases & Testing

**Edge cases:** already-invoiced (FOR-UPDATE + 23505→typed `duplicate` + dialog) ·
free event vs comp ticket (distinct errors) · refunded/free payment_status (warn) ·
pseudonymised attendee (block) · non-member no address (required) · invalid
tax-id format (block) · cross-tenant registration (RLS + probe) · concurrency
(index + FOR UPDATE) · credit-note/payment reuse · snapshot pinned at issue
(FR-038).

**Testing:**
- **Unit:** `splitVatInclusive` (fast-check `subtotal+vat===total` + boundary
  satang) · `enforceOneSubjectLine` · `createEventInvoiceDraft` (matched→F3,
  non-member→manual, free/comp→error, no-address→error, bad-tax-id→error,
  amountOverride 0/neg/MAX+1→`invalid_amount`, duplicate→warn, company-no-tin→error).
- **Integration (live Neon):** create event invoice (matched + non-member) → issue
  → PDF; **shared INV continuity across interleaved membership+event at the
  Asia/Bangkok fiscal-year boundary** (injected UTC clock, no gap/reset, §87);
  duplicate guard; **cross-tenant `EventRegistrationLookupPort` → err + probe
  audit**; VAT-inclusive amounts end-to-end; credit-note on event invoice;
  migration applied + integration green before commit.
- **E2E (`--workers=1`):** `/new` type-selector → event → attendee → buyer →
  create; F6 shortcut deep-link (admin-only); `@a11y` + `@i18n`.
- **Contract:** `createEventInvoiceDraft` route + event/attendee pickers; assert
  transactional (not broadcasts) email path.
- **PDF golden:** event-invoice render-input golden incl. `AS-VAT-01`.
- **thai-tax-compliance auditor:** §86/§87 + VAT-inclusive + numbering — pass before ship.

---

## 8. Governance & Open Questions

F4 = security/PII/tax surface → Review gate **≥2 reviewers** + security checklist;
full Spec Kit sequence (`/speckit.specify` → … → `/speckit.ship`). §3a/§3e
deviations recorded in `plan.md` Complexity Tracking.

**Open Questions (resolve with SweCham before /speckit.specify closes):**
- **Q1 — granularity:** is 1 invoice per registration right, or is group/company-
  pays-for-many-attendees needed? (Batch deferred to §9.)
- **Q2 — VAT applicability (RC §81):** are all SweCham events VAT-7%, or are some
  (cultural/educational/charitable) exempt? v1 hardcodes 7% + an admin "subject to
  7% VAT" confirmation; exempt events use the void + plain-receipt/0-VAT workaround.
  Needs SweCham finance sign-off.

---

## 9. Out of Scope (YAGNI) & Acknowledged Deferrals

- Batch invoicing + **batch credit-note on event cancellation** (acknowledged
  operational cost; deferred).
- A standalone "event customer" entity (non-member buyer is a per-invoice snapshot).
- Separate event invoice prefix (shares INV).
- Per-tenant "event invoicing enabled" setting (gated by the F4 feature flag).
- Editable buyer identity for a matched member (auto + read-only; override = future).
- **F5 self-pay (Decision 7):** matched members CAN self-pay event invoices via
  the existing subject-agnostic `getInvoiceForPayment` + see them in
  `/portal/invoices`; **non-members cannot** (no portal account → admin records
  payment manually; guest-payment-link = future).
- `member_identity_snapshot` → `BuyerIdentitySnapshot` rename (decide at
  /speckit.plan; if not renamed, the clarifying comment + retention-sweep
  inclusion are mandatory).
