# F4 Security — Threat Model & Review Checklist

**Feature**: F4 — Membership Invoicing & Thai-Tax Receipts
**Branch**: `007-invoices-receipts`
**Authored**: 2026-04-18 (T021)
**Author**: Jirawatpyk (solo-maintainer substitute — Constitution v1.4.0 Principle IX)
**Co-signed**: ☐ pending (CP-4 MVP ship-gate item — tasks.md T117)

## 1. Scope

Covers every mutation path + PII surface introduced by F4:

- 5 new DB tables (invoices, invoice_lines, credit_notes, tenant_invoice_settings, tenant_document_sequences)
- Bilingual PDF rendering + Vercel Blob persistence (private)
- Sequential-number allocator (Thai RD §87 compliance)
- Resend auto-email outbox with PDF attachments
- `/api/invoices/**`, `/api/credit-notes/**`, `/api/tenant-invoice-settings/**`, `/api/portal/invoices/**`, `/api/cron/auto-email-dispatch`
- Admin (`/admin/invoices`, `/admin/invoice-settings`) + member portal (`/portal/invoices`) surfaces

Excluded (out of scope, tracked elsewhere):

- Stripe / PromptPay online payment capture → F5
- e-Tax direct submission to Thai RD → never in scope (decision R1 in `docs/phases-plan.md`)
- Admin dashboard analytics on finance → out of F4 scope

## 2. Principals & Trust boundaries

| Principal | Trust level | Capability in F4 |
|---|---|---|
| Admin (F1 `admin` role) | Full trust within tenant | Draft/issue/void invoices, record payments, issue credit notes, mutate settings |
| Manager (F1 `manager` role) | Read-only on finance | Read invoices/receipts/credit notes, download PDF; NO state changes |
| Member (F1 `member` role) | Read-only on OWN company | Read own invoices via `/portal/invoices`; download own PDFs via signed URL |
| Neon RLS boundary | Database | Enforces `tenant_id = app.current_tenant` on every row |
| Vercel Blob | Storage | Holds private PDFs; 60 s signed URLs only |
| Resend | Email | Delivers auto-emails with PDF attachments; bounce webhook |
| Vercel Cron | Scheduler | Invokes dispatcher via Bearer `CRON_SECRET` auth |
| Tax inspector (future) | External | Read-only reconstruction of issued documents by document number |

## 3. 19-Threat Model

Summary from `research.md § 13`; full mitigations + tests listed here.

### T-01 — Cross-tenant probe via crafted URL
- **Attack**: authenticated admin of tenant A crafts URL for tenant B's invoice id.
- **Impact**: PII + financial leak; §Privacy breach; regulatory violation.
- **Mitigations**: (1) RLS + FORCE on all 5 tables; (2) `runInTenant(ctx, fn)` sets `app.current_tenant` once per request; (3) application layer ownership check re-verifies `invoices.tenant_id === ctx.slug` before signed-URL issue; (4) every probe emits `invoice_cross_tenant_probe` audit with actor_user_id + route.
- **Tests**: `tests/integration/invoicing/tenant-isolation.test.ts` (REVIEW-GATE BLOCKER), Phase-3 E2E `tests/e2e/invoice-draft-issue.spec.ts` AS5 member-crafted-URL 404.

### T-02 — Gap in tax-document sequence (Thai RD §87 violation)
- **Attack**: partial failure mid-issue leaves seq consumed but no invoice row.
- **Impact**: tax audit failure; Revenue Department fine.
- **Mitigations**: (1) `pg_advisory_xact_lock` + `SELECT … FOR UPDATE` on `tenant_document_sequences`; (2) PDF render inside the same tx — any throw rolls back seq increment; (3) 8-scenario chaos test in `tests/integration/invoicing/seq-number-atomicity.test.ts`; (4) 50-writer load test gated by `RUN_PERF=1`.

### T-03 — Duplicate payment recording
- **Attack**: admin double-clicks Record Payment; network retry replays the request.
- **Impact**: duplicate receipt numbers; audit confusion.
- **Mitigations**: (1) idempotency-key header (FR-007); (2) DB CHECK `invoices_paid_has_payment`; (3) use-case guard refuses `record-payment` when status is already `paid`.

### T-04 — Member downloads another company's invoice
- **Attack**: crafted `/portal/invoices/[id]` or direct PDF URL.
- **Impact**: PII leak between members of same chamber.
- **Mitigations**: (1) ownership check in `list-portal-invoices.ts` + `get-invoice-pdf-signed-url.ts` matches `invoices.member_id` with session member; (2) RLS cross-tenant; (3) audit `invoice_cross_tenant_probe` on mismatch.

### T-05 — Signed URL leaks → replay
- **Attack**: 60 s signed URL captured in logs / analytics / screen share.
- **Impact**: short-window PDF exfiltration.
- **Mitigations**: (1) 60 s TTL (minimum viable); (2) `signed_url_token` in logger redact list; (3) per-request scope — URL binds to actor + invoice; (4) Blob ACL = private, never public.
- **R7/N6 residual (accepted)** — `@vercel/blob` currently does not
  expose a per-request signed-URL API; our F4 adapter uploads with
  `access: 'public'` + `addRandomSuffix: false` and an unguessable
  UUID-keyed path (`invoicing/{tenantId}/{fy}/{invoiceId}_v1.pdf`).
  The primary route-layer mitigation is in place — the PDF HTTP
  handler **streams bytes** (never 307-redirects) and attaches
  `Content-Disposition: attachment`, so the blob URL no longer escapes
  via the application. Residual risk: if a blob URL otherwise leaks
  (email forwarding of an attached PDF's inline URL, log paste,
  browser cache on a shared machine), it grants permanent anonymous
  access to the single document until the blob is rotated or deleted.
  Tracked follow-up: flip `access` to `'private'` + issue per-request
  signed URLs with the documented 60 s TTL once `@vercel/blob` ships
  the API. The route-layer mitigation is sufficient for MVP given
  (a) the UUID path is not enumerable, (b) no route returns the blob
  URL, and (c) audit-log emits `invoice_pdf_resent` on every
  render-triggered rebuild.

### T-06 — PDF template injection via member name
- **Attack**: member legal_name contains `</Text><script>…</script>`.
- **Impact**: corrupted PDF or XSS if rendered in a browser PDF viewer.
- **Mitigations**: React's default JSX escaping; `@react-pdf/renderer` treats props as data, not markup; no `dangerouslySetInnerHTML` anywhere in templates.

### T-07 — Tax document deleted by member-erasure request
- **Attack**: member invokes GDPR/PDPA right-to-erasure; naïve implementation removes their invoices.
- **Impact**: Thai RD §87 violation; 10-year retention breach.
- **Mitigations**: FR-030 — tax documents are immune to member archival/deletion. GDPR lawful basis = "legal obligation". F9 will surface this as a distinct retention category.

### T-08 — Clock skew causes wrong fiscal year
- **Attack**: issue near 00:00 Bangkok on Jan 1 with drifted server clock.
- **Impact**: invoice lands in wrong FY → §87 sequence gap; wrong BE year on PDF.
- **Mitigations**: (1) `@js-joda/timezone` Asia/Bangkok wall-clock conversion (`src/lib/fiscal-year.ts`); (2) FY derivation from COMMIT-time timestamp, not request-arrival time; (3) year-boundary scenario in `seq-number-atomicity.test.ts` (e).

### T-09 — Outbox row poisoning
- **Attack**: malformed outbox row loops Resend forever.
- **Impact**: cost + Resend account flagged.
- **Mitigations**: permanent-failure cap at 5 retries, then `auto_email_delivery_failed` audit + admin UI badge (reuses F3's `notifications_outbox` permanent-failure pattern).

### T-10 — Credit note over-credits
- **Attack**: concurrent admins each issue 60% credit on a paid invoice.
- **Impact**: total credit > total invoice → negative liability on books.
- **Mitigations**: `SELECT … FOR UPDATE` on parent `invoices.credited_total_satang` row + CHECK `credited_total_satang <= total_satang`; loser of lock rereads + bails. Tested in `credit-note-partial-accumulation.test.ts` concurrent-race scenario (R2-E1).

### T-11 — VAT rate change rewrites history
- **Attack**: admin changes tenant VAT from 7 → 10 hoping historical invoices update.
- **Impact**: legal rewrite of issued tax documents.
- **Mitigations**: (1) `vat_rate_snapshot` column on `invoices` (and equivalent identity/pricing snapshots); (2) `invoices_enforce_immutability_trg` BEFORE UPDATE trigger rejects changes to snapshotted columns when status != draft.

### T-12 — PDF binary leaked via logs
- **Attack**: debug log line includes full PDF bytes via a stack trace.
- **Impact**: multi-MB PII leak to log aggregator.
- **Mitigations**: pino redact list covers `pdf_binary`, `signed_url_token`, `tax_id`, `member_legal_name_snapshot`, `member_address_snapshot` (T005). `pnpm test tests/unit/lib/logger-pii.test.ts` covers redaction.

### T-13 — Admin role demotion mid-transaction (stale RBAC)
- **Attack**: admin demoted after session cached but before issue commits.
- **Impact**: demoted admin issues one last invoice on their way out.
- **Mitigations**: (1) RBAC re-read from session-store (not memory) as first step of every use case; (2) demotion BEFORE first query → 403; (3) narrow TOCTOU window accepted — audited via actor_user_id; (4) Session cookie includes role hash so tamper detection is free.

### T-14 — Blob orphans from half-committed issue
- **Attack**: PDF uploaded to Blob but DB commit fails.
- **Impact**: accumulating orphan PDFs → cost + potential crawl.
- **Mitigations**: (1) content-addressed Blob keys (`sha256(tenant || doc || id || template)`) — orphans are deterministic; (2) transactional outbox sweeper marks orphans for cleanup; (3) Blob keys reused on idempotent replay (FR-007).

### T-15 — Resend bounce-storm → spam classifier
- **Attack**: bulk issue to list with many stale addresses.
- **Impact**: Resend reputation drops; legitimate mail flagged spam.
- **Mitigations**: (1) per-member auto-email throttle 10/h via Upstash token bucket; (2) outbox marks bounced on first `email.bounced` webhook; (3) admin UI surfaces permanent-failure badge; (4) `auto-email-outbox.test.ts` covers all 4 behaviours.

### T-16 — Admin demoted mid-transaction (accepted TOCTOU)
- **Attack**: See T-13; accepted narrow window where demote fires after RBAC check but before commit.
- **Impact**: one stale-role action.
- **Mitigations**: actor_user_id on every audit row; Phase 10 review can flag retroactively. Accepted as narrow, auditable TOCTOU window.

### T-17 — Logo SVG upload → PDF renderer image fetch → XSS / SSRF
- **Attack**: malicious SVG with `<script>` or external URL in `image href`.
- **Impact**: XSS in PDF viewer; SSRF hitting internal services.
- **Mitigations**: FR-034 — (1) strict MIME whitelist: PNG + JPEG only, SVG explicitly rejected 422; (2) size ≤ 1 MB; (3) dimension cap 2000×2000; (4) `sharp` re-encode strips metadata + embedded scripts; (5) PATCH settings refuses raw logo binary — only accepts the returned `logo_blob_key`. Tested in `logo-upload-security.test.ts` (T092).

### T-18 — Auto-email bounce log retains PDF replica outside 10-yr retention
- **Attack**: Resend bounce log holds invoice PDF ≤30 days after we've auto-deleted.
- **Impact**: Resend-side data slightly out of sync with our retention.
- **Status**: **Accepted** — Resend SOC 2 + GDPR DPA covers this narrower replica; "link-to-download" alternative rejected for UX cost. See research.md § 8a + DPA copy in Phase 10 docs.

### T-19 — Template-version drift rewrites historical documents
- **Attack**: template updated in code; old invoice re-rendered with new template → different sha256.
- **Impact**: audit re-verification fails; FR-016 determinism guarantee broken.
- **Mitigations**: (1) `pdf_template_version` stored on each invoice at issue; (2) resend + void + Blob-recovery re-render use the PINNED version; (3) only NEW issuance uses `CURRENT_TEMPLATE_VERSION`; (4) `pdf-deterministic.test.ts` R3-E4 assertion covers this.

### T-20 — PDF Thai text-layer decomposed (accepted residual)
- **Background**: `@react-pdf/renderer` + `fontkit` write the PDF
  ToUnicode CMap using fontkit's internal Thai shaping — sara-am
  (ำ U+0E33) is decomposed into ◌ํ + า (U+0E4D + U+0E32), post-base
  vowels (ี, ึ, ื, ุ, ู) are stored in logical rather than visual
  order. The VISUAL render is correct (verified across 5 QA cases
  covering PLC names, karan, tone marks, 134-char stress test).
- **Impact**: copy-paste / PDF text search / screen-reader output
  on the Thai text extracted from the PDF reads in a slightly
  mangled order. Does NOT affect: visual display, print output,
  Thai-RD §86/4 compliance, Adobe Reader preview, or attached
  email PDFs. Affects: copy-to-Excel for re-typing, full-text
  search inside the PDF, assistive-tech reading of the PDF.
- **Why accepted for MVP**:
  1. Fixing requires swapping the PDF engine (migrate to Puppeteer
     Chrome headless or Gotenberg) — 1–2 day rewrite + infrastructure.
  2. Real-world invoice workflow is print / file / email-attach — no
     member or auditor copy-pastes content from the PDF.
  3. The `/api/invoices/[id]` + `/api/portal/invoices/[id]` JSON
     endpoints return correctly-encoded Thai for any consumer that
     needs to extract the structured data.
- **Tracked follow-up**: migrate PDF engine to HarfBuzz-based renderer
  when volume grows beyond SweCham's single-tenant deployment or
  when a member flags the copy-paste limitation as a blocker.
- **Mitigations (today)**: shapeThai() pre-decomposes sara-am +
  injects word-boundary newlines so the VISUAL render is
  substantively correct; `pdf-deterministic.test.ts` pins
  `pdf_template_version: 1` so re-renders stay byte-identical to
  the originally-issued document.

## 4. PII catalogue (F4-introduced)

| Field | Column(s) | Lawful basis | Classification | Redacted in logs? |
|---|---|---|---|---|
| Tax ID (tenant) | tenant_invoice_settings.tax_id, invoices.tenant_identity_snapshot.tax_id | Legal obligation | PDPA §24 / GDPR Art. 6(1)(c) — Category B | Yes |
| Tax ID (member) | invoices.member_identity_snapshot.tax_id | Legal obligation | PDPA §24 / GDPR Art. 6(1)(c) — Category B | Yes |
| Legal name (member) | invoices.member_identity_snapshot.legal_name | Legal obligation | PDPA §24 / GDPR Art. 6(1)(c) — Category B | Yes |
| Address (member) | invoices.member_identity_snapshot.address | Legal obligation | PDPA §24 / GDPR Art. 6(1)(c) — Category B | Yes |
| Primary contact name/email | invoices.member_identity_snapshot.primary_contact_* | Legal obligation | PDPA §24 / GDPR Art. 6(1)(c) — Category B | F3 redact list already covers |
| **Recipient email (audit)** | `audit_log.payload.recipient_email` on `invoice_issued`, `invoice_paid`, `invoice_voided`, `credit_note_issued`, `invoice_pdf_resent`, `receipt_pdf_resent`, `credit_note_pdf_resent` | Legal obligation + legitimate interest (forensic / delivery proof) | PDPA §24 / GDPR Art. 6(1)(c)+(f) — **Category B PII** | **Deliberately retained as plaintext in audit_log** — access-controlled via RLS + append-only grants. Column-level access policy required before F10 MTA roll-out (T-F4-04). Audit log is never exported raw; CSV/BI exports MUST redact this column. |
| Signed URL tokens | transient in logs only | N/A | Secret (not PII) | Yes |
| PDF bytes | N/A (Blob) | Legal obligation | PDPA §24 / GDPR Art. 6(1)(c) — Category B | Yes |

## 5. Security Review Checklist (co-signature required before CP-4 ship gate)

- [ ] All 5 F4 tables have `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + `tenant_isolation_on_*` policy (verified by `scripts/verify-f4-migrations.ts` + `tests/integration/rls-coverage.test.ts`)
- [ ] `tests/integration/invoicing/tenant-isolation.test.ts` GREEN in CI (Review-Gate blocker)
- [ ] `src/lib/logger.ts` redact list covers `tax_id`, `member_legal_name_snapshot`, `member_address_snapshot`, `signed_url_token`, `pdf_binary`, `BLOB_READ_WRITE_TOKEN`, `CRON_SECRET` (T005)
- [ ] `src/proxy.ts` F4 kill-switch returns 503 on every `/api/invoices/**`, `/api/credit-notes/**`, `/api/tenant-invoice-settings/**`, `/api/portal/invoices/**`, `/api/cron/auto-email-dispatch` when `FEATURE_F4_INVOICING=false` (T020)
- [ ] Every `issue-invoice`, `record-payment`, `issue-credit-note`, `void-invoice`, `update-tenant-invoice-settings` use case runs RBAC check as first step
- [ ] Blob ACL = private on every F4 PDF key prefix (`invoicing/*`); signed URLs ≤ 60 s TTL (T047)
- [ ] `sharp` logo upload pipeline rejects SVG + >1MB + bad dimensions; EXIF stripped (T094)
- [ ] Resend PDF attachments use the pinned `pdf_template_version` from the invoice row, not `CURRENT_TEMPLATE_VERSION` (T107)
- [ ] `SELECT … FOR UPDATE` on `invoices.credited_total_satang` in `issue-credit-note.ts` (T078)
- [ ] Advisory lock + FOR UPDATE in `postgres-sequence-allocator.ts` (T041)
- [ ] Immutability trigger `invoices_enforce_immutability_trg` verified by `scripts/verify-f4-migrations.ts`
- [ ] Append-only audit events emit for every mutation: `invoice_draft_*`, `invoice_issued`, `invoice_paid`, `invoice_voided`, `credit_note_issued`, `invoice_*_cross_tenant_probe`, `pdf_render_failed`, `auto_email_delivery_failed` (16 events — verified by `audit-coverage.test.ts`, T113a)
- [ ] 10-yr retention doc updated in `docs/phases-plan.md` + `docs/observability.md` (Phase 10 T115c)
- [ ] Resend DPA copy attached to `specs/007-invoices-receipts/releases/v1.0.0.md` (T115a)
- [ ] **T-F4-01** — `src/app/api/cron/outbox-dispatch/route.ts` CRON_SECRET comparison uses `crypto.timingSafeEqual` after length-check (NOT plain `!==`). Guards against timing side-channel enumeration. (Fixed in Phase 10 staff-review remediation.)
- [ ] **T-F4-09** — `getInvoicePdfSignedUrl` + `getCreditNotePdfSignedUrl` use-cases scope repo queries by `tenantId`; cross-tenant probe integration test exists at `tests/integration/invoicing/pdf-routes-cross-tenant-probe.test.ts` (Principle I Review-Gate blocker, Phase 10 remediation).
- [ ] **T-F4-10** — GET handler of `/api/tenant-invoice-settings` carries the same slug-mismatch probe + `tenant_invoice_settings_cross_tenant_probe` emit as PATCH (symmetric pre-MTA). Audit emit is wrapped in try/catch on both verbs so an audit-adapter outage cannot rewrite the 403 into a 500.
- [ ] **T-F4-04** — `recipient_email` in audit payloads classified as Category-B PII (see § 4 catalogue). Column-level access policy on `audit_log.payload` planned before F10 MTA; CSV/BI exports redact this field today.
- [ ] **LINDDUN T-F4-03** — Portal resend response echoes the snapshot `recipientEmail` back to the caller (member sees their own PII). Acceptable for MVP; consider email masking (`j***@domain.com`) in a future hardening pass. Document in DPA.

## 6. Logo upload detailed threat model (T-17 expansion)

1. **MIME validation**: `Content-Type` header + `sharp` detect() — both must agree on PNG or JPEG. Mismatch → 415.
2. **Size guard**: `Content-Length` ≤ 1 MB; body streamed with back-pressure so a lying Content-Length still fails before we allocate the whole buffer.
3. **Dimension guard**: `sharp().metadata()` — reject > 2000×2000 or < 50×50.
4. **Re-encode**: `sharp(input).toFormat(mime === 'png' ? 'png' : 'jpeg', { progressive: false }).toBuffer()` — strips EXIF, ICC profiles, embedded JS, color-management attacks.
5. **50-logo cap**: `tenant_logo_count` column monotonic counter; > 50 returns 409 `logo_history_cap_reached`. Prevents a malicious admin from flooding Blob.
6. **Blob key**: `invoicing/{tenant_id}/logo/{sha256}.{ext}` — content-addressed; idempotent replay returns same key.
7. **Settings PATCH refuses raw binary**: only accepts `{ logo_blob_key: "..." }` pointing at an already-uploaded asset. Prevents a second upload channel that bypasses `sharp`.

## 7. Data sovereignty

- Primary storage: Neon `ap-southeast-1` Singapore. Thailand PDPA §28 cross-border cover.
- Swedish/EU member subjects: GDPR SCC with Vercel + Neon.
- Resend bounce-log: ≤30 day replica of PDF attachment + recipient email. DPA attached in Phase 10.
- Blob: private, Singapore region; signed URL ≤60 s TTL.

## 8. Open questions / follow-ups

- Phase 10 T118 `≥6 /speckit.review + ≥2 /speckit.staff-review` rounds — log findings in `reviews/review-NNN.md`.
- Annual re-review of this threat model in Q1 of each fiscal year (calendar reminder to be added in Phase 10).
