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
| Prefix mutability | **Immutable after the first member is assigned a number.** Set at tenant onboarding/seed; no in-app edit in MVP. |
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

A new `MemberNumberAllocatorPort` (Application) implemented in members Infrastructure, invoked **inside the existing `runInTenant` tx** of `createMember` (`create-member.ts:321`), **before** `createWithPrimaryContactInTx` so the allocated number is part of the member INSERT.

```
1. SELECT pg_advisory_xact_lock(hashtextextended('members:' || $tenantId, 0));  -- 64-bit (F5–F9 convention, NOT F4 hashtext 32-bit)
2. INSERT INTO tenant_member_sequences (tenant_id, last_number) VALUES ($tenantId, 0) ON CONFLICT DO NOTHING;
3. UPDATE tenant_member_sequences SET last_number = last_number + 1, updated_at = now()
     WHERE tenant_id = $tenantId RETURNING last_number;   -- the allocated number
```

- **Lock key** `members:{tenantId}` — single counter, no sub-dimensions; disjoint from `invoicing:` / `payments:` / `broadcasts:` / `renewals:` / `eventcreate:` / `insights:export:`. (`members:` confirmed reserved-free.)
- **Lock-order discipline**: the allocator touches **only** `tenant_member_sequences` — never `tenant_member_settings` (prefix is needed at display time, not allocation time). Keeps the lock graph acyclic (no deadlock; mirrors the F4 allocator's lock-order rule).
- **Gaps OK**: counter never decrements; archived/deleted members keep their number; no reuse.
- **Immutable**: `member_number` is never in `MemberPatch`; unchanged across archive/undelete; DB `NOT NULL` + `CHECK (>0)` + `UNIQUE` backstop the advisory lock.
- **Audit**: emit `member_number_assigned` (member-timeline event; payload `{ member_number }`).

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

-- then: SET NOT NULL, CREATE UNIQUE INDEX (see §4.1)
```

`created_at` and `member_id` are both `NOT NULL` (migration 0009) — safe for `ORDER BY`. Idempotent: the column add is `IF NOT EXISTS`-guarded; the unique index is `IF NOT EXISTS`; the seeds are `ON CONFLICT`.

**Migration files (2, split is required):**
1. `0NNN_member_number_schema.sql` — both new tables (+RLS/grants), `members.member_number` add-nullable, backfill, settings seed, sequence seed, `SET NOT NULL`, unique index, positive check.
2. `0NNN+1_member_number_audit_enum.sql` — `ALTER TYPE audit_event_type ADD VALUE 'member_number_assigned'` in an idempotent `DO $$ … IF NOT EXISTS pg_enum … $$` block (Postgres forbids `ALTER TYPE … ADD VALUE` in the same tx that uses the value).

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
- New **sortable** column (server-side `?sort=memberNumber&order=…`, same pattern as the engagement column). Narrow (~80px), header `whitespace-nowrap`.
- **MUST update `members-table-skeleton.tsx`** in the same commit: `cols` 10→11 (admin) / 9→10 (manager) + grid template (CLS-0 blocker per ux-standards §15 — TS/lint won't catch this). Add/extend the column-count E2E assertion.
- Visible to both `admin` and `manager`.

### 8.2 Admin member detail (`/admin/members/[memberId]`)
- Show the formatted number prominently **above** the UUID, with a `CopyButton` (FR-030 affordance family). UUID retains its copy button (backend lookups use UUID).

### 8.3 Member portal
- Profile card (`portal/profile`): formatted number above the existing UUID field.
- Portal dashboard (`portal/page.tsx`): a small badge near the company name so members see it on login.
- **Consolidate the two `serialiseMember` functions** (admin `src/app/api/members/_serialise.ts` + the portal inline one in `portal/profile/route.ts`) into one canonical serializer with a `scope` flag — OR add a contract test asserting **both** `GET /api/members/[id]` and the portal profile response include `member_number`. (Divergence already bit tax_id once.)

### 8.4 Admin search-by-number
- Parse the query (`SCCM-0042` / `0042` / `42`) → integer via `parseMemberNumberQuery`; add an `eq(members.memberNumber, n)` branch **alongside** the existing company/contact ILIKE in the directory filter (`drizzle-member-repo.ts` `buildDirectoryConds` / `directoryQFilter`). Integer hit uses the UNIQUE index. Parser lives in Application (pure), not in SQL or the route. Admin-only (`requireAdminContext`).
- Update the search-placeholder i18n (×3 locales) to hint that a member number is accepted.

### 8.5 Invoice / receipt PDF
- Extend `MemberIdentitySnapshot` (`src/modules/invoicing/domain/value-objects/member-identity-snapshot.ts`):
  - interface: `readonly member_number: number | null`
  - zod: `member_number: z.number().int().positive().nullable().optional().default(null)` — the **`.default(null)` is essential**: pre-existing snapshot JSONB (no field) parses to `null` (not `undefined`), avoiding a `number|null|undefined` type gap at the repo read boundary.
- Thread `member_number` through the snapshot **write path**: `member-identity-adapter.ts` SQL `SELECT` adds `m.member_number`; `makeMemberIdentitySnapshot(...)` receives it. **Membership invoices only** — `create-event-invoice-draft` passes `member_number: null` (event invoices have no member).
- **No retroactive backfill of already-issued invoice snapshots** — Thai tax-document immutability (§86/4, §105). `member_number` appears only in invoices issued **after** ship. The PDF template branches on a truthy value (like the existing `input.member.tax_id && (…)`), so historical invoices render unchanged → SC-003 byte-identical determinism preserved.
- PDF placement: buyer block, under tax ID, label `หมายเลขสมาชิก / Member No.` (bilingual, matching the template's `ไทย / English` convention).

## 9. Security & compliance

- Per-tenant scoped; `UNIQUE(tenant_id, member_number)`; both new tables RLS `ENABLE`+`FORCE`+grants; allocator runs under the tenant RLS tx.
- **No enumeration surface**: URLs/routes stay on UUID (permanent rule — `member_number` must never become a route/query param); not in public directory export/widget; portal identity stays session-bound via `requireMemberContext` (no lookup-by-number).
- `member_number` is a **controller-assigned pseudonym, not PII** under PDPA §6 — no erasure/anonymisation obligation; document this one-liner in the spec data-model (no RoPA change beyond a note). It IS included in the member's own GDPR self-service export (transparency; their own identifier).
- **Cross-tenant integration test (Constitution Principle I, Review-Gate blocker)**: (a) tenant A cannot read/modify tenant B's `tenant_member_sequences`; (b) the members list/detail expose `member_number` only for the session's tenant; (c) the formatted string on the PDF equals the stored integer.
- Audit: **one** new event type `member_number_assigned`, emitted per assignment via the members audit port. The one-time backfill is **not** a separate audit event — the migration file + drizzle journal + the seeded numbers are the durable record (emitting audit from raw SQL would bypass the Application audit port and the member-timeline trigger). Add the new event type in **all 4 places** (domain const + drizzle pgEnum + `audit-event.test.ts` count + `completeness.test.ts` count) — typecheck won't catch a stale count.
- Defensive: optionally add `member_number` + `*.member_number` to `src/lib/logger.ts` `REDACT_PATHS` (integer is not PII, but it appears next to `company_name`; low-cost defence-in-depth).

## 10. i18n

`en` (canonical) + `th` + `sv`:
- Column / inline label: `Member No.` / `เลขสมาชิก` / `Medlemsnr` (apply `whitespace-nowrap`).
- Portal / full label: `Member Number` / `หมายเลขสมาชิก` / `Medlemsnummer`.
- PDF label: `Member No.` / `หมายเลขสมาชิก` (bilingual, in template copy).
- Updated search placeholder mentioning member-number input.

## 11. Testing strategy

- **Domain**: `formatMemberNumber` (pad, large n auto-expand), `parseMemberNumberQuery` (prefix/zeros/garbage), `asMemberNumber` (rejects ≤0 / non-int). 100% line.
- **Application/integration (live Neon)**: allocator concurrency (two concurrent `createMember` → no duplicate, advisory lock holds); allocation atomic with member insert (rollback drops the number, gap acceptable); backfill correctness (PARTITION BY, tie-break determinism, seed = N → next N+1); UNIQUE violation path; **cross-tenant probe**; snapshot round-trips `member_number` (new) and parses old snapshots → null (no `MalformedSnapshotError`).
- **Contract**: admin members list/detail + portal profile responses include `member_number`; search-by-number returns the right member.
- **E2E / a11y**: skeleton column-count parity (CLS-0); th-TH label no-wrap at 1280px; portal badge; copy button.
- **PDF golden**: membership invoice issued post-feature shows the number; a historical-snapshot (member_number absent) re-renders byte-identical (SC-003).

## 12. Scope, phasing & follow-ons

**In scope (one feature):** §4–§11 above. ~2 migrations, **1** new audit event type (`member_number_assigned`), 5 surfaces.

**Suggested phase split (optional, for review/ship cadence):**
- **Phase A — foundation + admin**: tables, allocator, backfill, domain, `createMember` wiring, admin list (+skeleton) / detail, search, i18n, cross-tenant test.
- **Phase B — member-facing**: portal (profile + dashboard, serializer consolidation), PDF snapshot extension + template.

**Out of scope / follow-ons (note in spec, do not build now):**
- In-app prefix editor (prefix is seed-only + immutable in MVP).
- Command-palette `SCCM-NNNN → /admin/members/{uuid}` resolution (smart-feature integration point).
- Renewal-reminder emails / event-registration references quoting the member number (F8 email-template dependency).
- Configurable pad width.

## 13. Open risks

- **Same-second backfill ties**: ordered by `member_id` (UUID) → stable within one run but the relative order of same-second members is arbitrary. Acceptable per the user's "oldest = 0001" intent (rare; no business meaning lost). If a true join-order field surfaces later, a one-off re-number is possible (numbers are not yet externally printed at backfill time).
- **Serializer divergence**: mitigated by consolidation or the dual contract test (§8.3) — must not be skipped.
- **Snapshot migration window**: between deploying the new zod schema and any future tightening, keep the field `.optional().default(null)`; do **not** tighten to required (historical JSONB has no field).
