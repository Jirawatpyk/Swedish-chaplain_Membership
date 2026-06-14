# Member Import Spec — SweCham / TSCC first-load

**Status**: DRAFT (ready to build) · **Stage**: 3 of `docs/go-live-readiness.md`
**Scope**: One-time bulk load of ~131 member companies + ~164 contacts from the
operator's Excel workbook into the live tenant. **PII — the workbook is
gitignored and never committed; the importer runs only on the operator's machine.**

> Build can start now against this spec. The **final column-map is confirmed
> against the real Excel** (which arrives later) at build/run time — until then,
> mapping uses the documented 2026 Membership Package structure
> (`docs/membership-benefits-analysis.md`).

---

## 1. Target schema (verified from F3)

**`members`** (one row per company; PK `(tenant_id, member_id)`):
`company_name`* · `legal_entity_type` · `country`* (ISO-3166-1 alpha-2) ·
`tax_id` · `website` · `description` · `founded_year` · `turnover_thb` ·
`plan_id`* · `plan_year`* · `registration_date`* · `registration_fee_paid` ·
`city` · `province` · `postal_code` · `status` (default `active`) · `notes` ·
`preferred_locale`. (* = NOT NULL)

**`contacts`** (one row per person; PK `(tenant_id, contact_id)`; FK `member_id`):
`first_name`* · `last_name`* · `email`* · `phone` · `role_title` ·
`preferred_language` (alpha-2) · `is_primary` (exactly one per member) ·
`date_of_birth`.

---

## 2. Source → target mapping (confirm vs real Excel)

| Excel column (expected) | Target | Transform / validation |
|-------------------------|--------|------------------------|
| Company name | `members.company_name` | trim; required |
| Country | `members.country` | map name → ISO alpha-2 via `i18n-iso-countries`; default `TH`? (confirm) |
| Tax ID | `members.tax_id` | 13-digit Thai TIN check where `country=TH` |
| Membership tier | `members.plan_id` | **tier-name → plan lookup** (§ 4) |
| Turnover | `members.turnover_thb` | parse number; null ok |
| City / Province / Postal | `members.city/province/postal_code` | trim |
| Registration date | `members.registration_date` | parse → ISO date (UTC); **reject Buddhist Era** (off-by-543 guard) |
| Contact first/last | `contacts.first_name/last_name` | split if single "full name" column |
| Contact email | `contacts.email` | RFC validation (`email-validator`); lowercase; **dedupe key** |
| Contact phone | `contacts.phone` | normalize → E.164 (reuse F3 phone rule module) |
| Role / title | `contacts.role_title` | trim |
| Primary contact? | `contacts.is_primary` | exactly one true per member; if none, pick first |
| Member locale (company-level, if present) | `members.preferred_locale` | en/th/sv; null ok |
| Contact preferred language | `contacts.preferred_language` | en/th/sv; defaults `'en'` if absent |

---

## 3. Validation pass (runs before any write)

Fail-loud, per-row, accumulating a report:
1. Required fields present (`company_name`, ≥1 contact with valid `email`).
2. `email` valid + unique across the whole import (and not already in DB).
3. `country` resolves to a real ISO alpha-2.
4. `plan_id` resolves to a **seeded** plan for `plan_year` (§ 4) — unknown tier = error.
5. `registration_date` parses as Gregorian; **flag any year > 2400** (BE leak).
6. `phone` normalizes to E.164 or is empty (never store malformed).
7. Exactly one primary contact per member.
8. **`tax_id` REQUIRED for company-scoped members** (resolved plan
   `memberTypeScope === 'company'`) — FR-009a + Thai tax-invoice law (S1-P1-16,
   operator-decided rule). Individual/person tiers (Thai Alumni / Individual)
   may omit it. For `country='TH'` company members, the tax_id must be a valid
   13-digit Thai TIN (checksum); other countries: 1–50 chars. A company member
   with no tax_id is an import ERROR (so launch data is tax-compliant at entry,
   even before the invoice-issue code gate lands — see go-live-findings P1-16).

---

## 4. Tier → plan resolution

Tiers (from `membership-benefits-analysis.md`):
- **Corporate**: Premium · Large · Regular · Start-up · Individual · Thai Alumni
- **Partnership**: Diamond · Platinum · Gold (each *includes* Premium Corporate)

Resolution: load seeded plans for the tenant + `plan_year` (`scripts/seed-swecham-2026-plans.ts`
output), build a `{normalized-tier-name → plan_id}` map. Importer **fails** on any
tier it can't map — no silent default. Map confirmed against real Excel labels
(the Excel tier names historically differ from the PDF — see analysis § 1).

---

## 5. Execution model

1. **Dry-run (default)** — validate + print a report (`would create N members / M contacts`, all errors/warnings, tier histogram). **Zero writes.**
2. **Real run (`--commit`)** — only after a clean dry-run.
   - One transaction via `runInTenant(ctx, async (tx) => …)` — **all queries use `tx`** (RLS gotcha, CLAUDE.md).
   - Idempotent: dedupe by `lower(email)` **filtered `AND removed_at IS NULL`** (matches the partial unique index `contacts_tenant_email_uniq ON contacts(tenant_id, lower(email)) WHERE removed_at IS NULL`). A soft-deleted contact with the same email is invisible to that index — the importer must decide: skip-with-warning or reactivate (operator call). Re-run skips existing active contacts (report skipped).
   - Creates each member's **initial renewal cycle** (F8-completion Slice 1) inside the **same** batch tx via the shared `createCycleInTx` helper — so the commit run now creates **members + contacts + initial renewal cycles** atomically. Each cycle is anchored at the member's **CURRENT membership period** (068 cluster F): `period_from` starts from `registration_date` but is advanced by whole `term_months` multiples (preserving the registration **anniversary** month/day) until `period_to > now`, so a long-standing member (e.g. registered 2015) is NOT created with a years-past `expires_at` that the enter-awaiting + lapse crons would immediately flip to `lapsed` at launch. `period_to = period_from + 12 months`, frozen at the resolved `plan_id` price, status `upcoming`. (Only the import cold-start opts into this current-period anchoring via `createCycleInTx`'s `anchorToCurrentPeriod`; the on-paid / onboarding / lapsed-comeback paths already anchor at the current period and are unchanged.) Idempotent on re-run via the in-tx `findActiveForMemberInTx` no-op (a member skipped at the contact-dedupe step creates no cycle; an already-cycled member is a no-op). Reported as `cyclesCreated` (PII-free count).
   - Emits `member_created` + `contact_added` + `renewal_cycle_created` audit events.
   - Mid-batch failure (member, contact, **or cycle**) → whole tx rolls back (atomic). A cycle-insert failure throws (it does **not** swallow, unlike the post-launch onboarding listener) so the operator fixes the data + re-runs; the per-row failure bumps `renewals_import_cycle_create_failed_total{tenant}` (row-index/uuid only — no PII) before the re-throw.
3. **Pre-req order** (per `go-live-readiness.md § 6b`): tenant → plans → bootstrap admin → **PITR snapshot** → dry-run → commit.

---

## 6. Onboarding ≠ import (important)

The importer creates **records** (members + contacts) **and each member's
initial renewal cycle** (F8-completion Slice 1 — the cold-start arm; the
post-launch new-member onboarding listener on `createMember` is the steady-state
arm). What it does **not** do is grant member portal *access* — that is a
separate F3 invitation step. After import: decide whether to send ~131
invitations at launch or stagger — **throttle to respect Resend rate limits** (do
not fire 131 at once). Invitation sending is out of scope for this importer
(separate batch tool/flow).

**RoPA / processing-activity note:** the `--commit` run is a bulk cold-start
processing activity — it writes member + contact PII (already covered by the
existing RoPA member-records entry) plus a derived renewal cycle (a frozen plan
price + period, no new PII category). The run report is PII-free (counts +
row-indices only).

---

## 7. CLI shape (proposed)

> **Pre-req (build blocker)**: `package.json` has **no Excel parser**. Add one
> before writing the importer — `pnpm add -D exceljs` (streaming, good for size)
> or `xlsx` (lighter). Both MIT.

```bash
# dry-run (safe, default)
pnpm tsx scripts/import-members.ts --file ./swecham-members-2026.xlsx --plan-year 2026

# real import (after clean dry-run + PITR snapshot)
pnpm tsx scripts/import-members.ts --file ./swecham-members-2026.xlsx --plan-year 2026 --commit
```

Outputs a timestamped report file (no PII in logs — counts + row indices only).

---

## 8. Test plan (TDD per Principle II)

- Unit: mapping + validation pure functions (BE-date rejection, E.164, tier-map miss, dedupe); the report renderer surfaces `cyclesCreated` (PII-free).
- Integration (live Neon): dry-run produces zero writes (**and zero cycles**); `--commit` is idempotent on re-run; RLS isolation (rows land under correct `tenant_id`); rollback on injected mid-batch error.
- Integration — **initial renewal cycle** (F8-completion Slice 1): `--commit` creates exactly **one `upcoming` cycle per imported member** (`cyclesCreated == membersCreated`), anchored at each member's **current membership period** (068 cluster F — `period_from` advanced from `registration_date` by whole `term_months` multiples, anniversary preserved, until `period_to > now`; a recent registration is unchanged, a HISTORICAL one lands on a FUTURE `expires_at` so the member is not lapsed at launch), `period_to = +12 months`, frozen at the resolved plan price; a **re-run is idempotent** (no duplicate cycle — `findActiveForMemberInTx` no-op); **RLS isolation** (cycles land under the correct `tenant_id`); a **mid-batch cycle-insert failure rolls back ALL member + contact + cycle rows** (atomic — the cycle step throws, it does not swallow). See `tests/integration/scripts/import-members-cycles.test.ts`.
- Fixture: a small anonymized sample workbook (NOT real PII).
