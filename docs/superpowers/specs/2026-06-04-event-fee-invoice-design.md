# Event-Fee Invoices & Receipts — Design Spec (v2)

**Date:** 2026-06-04 · **Revised:** 2026-06-04 (v5)
**Status:** Draft — v2 panel review + v3 re-review gaps closed + v4 Open-Q resolution
+ **v5: scope refined — v1 = standard 7% VAT only; VAT-exempt §81 = fast-follow (§9).**
Ready for writing-plans.
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
3. **Granularity (Q1 — RESOLVED):** v1 = **1 invoice per event registration
   (1:1)**. Group / company-pays-for-many-attendees (one invoice over multiple
   registrations) is a **documented v2 fast-follow** (§9), not v1.
4. **Non-member buyer:** manual entry at creation; `tax_id` **optional**
   (present → ใบกำกับภาษี; absent → ใบเสร็จรับเงิน).
5. **Matched member:** auto-fill the full buyer identity from F3 incl. `tax_id`
   + composed address, read-only (snapshot at issue). Company member without a
   TIN is **rejected** at draft (`tax_id_required`, §86/4) — see §3.
6. **VAT (Q2 — RESOLVED; v1 = standard 7% only):** v1 issues **standard
   7%-inclusive** event invoices only — `ticket_price_thb` is VAT-inclusive,
   back-calc **half-away-from-zero** (matching `money.ts`, §3); doc-type per
   tax-id (tax invoice if tax-id present, else receipt). **VAT-exempt (RC §81)** is
   a documented **fast-follow (§9)** — the data model already supports it
   (`vat_rate_snapshot=0`, no later schema change), but the mode-selector +
   exempt rendering + receipt-only doc-type ship in v1.1.
   ⚠️ **Operational caveat (until exempt ships):** do NOT issue event invoices
   through the system for §81-exempt events (would wrongly charge 7%) — handle
   those manually/externally in the interim.

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

### Line kind (NF-D)
Add `'event_fee'` to **both** `INVOICE_LINE_KINDS` (domain const,
`invoice-line.ts:12` — currently `['membership_fee','registration_fee']`) **and**
the DB enum, landing **atomically** (the domain `as const` and the pgEnum `ADD
VALUE` must ship in the same change as `enforceOneSubjectLine`, else the
`'event_fee'` comparison is a TS2367 always-false / a DB enum error — F4-R8
pattern). Event invoices carry exactly one `event_fee` line (no pro-rate).

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
- **Audit routing (NF-A):** when `member_id` is null, emit `credit_note_issued`
  through the **non-timeline** branch `Exclude<F4AuditEventType,
  F4MemberTimelineAuditEventType>` (`payload: Record<string, unknown>` with
  `event_registration_id`) — do **NOT** widen `MemberTimelineAuditPayload`
  (audit-port.ts:186-188 stays `member_id: string`; widening would silently
  weaken the F3 timeline guarantee for the 5 membership events). A matched-member
  event credit note (member_id present) stays on the timeline branch. The
  use-case call-site switches branch on `member_id === null`.
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
- **Exempt mode = fast-follow (§9), NOT v1.** v1 always uses the tenant `vat_rate`
  (7%) inclusive. The data model already accommodates exempt (`vat_rate_snapshot=0`)
  so the fast-follow needs no schema change.

### (d) Use cases & ports
- **`createEventInvoiceDraft({ eventRegistrationId, buyer?, amountOverride? })`:**
  v1 always sets `vat_rate_snapshot` = tenant `vat_rate` (7%) + `vat_inclusive=true`.
  (The fast-follow adds a `vatMode: 'standard' | 'exempt'` param; exempt →
  `vat_rate_snapshot=0` + receipt-only doc-type — §9.)
  1. Read registration via **`EventRegistrationLookupPort.findById(tx, tenantId, id)`**
     (tx-threaded, mirrors `MemberIdentityPort`) — see §H1.
  2. Guards → typed errors: `no_fee_free_event` / `no_fee_comp_ticket`
     (split — partnership comp tickets legitimately have price 0),
     `attendee_erased` (pseudonymised), `duplicate` (active invoice exists —
     `SELECT … FOR UPDATE` on the index predicate; catch 23505 → typed
     `duplicate`, not a 500), `invalid_amount`, `tax_id_required`,
     `invalid_buyer_snapshot`.
  3. Amount: `total = amountOverride ?? ticket_price_thb`; `amountOverride` is
     **VAT-inclusive**, zod `.int().min(1).max(MAX_EVENT_INVOICE_SATANG)` where
     **`MAX_EVENT_INVOICE_SATANG = 100_000_000`** (= 1,000,000.00 THB) is a named
     domain constant shared by the use-case + the route-handler zod
     (defense-in-depth) → `invalid_amount` on violation. (NF-C — concrete value,
     not a placeholder.)
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

### (e) Clean Architecture & tenant isolation (H1 + NF-E)
`EventRegistrationLookupPort.findById(tx, tenantId, …)` lives in
invoicing/application; the adapter (invoicing/infrastructure) calls F6's
**`findByIdInTx(tx, tenantId, registrationId)`** via the public barrel — **F6's
`RegistrationsRepository.findById` (registrations-repository.ts:161) takes no
`tx`, so add a tx-threaded `findByIdInTx`** mirroring `InvoiceRepo.findByIdInTx`
(port extension on F6, not a barrel leak; the F6 Drizzle adapter implements it).
Threading the invoice `runInTenant` `tx` keeps RLS valid + closes the TOCTOU on a
fresh pool connection.
**Principle-I (all five sub-clauses):** (1) app-layer tenant filter; (2) db-layer
RLS via the threaded `tx`; (3) cross-tenant integration test asserting
`Result.err` + a `registration_cross_tenant_probe` audit event; (4) audit on the
probe; (5) **no super-admin bypass exists** for `EventRegistrationLookupPort` —
all reads are tenant-scoped through `runInTenant`; if a future super-admin path is
added it must be gated + logged + covered. Review-Gate blocker.

### (f) Audit taxonomy & retention (B6 + NF-A — decided now)
**Reuse** `invoice_draft_created` / `invoice_issued` / `invoice_paid` /
`invoice_voided` / `invoice_pdf_resent` with `invoice_subject` in the payload (no
new audit enum value).
- **Routing (NF-A — committed):** the `member_id`-null (non-member) variants emit
  through the **non-timeline** `Exclude<F4AuditEventType,
  F4MemberTimelineAuditEventType>` branch (`payload: Record<string, unknown>` with
  `event_registration_id`). **`MemberTimelineAuditPayload` is NOT changed** —
  `audit-port.ts:186-188` stays `member_id: string`; the audit-port type needs no
  edit. Matched-member event invoices (member_id present) emit on the timeline
  branch (so they appear in the member's F3 timeline). The use-case call-site
  switches branch on `member_id === null`. Add a **TS compile-test assertion**
  (tasks) that a non-member emit does not type-check against the timeline payload.
- **Email field:** buyer email in any payload is a named field
  `contact_email_sha256 = sha256Hex(email).slice(0,16)` (never raw; consistent
  with F6 import-csv:387), **omitted when the email is empty**.
- **Retention:** issued/paid/voided/pdf-resent stay **10-year** in
  `F4_AUDIT_RETENTION_YEARS` (Thai RD §87/3) — verified by `check:audit-counts`.
- No new enum value here, so no 4-place enum churn for audit; only the payload
  shape + the call-site branch change (captured for /speckit.tasks).

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
           VAT: 7% inclusive (v1 fixed — no selector; the exempt §81 selector is the §9 fast-follow)
           🏷️ doc-type:  tax-id present → "ใบกำกับภาษี/ใบเสร็จ" ; absent → "ใบเสร็จรับเงิน"
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
- **Loading (B8 — committed):** `loading.tsx` under `/admin/invoices/new` is a
  **shape-neutral** page skeleton (header + form-card outline, type-agnostic) — it
  is an RSC and cannot read `?type`, so it must NOT render a membership-specific
  shape (would flash the wrong skeleton on the event path → CLS, ux-standards
  §2.1). The type-specific `EventAttendeePickerSkeleton` (column-matched) renders
  inside a **client-side Suspense boundary** that mounts only when `Event` is
  selected + the event is chosen, with `useMinDelay(300)`.
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
- v1 event invoices are standard 7% → render the normal ใบกำกับภาษี/ใบเสร็จ per
  buyer tax-id (same as membership). (VAT-exempt §81 rendering — receipt-only +
  §81 note + no VAT line — is the §9 fast-follow.)
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
- **Retention/erasure — scheduled redaction job (fully specified):**
  Non-member (`member_id IS NULL`) snapshots have no F3 archive cascade, so a
  dedicated job enforces §87/3 + Art. 5(1)(e):
  - **Endpoint:** `POST /api/cron/invoicing/redact-expired-event-buyers` (Bearer
    `CRON_SECRET`, retry-OFF, cron-job.org — same pattern as F8/F9 crons).
  - **Predicate:** `invoice_subject='event' AND member_id IS NULL AND status<>'draft'
    AND issue_date < now() − interval '10 years'`.
  - **Action (tombstone, preserve tax record):** overwrite
    `member_identity_snapshot` →
    `{ legal_name:'[REDACTED]', tax_id:null, address:'[REDACTED]',
       primary_contact_name:'', primary_contact_email:'' }`; **keep** `*_satang`,
    `document_number`, `vat_*`, dates (the financial/tax record survives; only PII
    is erased).
  - **Audit:** emit `event_buyer_pii_redacted` per row — this is the **one new
    audit event type** the feature adds (the invoice_* events are reused, §3f), so
    it needs the 4-place update (domain const + pgEnum + audit-event.test +
    completeness.test) + **10y** retention in `F4_AUDIT_RETENTION_YEARS`
    (/speckit.tasks).
  - **Runbook:** add to `docs/runbooks/cron-jobs.md`.
- **Retention table (added):**

  | Data | Retention | Basis |
  |------|-----------|-------|
  | Event invoice financial record (`*_satang`, `document_number`, dates, audit issued/paid/voided) | **10y** from issue | RD §87/3 |
  | Non-member buyer PII (snapshot identity fields) | **10y** from issue, then redaction job tombstones | RD §87/3 ceiling + PDPA §19 / Art. 5(1)(e) storage-limitation |
  | Matched-member buyer PII | follows the F3 member lifecycle (archive cascade) | existing |

- **DSR:** refuse erasure during §87/3 retention (Art. 17(3)(b)); offer Art. 18
  restriction on contact fields; manual Art. 15/20 for accountless non-members.
- **Privacy notices (named):** (a) update the F6 attendee privacy notice
  (`src/i18n/messages/{en,th,sv}.json` namespace `events.privacyNotice.*`) to add
  the tax-receipt secondary purpose; (b) conditional invoice-email footer for
  `invoice_subject='event' AND member_id IS NULL`, keys
  `admin.invoices.emailFooter.eventNonMember.*` (EN/TH/SV).
- **RoPA:** `docs/compliance/processing-records.md` (currently says F4 out of
  scope, :17) — add an event-fee-invoice processing entry (purpose, categories,
  basis, retention, recipients) before /speckit.ship; content skeleton in the
  tasks list.
- **Redaction (logs):** add `primary_contact_email` to the invoicing pino
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

**Resolved (was Open Questions):**
- **Q1 — granularity → RESOLVED:** v1 = 1:1 (one invoice per registration);
  group/company-pay = v2 fast-follow (§9).
- **Q2 — VAT (RC §81) → RESOLVED:** **v1 = standard 7% inclusive only**; VAT-exempt
  §81 (mode selector + 0% + receipt-only) = fast-follow (§9). Operational caveat:
  no system event invoices for §81-exempt events until the fast-follow ships.

---

## 9. Out of Scope (YAGNI) & Acknowledged Deferrals

- **VAT-exempt §81 mode (Q2 fast-follow — first follow-up):** per-invoice VAT-mode
  selector (Standard 7% / Exempt §81); exempt → `vat_rate_snapshot=0`,
  `subtotal=total`, `vat=0`, **document is ALWAYS ใบเสร็จรับเงิน (never ใบกำกับภาษี,
  even with a buyer tax-id) + a "VAT-exempt RC §81" note + no VAT line**. Signalled
  by `invoice_subject='event' AND vat_rate_snapshot=0` (no schema change — the v1
  data model already supports it). Adds a `vatMode` param to `createEventInvoiceDraft`,
  AS-VAT-02 golden, exempt unit cases. The thai-tax auditor confirms §81
  exempt-sale documentary rules at that fast-follow's /speckit.plan.
- **Group / company-pays-for-many-attendees (Q1 v2 fast-follow):** one invoice
  over multiple registrations of one payer (multiple `event_fee` lines; buyer =
  the paying company, not an attendee). Acknowledged real B2B need — v2, not v1.
- Batch invoicing + **batch credit-note on event cancellation** (acknowledged
  operational cost; deferred).
- A standalone "event customer" entity (non-member buyer is a per-invoice snapshot).
- Separate event invoice prefix (shares INV).
- Per-tenant "event invoicing enabled" setting (gated by the F4 feature flag).
- Editable buyer identity for a matched member (auto + read-only; override = future).
- **F5 self-pay (Decision 7 + NF-B):** matched members CAN self-pay event invoices
  + see them in `/portal/invoices`; **non-members cannot** (no portal account →
  admin records payment manually; guest-payment-link = future). **Code reality:**
  `getInvoiceForPayment`'s DTO `InvoiceForPayment.memberId` is `string` (non-null,
  get-invoice-for-payment.ts:65) → a non-member (DB `member_id IS NULL`) row
  cannot be mapped → the "subject-agnostic reuse" claim is FALSE as-was. **Fix
  (committed):** widen `InvoiceForPayment.memberId: string | null`; `initiate-payment`
  skips the F3 member-ownership check when null (non-member payments are
  tenant-linked, not member-linked) — this keeps the admin record-payment path
  working for non-member event invoices while self-pay stays members-only at the
  portal layer.
- `member_identity_snapshot` → `BuyerIdentitySnapshot` rename (decide at
  /speckit.plan; if not renamed, the clarifying comment + retention-sweep
  inclusion are mandatory).
