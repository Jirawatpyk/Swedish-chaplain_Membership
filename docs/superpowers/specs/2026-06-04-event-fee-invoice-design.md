# Event-Fee Invoices & Receipts — Design Spec

**Date:** 2026-06-04
**Status:** Draft (brainstorming → design approved; pending spec review)
**Area:** F4 Invoicing (`src/modules/invoicing/**`) × F6 Events (`src/modules/events/**`)
**Approach:** A — generalise the existing invoice (single table, discriminator) — approved.

---

## 1. Problem & Goal

Today the invoicing system can only issue invoices/receipts for **membership** fees:
`createInvoiceDraft` takes `{ memberId, planId, planYear }` and auto-derives the
lines (membership_fee + optional registration_fee) from the member's plan. The
`invoices` table is member-centric and plan-centric at the schema level
(`member_id`, `plan_id`, `plan_year` all `NOT NULL`).

**Goal:** also issue Thai-tax-compliant invoices/receipts for **event ticket
fees**, for **both members and non-member attendees** (anyone who registered and
paid a ticket), reusing the existing invoice machinery (PDF §86/§87 renderer,
sequential numbering, status machine, credit notes, payments, auto-email).

### Decisions (from brainstorming)
1. **Buyer scope:** members **and** non-member attendees. → decouple the invoice
   buyer from the F3 member record.
2. **Entry point:** unified `/admin/invoices/new` with an invoice-type selector
   (Membership | Event fee). Plus an optional shortcut deep-link from the F6
   event-registration screen.
3. **Granularity:** 1 invoice per event registration (1:1). No batch.
4. **Non-member buyer identity:** manual entry at creation; `tax_id` **optional**.
   - `tax_id` present → full tax invoice (ใบกำกับภาษี).
   - `tax_id` absent → plain receipt (ใบเสร็จรับเงิน) — Thai practice: a receipt
     needs no buyer tax-id.
5. **Matched member:** auto-fill the **entire** buyer identity from F3 — incl.
   `tax_id` (`members.tax_id`), legal name, full structured address, primary
   contact — read-only (snapshot at issue, like membership). Member with a
   tax-id → tax invoice automatically; individual member (`tax_id` null) →
   receipt.
6. **VAT:** event tickets are VAT-applicable. `event_registrations.ticket_price_thb`
   is **VAT-inclusive** (the all-in price the attendee paid). The invoice
   back-calculates: `subtotal = round(total / 1.07)`, `vat = total − subtotal`.
   (Membership remains VAT-**exclusive**.)

---

## 2. Data Model (Approach A)

### `invoices` table changes (one migration)
| Column | Change | Rationale |
|--------|--------|-----------|
| `member_id` | `NOT NULL` → **nullable** | non-member attendee has no member row |
| `plan_id`, `plan_year` | `NOT NULL` → **nullable** | event invoice has no plan |
| `invoice_subject` (**new**) | enum `('membership','event')` `NOT NULL DEFAULT 'membership'` | discriminator; existing rows backfill `membership` |
| `event_id`, `event_registration_id` (**new**) | `uuid` nullable, FK to F6 | link event invoice → registration |
| `vat_inclusive` (**new**) | `boolean NOT NULL DEFAULT false` | `false`=membership (exclusive), `true`=event (inclusive) |
| `member_identity_snapshot` | keep name | **repurposed as the buyer snapshot** — existing shape (legal_name / tax_id / address / primary_contact_name / primary_contact_email) serves member (auto) and non-member (manual). The L-03 change (contact fields accept empty strings) is exactly what a contactless/manual buyer needs. |

**CHECK constraint** (per-subject required fields):
- `invoice_subject = 'membership'` ⇒ `member_id`, `plan_id`, `plan_year` `NOT NULL`.
- `invoice_subject = 'event'` ⇒ `event_registration_id` `NOT NULL`.

**Partial unique index** (duplicate guard):
`UNIQUE (tenant_id, event_registration_id) WHERE invoice_subject='event' AND status <> 'voided'`
— at most one active invoice per registration (DB-level backstop to the
soft-duplicate warning).

**Migration discipline:** apply migration + run `pnpm test:integration` before
committing the schema + code together (per the F4-R8 incident lesson). Verify
backfill (existing → `membership`/`vat_inclusive=false`) and the CHECK.

### Line kind
Add `'event_fee'` to `INVOICE_LINE_KINDS` (domain const) + the DB enum.
Event invoices carry exactly one `event_fee` line (no pro-rate).

### `tenant_invoice_settings` — NO changes
The feature **reuses every existing setting**: `vat_rate` (inclusive back-calc),
`currency_code`, seller identity (`legal_name_*`, `tax_id`, `registered_address_*`
→ tenant snapshot), `invoice_number_prefix` + cadence + `receipt_numbering_mode`
+ `credit_note_number_prefix` (event shares the **invoice** §87 sequence —
continuous INV-YYYY-NNNNNN, no separate prefix), `default_net_days` (due date),
`logo_blob_key` (PDF logo), `auto_email_*` (email the buyer).
**Only caveat:** `pro_rate_policy` is **not applied** to `event_fee` lines
(events are not pro-rated).

---

## 3. Domain & Application

### VAT-inclusive split (new domain helper — highest-risk unit)
`splitVatInclusive(totalSatang: bigint, vatRate: VatRate): { subtotal, vat }`
- `subtotal = round_half_even(total × 10000 / (10000 + rateBps))` in satang.
- `vat = total − subtotal` (derive, never independently round).
- **Invariant (property test, fast-check):** `subtotal + vat === total` exactly,
  for all `total` and rate — guards the off-by-0.01-satang class.
- Membership keeps its existing exclusive computation; `vat_inclusive` selects
  the path.
- **Storage:** the single `event_fee` line stores the **ex-VAT** amount
  (= computed `subtotal`); the invoice records `subtotal` + `vat` (= `total −
  subtotal`) + `total`. So the existing line → subtotal → VAT → total PDF table
  is unchanged and reconciles exactly. The `vat_inclusive` flag records that the
  entered amount was inclusive (provenance + deterministic re-render); it does
  NOT change the stored line/subtotal/total, only how they were derived at
  creation.

### Use cases
- **`createEventInvoiceDraft`** (new, parallel to `createInvoiceDraft`):
  input `{ eventRegistrationId, buyer?, amountOverride? }`.
  1. Read the registration (attendee, `ticket_price_thb`, match status,
     `event_id`) — tenant-scoped, RLS via `runInTenant` `tx`.
  2. Guards: free/0 price → `no_fee`; pseudonymised attendee → `attendee_erased`;
     active invoice already exists → `duplicate` (soft warning, confirmable).
  3. Buyer snapshot:
     - matched member → reuse `memberIdentityAdapter.getForIssue` (auto, incl.
       tax_id + composed address).
     - non-member → build the buyer snapshot from `buyer` (manual: legal_name,
       address [required], tax_id [optional/null], contact name+email pre-filled
       from attendee), validated by `makeMemberIdentitySnapshot`.
  4. Amount: `total = amountOverride ?? ticket_price_thb` (editable); split via
     `splitVatInclusive`; one `event_fee` line (`proRateFactor = null`).
  5. Create draft row: `invoice_subject='event'`, `vat_inclusive=true`,
     `event_id`, `event_registration_id`, `plan_*`/`member_id` per CHECK.
- **`issueInvoice`** (existing) — reused unchanged: subject-agnostic; pins the
  buyer snapshot + allocates the shared INV §87 number at issue.
- Status machine, credit notes, payments (F5) — reused unchanged (keyed by
  `invoice_id`).

### Clean Architecture
A new `EventRegistrationLookupPort` (invoicing/application) reads the
registration from F6 through its public barrel — mirroring the existing
`PlanLookupPort` (membership) and `MemberIdentityPort` (buyer). The adapter
lives in invoicing/infrastructure; the Application layer stays free of
drizzle / F6 internals.

---

## 4. UX / Userflow

Single screen `/admin/invoices/new` + a type toggle (radiogroup) at the top.
`Membership` is the default (back-compat).

```
[Step 1] Invoice type:  ● Membership fee   ○ Event fee

── when "Event fee" is selected, the form switches ──

[Step 2] Pick Event      → searchable select (F6 events): name + date
[Step 3] Pick Attendee   → registrations of that event; each row:
                           name · badge[member/non_member/unmatched] · ticket_price_thb · payment_status
[Step 4] Buyer details:
         • matched member → auto-filled from F3 (read-only): "ออกในนามสมาชิก: <company>"
                            (incl. tax_id + full address — no manual entry)
         • non-member     → form: legal name (pre-fill) · address (required) ·
                            tax-id (optional) · contact name+email (pre-fill)
[Step 5] Amount:
         ticket_price_thb pre-filled (editable, e.g. discount)
         live preview (VAT-inclusive): total X │ subtotal Y │ VAT 7% Z
         🏷️ doc-type badge (aria-live): tax-id present → "ใบกำกับภาษี/ใบเสร็จ" ; absent → "ใบเสร็จรับเงิน"

[Create draft] → existing invoice detail page → preview PDF → issue → pay / credit-note
```

### Shortcut (approved)
F6 event-registration row gains a CTA **"ออกใบกำกับ/ใบเสร็จ"** →
`/admin/invoices/new?eventRegistrationId=<id>` which pre-fills event + attendee
(mirrors the existing member-detail → `/new?memberId` deep-link). Lands on the
same `/new` form, pre-filled.

### Invoices list page (`/admin/invoices`)
The existing list (`invoice-table.tsx`) has columns: document number ·
**memberName** · issue/due date · total · status. No `plan` column → events need
no new column. Changes:
- **`memberName` generalises to "Buyer / ลูกค้า"** — sourced from the buyer
  snapshot `legal_name`, so it shows the company (member) OR the manual
  non-member name. Header label updated EN/TH/SV.
- **Subject chip:** an `Event` chip beside the buyer name for event invoices.
  Membership shows **no chip** (the default → keeps the list quiet).
- **Muted subtitle** under the buyer name for event rows: the event name
  (e.g. "ค่าเข้าร่วมงาน Annual Gala 2026"), so the admin sees which event at a
  glance. Membership rows show no subtitle (or the existing detail).
- **Filter:** add a `type` filter (All / Membership / Event) to
  `invoice-filters.tsx` alongside the status filter (the list now mixes both).

Example event row:
```
INV-2026-000042 │ บริษัท แอคมี จำกัด  [🎟 Event]   │ 2026-01-15 │ 1,070.00 │ ออกแล้ว
                │ ค่าเข้าร่วมงาน Annual Gala 2026  (muted)
```
Document number / date / total / status columns + the row actions (PDF download,
record-payment, credit-note) are unchanged (subject-agnostic).

### States & a11y/i18n (per `docs/ux-standards.md`)
Empty event picker / empty attendee list / shimmer while loading registrations /
toast + confirm on create / soft-duplicate confirm dialog. Type toggle is a
keyboard-navigable radiogroup; doc-type badge is `aria-live`. All labels in
EN/TH/SV.

---

## 5. PDF Rendering

Reuse `invoice-template.tsx`:
- `event_fee` line → `descriptionTh/En` = event name + date
  (e.g. "ค่าเข้าร่วมงาน <event> (<date>)" / "Event admission — <event> (<date>)").
- Buyer block, seller block, §86/§87, doc-type label (ใบกำกับภาษี vs ใบเสร็จ),
  amount-in-words — existing logic works as-is (buyer snapshot is generic; the
  §86 buyer-address + L-01/L-03 fixes already shipped).
- Membership-only fields are guarded by `invoice_subject` so nothing
  plan-specific renders for events.

---

## 6. Edge Cases & Error Handling

| Case | Handling |
|------|----------|
| Registration already invoiced | soft-duplicate **warning** + DB partial-unique backstop; admin confirms (re-issue allowed after void) |
| `ticket_price_thb` null/0 (free event) | **block** — "no fee to invoice" |
| `payment_status` = refunded/free | **warn** (issuing allowed; refunded usually wants a credit-note instead) |
| Attendee pseudonymised (F6 PII erasure) | **block** — no valid identity |
| Non-member without address | address **required** (§86 + appears on the receipt); tax-id optional |
| Cross-tenant registration | RLS (`runInTenant` `tx`) + tenant_id-scoped reads |
| Concurrency | partial unique index + standard tx |
| Credit note / payment of an event invoice | reused generic (keyed by invoice_id) |
| Buyer changes after issue | snapshot pinned at issue (FR-038) — immutable |

---

## 7. Testing

- **Unit:** `splitVatInclusive` (fast-check property: `subtotal+vat===total`;
  satang edge cases) · `createEventInvoiceDraft` (matched→F3, non-member→manual,
  free→error, no-address→error, duplicate→warn) · buyer snapshot for non-member.
- **Integration (live Neon):** create event invoice (matched + non-member) →
  issue → PDF; shared INV numbering continuity; duplicate guard; cross-tenant
  isolation; VAT-inclusive amounts correct end-to-end; **migration applied +
  integration green before commit**.
- **E2E (`--workers=1`):** `/new` type-selector → event → attendee → buyer →
  create; events-screen shortcut deep-link; `@a11y` + `@i18n`.
- **Contract:** new `createEventInvoiceDraft` route + event/attendee picker
  endpoints.
- **PDF golden:** event-invoice render-input golden (event line + buyer).
- **thai-tax-compliance auditor:** §86/§87 + VAT-inclusive correctness — pass
  before ship.

---

## 8. Governance

F4 is a security / PII / tax surface → Constitution Review gate requires
**≥2 reviewers** with one signing the security checklist (as for F4). Runs
through the full Spec Kit gate sequence
(`/speckit.specify` → … → `/speckit.ship`). New audit event types as needed
(e.g. `event_invoice_issued` or reuse `invoice_issued` with the subject in the
payload — decide at `/speckit.plan`).

---

## 9. Out of Scope (YAGNI)

- Batch invoicing (multiple registrations → one invoice).
- A standalone "event customer" entity (non-member buyer is a per-invoice manual
  snapshot, not a reusable record).
- A separate event invoice number prefix (events share the INV sequence).
- A per-tenant "event invoicing enabled" setting (gated by the F4 feature flag).
- Editable/overridable buyer identity for a **matched member** (auto + read-only,
  like membership; override is a possible future enhancement).
- Non-VAT / VAT-toggle events (all event invoices are VAT-inclusive 7%).
