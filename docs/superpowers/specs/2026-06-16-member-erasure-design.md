# Member Erasure (COMP-1) — Design

**Right to erasure for chamber members: GDPR Art. 17 ("right to be forgotten") + Thai PDPA §33.**

Date: 2026-06-16 · Status: design approved (brainstorming), pending spec/implementation-plan · Topic: COMP-1

---

## 1. Problem & purpose

A chamber member may exercise their statutory right to have their personal data erased. Today Chamber-OS can **export** a member's data (F9 — GDPR Art. 15 access / Art. 20 portability) and **archive** a member (status change + cascade that stops sessions, in-flight broadcasts, and renewal cycles), but it **cannot actually erase the personal data** — name, tax ID, address, contacts (name/email/phone/DoB), event-attendance identity, and broadcast content all remain in the database indefinitely.

This is a concrete compliance gap (not a bug): an erasure request received today has **no process or mechanism** to fulfil it. The feature closes that gap.

**Legal basis:** PDPA §33 (data deletion) · GDPR Art. 17 (erasure). Swedish/EU member data subjects are covered by GDPR via the SCCs already in place (see Constitution § Compliance). The chamber is the controller.

**Success criteria:**
- An admin can fulfil an erasure request for a member, removing/anonymising the member's personal data across every module, in one auditable operation.
- The operation is **idempotent**, **tenant-isolated** (Principle I), and **legally safe** — it never deletes data that statute requires retained (Thai tax documents, audit log, the marketing-suppression list).
- A DPO can produce a defensible record: who requested, who executed, what was erased, when.

---

## 2. The hard constraints that shape the design

| Constraint | Implication |
|---|---|
| **FK web** — `invoices`, `payments`, `event_registrations`, `broadcasts`, `renewal_cycles` all FK to `members(tenant_id, member_id)` | We **cannot hard-delete the member row** (would break FKs / risk cascade-deleting tax invoices). → anonymise **in place**, keep the row as a tombstone. |
| **Thai RD §87/3 / §86/4** — tax invoices/receipts/credit-notes must be retained **10 years**, including buyer name + tax_id for VAT-registrant buyers | The tax-document buyer identity **cannot be erased immediately**. → snapshot + legal-hold + scheduled redaction after 10y (the pattern already used for non-member event buyers). |
| **Audit log is append-only** (BEFORE DELETE trigger raises) | Audit rows are **never deleted**. → scrub PII from audit *payloads* (e.g. admin free-text `reason`/`notes`); keep the opaque `member_id` UUID (pseudonymous, not direct PII). |
| **GDPR Art. 21 / PDPA §32** — `marketing_unsubscribes` must persist indefinitely so future processing is avoided | The suppression list is **never erased**. |
| **Irreversibility** | Erasure cannot be undone → admin-mediated + typed-phrase confirmation. |

These constraints make the strategy largely **forced**: *anonymise-in-place immediately for un-pinned PII; legal-hold + scheduled-redact for tax-pinned identity; never-erase the suppression list and audit rows (scrub payloads only).*

---

## 3. Existing pieces we reuse (don't rebuild)

| Piece | Location | Reuse |
|---|---|---|
| `archiveMember` cross-module cascade | `members/application/use-cases/archive-member.ts` | The orchestration shell — sessions, invitations, F7 broadcasts, F8 renewals — via injected **cascade ports** that already accept `gdpr_erasure_request` / `pdpa_deletion_request` reasons. |
| `cancelInFlightBroadcastsForMember` (F7) + `cancelInFlightCyclesForMember` (F8) | broadcasts / renewals use-cases | Already wired into archive; erasure passes the erasure reason. |
| `eraseAttendeePii` (F6) | `events/application/use-cases/erase-attendee-pii.ts` | Idempotent hard-delete/pseudonymise of an event registration (audit-gated, advisory lock, quota credit-back) — applied per the member's matched registrations. |
| Non-member event-buyer 10y redact cron | `app/api/cron/invoicing/redact-expired-event-buyers/route.ts` | Pattern to extend to member invoice buyer-identity snapshots. |
| F9 GDPR export source map | `insights/.../gdpr-archive-source-adapter.ts` | The PII inventory it reads from = the inventory we must scrub. |
| Session revocation + invitation cascade ports | members ports | Already invoked on archive. |

**Missing (this feature builds):** `eraseMember` orchestration · members/contacts PII scrub · `member_erased` + `member_erasure_requested` audit events · F4 legal-hold + member redact cron · per-module erasure hooks (F5/F7-content/F8/F1-user) · admin UI · F3 RoPA + erasure runbook.

---

## 4. Erasure Outcome Matrix (the core)

| Module / table | Action | When |
|---|---|---|
| **members** | Anonymise-in-place: `company_name → '[erased]'`; `tax_id`, `address_line1/2`, `city`, `province`, `postal_code`, `description`, `notes`, `website` → NULL. Keep `member_id` (UUID), `member_number`, `plan_*`, dates, business metrics. Set `erased_at`. | immediate |
| **contacts** | Anonymise-in-place: `first_name`, `last_name`, `email`, `phone`, `date_of_birth`, `role_title` → NULL (keep row for `matched_contact_id` FK + referential history). | immediate |
| **F1 users (linked via `contacts.linked_user_id`)** | Cascade to F1 user erasure (F1 Art. 17 strategy already documented) + revoke sessions (existing hook). | immediate |
| **F4 invoices / credit-notes** | **Keep the document, number, amounts, VAT** (statutory 10y). Buyer identity must be a **snapshot** on the document; set `legal_hold_until = issue_date + 10y`. **US2 planning prerequisite:** verify whether member invoices currently snapshot the buyer identity or derive it live from the member row — if live-derived, the immediate member scrub would corrupt the rendered tax PDF, so the snapshot must be materialised **before** scrub. | redact snapshot after 10y (cron) |
| **F5 payments / refunds** | Scrub any buyer PII fields; keep transaction records (financial/audit retention). | immediate |
| **F6 event_registrations** (matched to member) | Reuse F6 pseudonymisation — hash/clear `attendee_email/name/company` for the member's matched registrations; keep quota/audit. | immediate |
| **F7 broadcasts** | Scrub `subject`, `body_html`, `from_name`, `reply_to_email`, `custom_recipient_emails`; redact `broadcast_deliveries.recipient_email`; cancel in-flight (existing hook). | immediate |
| **F8 renewal_cycles** | Cancel in-flight (existing hook); scrub member-linked PII references. | immediate |
| **audit_log** | **Never delete.** Scrub PII from payloads (admin free-text `reason`/`notes`); keep `member_id` UUID; emit `member_erased`. | immediate |
| **marketing_unsubscribes** | **Never erase** (Art. 21 — must persist to honour future opt-out). | retained |

---

## 5. Flow

```
admin (member detail page, admin-only) → "Erase member (PDPA / GDPR)"
  → pick reason (gdpr_erasure_request | pdpa_deletion_request)
  → typed-phrase confirmation (F4 destructive-action pattern)
  → eraseMember orchestration (single use-case):
       1. emit  member_erasure_requested
       2. run the existing archive cascade (sessions / invitations /
          broadcasts / renewals) with the erasure reason
       3. anonymise PII immediately
          (members, contacts, F1 user, F5, F6, F7 content + deliveries,
           audit payloads)
       4. set legal_hold_until on the member's F4 invoices/credit-notes
       5. emit  member_erased  (summary: what was scrubbed, counts)
  → [10 years later] cron redacts F4 invoice buyer snapshots whose hold expired
```

**Atomicity:** the immediate-scrub steps run in a tenant-scoped transaction so a failure leaves no partial state; the post-commit cascade (broadcasts/renewals) keeps the existing best-effort per-item pattern (already audited). Idempotent: re-running on an already-erased member is a no-op (gated on `erased_at` / a prior `member_erased` audit).

---

## 6. Audit & retention

- **New F3 audit events:** `member_erasure_requested`, `member_erased` (5y retention — F3 has no tax-document touchpoint). Added in the 4 required places (domain const + drizzle pgEnum + audit-event count test + completeness test).
- Every scrub/cancel emits its module's audit (DPO report answers "received when / executed by whom / erased what / when").
- The `member_erased` payload records counts per category + the legal-hold expiry for the tax-pinned subset.

---

## 7. Admin UI (minimal — YAGNI)

- **"Erase member"** action on the admin member-detail page (admin role only; `manager` cannot see it). Opens a typed-phrase confirmation dialog with the reason selector. Mirrors the F4 destructive-action UX + the F7 clear-halt confirmation pattern.
- **Erasure log** surface for the DPO: a read-only audit-filtered view (reuses the F9 audit-viewer) of `member_erasure_requested` / `member_erased` events. No new request state-machine table.

Rationale: SweCham ≈ 131 members → erasure requests are rare (≈ 0–2 / year). A full request state-machine is over-engineering; the audit trail is the durable compliance record.

---

## 8. Documentation deliverables

- `docs/compliance/processing-records.md` → add the **F3 members RoPA** (record of processing per PDPA §39 / GDPR Art. 30) — currently a TODO.
- `docs/runbook/member-erasure.md` → DPO/admin runbook: receiving a request, identity verification, the 10-year tax legal-hold, and a completeness checklist (which modules were scrubbed).

---

## 9. Phases (Spec Kit user stories — build incrementally)

- **US1 (core):** `eraseMember` orchestration + members/contacts anonymise + `member_erasure_requested`/`member_erased` audit + reuse of the existing session/invitation/broadcast/renewal cascades with the erasure reason. Acceptance: an admin-triggered erase anonymises the member + contacts and leaves an audit trail; idempotent; cross-tenant isolated.
- **US2 (per-module scrub):** F4 invoice buyer-snapshot + `legal_hold_until`; F5/F6/F7-content/F8 scrub hooks; F1 linked-user erasure. Acceptance: every module's member PII is anonymised **except** the tax-document subset, which is legal-held with its document intact.
- **US3 (scheduled redaction + surfaces + docs):** the 10-year member-invoice redact cron (extends the non-member cron); the admin "Erase member" UI + DPO erasure-log view; the F3 RoPA + erasure runbook. Acceptance: a held invoice past 10y is auto-redacted; admin can trigger + audit an erasure end-to-end.

---

## 10. Testing

- **Cascade completeness** — after erase, every module's member PII is anonymised (assert per the F9 export inventory: re-exporting an erased member yields tombstones, not PII).
- **Tax-retention regression (critical)** — issued tax invoices remain present + renderable + carry their legal-hold; the immediate scrub does NOT corrupt the statutory record (live-Neon integration).
- **Suppression-list invariant** — `marketing_unsubscribes` rows survive erasure (Art. 21).
- **Idempotency** — re-running erase on an erased member is a no-op (no double audit, no error).
- **Cross-tenant isolation** — erasing a member in tenant A leaves tenant B untouched (Principle I sub-clause 3 Review-Gate blocker).
- **Redact cron** — a member invoice past `legal_hold_until` is redacted; one inside the window is not.

---

## 11. Decisions made (no open questions)

- **Admin-mediated, immediate + typed-phrase confirm** (not self-service; no heavy request state-machine; no separate undo window — the typed-phrase confirm + admin verification is the guard).
- **Anonymise-in-place** for members + contacts (not hard-delete) — forced by the FK web + tax retention.
- **Two-phase** for tax-pinned identity (immediate scrub of un-pinned PII; legal-hold + 10y cron redaction for the invoice buyer snapshot).
- **Never-erase**: audit rows (scrub payloads only) and the marketing-suppression list.
- **Reuse** the existing archive cascade + the F6 pseudonymisation + the non-member redact-cron pattern.

---

## Constitution check (high-level)

- **I Tenant isolation** — all scrubs run inside `runInTenant` (RLS); mandatory cross-tenant integration test.
- **III Clean Architecture** — `eraseMember` orchestration in `members/application`; per-module scrub via injected ports (no cross-module schema import); the broadcasts/renewals/events erasure hooks live in their own modules behind ports.
- **IV PCI DSS** — payments scrub touches no cardholder data (held by the processor, SAQ-A preserved).
- **II Test-First** — TDD; tax-retention regression authored before the scrub.
- **Compliance / retention** — honours §87/3 (tax 10y), append-only audit, Art. 21 suppression.
