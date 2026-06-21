# COMP-1 US3-B — 10-Year Member-Invoice + Credit-Note Tax Redaction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new sibling cron `redact-expired-member-invoices` that, ~10 years after issue, tombstones the buyer PII (DB snapshot + PDF blob bytes) on an **erased member's** F4 tax documents — membership invoices, matched-member event invoices, **and credit notes** — once the Thai RD §87/3 statutory tax-retention hold lifts, completing the Art.17/§33 erasure for the retained tax-document copy.

**Architecture:** Reuse the existing event-buyer redaction mechanism (`/api/cron/invoicing/redact-expired-event-buyers`) by extracting its per-row redaction STEP (GUC-gated tombstone UPDATE + RETURNING-gated audit + retryable post-commit blob purge) into a shared infrastructure helper parameterized by document table. The event-buyer cron is refactored to call the helper (no behaviour change — its existing tests prove it). The new member cron calls the SAME helper for the member-invoice arm (`member_id IS NOT NULL`, joined to `members.erased_at IS NOT NULL`, >10y) and the credit-note arm (joined via `original_invoice_id → invoices.member_id`). Credit notes need a NEW migration: a `app.allow_pii_redaction` GUC arm on the `credit_notes` immutability trigger + a `pii_blob_purged_at` marker column (the reused mechanism does not cover them today).

**Tech Stack:** Next.js route handler (cron), Drizzle raw SQL, Postgres trigger (plpgsql, GUC-gated), Vercel Blob, `f4AuditAdapter`, Vitest live-Neon integration. **No new audit type** (reuses `event_buyer_pii_redacted` with a member discriminator — per the design's no-new-type constraint). **One new migration** (credit-notes GUC arm + marker).

**Design:** `docs/superpowers/specs/2026-06-19-member-erasure-us3-bcde-design.md` § US3-B. **Precedent (read it — the member arm mirrors it):** `src/app/api/cron/invoicing/redact-expired-event-buyers/route.ts` + migrations `0205`/`0206` (invoices GUC arm) + `0027` (credit-notes immutability trigger).

**Security:** Tax-data + PII surface (GUC-gated immutability-trigger bypass). Review gate needs ≥2 reviewers + a signed security checklist + a thai-tax-compliance-auditor pass (the §87 no-gaps integrity must survive: only buyer PII is tombstoned; seller / amounts / numbering / dates are PRESERVED).

---

## Resolved design decisions (locked before tasks)

1. **10-year anchor for credit notes = the credit note's OWN `issue_date`** (it is its own §86/10 tax document with its own §87/3 retention window — not the original invoice's date). Same `issue_date < (now() - interval '10 years')::date` predicate as invoices.
2. **Audit reuse (no new type):** reuse `event_buyer_pii_redacted` (a generic, non-timeline F4 audit type, 10y retention) for the member-document redactions too. Add a payload discriminator: `member_id` + `document_kind` (`'invoice'`|`'credit_note'`) + (`invoice_subject` for invoices / `original_invoice_id` for credit notes). The type name is legacy (it predates the member arm); the `document_kind`/`member_id` discriminator makes the member case unambiguous and lets US3-D join the tax-redaction outcome per member. Update the audit-port docblock to say the type now also covers member invoices + credit notes. **No `ALTER TYPE` migration** (the type already exists).
3. **Eligibility gate = `member_id IS NOT NULL` (NOT `invoice_subject='membership'`)** joined to `members.erased_at IS NOT NULL` — so a **matched-member EVENT invoice** (`invoice_subject='event' AND member_id IS NOT NULL`) is also redacted (it carries the member's buyer PII and would otherwise fall in the gap between the two crons; the event-buyer cron handles only `member_id IS NULL`).
4. **`member_number` / `member_number_display` are NOT redacted** (master design §5 KEEPS the member number — it is a per-tenant sequence id, not PII). The tombstone redacts the SAME 5 PII fields as the event cron (`legal_name`/`address`/`primary_contact_name` → `'[REDACTED]'`, `primary_contact_email` → `''`, `tax_id` → NULL). The redacted snapshot still passes the read-boundary zod (`memberIdentitySnapshotSchema`): the 3 redacted strings are non-empty, `primary_contact_email:''` is allowed, `tax_id:null` is allowed, and `member_number`⟺`member_number_display` stay both-non-null (membership) so the `.superRefine` pairing holds.
5. **Shared-helper extraction (design prefers it):** extract the per-row redaction step + the post-commit purge step into `src/modules/invoicing/infrastructure/redaction/redact-buyer-pii-step.ts`, parameterized by `documentTable: 'invoices' | 'credit_notes'`. The cross-tenant orchestration + the arm-specific eligible-query stay in each route. The event-buyer cron is refactored to call the helper (its existing tests are the no-regression gate). **The design § US3-B says "shared invoicing _application_ use-case" — that wording is SUPERSEDED here:** raw Drizzle SQL + `tx` + `runInTenant` are forbidden in the Application layer by the Principle III ESLint bans (`applicationForbiddenPaths`/`Patterns`), so the shared step is correctly an **Infrastructure** helper; the route remains the composition root (mirrors the existing F4/F5 maintenance crons, which do raw work in infra adapters + orchestrate in the route — `event-buyer route:100-103`). This is a layer-correctness override of loose design wording, NOT a scope change (architect plan review I-1 — pre-empts a false-positive spec-compliance divergence).

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `drizzle/migrations/0227_credit_notes_pii_redaction_exemption.sql` | ADD `credit_notes.pii_blob_purged_at` + CREATE OR REPLACE `credit_notes_enforce_immutability()` with a GUC arm (allow ONLY `member_identity_snapshot` + `pii_blob_purged_at` under `app.allow_pii_redaction='true'`; lock everything incl. the marker on the normal path) + inline `SET search_path`. | Create |
| `src/modules/invoicing/infrastructure/db/schema-credit-notes.ts` | Add the `piiBlobPurgedAt` Drizzle column. | Modify |
| `src/modules/invoicing/infrastructure/redaction/redact-buyer-pii-step.ts` | Shared per-row tombstone+audit (`tombstoneBuyerPiiAndAuditInTx`) + post-commit purge+marker (`purgeBuyerPdfBlobsAndStampMarker`), parameterized by `documentTable`. | Create |
| `src/app/api/cron/invoicing/redact-expired-event-buyers/route.ts` | Refactor the inline per-row step + post-commit purge to call the shared helper (no behaviour change). | Modify |
| `src/app/api/cron/invoicing/redact-expired-member-invoices/route.ts` | New cron: per-tenant, GUC-gated; member-invoice eligible-query (`member_id IS NOT NULL` + erased + >10y) + credit-note eligible-query (join via `original_invoice_id`); calls the shared helper for both arms. | Create |
| `src/modules/invoicing/application/ports/audit-port.ts` | Update the `event_buyer_pii_redacted` docblock (now also member invoices + credit notes). | Modify |
| `src/lib/metrics.ts` | Add `memberDocumentPiiRedacted(outcome, tenantId)` (parallel to `eventBuyerPiiRedacted`). | Modify |
| `docs/runbooks/cron-jobs.md` | Document the new cron (schedule, Bearer auth, the 10y-from-2036 note, the credit-notes arm). | Modify |
| `tests/integration/invoicing/redact-expired-member-invoices.test.ts` | Live-Neon: membership + matched-member-event invoice + credit note redacted; non-erased member intact; <10y intact; idempotent; tax-retention re-render regression; §87 no-gaps. | Create |
| `tests/unit/api/cron/invoicing/redact-expired-member-invoices.test.ts` | Auth (401) + zero-work + tenant-error isolation (mirror the event-buyer unit test). | Create |
| `tests/integration/invoicing/credit-notes-redaction-guc.test.ts` | The new credit-notes GUC arm: redaction UPDATE succeeds under the GUC; a money/numbering UPDATE under the GUC RAISEs; a `member_identity_snapshot` UPDATE WITHOUT the GUC RAISEs (normal path still locks). | Create |

---

## Task 1: Credit-notes PII-redaction GUC migration + schema column

**Files:**
- Create: `drizzle/migrations/0227_credit_notes_pii_redaction_exemption.sql`
- Modify: `src/modules/invoicing/infrastructure/db/schema-credit-notes.ts`
- Test: `tests/integration/invoicing/credit-notes-redaction-guc.test.ts`

Context: `credit_notes` is born issued (no draft) — its immutability trigger (`credit_notes_enforce_immutability`, migration 0027) locks every snapshot/money/pdf column from INSERT. To redact the buyer PII after 10y we add a GUC arm exactly like the invoices trigger gained in 0205/0206: under `app.allow_pii_redaction='true'` ONLY `member_identity_snapshot` + the new `pii_blob_purged_at` marker may change; every other column still RAISEs; the normal path (no GUC) locks everything incl. the marker. **CREATE OR REPLACE resets the per-function `search_path` set by migration 0124 — re-declare it inline** (the documented gotcha; mirror 0205/0206).

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/invoicing/credit-notes-redaction-guc.test.ts`. Model the seed on `tests/integration/invoicing/redact-expired-event-buyers.test.ts` (creates a tenant + invoice settings + an issued invoice + a credit note). The 3 cases pin the trigger contract:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
// Reuse the invoicing integration harness: createTestTenant + a helper that
// seeds an issued invoice + a credit note (see redact-expired-event-buyers.test.ts).

describe('credit_notes PII-redaction GUC arm (COMP-1 US3-B, live Neon)', () => {
  // seed: a tenant + one issued credit note with a real buyer snapshot.
  // (helpers from the invoicing integration fixtures.)

  it('UNDER the GUC, redacting member_identity_snapshot + stamping pii_blob_purged_at SUCCEEDS', async () => {
    const { tenant, creditNoteId } = await seedCreditNote();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.execute(sql`SET LOCAL app.allow_pii_redaction = 'true'`);
      await tx.execute(sql`
        UPDATE credit_notes
        SET member_identity_snapshot = member_identity_snapshot
              || jsonb_build_object('legal_name','[REDACTED]','address','[REDACTED]',
                   'primary_contact_name','[REDACTED]','primary_contact_email','','tax_id',NULL),
            pii_blob_purged_at = now()
        WHERE credit_note_id = ${creditNoteId}
      `);
    });
    const rows = (await runInTenant(tenant.ctx, (tx) =>
      tx.execute(sql`SELECT member_identity_snapshot->>'legal_name' AS ln, pii_blob_purged_at FROM credit_notes WHERE credit_note_id = ${creditNoteId}`),
    )) as unknown as Array<{ ln: string; pii_blob_purged_at: Date | null }>;
    expect(rows[0]?.ln).toBe('[REDACTED]');
    expect(rows[0]?.pii_blob_purged_at).not.toBeNull();
  });

  it('UNDER the GUC, changing a MONEY/numbering column RAISEs (only PII + marker exempt)', async () => {
    const { tenant, creditNoteId } = await seedCreditNote();
    await expect(
      runInTenant(tenant.ctx, async (tx) => {
        await tx.execute(sql`SET LOCAL app.allow_pii_redaction = 'true'`);
        await tx.execute(sql`UPDATE credit_notes SET total_satang = 1 WHERE credit_note_id = ${creditNoteId}`);
      }),
    ).rejects.toThrow(/immutable|only member_identity_snapshot/i);
  });

  it('WITHOUT the GUC, changing member_identity_snapshot RAISEs (normal path still locks it)', async () => {
    const { tenant, creditNoteId } = await seedCreditNote();
    await expect(
      runInTenant(tenant.ctx, (tx) =>
        tx.execute(sql`UPDATE credit_notes SET member_identity_snapshot = '{}'::jsonb WHERE credit_note_id = ${creditNoteId}`),
      ),
    ).rejects.toThrow(/immutable/i);
  });

  it('UNDER the GUC, changing source_refund_id RAISEs (the money-FK is NOT in the 2-col exemption)', async () => {
    // thai-tax + security plan review: source_refund_id (mig 0038, post-0027) is a
    // §86/10 money-linkage FK and MUST stay locked even under the redaction GUC.
    const { tenant, creditNoteId } = await seedCreditNote();
    await expect(
      runInTenant(tenant.ctx, async (tx) => {
        await tx.execute(sql`SET LOCAL app.allow_pii_redaction = 'true'`);
        await tx.execute(sql`UPDATE credit_notes SET source_refund_id = '00000000-0000-0000-0000-000000000000' WHERE credit_note_id = ${creditNoteId}`);
      }),
    ).rejects.toThrow(/immutable|only member_identity_snapshot/i);
  });

  it('the immutability function retains its search_path hardening after CREATE OR REPLACE', async () => {
    // The 0124 gotcha: CREATE OR REPLACE resets per-function proconfig. Gate the
    // inline `SET search_path` in CI, not just a manual psql check (drizzle review S1).
    const rows = (await runInTenant(/* any tenant ctx */ tenantCtx, (tx) =>
      tx.execute(sql`SELECT proconfig FROM pg_proc WHERE proname = 'credit_notes_enforce_immutability'`),
    )) as unknown as Array<{ proconfig: string[] | null }>;
    expect(rows[0]?.proconfig ?? []).toContain('search_path=pg_catalog, public');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:integration -- tests/integration/invoicing/credit-notes-redaction-guc.test.ts`
Expected: FAIL — case 1 RAISEs (no GUC arm yet → the trigger blocks the redaction UPDATE) and `pii_blob_purged_at` does not exist.

- [ ] **Step 3: Write the migration**

Create `drizzle/migrations/0227_credit_notes_pii_redaction_exemption.sql`:

```sql
-- COMP-1 US3-B — GUC-gated PII-redaction exemption on the credit_notes
-- immutability trigger + a retryable PDF-blob purge marker.
--
-- WHY: the 10-year member-invoice retention sweeper
-- (`/api/cron/invoicing/redact-expired-member-invoices`) must tombstone the
-- buyer PII held in `credit_notes.member_identity_snapshot` once the §87/3
-- statutory retention window has elapsed. That column is locked from INSERT by
-- `credit_notes_enforce_immutability` (migration 0027), so a redaction UPDATE is
-- BLOCKED. This adds the SAME GUC arm the invoices trigger gained in 0205/0206:
-- under `app.allow_pii_redaction='true'` ONLY `member_identity_snapshot` +
-- `pii_blob_purged_at` may change; EVERY other column still RAISEs; the normal
-- path (GUC unset) locks everything INCLUDING the new marker.
--
-- SEARCH-PATH HARDENING: CREATE OR REPLACE FUNCTION RESETS the per-function
-- config set via ALTER FUNCTION (migration 0124 set search_path). Re-declare it
-- INLINE so the hardening survives (mirrors 0205/0206; the documented gotcha).

-- 1. The retryable purge marker. Nullable; set ONLY by the redaction cron after
--    a fully successful PDF-blob purge.
ALTER TABLE "credit_notes" ADD COLUMN IF NOT EXISTS "pii_blob_purged_at" timestamptz;--> statement-breakpoint

-- 2. CREATE OR REPLACE the immutability trigger function with the GUC arm.
--    Body = migration 0027's lock list, split into a GUC-exempt branch (locks
--    all EXCEPT member_identity_snapshot + pii_blob_purged_at) + the normal
--    branch (locks all incl. member_identity_snapshot + pii_blob_purged_at).
--    The trigger binding (credit_notes_enforce_immutability_trg) is unchanged —
--    CREATE OR REPLACE keeps the same OID.
CREATE OR REPLACE FUNCTION "credit_notes_enforce_immutability"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- PII-redaction exemption: authorised ONLY when the sweeper has set
  -- `SET LOCAL app.allow_pii_redaction = 'true'`. Allows ONLY the two
  -- redaction-owned columns to change — member_identity_snapshot (buyer-PII
  -- tombstone) + pii_blob_purged_at (purge-completed marker) — while every
  -- other snapshot / numbering / money / pdf column stays immutable. `, true`
  -- makes current_setting return NULL (not error) when the GUC was never set.
  IF current_setting('app.allow_pii_redaction', true) = 'true' THEN
    IF NEW."original_invoice_id"        IS DISTINCT FROM OLD."original_invoice_id"
       OR NEW."fiscal_year"             IS DISTINCT FROM OLD."fiscal_year"
       OR NEW."sequence_number"         IS DISTINCT FROM OLD."sequence_number"
       OR NEW."document_number"         IS DISTINCT FROM OLD."document_number"
       OR NEW."issue_date"              IS DISTINCT FROM OLD."issue_date"
       OR NEW."issued_by_user_id"       IS DISTINCT FROM OLD."issued_by_user_id"
       OR NEW."reason"                  IS DISTINCT FROM OLD."reason"
       OR NEW."credit_amount_satang"    IS DISTINCT FROM OLD."credit_amount_satang"
       OR NEW."vat_satang"              IS DISTINCT FROM OLD."vat_satang"
       OR NEW."total_satang"            IS DISTINCT FROM OLD."total_satang"
       OR NEW."tenant_identity_snapshot" IS DISTINCT FROM OLD."tenant_identity_snapshot"
       OR NEW."pdf_blob_key"            IS DISTINCT FROM OLD."pdf_blob_key"
       OR NEW."pdf_sha256"              IS DISTINCT FROM OLD."pdf_sha256"
       OR NEW."pdf_template_version"    IS DISTINCT FROM OLD."pdf_template_version"
       -- `source_refund_id` (F5 migration 0038, added AFTER the 0027 trigger so
       -- it is NOT in 0027's lock list) is a §86/10 money-linkage FK on an issued
       -- tax doc. The allow-list-by-omission trigger would otherwise leave it
       -- MUTABLE under the GUC — LOCK it (thai-tax + security plan review). NOTE:
       -- created_at/updated_at are intentionally NOT locked (parity with the
       -- invoices trigger; updated_at legitimately bumps on the redaction UPDATE).
       OR NEW."source_refund_id"        IS DISTINCT FROM OLD."source_refund_id"
    THEN
      RAISE EXCEPTION 'credit_notes: only member_identity_snapshot may change under PII redaction (row id=%)', OLD."credit_note_id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Normal path (GUC unset) — UNCHANGED lock set from migration 0027, PLUS the
  -- new pii_blob_purged_at marker (no normal write path may touch it). The
  -- original message is preserved so existing credit-note immutability tests match.
  IF NEW."original_invoice_id"       IS DISTINCT FROM OLD."original_invoice_id"
     OR NEW."fiscal_year"            IS DISTINCT FROM OLD."fiscal_year"
     OR NEW."sequence_number"        IS DISTINCT FROM OLD."sequence_number"
     OR NEW."document_number"        IS DISTINCT FROM OLD."document_number"
     OR NEW."issue_date"             IS DISTINCT FROM OLD."issue_date"
     OR NEW."issued_by_user_id"      IS DISTINCT FROM OLD."issued_by_user_id"
     OR NEW."reason"                 IS DISTINCT FROM OLD."reason"
     OR NEW."credit_amount_satang"   IS DISTINCT FROM OLD."credit_amount_satang"
     OR NEW."vat_satang"             IS DISTINCT FROM OLD."vat_satang"
     OR NEW."total_satang"           IS DISTINCT FROM OLD."total_satang"
     OR NEW."tenant_identity_snapshot" IS DISTINCT FROM OLD."tenant_identity_snapshot"
     OR NEW."member_identity_snapshot" IS DISTINCT FROM OLD."member_identity_snapshot"
     OR NEW."pdf_blob_key"           IS DISTINCT FROM OLD."pdf_blob_key"
     OR NEW."pdf_sha256"             IS DISTINCT FROM OLD."pdf_sha256"
     OR NEW."pdf_template_version"   IS DISTINCT FROM OLD."pdf_template_version"
     OR NEW."source_refund_id"       IS DISTINCT FROM OLD."source_refund_id"
     OR NEW."pii_blob_purged_at"     IS DISTINCT FROM OLD."pii_blob_purged_at"
  THEN
    RAISE EXCEPTION 'credit_notes: snapshot + money + pdf columns are immutable from INSERT (row id=%)', OLD."credit_note_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
```

- [ ] **Step 4: Add the Drizzle column**

In `src/modules/invoicing/infrastructure/db/schema-credit-notes.ts`, add (after `pdfTemplateVersion`, mirroring the invoices `piiBlobPurgedAt`):

```ts
    // COMP-1 US3-B — retryable PDF-blob purge marker, set ONLY by the member-
    // invoice redaction cron after a fully successful blob purge (migration 0227).
    // NULL = purge not yet completed. Exempt (with member_identity_snapshot) under
    // the `app.allow_pii_redaction` GUC; locked on every normal write path.
    piiBlobPurgedAt: timestamp('pii_blob_purged_at', { withTimezone: true }),
```

(Match the exact `timestamp` import + style used by `schema-invoices.ts:193`.)

- [ ] **Step 5: Apply the migration + run the test**

Run: `pnpm drizzle-kit migrate` (applies 0227 to live Neon).
Run: `pnpm test:integration -- tests/integration/invoicing/credit-notes-redaction-guc.test.ts`
Expected: PASS (5 cases — incl. the source_refund_id GUC lock + the proconfig assertion).
**ALSO run the PRE-EXISTING credit-note immutability tests** (drizzle review S2 — confirm the added `pii_blob_purged_at` lock + the CREATE OR REPLACE did not regress the normal-path immutability): `pnpm test:integration -- tests/integration/invoicing/` (or the specific credit-note immutability spec) → all green. A new `NULL`-default column is `NULL IS DISTINCT FROM NULL` = FALSE for every existing write, so this should pass; running it CATCHES any surprise `UPDATE credit_notes` path.
The proconfig assertion case above gates the search_path hardening in CI (the 0124 gotcha) — no manual psql step needed.

- [ ] **Step 6: Commit**

```bash
git add drizzle/migrations/0227_credit_notes_pii_redaction_exemption.sql src/modules/invoicing/infrastructure/db/schema-credit-notes.ts tests/integration/invoicing/credit-notes-redaction-guc.test.ts
git commit -m "feat(invoicing): credit_notes PII-redaction GUC arm + pii_blob_purged_at marker (COMP-1 US3-B)"
```

(Conventional Commits; header ≤100 chars; end the body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. **Apply migration + integration test BEFORE committing** — the project gotcha.)

---

## Task 2: Extract the shared redaction step + refactor the event-buyer cron

**Files:**
- Create: `src/modules/invoicing/infrastructure/redaction/redact-buyer-pii-step.ts`
- Modify: `src/app/api/cron/invoicing/redact-expired-event-buyers/route.ts`
- Test: (no new test — the event-buyer cron's EXISTING tests `tests/integration/invoicing/redact-expired-event-buyers.test.ts` + `tests/unit/api/cron/invoicing/redact-expired-event-buyers.test.ts` are the no-regression gate.)

Context: the per-row redaction step is currently inline in the event-buyer route (`:238-376` the in-tx tombstone+audit; `:391-458` the post-commit purge+marker). Extract it verbatim, parameterized by `documentTable`, so both crons share ONE reviewed implementation. **No behaviour change** — the event-buyer cron's existing tests must stay green.

- [ ] **Step 1: Create the shared helper**

Create `src/modules/invoicing/infrastructure/redaction/redact-buyer-pii-step.ts`:

```ts
/**
 * COMP-1 US3-B — shared buyer-PII redaction step, extracted verbatim from the
 * event-buyer cron so the member-invoice cron + the event-buyer cron share ONE
 * reviewed implementation. Parameterized by `documentTable` ('invoices' |
 * 'credit_notes'); the arm-specific eligible-QUERY stays in each route.
 *
 * The redaction tombstones the 5 buyer-PII fields on `member_identity_snapshot`
 * (legal_name/address/primary_contact_name → '[REDACTED]', primary_contact_email
 * → '', tax_id → NULL) — preserving the jsonb shape so the read-boundary zod +
 * the §86/4 PDF re-render stay valid — and purges the issued PDF blob BYTES,
 * with the HIGH-3 retryable `pii_blob_purged_at` marker. Runs ONLY under the
 * caller's `SET LOCAL app.allow_pii_redaction='true'` GUC (set in the route tx).
 */
import { sql } from 'drizzle-orm';
import type { TenantContext } from '@/modules/tenants';
import { runInTenant } from '@/lib/db';
import type { AuditPort } from '@/modules/invoicing/application/ports/audit-port';

export type RedactionDocumentTable = 'invoices' | 'credit_notes';

/** PII fields tombstoned on the buyer snapshot. NAMES only — never values. */
export const REDACTED_BUYER_FIELDS = [
  'legal_name',
  'address',
  'primary_contact_name',
  'primary_contact_email',
  'tax_id',
] as const;

export interface RedactionPurgeWorkItem {
  readonly documentTable: RedactionDocumentTable;
  readonly documentId: string;
  readonly keys: readonly string[];
  /** true → tombstoned on THIS pass; false → a retry purging an already-tombstoned row. */
  readonly tombstonedThisRun: boolean;
}

/**
 * In-tx: tombstone the buyer snapshot (RETURNING-gated for audit-once), stamp
 * the marker for a zero-blob row, and emit `event_buyer_pii_redacted`. Returns
 * the post-commit purge work item, or null (a lost concurrency race, or a fresh
 * zero-blob row whose redaction is already complete).
 *
 * `alreadyTombstoned` (the SELECT's `legal_name = '[REDACTED]'` flag) → the
 * retry case: skip the tombstone UPDATE + audit, only queue the blob purge.
 */
export async function tombstoneBuyerPiiAndAuditInTx(params: {
  readonly tx: Parameters<Parameters<typeof runInTenant>[1]>[0];
  readonly documentTable: RedactionDocumentTable;
  readonly documentId: string;
  readonly blobKeys: readonly string[];
  readonly alreadyTombstoned: boolean;
  readonly audit: AuditPort;
  readonly auditPayloadExtra: Record<string, unknown>;
  readonly tenantId: string;
  readonly requestId: string | null;
  readonly route: string;
}): Promise<RedactionPurgeWorkItem | null> {
  const { tx, documentTable, documentId, blobKeys, alreadyTombstoned } = params;

  if (alreadyTombstoned) {
    return blobKeys.length > 0
      ? { documentTable, documentId, keys: blobKeys, tombstonedThisRun: false }
      : null;
  }

  const redactedAt = new Date().toISOString();

  // Tombstone the 5 PII fields, preserving the jsonb shape (read-boundary zod +
  // §86/4 re-render stay valid). RETURNING-gated: a concurrent instance that
  // already tombstoned the row makes this match 0 rows → no double-audit. The id
  // column + table are hardcoded per `documentTable` (no sql.raw → injection-safe).
  const idColumn = documentTable === 'invoices' ? 'invoice_id' : 'credit_note_id';
  const tombstoned =
    documentTable === 'invoices'
      ? ((await tx.execute(sql`
          UPDATE invoices
          SET member_identity_snapshot = member_identity_snapshot
            || jsonb_build_object('legal_name','[REDACTED]','address','[REDACTED]',
                 'primary_contact_name','[REDACTED]','primary_contact_email','','tax_id',NULL)
          WHERE invoice_id = ${documentId}
            AND (member_identity_snapshot->>'legal_name') <> '[REDACTED]'
          RETURNING invoice_id
        `)) as unknown as Array<{ invoice_id: string }>)
      : ((await tx.execute(sql`
          UPDATE credit_notes
          SET member_identity_snapshot = member_identity_snapshot
            || jsonb_build_object('legal_name','[REDACTED]','address','[REDACTED]',
                 'primary_contact_name','[REDACTED]','primary_contact_email','','tax_id',NULL)
          WHERE credit_note_id = ${documentId}
            AND (member_identity_snapshot->>'legal_name') <> '[REDACTED]'
          RETURNING credit_note_id
        `)) as unknown as Array<{ credit_note_id: string }>);

  if (tombstoned.length !== 1) return null; // concurrent instance owns this row.

  // Zero-blob row: redaction complete the instant the snapshot is tombstoned —
  // stamp the marker in THIS GUC tx (defence-in-depth; non-draft invoices always
  // carry a PDF key, but a future doc-kind / data fix might not).
  if (blobKeys.length === 0) {
    if (documentTable === 'invoices') {
      await tx.execute(sql`UPDATE invoices SET pii_blob_purged_at = now() WHERE invoice_id = ${documentId} AND pii_blob_purged_at IS NULL`);
    } else {
      await tx.execute(sql`UPDATE credit_notes SET pii_blob_purged_at = now() WHERE credit_note_id = ${documentId} AND pii_blob_purged_at IS NULL`);
    }
  }

  // Audit in the SAME tx (atomic). Emitted EXACTLY ONCE per row (RETURNING gate).
  // Field NAMES only — never the erased PII values. 10y retention via the adapter.
  await params.audit.emit(tx, {
    eventType: 'event_buyer_pii_redacted',
    actorUserId: 'system:cron',
    summary: 'event_buyer_pii_redacted',
    payload: {
      ...params.auditPayloadExtra,
      [idColumn]: documentId,
      redacted_at: redactedAt,
      redacted_fields: [...REDACTED_BUYER_FIELDS],
      blob_purged_keys: blobKeys,
      reason: 'retention_10y_elapsed',
      route: params.route,
    },
    tenantId: params.tenantId,
    requestId: params.requestId,
  });

  return blobKeys.length > 0
    ? { documentTable, documentId, keys: blobKeys, tombstonedThisRun: true }
    : null;
}

/**
 * Post-commit: purge the PDF blob BYTES best-effort; ONLY on a fully successful
 * purge of every key, stamp `pii_blob_purged_at` via a SEPARATE GUC tx. A crash
 * before the stamp leaves the marker NULL → the next sweep re-selects + retries
 * (snapshot already tombstoned → no PII re-exposed, audit not re-emitted).
 */
export async function purgeBuyerPdfBlobsAndStampMarker(params: {
  readonly ctx: TenantContext;
  readonly item: RedactionPurgeWorkItem;
  readonly tenantId: string;
  readonly blobDelete: (key: string) => Promise<void>;
  readonly onPurged: (kind: 'fresh' | 'retry') => void;
  /**
   * Called per error with the document id + the error CLASS NAME (never the
   * message — PG/Blob messages can carry SQL fragments / keys) + the `phase`, so
   * the caller logs the right message + bumps the error metric. Preserves the
   * per-row forensic breadcrumb the inline event-buyer cron emitted.
   */
  readonly onError: (info: {
    readonly documentId: string;
    readonly errKind: string;
    readonly phase: 'blob_delete' | 'marker';
  }) => void;
}): Promise<void> {
  const { ctx, item, tenantId } = params;
  let allPurged = true;
  for (const key of item.keys) {
    try {
      await params.blobDelete(key);
    } catch (e) {
      allPurged = false;
      params.onError({ documentId: item.documentId, errKind: e instanceof Error ? e.constructor.name : 'unknown', phase: 'blob_delete' });
    }
  }
  if (!allPurged) return; // marker stays NULL → retried next tick.

  try {
    await runInTenant(ctx, async (tx) => {
      await tx.execute(sql`SET LOCAL app.allow_pii_redaction = 'true'`);
      if (item.documentTable === 'invoices') {
        await tx.execute(sql`UPDATE invoices SET pii_blob_purged_at = now() WHERE invoice_id = ${item.documentId} AND tenant_id = ${tenantId} AND pii_blob_purged_at IS NULL`);
      } else {
        await tx.execute(sql`UPDATE credit_notes SET pii_blob_purged_at = now() WHERE credit_note_id = ${item.documentId} AND tenant_id = ${tenantId} AND pii_blob_purged_at IS NULL`);
      }
    });
    params.onPurged(item.tombstonedThisRun ? 'fresh' : 'retry');
  } catch (e) {
    params.onError({ documentId: item.documentId, errKind: e instanceof Error ? e.constructor.name : 'unknown', phase: 'marker' });
  }
}
```

NOTE: confirm `credit_notes` has a `tenant_id` column for the post-commit marker UPDATE's `tenant_id = ${tenantId}` guard (the invoices version uses it at route `:428`). If `credit_notes` is tenant-scoped via `tenant_id` (it is — RLS), keep the guard; if the column name differs, adjust.

- [ ] **Step 2: Refactor the event-buyer route to call the helper**

In `src/app/api/cron/invoicing/redact-expired-event-buyers/route.ts`, replace the inline per-row loop body (`:238-376`) so that for each eligible row it calls `tombstoneBuyerPiiAndAuditInTx({ tx, documentTable: 'invoices', documentId: row.invoice_id, blobKeys, alreadyTombstoned: row.already_tombstoned, audit: f4AuditAdapter, auditPayloadExtra: {}, tenantId: tenantSlug, requestId, route: ROUTE })` and collects the returned non-null items into `purgeWork`; increment `tenantRedacted` when the returned item has `tombstonedThisRun === true`. Replace the post-commit purge loop (`:391-458`) with a loop calling `purgeBuyerPdfBlobsAndStampMarker({ ctx, item, tenantId: tenantSlug, blobDelete: (k) => vercelBlobAdapter.delete(k), onPurged: (kind) => logger.info({ requestId, route: ROUTE, tenantId: tenantSlug, invoiceId: item.documentId, purgeKind: kind }, 'cron.redact_expired_event_buyers.blob_purged'), onError: ({ documentId, errKind, phase }) => { invoicingMetrics.eventBuyerPiiRedacted('error', tenantSlug); logger.error({ requestId, route: ROUTE, tenantId: tenantSlug, invoiceId: documentId, errKind }, phase === 'blob_delete' ? 'cron.redact_expired_event_buyers.blob_delete_failed' : 'cron.redact_expired_event_buyers.purge_marker_failed'); } })` — the enriched `onError` RESTORES the per-row `blob_delete_failed` / `purge_marker_failed` forensic logs the inline cron emitted (the helper's `() => void` `onError` had dropped them; the metric alone is not enough for the runbook). Keep the eligible-QUERY (`:209-230`), the GUC `SET LOCAL` (`:187`), the tenant loop, and the metric/summary emits unchanged. Import the helper from `@/modules/invoicing/infrastructure/redaction/redact-buyer-pii-step`.

(The `auditPayloadExtra: {}` keeps the event-buyer payload byte-identical to today — it already has no `member_id`. The helper writes `invoice_id`/`redacted_at`/`redacted_fields`/`blob_purged_keys`/`reason`/`route`, exactly the current payload.)

- [ ] **Step 3: Run the event-buyer cron's EXISTING tests (no-regression gate)**

Run: `pnpm test:integration -- tests/integration/invoicing/redact-expired-event-buyers.test.ts` and `pnpm vitest run tests/unit/api/cron/invoicing/redact-expired-event-buyers.test.ts`
Expected: ALL pass unchanged (the refactor is behaviour-preserving). If any assertion on the audit payload or the redacted snapshot shifts, the extraction diverged — reconcile to byte-identical.
Run the temp-tsconfig typecheck + `pnpm lint`.

- [ ] **Step 4: Commit**

```bash
git add src/modules/invoicing/infrastructure/redaction/redact-buyer-pii-step.ts "src/app/api/cron/invoicing/redact-expired-event-buyers/route.ts"
git commit -m "refactor(invoicing): extract shared buyer-PII redaction step; event-buyer cron reuses it (COMP-1 US3-B)"
```

---

## Task 3: New member-invoice cron — invoice arm

**Files:**
- Create: `src/app/api/cron/invoicing/redact-expired-member-invoices/route.ts`
- Modify: `src/lib/metrics.ts` (add `memberDocumentPiiRedacted`)
- Test: `tests/integration/invoicing/redact-expired-member-invoices.test.ts` (the invoice-arm cases) + `tests/unit/api/cron/invoicing/redact-expired-member-invoices.test.ts`

Context: the new cron mirrors the event-buyer cron's shell (Bearer auth, cross-tenant loop, per-tenant GUC tx, post-commit purge) but its eligible-query targets **erased members' >10y invoices** (`member_id IS NOT NULL AND issue_date < now()-10y AND status <> 'draft'` joined to `members.erased_at IS NOT NULL`) — covering BOTH membership and matched-member-event invoices. Credit notes are added in Task 4.

- [ ] **Step 1: Add the metric**

In `src/lib/metrics.ts`, add to `invoicingMetrics` (mirror `eventBuyerPiiRedacted` at `:700`):

```ts
  /**
   * COMP-1 US3-B — member-document (invoice + credit-note) 10y PII-redaction
   * sweep outcome, per tenant. `redacted` = ≥1 doc tombstoned this tenant tick;
   * `swept_zero` = tenant had no due docs; `error` = a blob/marker failure (the
   * cron retries on the next tick).
   */
  memberDocumentPiiRedacted(outcome: 'redacted' | 'swept_zero' | 'error', tenantId: string): void {
    safeMetric(() => {
      // Counter name says "document" (covers invoices + credit notes), matching
      // the method name + the runbook alert query (architect plan review S-3).
      counter('member_document_pii_redacted_total', 1, { outcome, tenant: tenantId });
    });
  },
```

(Match the exact `counter(...)` signature used by `eventBuyerPiiRedacted` — read `:700-712` and mirror it precisely.)

- [ ] **Step 2: Write the failing integration test (invoice arm)**

Create `tests/integration/invoicing/redact-expired-member-invoices.test.ts`. Reuse the invoicing integration harness (seed a tenant + settings + a member + an issued invoice with a frozen buyer snapshot + a backdated `issue_date`). Seed an ERASED member (set `members.erased_at`). Invoice-arm cases:

```ts
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
// harness: createTestTenant, seedErasedMember, seedIssuedMembershipInvoice({ issueDate, memberId }),
// seedMatchedMemberEventInvoice(...), callRoute (POST the cron with Bearer CRON_SECRET).

describe('redact-expired-member-invoices — invoice arm (COMP-1 US3-B, live Neon)', () => {
  it('tombstones an ERASED member 11y-old MEMBERSHIP invoice + records the audit', async () => {
    const { tenant } = await createTestTenant();
    const memberId = await seedErasedMember(tenant);
    const invoiceId = await seedIssuedMembershipInvoice(tenant, { memberId, issueDate: '2014-01-01' });
    await callRoute(); // POST the cron, Bearer CRON_SECRET
    const row = (await runInTenant(tenant.ctx, (tx) =>
      tx.execute(sql`SELECT member_identity_snapshot->>'legal_name' AS ln, member_identity_snapshot->>'tax_id' AS tid FROM invoices WHERE invoice_id = ${invoiceId}`),
    )) as unknown as Array<{ ln: string; tid: string | null }>;
    expect(row[0]?.ln).toBe('[REDACTED]');
    expect(row[0]?.tid).toBeNull();
    // financial / numbering / member_number PRESERVED (§87 integrity) — assert a money col + document_number unchanged.
    // audit row present: event_buyer_pii_redacted with payload member_id + document_kind 'invoice'.
    const audit = (await runInTenant(tenant.ctx, (tx) =>
      tx.execute(sql`SELECT payload FROM audit_log WHERE tenant_id = ${tenant.ctx.slug} AND event_type = 'event_buyer_pii_redacted' AND payload->>'invoice_id' = ${invoiceId}`),
    )) as unknown as Array<{ payload: Record<string, unknown> }>;
    expect(audit[0]?.payload).toMatchObject({ invoice_id: invoiceId, member_id: memberId, document_kind: 'invoice' });
  }, 30_000);

  it('tombstones an ERASED member 11y-old MATCHED-MEMBER EVENT invoice (the gap case)', async () => {
    const { tenant } = await createTestTenant();
    const memberId = await seedErasedMember(tenant);
    const invoiceId = await seedMatchedMemberEventInvoice(tenant, { memberId, issueDate: '2014-01-01' });
    await callRoute();
    const row = (await runInTenant(tenant.ctx, (tx) =>
      tx.execute(sql`SELECT member_identity_snapshot->>'legal_name' AS ln FROM invoices WHERE invoice_id = ${invoiceId}`),
    )) as unknown as Array<{ ln: string }>;
    expect(row[0]?.ln).toBe('[REDACTED]');
  }, 30_000);

  it('LEAVES a NON-erased member 11y-old invoice fully intact (relationship still live)', async () => {
    const { tenant } = await createTestTenant();
    const memberId = await seedActiveMember(tenant); // erased_at IS NULL
    const invoiceId = await seedIssuedMembershipInvoice(tenant, { memberId, issueDate: '2014-01-01' });
    await callRoute();
    const row = (await runInTenant(tenant.ctx, (tx) =>
      tx.execute(sql`SELECT member_identity_snapshot->>'legal_name' AS ln FROM invoices WHERE invoice_id = ${invoiceId}`),
    )) as unknown as Array<{ ln: string }>;
    expect(row[0]?.ln).not.toBe('[REDACTED]');
  }, 30_000);

  it('LEAVES an erased member <10y invoice intact (retention not elapsed)', async () => {
    const { tenant } = await createTestTenant();
    const memberId = await seedErasedMember(tenant);
    const invoiceId = await seedIssuedMembershipInvoice(tenant, { memberId, issueDate: '2024-01-01' });
    await callRoute();
    const row = (await runInTenant(tenant.ctx, (tx) =>
      tx.execute(sql`SELECT member_identity_snapshot->>'legal_name' AS ln FROM invoices WHERE invoice_id = ${invoiceId}`),
    )) as unknown as Array<{ ln: string }>;
    expect(row[0]?.ln).not.toBe('[REDACTED]');
  }, 30_000);

  it('is idempotent — a 2nd run does not re-emit the audit', async () => {
    const { tenant } = await createTestTenant();
    const memberId = await seedErasedMember(tenant);
    const invoiceId = await seedIssuedMembershipInvoice(tenant, { memberId, issueDate: '2014-01-01' });
    await callRoute();
    await callRoute();
    const audit = (await runInTenant(tenant.ctx, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'event_buyer_pii_redacted' AND payload->>'invoice_id' = ${invoiceId}`),
    )) as unknown as Array<{ n: number }>;
    expect(audit[0]?.n).toBe(1);
  }, 30_000);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm test:integration -- tests/integration/invoicing/redact-expired-member-invoices.test.ts`
Expected: FAIL — the route module does not exist.

- [ ] **Step 4: Implement the cron route (invoice arm)**

Create `src/app/api/cron/invoicing/redact-expired-member-invoices/route.ts`. Use the event-buyer route as the structural template (Bearer auth, the tenant-list SELECT, the per-tenant `runInTenant` + `SET LOCAL app.allow_pii_redaction`, the post-commit purge loop). The invoice-arm eligible-query (note the `members` join + `member_id IS NOT NULL`):

```sql
SELECT
  i.invoice_id,
  i.pdf_blob_key,
  i.receipt_pdf_blob_key,
  i.member_id,
  i.invoice_subject,
  (i.member_identity_snapshot->>'legal_name') = '[REDACTED]' AS already_tombstoned
FROM invoices i
JOIN members m ON m.member_id = i.member_id AND m.erased_at IS NOT NULL
WHERE i.member_id IS NOT NULL
  AND i.status <> 'draft'
  AND i.issue_date < (now() - interval '10 years')::date
  AND i.member_identity_snapshot IS NOT NULL
  AND (
    (i.member_identity_snapshot->>'legal_name') <> '[REDACTED]'
    OR (
      (i.member_identity_snapshot->>'legal_name') = '[REDACTED]'
      AND i.pii_blob_purged_at IS NULL
      AND (i.pdf_blob_key IS NOT NULL OR i.receipt_pdf_blob_key IS NOT NULL)
    )
  )
FOR UPDATE OF i SKIP LOCKED
```

For each row: `blobKeys = [pdf_blob_key, receipt_pdf_blob_key].filter(Boolean)`; call `tombstoneBuyerPiiAndAuditInTx({ tx, documentTable: 'invoices', documentId: row.invoice_id, blobKeys, alreadyTombstoned: row.already_tombstoned, audit: f4AuditAdapter, auditPayloadExtra: { member_id: row.member_id, document_kind: 'invoice', invoice_subject: row.invoice_subject }, tenantId: tenantSlug, requestId, route: ROUTE })`; collect non-null items into `purgeWork`; `tenantRedacted += item?.tombstonedThisRun ? 1 : 0`. Post-commit: `purgeBuyerPdfBlobsAndStampMarker(...)` with `onPurged: (kind) => logger.info({ requestId, route: ROUTE, tenantId: tenantSlug, documentId: item.documentId, purgeKind: kind }, 'cron.redact_expired_member_invoices.blob_purged')` and `onError: ({ documentId, errKind, phase }) => { invoicingMetrics.memberDocumentPiiRedacted('error', tenantSlug); logger.error({ requestId, route: ROUTE, tenantId: tenantSlug, documentId, errKind }, phase === 'blob_delete' ? 'cron.redact_expired_member_invoices.blob_delete_failed' : 'cron.redact_expired_member_invoices.purge_marker_failed'); }` (the enriched `onError` carries `documentId`/`errKind`/`phase` — same forensic breadcrumb as the event-buyer cron). Per-tenant metric `memberDocumentPiiRedacted(tenantRedacted > 0 ? 'redacted' : 'swept_zero', tenantSlug)`. `ROUTE = '/api/cron/invoicing/redact-expired-member-invoices'`. `maxDuration = 300`, `runtime='nodejs'`, `dynamic='force-dynamic'`.

**RLS note (Principle I):** the `JOIN members m` runs inside `runInTenant` so RLS scopes BOTH `invoices` and `members` to the tenant. The members table is RLS+FORCE; the join cannot cross tenants. The cross-tenant integration test (Task 5) is the gate-blocker.

**Build it test-shaped (security FIX-2 + architect S-2):** extract the PER-TENANT redaction body — the `runInTenant(ctx, …)` tombstone+audit loop + the post-commit purge for ONE tenant — into a named exported async function `redactExpiredMemberDocumentsForTenant(ctx: TenantContext, requestId: string | null): Promise<{ redacted: number }>` (in the route file or a co-located module). The route's cross-tenant loop calls it per tenant; the Task-5 cross-tenant isolation test calls it DIRECTLY for tenant A and asserts tenant B's rows are untouched — a genuine 2-tenant live-Neon RLS test driving the REAL code path (NOT the full sweep, which redacts every tenant and proves nothing). Do this NOW (route authoring), not deferred to Task 5.

- [ ] **Step 5: Write the unit test (auth + zero-work + tenant isolation)**

Create `tests/unit/api/cron/invoicing/redact-expired-member-invoices.test.ts` mirroring `tests/unit/api/cron/invoicing/redact-expired-event-buyers.test.ts`: 401 on missing/wrong Bearer; 200 `{ ok, redactedCount: 0, … }` when no tenant has due docs; one tenant throwing does not block the rest (per-tenant try/catch, `tenantsErrored` incremented).

- [ ] **Step 6: Run tests + typecheck + lint**

Run the integration test (invoice-arm cases pass) + the unit test + the temp-tsconfig typecheck + `pnpm lint` + `pnpm check:layout` (the new `route.ts` has no page sibling, so it's exempt — confirm check:layout stays green).

- [ ] **Step 7: Commit**

```bash
git add "src/app/api/cron/invoicing/redact-expired-member-invoices/route.ts" src/lib/metrics.ts tests/integration/invoicing/redact-expired-member-invoices.test.ts tests/unit/api/cron/invoicing/redact-expired-member-invoices.test.ts
git commit -m "feat(invoicing): redact-expired-member-invoices cron — invoice arm (COMP-1 US3-B)"
```

---

## Task 4: Credit-note arm

**Files:**
- Modify: `src/app/api/cron/invoicing/redact-expired-member-invoices/route.ts` (add the credit-note arm)
- Test: `tests/integration/invoicing/redact-expired-member-invoices.test.ts` (add credit-note cases)

Context: an erased member's >10y credit notes carry the SAME buyer PII + the SAME §87/3 retention. `credit_notes` has no `member_id` — join via `original_invoice_id → invoices.member_id → members.erased_at`. The 10y anchor is the credit note's OWN `issue_date` (decision 1). One PDF blob (`pdf_blob_key`). Reuses the Task-1 GUC arm + the Task-2 helper (`documentTable: 'credit_notes'`).

- [ ] **Step 1: Write the failing test (credit-note cases)**

Append to `tests/integration/invoicing/redact-expired-member-invoices.test.ts`:

```ts
  it('tombstones an ERASED member 11y-old CREDIT NOTE + purges its PDF, joined via original invoice', async () => {
    const { tenant } = await createTestTenant();
    const memberId = await seedErasedMember(tenant);
    const invoiceId = await seedIssuedMembershipInvoice(tenant, { memberId, issueDate: '2014-01-01' });
    const creditNoteId = await seedCreditNote(tenant, { originalInvoiceId: invoiceId, issueDate: '2014-02-01' });
    await callRoute();
    const row = (await runInTenant(tenant.ctx, (tx) =>
      tx.execute(sql`SELECT member_identity_snapshot->>'legal_name' AS ln, pii_blob_purged_at FROM credit_notes WHERE credit_note_id = ${creditNoteId}`),
    )) as unknown as Array<{ ln: string; pii_blob_purged_at: Date | null }>;
    expect(row[0]?.ln).toBe('[REDACTED]');
    // a real blob key was seeded → purged → marker stamped.
    expect(row[0]?.pii_blob_purged_at).not.toBeNull();
    const audit = (await runInTenant(tenant.ctx, (tx) =>
      tx.execute(sql`SELECT payload FROM audit_log WHERE event_type = 'event_buyer_pii_redacted' AND payload->>'credit_note_id' = ${creditNoteId}`),
    )) as unknown as Array<{ payload: Record<string, unknown> }>;
    expect(audit[0]?.payload).toMatchObject({ credit_note_id: creditNoteId, member_id: memberId, document_kind: 'credit_note', original_invoice_id: invoiceId });
  }, 30_000);

  it('LEAVES a NON-erased member 11y-old credit note intact', async () => {
    const { tenant } = await createTestTenant();
    const memberId = await seedActiveMember(tenant);
    const invoiceId = await seedIssuedMembershipInvoice(tenant, { memberId, issueDate: '2014-01-01' });
    const creditNoteId = await seedCreditNote(tenant, { originalInvoiceId: invoiceId, issueDate: '2014-02-01' });
    await callRoute();
    const row = (await runInTenant(tenant.ctx, (tx) =>
      tx.execute(sql`SELECT member_identity_snapshot->>'legal_name' AS ln FROM credit_notes WHERE credit_note_id = ${creditNoteId}`),
    )) as unknown as Array<{ ln: string }>;
    expect(row[0]?.ln).not.toBe('[REDACTED]');
  }, 30_000);
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:integration -- tests/integration/invoicing/redact-expired-member-invoices.test.ts -t "CREDIT NOTE"`
Expected: FAIL — the cron has no credit-note arm yet (the credit note is untouched).

- [ ] **Step 3: Implement the credit-note arm**

In the route, AFTER the invoice arm's per-tenant tx (in the SAME `runInTenant` tx, under the same GUC, OR a second tx in the same tenant iteration — prefer the SAME tx so one GUC set covers both), add a second eligible-query for credit notes + the same per-row helper call with `documentTable: 'credit_notes'`:

```sql
SELECT
  cn.credit_note_id,
  cn.pdf_blob_key,
  cn.original_invoice_id,
  i.member_id,
  (cn.member_identity_snapshot->>'legal_name') = '[REDACTED]' AS already_tombstoned
FROM credit_notes cn
JOIN invoices i ON i.invoice_id = cn.original_invoice_id
JOIN members m ON m.member_id = i.member_id AND m.erased_at IS NOT NULL
WHERE i.member_id IS NOT NULL
  AND cn.issue_date < (now() - interval '10 years')::date
  AND cn.member_identity_snapshot IS NOT NULL
  AND (
    (cn.member_identity_snapshot->>'legal_name') <> '[REDACTED]'
    OR (
      (cn.member_identity_snapshot->>'legal_name') = '[REDACTED]'
      AND cn.pii_blob_purged_at IS NULL
      AND cn.pdf_blob_key IS NOT NULL
    )
  )
FOR UPDATE OF cn SKIP LOCKED
```

For each row: `blobKeys = [cn.pdf_blob_key]` (credit notes have ONE PDF, NOT NULL); call `tombstoneBuyerPiiAndAuditInTx({ tx, documentTable: 'credit_notes', documentId: row.credit_note_id, blobKeys, alreadyTombstoned: row.already_tombstoned, audit: f4AuditAdapter, auditPayloadExtra: { member_id: row.member_id, document_kind: 'credit_note', original_invoice_id: row.original_invoice_id }, tenantId: tenantSlug, requestId, route: ROUTE })`; collect into the SAME `purgeWork` array (the helper + the post-commit purge already switch on `item.documentTable`, so credit-note items purge + stamp the credit_notes marker correctly). Count credit-note tombstones into `tenantRedacted` too.

- [ ] **Step 4: Run tests + typecheck + lint**

Run the full integration file (invoice + credit-note cases pass) + the temp-tsconfig typecheck + `pnpm lint`.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/cron/invoicing/redact-expired-member-invoices/route.ts" tests/integration/invoicing/redact-expired-member-invoices.test.ts
git commit -m "feat(invoicing): redact-expired-member-invoices — credit-note arm via original-invoice join (COMP-1 US3-B)"
```

---

## Task 5: Tax-retention regression + §87 no-gaps integrity + cross-tenant isolation

**Files:**
- Modify: `tests/integration/invoicing/redact-expired-member-invoices.test.ts`

Context: three properties the thai-tax + security reviews require. (a) The PDF re-renders from the FROZEN snapshot, so a redacted snapshot → a redacted PDF (the tax document copy is genuinely minimised, not just the DB) — and BEFORE redaction the re-render still shows the buyer (proving the snapshot, not the live-scrubbed member, drives the PDF). (b) §87 integrity: the row + document_number + amounts + seller identity survive untouched — only buyer PII is tombstoned. (c) Principle-I cross-tenant isolation (Review-gate blocker).

- [ ] **Step 1: Write the regression + integrity + cross-tenant tests**

```ts
  it('§87 no-gaps: redaction PRESERVES document_number + amounts + seller identity (only buyer PII tombstoned)', async () => {
    const { tenant } = await createTestTenant();
    const memberId = await seedErasedMember(tenant);
    const invoiceId = await seedIssuedMembershipInvoice(tenant, { memberId, issueDate: '2014-01-01' });
    const before = await readInvoiceTaxFields(tenant, invoiceId); // document_number, total_satang, tenant_identity_snapshot, fiscal_year, sequence_number
    await callRoute();
    const after = await readInvoiceTaxFields(tenant, invoiceId);
    expect(after.document_number).toBe(before.document_number);
    expect(after.total_satang).toBe(before.total_satang);
    expect(after.fiscal_year).toBe(before.fiscal_year);
    expect(after.sequence_number).toBe(before.sequence_number);
    expect(after.tenant_identity_snapshot).toEqual(before.tenant_identity_snapshot);
    // member_number PRESERVED (kept per master design §5)
    const mn = (await runInTenant(tenant.ctx, (tx) =>
      tx.execute(sql`SELECT member_identity_snapshot->>'member_number' AS m FROM invoices WHERE invoice_id = ${invoiceId}`),
    )) as unknown as Array<{ m: string | null }>;
    expect(mn[0]?.m).not.toBeNull();
  }, 30_000);

  it('tax-retention regression: the re-rendered PDF shows the buyer BEFORE redaction and is REDACTED after', async () => {
    const { tenant } = await createTestTenant();
    const memberId = await seedErasedMember(tenant);
    const invoiceId = await seedIssuedMembershipInvoice(tenant, { memberId, issueDate: '2014-01-01', legalName: 'Acme Co Ltd' });
    // Re-render the PDF from the snapshot BEFORE redaction → buyer present.
    const pdfBefore = await renderInvoicePdfText(tenant, invoiceId); // reuse the F4 re-render path
    expect(pdfBefore).toContain('Acme Co Ltd');
    await callRoute();
    const pdfAfter = await renderInvoicePdfText(tenant, invoiceId);
    expect(pdfAfter).not.toContain('Acme Co Ltd');
    expect(pdfAfter).toContain('[REDACTED]');
  }, 60_000);

  it('cross-tenant isolation (Principle I gate-blocker): tenant-A run does NOT redact tenant-B docs', async () => {
    const a = await createTestTenant();
    const b = await createTestTenant();
    const memberB = await seedErasedMember(b);
    const invoiceB = await seedIssuedMembershipInvoice(b, { memberId: memberB, issueDate: '2014-01-01' });
    // Run ONLY tenant A's per-tenant redaction body (the named function extracted
    // in Task 3). Under tenant A's `runInTenant`/RLS it must NOT reach tenant B's row.
    await redactExpiredMemberDocumentsForTenant(a.tenant.ctx, null);
    const rowB = (await runInTenant(b.tenant.ctx, (tx) =>
      tx.execute(sql`SELECT member_identity_snapshot->>'legal_name' AS ln FROM invoices WHERE invoice_id = ${invoiceB}`),
    )) as unknown as Array<{ ln: string }>;
    expect(rowB[0]?.ln).not.toBe('[REDACTED]'); // tenant A's run cannot reach tenant B's row (RLS).
  }, 30_000);
```

NOTE: this is the Principle-I gate-blocker. A full route POST sweeps EVERY tenant (a maintenance path) and would redact both A and B — proving nothing. Isolation = the PER-TENANT body (`redactExpiredMemberDocumentsForTenant`, extracted in Task 3 Step 4) running under tenant A's `runInTenant`/RLS cannot mutate tenant B's rows. The test drives that REAL function directly (option a, decided — security FIX-2). Do NOT mock RLS or assert via the full sweep.

- [ ] **Step 2: Run + reconcile**

Run: `pnpm test:integration -- tests/integration/invoicing/redact-expired-member-invoices.test.ts`
Expected: all pass. For the re-render regression, reuse the F4 PDF re-render path (`renderInvoicePdfText` — find the existing test helper / the auto-rerender use-case the F4 tests use; do NOT hand-roll a renderer). If extracting `redactSingleTenant` for the cross-tenant test, keep the route delegating to it (no behaviour change for the full sweep).

- [ ] **Step 3: Commit**

```bash
git add tests/integration/invoicing/redact-expired-member-invoices.test.ts "src/app/api/cron/invoicing/redact-expired-member-invoices/route.ts"
git commit -m "test(invoicing): US3-B tax-retention regression + §87 integrity + cross-tenant isolation (COMP-1 US3-B)"
```

---

## Task 6: Audit-port docblock + cron registration + runbook

**Files:**
- Modify: `src/modules/invoicing/application/ports/audit-port.ts` (the `event_buyer_pii_redacted` docblock)
- Modify: `docs/runbooks/cron-jobs.md`
- (Operator step) register the cron on cron-job.org.

- [ ] **Step 1: Update the audit-port docblock**

In `audit-port.ts`, extend the `event_buyer_pii_redacted` docblock (currently `:107-124`) to note it now ALSO covers the member-document redaction (member invoices + matched-member event invoices + credit notes), discriminated by the payload `member_id` + `document_kind`. Do NOT change the type, the retention (`10`), or any other member — additive comment only. (No new audit type.)

- [ ] **Step 2: Document the cron in the runbook**

In `docs/runbooks/cron-jobs.md`, add a section for `redact-expired-member-invoices` mirroring the `redact-expired-event-buyers` section: schedule (daily, retry-OFF), Bearer `CRON_SECRET`, the cross-tenant sweep, the 10y-from-~2036 "no live trigger for ~10 years" note, the credit-note arm, and the `member_document_pii_redacted_total{outcome,tenant}` metric + alert.

- [ ] **Step 3: Operator registration (note in the plan, not auto-done)**

The cron fires via cron-job.org (HTTP POST + Bearer `CRON_SECRET`), like the sibling F4/F5/F6 crons. **This is an operator action** — add a cron-job.org entry pointing at `https://<deploy>/api/cron/invoicing/redact-expired-member-invoices`, daily, Bearer `CRON_SECRET`, retry-OFF. Record it as a ship-day gate in the PR description (no code; the route already exists + is CRON_SECRET-gated). No `vercel.json` change (this project uses external cron-job.org triggers).

- [ ] **Step 4: Commit**

```bash
git add src/modules/invoicing/application/ports/audit-port.ts docs/runbooks/cron-jobs.md
git commit -m "docs(invoicing): audit-port note + runbook for the member-invoice redaction cron (COMP-1 US3-B)"
```

---

## Task 7: Full gate sweep + security + thai-tax + spec review

**Files:** none (verification + review)

- [ ] **Step 1: Full local gate sweep**

```bash
pnpm lint && pnpm check:layout && pnpm vitest run tests/unit/api/cron/invoicing && pnpm test:integration -- tests/integration/invoicing/credit-notes-redaction-guc.test.ts tests/integration/invoicing/redact-expired-member-invoices.test.ts tests/integration/invoicing/redact-expired-event-buyers.test.ts
```
Then the temp-tsconfig typecheck (excludes `.next`). Confirm the event-buyer cron's existing tests are STILL green (the Task-2 refactor introduced no regression). Confirm `proconfig` on `credit_notes_enforce_immutability` carries the search_path.

- [ ] **Step 2: thai-tax-compliance-auditor**

Dispatch `thai-tax-compliance-auditor` on the diff: the §87/3 retention semantics (10y anchor correct for invoices + credit notes), the §87 no-gaps integrity (numbering/amounts/seller PRESERVED; only buyer PII tombstoned), the credit-note ↔ original-invoice linkage, the GUC arm cannot mutate any tax-relevant field, the matched-member-event-invoice gap closure.

- [ ] **Step 3: security-engineer + drizzle-migration-reviewer**

Dispatch `security-engineer` (the GUC-gated immutability bypass: only the redaction cron sets the GUC, the trigger lets ONLY the 2 columns change, no PII in logs/audit, cross-tenant isolation via RLS on the `members` join, the Principle-I cross-tenant integration test exists) + `drizzle-migration-reviewer` (migration 0227: the trigger replace preserves the binding + search_path; the GUC arm mirrors 0205/0206; the marker column is exempt under GUC + locked normally; idempotent `ADD COLUMN IF NOT EXISTS`). Sign the security checklist.

- [ ] **Step 4: spec-compliance-auditor**

Dispatch `spec-compliance-auditor` against `docs/superpowers/specs/2026-06-19-member-erasure-us3-bcde-design.md` § US3-B: every design bullet realized (member_id-gate not subject-gate; matched-member-event invoice covered; credit-notes IN SCOPE with the GUC-arm+marker migration; shared-helper extraction; reuse the existing audit; the tax-retention + §87 + non-erased-intact tests).

- [ ] **Step 5: Address findings + re-run gates; finish the branch**

Fix findings (sequential commits). Re-run Step 1. Then `superpowers:finishing-a-development-branch`.

---

## Self-Review (against the design § US3-B)

**1. Spec coverage:**
- "new sibling cron reusing the redaction core" → Task 2 (extract) + Task 3 (new cron). ✓
- "member_id IS NOT NULL + erased + 10y, joined to members.erased_at; matched-member EVENT invoice covered (NOT subject-gated)" → Task 3 eligible-query. ✓
- "extract the redaction STEP into a shared helper; refactor the event cron (no behaviour change)" → Task 2. ✓
- "CREDIT NOTES IN SCOPE (BLOCKER): GUC arm on trigger 0027 + pii_blob_purged_at marker; find via original_invoice_id→member_id; 10y anchor = credit-note's own date; tombstone + purge via the shared helper" → Task 1 (migration) + Task 4 (arm). ✓
- "reuse the existing redaction audit with a member discriminator; no new audit type" → Task 2/3/4 (`event_buyer_pii_redacted` + `member_id`/`document_kind`); Task 6 docblock. ✓
- "tests: erased >10y invoice (membership + matched-event) + credit notes redacted+purged; non-erased intact; <10y intact; idempotent; tax-retention re-render regression; §87 no-gaps; event cron stays green" → Tasks 3/4/5 + Task 2 Step 3. ✓
- Cross-cutting: tenant isolation + cross-tenant test (Task 5); migration (Task 1); Test-First (every task RED→GREEN); security/thai-tax/migration review (Task 7). ✓

**2. Placeholder scan:** the migration SQL + the shared-helper body + the eligible-queries are complete. The integration tests reference harness helpers (`createTestTenant`, `seedErasedMember`, `seedIssuedMembershipInvoice`, `seedCreditNote`, `renderInvoicePdfText`) by name — the implementer wires the exact import from the existing invoicing integration fixtures (`redact-expired-event-buyers.test.ts` + the F4 PDF-render tests); flagged explicitly in each test task. The cron registration is an operator step (no code), flagged in Task 6.

**3. Type consistency:** `RedactionDocumentTable` / `RedactionPurgeWorkItem` / `tombstoneBuyerPiiAndAuditInTx` / `purgeBuyerPdfBlobsAndStampMarker` defined in Task 2, consumed identically in Tasks 2/3/4. The audit `event_buyer_pii_redacted` + the payload keys (`invoice_id`/`credit_note_id`, `member_id`, `document_kind`, `original_invoice_id`, `invoice_subject`, `redacted_at`, `redacted_fields`, `blob_purged_keys`, `reason`, `route`) are consistent across the helper, the routes, and the test assertions. `pii_blob_purged_at` column added to `credit_notes` (Task 1) is read/written by the helper (Task 2) for `documentTable: 'credit_notes'`.

**4. Ambiguity resolved:** the 10y anchor for credit notes = the credit note's own `issue_date` (decision 1). The cross-tenant test proves the per-tenant-body isolation property, NOT the full sweep (Task 5 Step 1 note). The credit-note arm runs in the SAME per-tenant GUC tx as the invoice arm (one `SET LOCAL` covers both) — Task 4 Step 3.
