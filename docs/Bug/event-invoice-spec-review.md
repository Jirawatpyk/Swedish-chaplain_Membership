I've read the spec fully. Now I'll write the consolidated review report by deduping and ranking the panel's findings.

# Consolidated Spec Review — Event-Fee Invoices & Receipts (`2026-06-04-event-fee-invoice-design.md`)

## 1. Overall Verdict

**NOT READY** to proceed to /speckit.plan. **Major changes required.** All six specialists returned `major_changes`. The spec's central claim — "`issueInvoice` (existing) reused unchanged: subject-agnostic" (§3, lines 122–124) — is **factually false** and would block every event invoice from issuing. The spec also omits the Domain-type and audit-taxonomy changes the design actually requires, and has unaddressed PII/PDPA, VAT-rounding, and amount-validation gaps. Resolve the blockers below in the spec doc, then re-gate.

---

## 2. Blocker & High Findings (deduped, must resolve before implementation)

### B1 — `issueInvoice` is NOT subject-agnostic (BLOCKER)
**Specialists:** Thai Tax Auditor, architect, PM, AppSec — **all four independently.** Highest-confidence finding in the panel.
**Issue:** §3 lines 122–124 claim reuse-unchanged, but `issue-invoice.ts` has three hard membership couplings that fire for **every** event invoice:
- Line 233 `enforceOneMembershipLine(draft.lines)` → an `event_fee` draft has zero `membership_fee` lines → returns `no_membership_line` → **issue always fails.**
- Lines 202–209 `memberIdentity.getForIssue(tx, tenantId, draft.memberId, {forUpdate:true})` unconditional → null `memberId` (non-member) → Postgres `22P02` (null UUID) or `member_not_found`.
- Lines 222–228 company-tier `tax_id_required` gate runs on live `memberIdentity` data, which event invoices don't load (they use the pinned snapshot) → company members can issue event invoices without a TIN, violating §86/4.

**Spec change:** Replace the "reused unchanged" sentence with an explicit "**Changes to `issueInvoice`**" subsection specifying: (a) subject-aware `enforceOneSubjectLine(subject, lines)` in `invoice.ts` (Domain, zero imports) — exactly one `membership_fee` for membership, exactly one `event_fee` for event; new error variants `no_event_fee_line` | `multiple_event_fee_lines`; (b) skip the member `FOR UPDATE` lock + archive-race guard when `draft.memberId === null`, validating the pre-pinned snapshot instead; (c) move the §86/4 tax-id-required check to `createEventInvoiceDraft` (gate on the buyer snapshot's `tax_id`, not `memberTypeScope`); (d) document the revised lock order (no member-lock step for event path) for deadlock-safety review. Log as a Complexity Tracking deviation.

### B2 — Invoice **Domain type** + ports + mapper never updated for nullable/discriminator fields (BLOCKER)
**Specialists:** Thai Tax Auditor, architect, PM.
**Issue:** §2 changes only the DB schema. But `invoice.ts` Domain interface has `memberId: string`, `planId: string`, `planYear: number` (all non-null) and no `invoiceSubject`/`vatInclusive`/`eventId`/`eventRegistrationId`. Under `strict` + `exactOptionalPropertyTypes`, any event-invoice construction is a TS2322/TS2379 compile error, and the Application layer has no type-safe way to branch on subject. `InvoiceRepo.insertDraft` port + `rowsToInvoice` mapper also hard-code the non-null fields — forcing fabricated UUIDs/empty strings (a type lie).
**Spec change:** Add a "**Domain type changes**" paragraph to §2/§3: `memberId/planId: string | null`, `planYear: number | null`, `invoiceSubject: 'membership'|'event'`, `vatInclusive: boolean`, `eventId/eventRegistrationId: string | null`. State these must land simultaneously in `Invoice` (domain), `InvoiceRow` (Drizzle), `InvoiceRepo.insertDraft` port, and `rowsToInvoice` mapper, plus every caller reading those fields (per F4-R8 lesson: migration + integration green before commit).

### B3 — VAT-inclusive rounding mode conflicts with existing `Money` arithmetic (BLOCKER)
**Specialist:** Thai Tax Auditor.
**Issue:** §3 line 91 specifies `round_half_even` (banker's rounding) for the inclusive split, but `money.ts` lines 133–134 (`multiplyByFraction`), `calculateVat`, and `calculateCreditNoteVat` all use **half-away-from-zero**. A credit note on an event invoice re-derives VAT via `originalVat.multiplyByFraction(creditTotal, originalTotal)` (half-away) against a subtotal derived half-even → potential ±1 satang mismatch the Revenue Department will catch.
**Spec change:** Standardise on **half-away-from-zero** to match the existing pipeline. Rewrite §3 to bigint integer math: `subtotal = (totalSatang * 10000n + rateBps/2n) / (10000n + rateBps)`, `vat = totalSatang − subtotal` (invariant `subtotal+vat===total` preserved). Add fast-check property test covering boundary totals (e.g. 107, 214, 321 satang where modes diverge).

### B4 — `amountOverride` has no validation bounds (BLOCKER)
**Specialist:** AppSec (SEC-EI-01). Related: PM (comp-ticket vs override).
**Issue:** §3 step 4 `total = amountOverride ?? ticket_price_thb` with no constraint. Override can be `0` (bypasses the `no_fee` guard which only checks `ticket_price_thb`), negative (negative-total "tax invoice" — §86 violation + revenue manipulation), or astronomically large (BigInt/`@react-pdf` DoS).
**Spec change:** Add to `createEventInvoiceDraftSchema` (and the route-handler zod, defense-in-depth): `amountOverride: z.number().int().min(1).max(<tenant ceiling, e.g. 10_000_000_00>).optional()`. Add error code `invalid_amount` to the draft-error union; unit tests for `0`, negative, `MAX+1`. Document whether the override is VAT-inclusive (it should be — confirm in the schema contract).

### B5 — `issue-credit-note` audit payload requires non-null `member_id` (BLOCKER)
**Specialists:** Thai Tax Auditor; reinforced by architect/PM/AppSec audit-taxonomy findings.
**Issue:** `issue-credit-note.ts` line 557 puts `member_id: loaded.memberId` into a `credit_note_issued` event typed as `F4MemberTimelineAuditEventType`, whose payload requires `member_id: string` (audit-port.ts:186-188). Null memberId (non-member) → compile error. Line 580 also auto-emails to `primary_contact_email`, which L-03 allows to be `''`.
**Spec change:** Specify that `issueCreditNote` must either promote `credit_note_issued` to accept `member_id: string | null` (with `event_registration_id` when null) or branch to a non-timeline event type; and guard the auto-email with `if (recipientEmail) …`.

### B6 — Audit taxonomy + retention deferred = compliance gap that must be resolved NOW (BLOCKER)
**Specialists:** PM, AppSec (SEC-EI-06); also flagged medium by Thai Tax Auditor + architect.
**Issue:** §8 lines 252–254 defers the event/reuse decision to /speckit.plan. But `F4MemberTimelineAuditEventType` requires non-null `member_id`; non-member event invoices have `member_id = null` → either a type violation or the event silently drops from the F3 timeline. Separately, any new tax-document-touching event type **must** map to **10y** in `F4_AUDIT_RETENTION_YEARS` (audit-port.ts:110) or T135/`check:audit-counts` fails and retention silently downgrades to 5y (Thai RD §87/3 violation).
**Spec change:** Decide in the spec now: reuse `invoice_draft_created`/`invoice_issued` with `invoice_subject` in the payload (recommended by architect + AppSec — no new enum migration), define a payload variant where `member_id: string | null` and `event_registration_id` required, assign **10y** retention to issued/paid/voided/pdf-resent, and note the 4-place update (domain const + pgEnum + audit-event.test.ts + completeness.test.ts) for /speckit.tasks. Buyer email in any payload must be `sha256Hex(email).slice(0,16)`, never raw (consistent with F6 import-csv.ts:387).

### B7 — Non-member buyer PII: no lawful basis, no retention/erasure, no RoPA, no collection notice (BLOCKER)
**Specialist:** PDPA/GDPR Officer (four blocker/high findings consolidated).
**Issue:** The spec introduces a brand-new PII collection path (legal_name, address, tax_id, contact name/email for non-members in `member_identity_snapshot`) with **zero** compliance scaffolding:
- No documented PDPA §19 / GDPR Art. 6 lawful basis per field (statutory §86/§87 covers name/address/tax_id; contact fields need contract basis).
- Pre-fill from F6 attendee data is a **new processing purpose** (F6 collected under legitimate-interest event-admin basis) → PDPA §23 / Art. 5(1)(b) purpose-limitation breach without a compatibility assessment.
- **No deletion/anonymisation** for non-member snapshots (member_id IS NULL has no F3 archive cascade) → PII persists indefinitely → §19 / Art. 5(1)(e) storage-limitation breach.
- `processing-records.md` (RoPA, PDPA §39 / Art. 30) not listed as a deliverable.
- Auto-email to a non-member is first contact → needs a PDPA §23 privacy-notice footer (EN/TH/SV); F4 template has none.

**Spec change:** Add a "**Lawful Basis & Data Protection**" section: (a) per-field basis table (legal_name/address/tax_id → legal obligation §86/§87; contact → contract/document delivery); (b) commit to RD §86/§87 legal-obligation as the secondary-use basis for the pre-fill **and** update the F6 privacy notice (3 locales) to add the tax-receipt purpose; (c) a 10y-from-issue scheduled redaction job that tombstones `member_identity_snapshot` PII on `member_id IS NULL` event invoices while preserving `*_satang` + `document_number` — added to §2, §7, and the Retention table; (d) require `processing-records.md` update before /speckit.ship; (e) conditional privacy-notice footer in the invoice email for `invoice_subject='event' AND member_id IS NULL` (3 locales); (f) DSR playbook — refuse erasure during §87/3 retention (Art. 17(3)(b)), offer Art. 18 restriction on contact fields, manual Art. 15/20 fulfilment for accountless non-members.

### B8 — Non-member buyer form / picker UX & a11y undefined (BLOCKER)
**Specialist:** Chamber-OS UX Architect (two blocker findings consolidated).
**Issue:** (a) §4 says "shimmer while loading" but defines no skeleton shape, Suspense owner, `loading.tsx`, or `useMinDelay(300)` for the event/attendee pickers — CLS risk per ux-standards §2.1. (b) §4 Step 4 collapses "address (required)" into one word — Thai §86 needs street/district/province/postcode; the spec doesn't state freeform-textarea vs structured, per-field validation, error copy, or `aria-required`/`aria-describedby`, making the EN/TH/SV key inventory unverifiable.
**Spec change:** Add a named `EventAttendeePickerSkeleton` (column-matched), a `loading.tsx` under `/admin/invoices/new`, and `useMinDelay(300)`. Decide and document **freeform textarea** for address (matches the existing single-string `member_identity_snapshot.address` contract — confirm via `makeMemberIdentitySnapshot`) with required/optional flags, per-field inline error copy in EN/TH/SV, and the aria pattern.

### H1 — `EventRegistrationLookupPort` tx-threading + cross-tenant test (HIGH)
**Specialists:** architect, AppSec (SEC-EI-03), Thai Tax Auditor (boundary test).
**Issue:** §3 line 128 reads F6 "through its public barrel," but F6's `RegistrationsRepository` methods take `TenantId` and **no `tx`** — reading outside the invoice `runInTenant` tx opens a TOCTOU window (registration pseudonymised/deleted between check and insert) and risks RLS bypass on a fresh pool connection (per the CLAUDE.md gotcha). The `?eventRegistrationId` deep-link is also an IDOR surface with no UUID guard and no mandated Principle-I cross-tenant test (Review-Gate blocker under Constitution v1.4.0).
**Spec change:** Define `EventRegistrationLookupPort.findById(tx, tenantId, …)` (mirror `MemberIdentityPort.getForIssue`); extend F6's repo with a tx-threaded `findById` if absent (port extension, not a barrel leak). Add the five Principle-I sub-clauses to §3 + a §7 cross-tenant integration test asserting `Result.err` + a `registration_cross_tenant_probe` audit event. Copy the `UUID_RE.test()` guard from `/admin/invoices/new/page.tsx:46` to the `?eventRegistrationId` server page.

### H2 — Invoices-list buyer link breaks for non-members; chip/column tokens undefined (HIGH)
**Specialist:** Chamber-OS UX Architect (two findings).
**Issue:** `invoice-table.tsx:364` hardcodes `<Link href={/admin/members/${r.memberId}}>` → null memberId yields `/admin/members/null` (404). The `[🎟 Event]` chip nominates no shadcn Badge variant (raw-colour risk per ux-standards §1.2). `memberName` → "Buyer" header label change risks an i18n key collision.
**Spec change:** §4 list: non-member event rows render Buyer as plain text (no link); matched-member rows keep `/admin/members/{memberId}`. Chip uses `Badge variant="secondary"` (no new token). Add keys `admin.invoices.list.columns.buyer` and `admin.invoices.list.subjectChip.event`(+`.eventAria`) in EN/TH/SV.

### H3 — Soft-duplicate guard: TOCTOU 500 + voided-row false positive (HIGH)
**Specialists:** AppSec (SEC-EI-05), architect (partial-index NULL semantics), UX (dialog anatomy).
**Issue:** §3 step 2 check-then-insert has a race: the partial unique index catches one of two concurrent INSERTs as Postgres 23505 → opaque 500, not a typed `duplicate`. The duplicate check must query the **same predicate** as the index (`status <> 'voided'`) or it false-warns on a voided row. The confirm dialog (§4/§6) has no title/copy/button labels/focus-default/i18n keys.
**Spec change:** §3 step 2: `SELECT … FOR UPDATE` on `invoices WHERE tenant_id=? AND event_registration_id=? AND invoice_subject='event' AND status<>'voided'` inside the tx; catch 23505 → return typed `duplicate`. Confirm NULL-is-distinct is intentional for membership rows. Add `AS-DEDUP-01` (void → re-issue succeeds without warning). Specify the AlertDialog (title/description/Cancel-default+"Issue anyway"/i18n keys `admin.invoices.eventFeeForm.duplicateDialog.*`).

### H4 — Non-member `tax_id` & `legal_name`/`address` have no format/length validation (HIGH)
**Specialist:** AppSec (SEC-EI-04, SEC-EI-08).
**Issue:** `memberIdentitySnapshotSchema` accepts any `z.string().min(1)` for `tax_id` → non-numeric/`<script>` passes, lands in the 5y audit log (log injection) and produces a §86/4-invalid invoice. `legal_name`/`address` have no max-length → 50k-char input → `@react-pdf` timeout/DoS.
**Spec change:** Add `nonMemberTaxIdSchema = z.string().regex(/^\d{13}$/).nullable()` for the non-member buyer path; `legal_name: .max(500)`, `address: .max(1000)`. Error codes `invalid_tax_id_format`. Unit tests SEC-EI-04/08. Confirm `primary_contact_email` is in the invoicing pino `REDACT_PATHS`.

### H5 — Auto-email to non-member with empty contact email (HIGH)
**Specialists:** architect, AppSec (SEC-EI-07), PM (transactional vs broadcast path).
**Issue:** `issueInvoice` line 381 enqueues to `memberSnap.primary_contact_email`, which L-03 permits to be `''` → enqueue to empty recipient fails silently or errors (possibly leaking the invoice payload in logs). PM adds: for non-members the recipient should be the registration `attendeeEmail`, and event emails must use the **F4 transactional** Resend path (`RESEND_API_KEY`), **never** the F7 broadcasts path (a marketing unsubscribe must not suppress a tax document).
**Spec change:** §3: guard `if (primary_contact_email !== '') enqueue` (skip + `pino.warn` + audit `…auto_email_skipped_no_contact` otherwise); for non-members use the registration `attendeeEmail`. §5: state the transactional outbox explicitly + a contract test asserting it.

### H6 — Matched-member event invoice bypasses §86/4 company-tax-id requirement (HIGH)
**Specialist:** Thai Tax Auditor (overlaps B1c).
**Spec change:** In `createEventInvoiceDraft`, before pinning a matched-member snapshot: if `memberTypeScope === 'company' && !snapshot.tax_id` → return `tax_id_required`. §86/4 compliance, not optional.

### H7 — Event date in line description must be CE in storage, BE display-only (HIGH)
**Specialist:** Thai Tax Auditor.
**Issue:** §5 `<date>` in `descriptionTh` is unspecified; storing a BE date string in `invoice_lines.description_th` is an off-by-543 ship blocker.
**Spec change:** §5: `<date>` = event date as CE ISO-8601 (YYYY-MM-DD) in both EN and TH stored description; PDF renderer converts to BE at presentation only (same helper as issue date). Add to §7 test cases.

### H8 — Shared INV sequence continuity untested at fiscal-year boundary (HIGH)
**Specialist:** Thai Tax Auditor.
**Spec change:** §7 add: "INV-YYYY continuity across interleaved membership + event invoices at the Asia/Bangkok fiscal-year boundary (23:59:59 → 00:00:00, injected UTC clock)" — confirm `fiscalYearFromUtcIso` gives no gap/reset (§87 no-gaps).

### H9 — `enforce...`/`assertSnapshotsSet` & VAT line semantics need explicit acceptance numbers (HIGH)
**Specialists:** architect (line-amount reconciliation, `assertSnapshotsSet` rename), Thai Tax Auditor.
**Spec change:** §3: state the `event_fee` line `unitPrice` stores the **ex-VAT** subtotal (so PDF shows subtotal/VAT/total correctly); add `AS-VAT-01`: ticket_price=1070 → line 1,000.00 / VAT 70.00 / total 1,070.00, encoded in the golden PDF test. State the buyer snapshot is **always** populated for event invoices (reject `invalid_buyer_snapshot` before persist) and clarify `assertSnapshotsSet`'s comment covers member-or-non-member.

### H10 — VAT-applicability legal risk (Thai RC §81 exemptions) (HIGH)
**Specialists:** PM, Thai Tax Auditor (§9 medium).
**Issue:** Decision 6 (line 39) hardcodes all event tickets as VAT-7% with no escape; RC §81 exempts certain cultural/educational/charitable services (SweCham hosts both kinds) → risk of VATing an exempt event.
**Spec change:** §8 Risk Flag + a visible admin confirmation on the create form ("Confirm this event is subject to 7% VAT"); document the no-per-event-toggle decision in §9 with the exempt-event workaround (void + plain-receipt/0-VAT path) and a pre-launch SweCham sign-off note.

---

## 3. Medium / Low Findings

**Fold into the spec NOW (cheap, prevents omission):**
- **Migration split (architect, HIGH-leaning medium):** `ALTER TYPE … ADD VALUE 'event_fee'` is **non-transactional** — must be its own migration N; nullable columns + backfill + `vat_inclusive` + `event_id`/`event_registration_id` + CHECK go in transactional migration N+1. Same applies to any new audit pgEnum value. Document in §2 migration discipline.
- **F5 self-pay scope (PM, HIGH):** add Decision 7 — matched members can self-pay event invoices via the existing subject-agnostic `getInvoiceForPayment`; non-members cannot (no portal account → admin records payment manually). Add guest-payment-link to §9.
- **Member portal visibility (PM, medium):** state matched-member event invoices appear in `/portal/invoices` (naturally via `list-invoices-by-member`); non-member invoices have no portal visibility.
- **Comp-ticket distinct error (PM, medium):** partnership comp tickets (Diamond/Platinum/Gold) legitimately have `ticket_price_thb = 0`; split the `no_fee` block into `no_fee_comp_ticket` vs `no_fee_free_event` with distinct messages.
- **Command palette (UX, medium):** existing "New invoice" → `/admin/invoices/new` (type selector first); add "New event fee invoice" → `?type=event`. Note in §4 + tasks.
- **RBAC on F6 CTA (UX, HIGH-leaning medium):** the shortcut CTA must render admin-only (invoice creation is admin-gated; manager would hit `notFound()`). Hide for manager.
- **`attendee_pdpa_consent_acknowledged` (PDPA, medium):** add a code comment that the §86/§87 legal-obligation basis means consent-withdrawal does NOT block the pre-fill.
- **Three distinct attendee-picker empty states (UX, medium):** no-registrations / all-already-invoiced / all-erased — each with icon + title + CTA in EN/TH/SV.

**Defer to /speckit.plan or note as deferred:**
- Doc-type badge `aria-live` branching — static `role="status"` for matched members, `aria-live="polite"` only on the non-member tax-id-typing path (UX, medium — implementation detail).
- Wizard vs progressive-disclosure semantics + section landmarks + 2-button footer (UX, HIGH-leaning) — fold the **decision** ("progressive-disclosure, no stepper") into §4 now; aria details at plan time.
- `member_identity_snapshot` → `BuyerIdentitySnapshot` rename vs prominent comment (PDPA medium) — decide at /speckit.plan; if not renamed, the comment + the retention-sweep inclusion are mandatory (ties to B7c).
- Batch credit-note on event cancellation (PM, HIGH-leaning) — add to §9 as an acknowledged operational cost; implementation deferred.
- 1:1-granularity validation with SweCham finance (PM, medium) — add as §8 Open Question Q1 before implementation starts.

---

## 4. Cross-Cutting Themes (≥2 specialists)

1. **"`issueInvoice` reused unchanged" is the spec's load-bearing false claim** — flagged by **4 of 6** (Tax, architect, PM, AppSec). This single error cascades into the line-kind guard, member-lock, tax-id gate, credit-note payload, and audit taxonomy. Fixing B1+B2+B5+B6 together is the critical path.
2. **Nullable `member_id` ripples through every layer** — DB → Drizzle row → Domain type → ports → mapper → audit payload → invoice-table link → portal query. Touched by Tax, architect, PM, UX, AppSec. The spec treats it as a migration-only concern; it is a full-stack type change.
3. **Non-member PII is a net-new compliance surface** — PDPA officer (4 findings) + AppSec (tax-id/email validation, redaction) + PM (transactional email path). Lawful basis, retention/erasure, RoPA, collection notice, and field validation must all be added before /speckit.plan.
4. **VAT correctness end-to-end** — rounding mode (Tax), ex-VAT line storage + golden numbers (architect, Tax), §81 exemption risk (PM, Tax). Pick half-away-from-zero, encode `AS-VAT-01`, add the exemption guard.
5. **Tenant-isolation + TOCTOU on the F6 read and duplicate guard** — architect + AppSec + Tax. Both the `EventRegistrationLookupPort` and the duplicate check must thread the same `tx` and have explicit cross-tenant/concurrency tests (Principle I Review-Gate blocker).

---

## 5. Recommended Spec Edits — Checklist (before /speckit.plan)

- [ ] **§3** Replace "reused unchanged" with a "Changes to `issueInvoice`" subsection: subject-aware line guard, conditional member-lock skip, moved §86/4 tax-id gate, revised lock order. *(B1, H6)*
- [ ] **§2/§3** Add "Domain type changes": nullable `memberId/planId/planYear` + `invoiceSubject`/`vatInclusive`/`eventId`/`eventRegistrationId` across Domain, Drizzle row, `insertDraft` port, mapper. *(B2)*
- [ ] **§3** Rewrite the inclusive-split formula to half-away-from-zero bigint math; add boundary fast-check cases. *(B3)*
- [ ] **§3** Add `amountOverride` zod bounds (`.int().min(1).max(...)`) + `invalid_amount` error + tests; state override is VAT-inclusive. *(B4)*
- [ ] **§3** Specify `issueCreditNote` changes: nullable `member_id` audit payload (or non-timeline event) + empty-email auto-email guard. *(B5)*
- [ ] **§8** Decide audit taxonomy NOW: reuse `invoice_*` events with `invoice_subject` payload + nullable `member_id`/required `event_registration_id` variant; assign 10y retention; note the 4-place update; hash buyer email. *(B6)*
- [ ] **New §** "Lawful Basis & Data Protection": per-field basis table, F6 secondary-use/privacy-notice update, 10y redaction job, RoPA deliverable, conditional email privacy footer (EN/TH/SV), DSR playbook. *(B7)*
- [ ] **§4** Add `EventAttendeePickerSkeleton` + `loading.tsx` + `useMinDelay(300)`; decide freeform-textarea address with per-field validation/error copy/aria in EN/TH/SV. *(B8)*
- [ ] **§3/§7** Define `EventRegistrationLookupPort.findById(tx, tenantId, …)`; F6 tx-threaded repo extension; 5 Principle-I sub-clauses + cross-tenant test + `registration_cross_tenant_probe`; UUID guard on `?eventRegistrationId`. *(H1)*
- [ ] **§4** Non-member Buyer cell = plain text (no link); chip `variant="secondary"`; add i18n keys `…columns.buyer`, `…subjectChip.event(+Aria)`. *(H2)*
- [ ] **§3/§4/§6** `SELECT … FOR UPDATE` + 23505→typed `duplicate`; predicate-matched check; `AS-DEDUP-01`; full AlertDialog spec + i18n keys. *(H3)*
- [ ] **§3** Non-member `tax_id` regex `^\d{13}$`, `legal_name.max(500)`, `address.max(1000)`, redact `primary_contact_email`. *(H4)*
- [ ] **§3/§5** Auto-email guards empty email; non-member uses `attendeeEmail`; state F4 transactional outbox + contract test. *(H5)*
- [ ] **§5/§7** Line-description `<date>` = CE ISO stored, BE display-only. *(H7)*
- [ ] **§7** Fiscal-year-boundary shared-sequence integration test. *(H8)*
- [ ] **§3/§7** `event_fee` line stores ex-VAT subtotal; `AS-VAT-01` golden numbers; always-populated buyer snapshot (`invalid_buyer_snapshot` pre-persist). *(H9)*
- [ ] **§8/§4/§9** RC §81 VAT-exemption risk flag + admin "subject to 7% VAT" confirmation + exempt-event workaround. *(H10)*
- [ ] **§2** Split enum-add migration (non-transactional) from the transactional schema migration. *(Medium — fold now)*
- [ ] **§1/§9** Decision 7 (F5 self-pay: members yes, non-members no) + portal visibility note + comp-ticket distinct error + command-palette entry + admin-only F6 CTA. *(Mediums — fold now)*
- [ ] **§9/§8** Acknowledge batch-credit-note deferral + 1:1-granularity Open Question Q1 for SweCham finance validation. *(Defer-but-note)*

**Relevant code the spec edits must reconcile against (absolute paths):**
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\invoicing\application\use-cases\issue-invoice.ts` (lines ~202–209, 220, 222–228, 233, 381 — couplings in B1/H5)
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\invoicing\application\use-cases\issue-credit-note.ts` (lines ~557, 580 — B5)
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\invoicing\domain\invoice.ts` (Domain interface + `enforceOneMembershipLine` + `assertSnapshotsSet` — B2/B1/H9)
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\invoicing\domain\value-objects\money.ts` (lines ~133–134 half-away rounding — B3)
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\invoicing\domain\value-objects\member-identity-snapshot.ts` (schema `z.string().min(1)` — H4)
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\invoicing\application\ports\audit-port.ts` (lines ~110–144 retention map, ~177/186–188 timeline payload — B6/B5)
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\invoicing\infrastructure\schema-invoices.ts` (`notNull()` columns — B2)
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\components\...\invoice-table.tsx` (line ~364 hardcoded member link — H2)
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\app\(staff)\admin\invoices\new\page.tsx` (lines ~38 RBAC gate, ~46 UUID guard — H1, UX RBAC)
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\events\application\use-cases\_helpers\import-csv.ts` (line ~387 `sha256Hex` email pattern — B6)