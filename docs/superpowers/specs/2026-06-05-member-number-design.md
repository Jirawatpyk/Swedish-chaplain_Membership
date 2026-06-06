# Design — Human-Readable Member Number (display ID)

**Status**: DESIGN — awaiting user review (pre-`/speckit` / pre-writing-plans)
**Date**: 2026-06-05
**Branch**: `055-member-number`
**Module**: `src/modules/members/**` (owner) + read-only touch points in `invoicing` (PDF snapshot) and presentation (admin/portal)
**Author**: brainstorming session, hardened by a 5-specialist pressure-test (arch · tax · migration · security · UX)

---

## 1. Summary & goal

Members are currently identified **only** by a `uuid` (`members.member_id`, composite PK `(tenant_id, member_id)`, generated client-side via `crypto.randomUUID`). The UUID is an excellent surrogate key but is unreadable for humans. Chamber staff and members need a short, quotable **member number** (e.g. `SCCM-0042`).

This feature **adds a human-readable, per-tenant, sequential member number as a display identifier**. The UUID remains the true primary key and the only value used in URLs and backend lookups. This is the same surrogate-UUID + human-readable-code pattern F4 already uses for invoices (UUID PK + §87 document number `INV-2026-0001`).

**This is an additive feature.** No primary key changes, no FK type changes, no URL changes.

## 2. User-locked decisions (do not relitigate)

| Decision | Choice |
|---|---|
| Approach | **Additive** — keep members UUID composite PK; add a new display field. URLs stay UUID. |
| Format | `{prefix}-{zeroPad}`, e.g. `SCCM-0042`. Prefix is **per-tenant** (default `M`, SweCham = `SCCM`). |
| Sequence | **Continuous per tenant**, lifetime, **never resets**. Gaps acceptable (no decrement, no reuse). |
| Backfill (131 SweCham members) | By `created_at` ascending — oldest member = `0001`. |
| Display surfaces | Admin list + detail · invoice/receipt PDF · member portal · admin search-by-number. |
| Prefix mutability | **Set once at provisioning (seed migration only); NO runtime mutation path exists at any point.** The guard is the *absence* of any UPDATE use-case — not a DB check. "Immutable after first member" is explanatory (SweCham backfills immediately ⇒ effectively immutable from ship). |
| Manager role | Member number is **visible to both `admin` and `manager`** (non-sensitive). |
| PDF placement | In the **buyer block** (under tax ID), label **`หมายเลขสมาชิก / Member No.`**. |

### Decided defaults (Principle X — Simplicity)
- **Pad width fixed at 4** (`0001`–`9999`). Not configurable in MVP. Display auto-expands gracefully beyond 9999 (`10000`). Revisit only if a real tenant approaches the cap.
- **Prefix validation**: `^[A-Z][A-Z0-9]{0,7}$` (uppercase, 1–8 chars) — mirrors `DocumentNumber.RE_PREFIX`. `SCCM` ✓.
- **Backfill tie-break**: `ORDER BY created_at ASC, member_id ASC` (deterministic within a run; same-second ties ordered by UUID).
- **GDPR self-service export**: include the member's own number (transparency).
- **Portal**: show on the profile card **and** a small badge on the portal dashboard.
- **Copy button**: yes, on the admin detail formatted number.

## 3. Non-goals

- No change to `members.member_id` (UUID) or any FK. No route/URL change (routes stay UUID — prevents enumeration).
- No in-app **prefix editor** in MVP (prefix is seed-only + immutable after first member).
- No member number in the **public** directory export (F9) or the public directory widget.
- No renewal-reminder-email / command-palette integration in MVP (tracked as follow-ons in §11).

## 4. Data model

All new objects live in the **members** module (`src/modules/members/infrastructure/db/`). All tenant-scoped tables get RLS `ENABLE` + `FORCE` + `chamber_app` grants + a `tenant_id = current_setting('app.current_tenant', true)` isolation policy (Constitution Principle I, two-layer isolation).

### 4.1 `members` — new column
```sql
ALTER TABLE members ADD COLUMN member_number integer;           -- step 1: nullable
-- (backfill — see §6)
ALTER TABLE members ALTER COLUMN member_number SET NOT NULL;     -- step 3
CREATE UNIQUE INDEX IF NOT EXISTS members_tenant_member_number_uniq
  ON members USING btree (tenant_id, member_number);            -- step 4 (mirrors contacts_tenant_email_uniq, migration 0009)
ALTER TABLE members ADD CONSTRAINT members_member_number_positive CHECK (member_number > 0);
```

### 4.2 `tenant_member_sequences` — per-tenant lifetime counter (NEW table)
A dedicated counter, **not** the F4 `tenant_document_sequences` (which is `(tenant_id, document_type, fiscal_year)` because §87 resets yearly — irrelevant noise here).
```sql
CREATE TABLE tenant_member_sequences (
  tenant_id   text PRIMARY KEY,
  last_number integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- RLS ENABLE + FORCE + policy + grants (mirror tenant_document_sequences, migration 0019)
```
`last_number` stores the **last-issued** value (so the next allocation = `last_number + 1`). Backfill seeds it to `N` (count per tenant).

### 4.3 `tenant_member_settings` — per-tenant prefix (NEW table, members module)
**Not** an extension of `tenant_invoice_settings` — that lives in the invoicing bounded context and a members-module read of it would violate Principle III **and** create a forbidden lock-order edge with the F4 allocator.
```sql
CREATE TABLE tenant_member_settings (
  tenant_id            text PRIMARY KEY,
  member_number_prefix text NOT NULL DEFAULT 'M'
                       CHECK (member_number_prefix ~ '^[A-Z][A-Z0-9]{0,7}$'),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
-- RLS ENABLE + FORCE + policy + grants
```
Pad width is **not** stored (fixed at 4). The SweCham row is seeded with `prefix='SCCM'` in the backfill migration. Immutable after first member ⇒ **no UPDATE use-case in MVP**.

## 5. Sequence allocation

A new `MemberNumberAllocatorPort` (Application port, members Infrastructure impl). **Wiring is critical**: the allocator must be the **first statement INSIDE the `runInTenant(deps.tenant, async (tx) => { … })` callback** in `createMember` (`create-member.ts:321`), **before** `createWithPrimaryContactInTx`. Any advisory lock / `tenant_member_sequences` touch that runs *outside* that tx uses a pool-fresh connection without `SET LOCAL app.current_tenant` and **silently bypasses RLS** (the F7.1a US2 incident class — CLAUDE.md § Gotchas).

```
1. SELECT pg_advisory_xact_lock(hashtextextended('members:' || $tenantId, 0));  -- 64-bit (F5–F9 convention; F4 uses legacy 32-bit hashtext() — members: is disjoint from invoicing: so bit-width is irrelevant)
2. INSERT INTO tenant_member_sequences (tenant_id, last_number) VALUES ($tenantId, 0) ON CONFLICT DO NOTHING;
3. UPDATE tenant_member_sequences SET last_number = last_number + 1, updated_at = now()
     WHERE tenant_id = $tenantId RETURNING last_number;   -- the allocated number
```
4. **Handoff**: pass the returned `last_number` as `memberNumber` into the `memberDraft` assembled at `create-member.ts:276`, then into `createWithPrimaryContactInTx` — the member INSERT carries the allocated number, in the **same** `tx`. A `createMember` rollback unwinds the member row; leaving the counter incremented is acceptable (gap-OK).

- **`UPDATE … RETURNING` (no `SELECT … FOR UPDATE`)**: F4's allocator does an explicit `SELECT … FOR UPDATE` before the `UPDATE` — a legacy belt-and-suspenders. Here the advisory lock already serialises every writer, so `UPDATE … RETURNING` alone is sufficient. **Do not copy-paste the F4 allocator verbatim.**
- **Lock key** `members:{tenantId}` — single counter, no sub-dimensions; disjoint from `invoicing:` / `payments:` / `broadcasts:` / `renewals:` / `eventcreate:` / `insights:export:` (`members:` confirmed reserved-free — existing `members:` strings in `policies.ts` are RBAC resource ids, never advisory-lock keys).
- **Lock-order discipline**: the allocator touches **only** `tenant_member_sequences` — never `tenant_member_settings` (prefix is needed at display time, not allocation time). Keeps the lock graph acyclic (mirrors the F4 allocator's lock-order rule).
- **Gaps OK**: counter never decrements; archived/deleted members keep their number; no reuse.
- **Immutable**: `member_number` is never in `MemberPatch`; unchanged across archive/undelete; DB `NOT NULL` + `CHECK (>0)` + `UNIQUE` backstop the advisory lock.
- **Read path**: `rowToMember()` (`drizzle-member-repo.ts:56`) — the **single** DB-row→`Member`-aggregate function — must read `row.memberNumber` and convert via `asMemberNumber()`. If missed, every read (findById, directory search, …) silently returns a `Member` without the number (TS catches it only after the schema type is updated — easy to miss).
- **Audit**: emit `member_number_assigned` (member-timeline event; payload `{ member_number }`). See §9 for the correct F3 enum wiring.

## 6. Backfill migration

Runs once on live Neon for the ~131 SweCham members. **Apply migration + run integration tests BEFORE committing schema+code** (project gotcha).

```sql
-- (after ADD COLUMN nullable)
-- Seed the prefix for the existing SweCham tenant (immutable thereafter):
INSERT INTO tenant_member_settings (tenant_id, member_number_prefix)
  VALUES ('<swecham-tenant-id>', 'SCCM') ON CONFLICT (tenant_id) DO NOTHING;

-- Assign 1..N PER TENANT (PARTITION BY tenant_id is mandatory — without it the
-- numbering runs globally across tenants = cross-tenant data-corruption bug):
UPDATE members m
SET    member_number = sub.rn
FROM (
  SELECT tenant_id, member_id,
         ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY created_at ASC, member_id ASC) AS rn
  FROM members
) sub
WHERE m.tenant_id = sub.tenant_id AND m.member_id = sub.member_id;

-- Seed each tenant's counter to its max (next new member = N+1):
INSERT INTO tenant_member_sequences (tenant_id, last_number)
  SELECT tenant_id, MAX(member_number) FROM members GROUP BY tenant_id
  ON CONFLICT (tenant_id) DO UPDATE SET last_number = EXCLUDED.last_number;

-- Loud-fail verification BEFORE SET NOT NULL (mirrors migration 0094 lines 88-96):
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM members WHERE member_number IS NULL) THEN
    RAISE EXCEPTION 'member_number backfill failed: % rows still NULL',
      (SELECT COUNT(*) FROM members WHERE member_number IS NULL);
  END IF;
END $$;
-- then: ALTER COLUMN member_number SET NOT NULL; CREATE UNIQUE INDEX (see §4.1)
```

`created_at` and `member_id` are both `NOT NULL` (migration 0009) — safe for `ORDER BY`. **Idempotency is via the Drizzle journal (single-shot), NOT `IF NOT EXISTS` on the column add.** `ADD COLUMN IF NOT EXISTS` is **forbidden here**: the canonical project note (migration 0094 lines 16-21) is that an `IF NOT EXISTS` column add lets the later `SET NOT NULL` silently re-run on a second pass even though the backfill already finished. Use a single-shot `ALTER TABLE members ADD COLUMN member_number integer;` and rely on the journal. Only the **UNIQUE INDEX** may keep `IF NOT EXISTS` (index creation does not interact with `SET NOT NULL`); the seeds use `ON CONFLICT`.

**Migration files (2 — split is required; next free numbers are `0209` / `0210`, current last = `0208`):**
1. `0209_member_number_schema.sql` — both new tables (+RLS/grants), `members.member_number` single-shot add (nullable), settings seed, backfill UPDATE, verification DO block, sequence seed, `SET NOT NULL`, unique index, positive check.
2. `0210_member_number_audit_enum.sql` — `ALTER TYPE audit_event_type ADD VALUE 'member_number_assigned'` in an idempotent `DO $$ … IF NOT EXISTS pg_enum … $$` block (Postgres forbids `ALTER TYPE … ADD VALUE` in the same tx that uses the value; precedent: F5 migrations 0043 + 0046). Confirm `drizzle.config.ts` does not override the default per-file tx boundary.

Declare `members.member_number` as **nullable** in `schema-members.ts` first; add `.notNull()` only *after* the backfill migration applies (else `drizzle-kit generate` emits `ADD COLUMN NOT NULL` without DEFAULT → fails on the live non-empty table).

## 7. Domain model

In `src/modules/members/domain/member.ts`:
```ts
declare const MemberNumberBrand: unique symbol;
export type MemberNumber = number & { readonly [MemberNumberBrand]: true };
export function asMemberNumber(n: number): MemberNumber { /* assert int > 0 */ }
```
- Add `readonly memberNumber: MemberNumber` to the `Member` aggregate. Excluded from `MemberPatch` (immutable).
- `formatMemberNumber(prefix: string, n: MemberNumber, pad = 4): string` — **pure Domain function**, zero framework imports, reused by the PDF template (Infrastructure) and API serializers (Presentation) per Principle III. Returns `${prefix}-${String(n).padStart(pad, '0')}`.
- A pure **parser** `parseMemberNumberQuery(q: string): number | null` (Application/Domain helper) — strips an optional `PREFIX-` and leading zeros, returns the integer or null. Used by search.

## 8. Display surfaces

### 8.1 Admin members list (`src/components/members/members-table.tsx`)
- New **sortable** column. Extend `DirectoryOffsetFilter.sort` (`member-repo.ts:57`) from `'engagement'` to `'engagement' | 'memberNumber'`; add a numeric `ASC NULLS LAST` orderBy branch in `searchDirectoryWithCount` (`drizzle-member-repo.ts:649-657`) alongside the engagement branch. Server-side `?sort=memberNumber&order=…`. Narrow (~80px), header `whitespace-nowrap`.
- **MUST update `members-table-skeleton.tsx`** in the same commit: `cols` **9→10** (manager / `withSelection=false`) and **10→11** (admin / `withSelection=true`) + both grid-template strings (CLS-0 blocker per ux-standards §15 — TS/lint won't catch this). A fast **Vitest** presentation test (10 cells no-selection, 11 with-selection) guards it before the E2E CLS check.
- Visible to both `admin` and `manager`.

### 8.2 Admin member detail (`/admin/members/[memberId]`)
- Show the formatted number prominently **above** the UUID, with a `CopyButton` (FR-030 affordance family). UUID retains its copy button (backend lookups use UUID).

### 8.3 Member portal & data-export
- Profile card (`portal/profile` — a React Server Component, **no JSON API endpoint**): formatted number above the existing UUID field.
- Portal dashboard (`portal/page.tsx`): a small badge near the company name so members see it on login.
- **Serializers** — the admin `src/app/api/members/_serialise.ts` and the portal serializer (`portal/profile/route.ts`, a *narrower whitelisted struct* that deliberately redacts `tax_id`/`notes` — not a full `Member`) diverge (this already bit `tax_id` once). **REQUIRED** (not optional): both must emit `member_number`. Lowest-risk path = a **mandatory** contract test on `GET /api/members/[id]` asserting `body.member_number` + a unit test on `serialiseMember` mapping `memberNumber → member_number`; portal RSC coverage via the E2E badge test (§11). A `scope`-flag consolidation is a *should-fix follow-on* that must preserve the portal redaction whitelist.
- **GDPR self-service export** (decided §2 = include): `gdpr-archive-source-adapter.ts` (`src/modules/insights/infrastructure/sources/`, ~lines 270-296) builds `profile.json` from the live `Member` — add `member_number: member.memberNumber` once the `Member` type carries it. **Omitting it breaks GDPR Art. 15/20** transparency for the member's own archive. §11 must assert the `gdpr_member_archive` zip's `profile.json` includes `member_number`.

### 8.4 Admin search-by-number
- Parse the query (`SCCM-0042` / `0042` / `42`) → integer via `parseMemberNumberQuery`; add an `eq(members.memberNumber, n)` branch **alongside** the existing company/contact ILIKE in the directory filter (`drizzle-member-repo.ts` `buildDirectoryConds` / `directoryQFilter`). Integer hit uses the UNIQUE index. Parser lives in Application (pure), not in SQL or the route. Admin-only (`requireAdminContext`).
- Update the search-placeholder i18n (×3 locales) to hint that a member number is accepted.

### 8.5 Invoice / receipt PDF
- Extend `MemberIdentitySnapshot` (`src/modules/invoicing/domain/value-objects/member-identity-snapshot.ts`) — **interface AND zod schema in the SAME commit** (⚠️ `makeMemberIdentitySnapshot` / `parseMemberIdentitySnapshot` call `z.object().safeParse`, which **silently strips** any key not declared in the schema; adding the field to the TS interface but not the zod schema → `member_number` is dropped at write *and* read with **no type error**, template always sees `undefined`):
  - interface: `readonly member_number: number | null`
  - zod: `member_number: z.number().int().positive().nullable().optional().default(null)` — `.optional().default(null)` (not just `.nullable()`) is essential: a historical snapshot with **no key** parses to `null` (not `undefined`), satisfying `exactOptionalPropertyTypes` and avoiding a `number|null|undefined` gap.
  - **Strip-regression unit test**: `makeMemberIdentitySnapshot({ …validParts, member_number: 42 }).member_number === 42`.
- **Write path**: `member-identity-adapter.ts` (`getForIssue`) SQL `SELECT` adds `m.member_number`; `makeMemberIdentitySnapshot(...)` receives it. The membership-vs-event gate is the **invoice subject**: membership invoices (`member_id IS NOT NULL`, via `getForIssue`) snapshot the real number; **event invoices** (`member_id IS NULL` per the F4 CHECK — always, even when the attendee is a chamber member) get **no `member_number` key** in their non-member buyer snapshot. **`create-event-invoice-draft` needs NO new parameter** — the absent key + `.default(null)` resolves to `null` at read time automatically.
- **No retroactive backfill of already-issued invoice snapshots** — Thai tax-document immutability (§86/4, §105). `member_number` appears only in invoices issued **after** ship. The PDF template guards with `{input.member.member_number !== null && (…)}` (explicit `!== null`, not truthy — defensive against a future type-widen), so historical invoices (`null`) skip the line → SC-003 determinism preserved. The same stored-snapshot read covers credit-note **and void-stamped-invoice** re-renders unchanged.
- PDF placement: buyer block, under tax ID, label `หมายเลขสมาชิก / Member No.` (bilingual, matching the template's `ไทย / English` convention).

## 9. Security & compliance

- Per-tenant scoped; `UNIQUE(tenant_id, member_number)`; both new tables RLS `ENABLE`+`FORCE`+grants; allocator runs under the tenant RLS tx.
- **No enumeration surface**: URLs/routes stay on UUID (permanent rule — `member_number` must never become a route/query param); not in public directory export/widget; portal identity stays session-bound via `requireMemberContext` (no lookup-by-number).
- **PII classification (nuanced)**: the **integer alone** is not personal data (PDPA §6 / GDPR Recital 26 — a controller-assigned sequential identifier, like a bank account number, not collected from the subject). **But** the formatted string (`SCCM-0042`) **combined with `company_name`/contact name in the same response or log line IS personal data** (a trivially re-linkable pseudonym). Processing basis: **contract / legitimate interest** — same as the member record, no new basis. Data-minimisation satisfied (the number *replaces* the UUID in human-facing contexts). No erasure obligation for the integer itself; erasing the member record cascades it.
- **`REDACT_PATHS` — REQUIRED, not optional**: add `member_number` + `*.member_number` (snake + camel) to `src/lib/logger.ts` `REDACT_PATHS`. The admin-list serialiser returns `memberNumber` **and** `companyName` in the same object — logging it whole would link the number to the company (personal data). Mirror the `payment_reference` precedent (logger.ts ~line 161).
- **RoPA / privacy notice**: add `member_number` (controller-assigned sequential identifier, not collected from the subject) to the **F3 members RoPA** data-fields list — lawful basis & recipients unchanged. **Privacy notice (GDPR Art. 13 / PDPA §23)**: note at the next notice-review cycle that a sequential member number is assigned and appears in the portal + GDPR export (no consent — contract basis; does not block ship unless the notice is already overdue).
- **Cross-tenant integration test (Constitution Principle I, Review-Gate blocker)** — new file `tests/integration/members/member-number-tenant-isolation.test.ts`: (a) tenant A cannot SELECT/UPDATE/INSERT tenant B's `tenant_member_sequences`; (b) directory search/detail expose `member_number` only for the session's tenant; (c) the formatted string equals the stored integer. Use `createTwoTestTenants()`.
- **Audit — ONE new event type `member_number_assigned`, wired the F3 way (NOT the F1 4-places pattern)**: (1) add to the `F3AuditEventType` union (`src/modules/members/application/ports/audit-port.ts`); (2) add to `auditEventTypeEnum` (`src/modules/auth/infrastructure/db/schema.ts`); (3) `ALTER TYPE … ADD VALUE` in migration `0210`; (4) update the **F3** count guard (`check-cross-module-audit-counts.ts` / the F3 audit-port test). ⚠️ **Do NOT touch** `AUDIT_EVENT_TYPES` in `auth/domain/audit-event.ts` or `audit-event.test.ts` / `completeness.test.ts` — those are **F1-only** and must stay at **32**. Retention: **5 years** (F3 default via `drizzleAuditAdapter`; do not route through F4/F9 ports). The one-time backfill is recorded by the migration journal + seeded numbers, not a separate audit event (raw-SQL audit would bypass the Application port + member-timeline trigger).

## 10. i18n

`en` (canonical) + `th` + `sv`:
- Column / inline label: `Member No.` / `เลขสมาชิก` / `Medlemsnr` (apply `whitespace-nowrap`).
- Portal / full label: `Member Number` / `หมายเลขสมาชิก` / `Medlemsnummer`.
- PDF label: `Member No.` / `หมายเลขสมาชิก` (bilingual, in template copy).
- Updated search placeholder mentioning member-number input.

## 11. Testing strategy

- **Domain (100% line+branch)**: `formatMemberNumber` (pad, large-n auto-expand); `parseMemberNumberQuery` — enumerate null returns (`''`, `'NOT-A-NUMBER'`, `'SCCM-'`, `'-1'`, `'0'`) and valid (`'SCCM-0042'→42`, `'42'→42`, `'0042'→42`); `asMemberNumber` rejects `≤0` **and** non-integer (`1.5`).
- **Application/integration (live Neon)**: allocator concurrency (two concurrent `createMember` → no duplicate; mirrors `seq-number-atomicity.test.ts`); allocation atomic with member insert (rollback leaves a gap, no member row); backfill correctness (PARTITION BY per tenant, tie-break determinism, seed = N → next N+1); **DB-layer backstop** (raw INSERT of a duplicate `(tenant_id, member_number)` → UNIQUE violation; INSERT `member_number = 0`/`-1` → CHECK violation — proves the DB guards independently of the allocator); snapshot round-trips `member_number` (new) and parses old snapshots → `null` (no `MalformedSnapshotError`) + the **strip-regression** test (§8.5).
- **Cross-tenant** (Principle I blocker): new `tests/integration/members/member-number-tenant-isolation.test.ts` — see §9.
- **Contract / serializer**: extend `tests/contract/members/get-member.test.ts` to assert `body.member_number`; unit-test `serialiseMember` maps `memberNumber → member_number`; assert the `gdpr_member_archive` zip `profile.json` includes `member_number` (non-null post-backfill). *(Portal profile is an RSC — no JSON contract; covered by the E2E badge test.)*
- **Presentation/E2E/a11y**: `members-table-skeleton` Vitest test (10 cells no-selection / 11 with-selection) + E2E CLS-0; th-TH label no-wrap at 1280px; portal badge; admin-detail copy button.
- **PDF golden (render-INPUT golden, matching `credit-note-pdf-golden.test.ts` — NOT a binary byte-diff)**: (a) membership invoice issued post-feature → buyer block shows `หมายเลขสมาชิก / Member No. SCCM-0042`; (b) event invoice → no member-number line (snapshot `member_number` absent → `null`); (c) historical membership snapshot (no field) → `PdfRenderInput` buyer block omits the line (SC-003 determinism). Credit-note + void re-render of a pre-feature invoice → `null` → omitted.

## 12. Scope, phasing & follow-ons

**In scope (one feature):** §4–§11 above. ~2 migrations, **1** new audit event type (`member_number_assigned`), 5 surfaces.

**Ship cadence: A+B together as ONE feature** (user decision 2026-06-05 — no staged ship). The A/B grouping below is an *informational implementation-ordering* guide only, not separate releases:
- **Group A — foundation + admin**: tables, allocator, backfill, domain, `createMember` wiring, admin list (+skeleton) / detail, search, i18n, cross-tenant test.
- **Group B — member-facing**: portal (profile + dashboard, serializer consolidation), PDF snapshot extension + template.

**Out of scope / follow-ons (note in spec, do not build now):**
- In-app prefix editor (prefix is seed-only + immutable in MVP).
- Command-palette `SCCM-NNNN → /admin/members/{uuid}` resolution (smart-feature integration point).
- Renewal-reminder emails / event-registration references quoting the member number (F8 email-template dependency).
- Configurable pad width.

## 13. Open risks

- **Same-second backfill ties**: ordered by `member_id` (UUID) → stable within one run but the relative order of same-second members is arbitrary. Acceptable per the user's "oldest = 0001" intent (rare; no business meaning lost). If a true join-order field surfaces later, a one-off re-number is possible (numbers are not yet externally printed at backfill time).
- **Current member data is SIMULATED** (user, 2026-06-05): the live DB holds dummy/test members, not the real ~131 SweCham members (which still live in the Excel workbook, not yet imported). The backfill ordering is therefore moot for the current data — it simply seeds the per-tenant counter and assigns numbers to the dummy rows. **When the real members are imported** (members CSV import, post-ship), they receive numbers in **import order** via the normal `createMember` allocator. *Operational note*: if join-order numbering matters for the real set, order the import file by join date — there is no separate join-date re-backfill in scope.
- **Serializer divergence**: mitigated by consolidation or the dual contract test (§8.3) — must not be skipped.
- **Snapshot migration window**: between deploying the new zod schema and any future tightening, keep the field `.optional().default(null)`; do **not** tighten to required (historical JSONB has no field).
- **Future-importer dependency**: numbering relies on the allocator running inside `createMember`. The future members CSV importer **MUST call `createMember`** (invoking the allocator), **not** a bulk `INSERT` — a direct INSERT bypasses the allocator → NULL/duplicate `member_number`. This is a mandatory acceptance criterion for the importer spec.
