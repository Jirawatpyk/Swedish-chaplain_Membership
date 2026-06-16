# Member Erasure — US2b (F7 Content + Deliveries Tombstone) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Redact the PII a member authored into / received in F7 broadcasts — scrub `subject`/`body_html`/`body_source`/`from_name`/`reply_to_email` → `'[redacted]'` and `custom_recipient_emails` → NULL on every broadcast the erased member originated, and tombstone the member's `broadcast_deliveries` recipient email — wired into `eraseMember` as a post-commit best-effort cascade.

**Architecture:** Two DB-immutability barriers, two bypass mechanisms. (1) The `broadcasts` content lives under `broadcasts_immutable_after_submit_fn` — amend it to add a `current_setting('app.allow_broadcast_redaction','on')` exemption arm that whitelists ONLY the content columns (mirrors F4's `app.allow_pii_redaction` GUC). (2) `broadcast_deliveries` is append-only via an unconditional trigger with no GUC arm — use the established `ALTER TABLE … DISABLE/ENABLE TRIGGER` bypass (the same mechanism the existing `setMemberIdNull` use-case uses). A net-new `scrubBroadcastContentForMember` use-case in the broadcasts module does both under one `runInTenant` tx and emits `broadcast_content_redacted`; the members module reaches it via a new `BroadcastsContentScrubPort` + adapter, exactly like the existing `BroadcastsCascadePort` cancel cascade. `broadcast_batch_delivery_events` is **not** touched (pure idempotency ledger, no PII).

**Tech Stack:** TypeScript 5.7 strict · Drizzle ORM + Neon Postgres (RLS+FORCE, `runInTenant`, plpgsql triggers, GUC `SET LOCAL`) · Vitest · `Result<T,E>` · Clean Architecture.

---

## Pre-flight (read before Task 1)

- **`broadcasts` schema** — `src/modules/broadcasts/infrastructure/schema.ts:155-350`. Content cols (all `text NOT NULL`): `subject` (drizzle `subject`), `bodyHtml` (`body_html`), `bodySource` (`body_source`), `fromName` (`from_name`), `replyToEmail` (`reply_to_email`). `customRecipientEmails` (`custom_recipient_emails`) is `text[]` **nullable**. Member link: `requestedByMemberId` (`requested_by_member_id` `uuid NOT NULL`), indexed `broadcasts_tenant_status_member_idx (tenant_id, status, requested_by_member_id)`. Composite PK `(tenant_id, broadcast_id)`. **CHECK constraints:** `broadcasts_subject_length` (`length(subject) BETWEEN 1 AND 200`) + `broadcasts_body_html_size` (`octet_length(body_html) BETWEEN 1 AND 200*1024`) → tombstone with a **non-empty** sentinel `'[redacted]'`, never `''`. `body_source` has no length CHECK but is trigger-checked.
- **`broadcasts_immutable_after_submit_fn`** — current live body is migration **0075** (`drizzle/migrations/0075_alter_broadcasts_immutability_trigger.sql:17-43`); 0124 only re-applied `SET search_path`. When `OLD.status != 'draft'` it RAISEs `check_violation` if `subject`/`body_html`/`body_source`/`segment_type`/`segment_params`/`custom_recipient_emails`/`scheduled_for` change (with a `submitted→approved` `scheduled_for` escape). **Note `from_name`/`reply_to_email` are NOT checked** → already mutable post-submit → they need NO GUC whitelist (scrub them with a plain UPDATE). Trigger binding `broadcasts_immutable_after_submit` BEFORE UPDATE (`0064:198-201`). A `CREATE OR REPLACE` resets the function config → **must re-apply** `ALTER FUNCTION … SET search_path = pg_catalog, public` (0124 hardening).
- **`broadcast_deliveries` schema** — `schema.ts:366-419`. `recipientEmailLower` (`recipient_email_lower` `text NOT NULL`) = PII; `recipientMemberId` (`recipient_member_id` `uuid` **nullable**) = resolved member link; composite PK `(tenant_id, delivery_id)`; index `broadcast_deliveries_recipient_lookup_idx (tenant_id, recipient_email_lower)`. Append-only triggers `broadcast_deliveries_no_update` / `broadcast_deliveries_no_delete` (`drizzle/migrations/0065`) call `broadcast_deliveries_append_only_fn()` (unconditional RAISE — **no GUC arm**). The documented bypass (`0065:79-82`) is `ALTER TABLE … DISABLE/ENABLE TRIGGER`, used by an existing `setMemberIdNull` use-case — **find it (`grep setMemberIdNull src/modules/broadcasts`) and mirror its DISABLE/ENABLE structure exactly** (it already nulls `recipient_member_id`; US2b extends it to also tombstone `recipient_email_lower`, or adds a sibling that does both).
- **`broadcast_batch_delivery_events`** — `schema.ts:721-739`: `tenant_id`/`resend_event_id`/`batch_manifest_id`/`counter_field`/`recorded_at` only — **NO PII, NOT a target.**
- **The F7 cancel cascade to mirror** — port `src/modules/members/application/ports/broadcasts-cascade-port.ts`; adapter `src/modules/members/infrastructure/adapters/broadcasts-cascade-adapter.ts` (`f7BroadcastsCascadeAdapter`); use-case `src/modules/broadcasts/application/use-cases/cancel-in-flight-broadcasts-for-member.ts` + deps factory `makeCancelInFlightBroadcastsForMemberDeps` (`broadcasts-deps.ts:344-350`), both barrel-exported from `src/modules/broadcasts/index.ts`. The new `scrubBroadcastContentForMember` + `makeScrubBroadcastContentForMemberDeps` follow this exactly.
- **F7 audit** — the broadcasts `AuditPort`/`f7AuditAdapter` (`audit.emit(tx, {eventType, …})`). `broadcast_content_redacted` is a net-new F7 audit event → register in the **4 places** for the broadcasts taxonomy: the F7 audit-port event union (`src/modules/broadcasts/application/ports/audit-port.ts`), the shared drizzle `pgEnum('audit_event_type', …)` in auth schema, a migration `ALTER TYPE … ADD VALUE 'broadcast_content_redacted'`, and the broadcasts audit-event-type **parity** integration test (`tests/integration/broadcasts/audit-event-type-parity.test.ts`). (Follow the `add_audit_event_type` memory.)
- **eraseMember wiring** — `EraseMemberDeps` `:62-72`; the post-commit cascade section ends ~`:403`; new cascade blocks slot before `// 4. Completion proof` (~`:405`). The F7 content scrub is the named US2 slot in the header comment.
- **Run commands** — as US2a. Confirm the next free migration index with `ls drizzle/migrations/*.sql | tail -1`.

**File-structure map:**
- Create `drizzle/migrations/0XXX_broadcasts_redaction_guc.sql` — amend the trigger fn + re-apply search_path + add `broadcast_content_redacted` enum value.
- Modify `src/modules/auth/infrastructure/db/schema.ts` — add `'broadcast_content_redacted'` to the pgEnum.
- Modify `src/modules/broadcasts/application/ports/audit-port.ts` — add the event to the F7 union.
- Modify `tests/integration/broadcasts/audit-event-type-parity.test.ts` — include the new value.
- Modify `src/modules/broadcasts/infrastructure/.../broadcasts-repo.ts` — add `scrubContentForMemberInTx` + `tombstoneDeliveriesForMemberInTx`.
- Create `src/modules/broadcasts/application/use-cases/scrub-broadcast-content-for-member.ts`.
- Modify `src/modules/broadcasts/infrastructure/broadcasts-deps.ts` — add `makeScrubBroadcastContentForMemberDeps`.
- Modify `src/modules/broadcasts/index.ts` — barrel-export both.
- Create `src/modules/members/application/ports/broadcasts-content-scrub-port.ts` + `src/modules/members/infrastructure/adapters/broadcasts-content-scrub-adapter.ts`.
- Modify `erase-member.ts` + `members-deps.ts` — new dep + cascade block + wiring.
- Tests: a live-Neon broadcasts integration (GUC exemption + content scrub + delivery tombstone), an eraseMember e2e, the members unit cascade cases + deps guard.

---

## Task 1: Amend the immutability trigger with the `app.allow_broadcast_redaction` GUC + register `broadcast_content_redacted`

**Files:**
- Create: `drizzle/migrations/0XXX_broadcasts_redaction_guc.sql` (+ journal)
- Modify: `src/modules/auth/infrastructure/db/schema.ts`, `src/modules/broadcasts/application/ports/audit-port.ts`
- Test: `tests/integration/broadcasts/audit-event-type-parity.test.ts` + a new trigger-exemption integration test

- [ ] **Step 1: Write the failing trigger-exemption integration test (RED)**

Create `tests/integration/broadcasts/redaction-guc-trigger.test.ts` (reuse the broadcasts integration seed helpers). Seed a submitted (non-draft) broadcast, then:
```ts
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';

describe('broadcasts_immutable_after_submit_fn — app.allow_broadcast_redaction GUC', () => {
  it('RAISEs on a content UPDATE of a submitted broadcast WITHOUT the GUC', async () => {
    const { broadcastId } = await seedSubmittedBroadcast(ctx);
    await expect(
      runInTenant(ctx, (tx) => tx.execute(sql`
        UPDATE broadcasts SET subject = '[redacted]'
        WHERE tenant_id = ${ctx.slug} AND broadcast_id = ${broadcastId}
      `)),
    ).rejects.toThrow(/broadcast_immutable_after_submit/);
  });

  it('ALLOWS the content UPDATE under SET LOCAL app.allow_broadcast_redaction = on', async () => {
    const { broadcastId } = await seedSubmittedBroadcast(ctx);
    await runInTenant(ctx, async (tx) => {
      await tx.execute(sql`SET LOCAL app.allow_broadcast_redaction = 'on'`);
      await tx.execute(sql`
        UPDATE broadcasts
        SET subject = '[redacted]', body_html = '[redacted]', body_source = '[redacted]',
            custom_recipient_emails = NULL
        WHERE tenant_id = ${ctx.slug} AND broadcast_id = ${broadcastId}
      `);
    });
    const row = await rawSelectBroadcast(ctx, broadcastId);
    expect(row.subject).toBe('[redacted]');
  });

  it('still RAISEs under the GUC if a NON-PII column (segment_type) changes', async () => {
    const { broadcastId } = await seedSubmittedBroadcast(ctx);
    await expect(
      runInTenant(ctx, async (tx) => {
        await tx.execute(sql`SET LOCAL app.allow_broadcast_redaction = 'on'`);
        await tx.execute(sql`UPDATE broadcasts SET segment_type = 'tier' WHERE tenant_id = ${ctx.slug} AND broadcast_id = ${broadcastId}`);
      }),
    ).rejects.toThrow(/broadcast_redaction_only_pii_cols/);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (the GUC arm doesn't exist yet)**

Run: `pnpm vitest run -c vitest.integration.config.ts tests/integration/broadcasts/redaction-guc-trigger.test.ts`
Expected: the GUC-allowed case FAILs (still RAISEs `broadcast_immutable_after_submit`) — the exemption arm isn't in the function.

- [ ] **Step 3: Write the migration (amend the trigger fn + re-apply search_path + add the enum value)**

Create `drizzle/migrations/0XXX_broadcasts_redaction_guc.sql`. Base the body on the **0075** definition and ADD the GUC arm:
```sql
-- COMP-1 US2b — GDPR Art.17 broadcast content redaction.
-- (1) Amend the immutability trigger to exempt the PII content columns under a
--     new GUC, mirroring F4's app.allow_pii_redaction. Base = migration 0075.
CREATE OR REPLACE FUNCTION broadcasts_immutable_after_submit_fn()
RETURNS TRIGGER AS $$
DECLARE
  scheduled_for_changed boolean;
BEGIN
  IF OLD.status != 'draft' THEN
    -- GDPR Art.17 redaction exemption: when the erasure path sets
    -- `SET LOCAL app.allow_broadcast_redaction = 'on'`, the content/PII columns
    -- (subject/body_html/body_source/custom_recipient_emails) MAY change; every
    -- other immutable column still RAISEs. The `, true` arg returns NULL (not
    -- error) when the GUC was never set in this session.
    IF current_setting('app.allow_broadcast_redaction', true) = 'on' THEN
      IF NEW.segment_type   IS DISTINCT FROM OLD.segment_type
         OR NEW.segment_params IS DISTINCT FROM OLD.segment_params
         OR NEW.scheduled_for  IS DISTINCT FROM OLD.scheduled_for THEN
        RAISE EXCEPTION 'broadcast_redaction_only_pii_cols'
          USING ERRCODE = 'check_violation',
                HINT    = 'Under app.allow_broadcast_redaction only subject/body_html/body_source/custom_recipient_emails may change.';
      END IF;
      RETURN NEW;
    END IF;

    scheduled_for_changed := NEW.scheduled_for IS DISTINCT FROM OLD.scheduled_for;
    IF OLD.status = 'submitted' AND NEW.status = 'approved' THEN
      scheduled_for_changed := FALSE;
    END IF;
    IF NEW.subject IS DISTINCT FROM OLD.subject
       OR NEW.body_html IS DISTINCT FROM OLD.body_html
       OR NEW.body_source IS DISTINCT FROM OLD.body_source
       OR NEW.segment_type IS DISTINCT FROM OLD.segment_type
       OR NEW.segment_params IS DISTINCT FROM OLD.segment_params
       OR NEW.custom_recipient_emails IS DISTINCT FROM OLD.custom_recipient_emails
       OR scheduled_for_changed THEN
      RAISE EXCEPTION 'broadcast_immutable_after_submit'
        USING ERRCODE = 'check_violation',
              HINT    = 'Cancel and create a new draft to change content (FR-004 + Clarifications Q3).';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- (2) Re-apply the 0124 search_path hardening (CREATE OR REPLACE reset it).
ALTER FUNCTION broadcasts_immutable_after_submit_fn() SET search_path = pg_catalog, public;
--> statement-breakpoint
-- (3) New F7 audit event for the redaction action.
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_content_redacted';
```
Append the journal entry. **Before writing, diff against the TRUE current trigger body** (`git show` the latest migration that `CREATE OR REPLACE`s `broadcasts_immutable_after_submit_fn` — 0075 is the latest per US2 research, but re-confirm) so you don't drop a field added after 0075.

- [ ] **Step 4: Apply + re-run the trigger test — expect GREEN**

Run: `pnpm drizzle-kit migrate` then `pnpm vitest run -c vitest.integration.config.ts tests/integration/broadcasts/redaction-guc-trigger.test.ts`
Expected: all 3 cases pass (no-GUC RAISEs; GUC allows content; GUC + non-PII RAISEs `broadcast_redaction_only_pii_cols`).

- [ ] **Step 5: Register the F7 audit event in the remaining 3 places**

- `src/modules/auth/infrastructure/db/schema.ts` pgEnum — add `'broadcast_content_redacted'` (after the COMP-1 tail).
- `src/modules/broadcasts/application/ports/audit-port.ts` — add `'broadcast_content_redacted'` to the F7 event union (+ any exhaustiveness static-assert count).
- `tests/integration/broadcasts/audit-event-type-parity.test.ts` — add the value to the expected F7-prefixed set so the live enum↔union parity passes.

- [ ] **Step 6: Run the parity test + commit**

Run: `pnpm vitest run -c vitest.integration.config.ts tests/integration/broadcasts/audit-event-type-parity.test.ts` → green.
```bash
git add drizzle/migrations/0XXX_broadcasts_redaction_guc.sql drizzle/migrations/meta/_journal.json src/modules/auth/infrastructure/db/schema.ts src/modules/broadcasts/application/ports/audit-port.ts tests/integration/broadcasts/audit-event-type-parity.test.ts tests/integration/broadcasts/redaction-guc-trigger.test.ts
git commit -m "feat(broadcasts): app.allow_broadcast_redaction GUC trigger arm + broadcast_content_redacted audit (COMP-1 US2b)"
```

---

## Task 2: Repo methods — content scrub + delivery tombstone

**Files:**
- Modify: the broadcasts repo (`grep -l 'listInFlightOwnedByMember' src/modules/broadcasts/infrastructure` → the drizzle repo)
- Test: `tests/integration/broadcasts/scrub-content-for-member.test.ts` (create)

- [ ] **Step 1: Write the failing integration test (RED)**

Create `tests/integration/broadcasts/scrub-content-for-member.test.ts`. Seed a submitted broadcast originated by member M (with a distinctive `subject`/`body_html`) + a `broadcast_deliveries` row with `recipient_member_id = M` and `recipient_email_lower = 'recipient@example.com'`:
```ts
it('scrubContentForMemberInTx redacts content under the GUC', async () => {
  const { memberId, broadcastId } = await seedSubmittedBroadcastForMember(ctx, { subject: 'Volvo update' });
  await runInTenant(ctx, (tx) => repo.scrubContentForMemberInTx(tx, ctx.slug, memberId));
  const row = await rawSelectBroadcast(ctx, broadcastId);
  expect(row.subject).toBe('[redacted]');
  expect(row.body_html).toBe('[redacted]');
  expect(row.custom_recipient_emails).toBeNull();
});

it('tombstoneDeliveriesForMemberInTx nulls recipient member + email via trigger bypass', async () => {
  const { memberId, deliveryId } = await seedDeliveryForMember(ctx, { recipientEmail: 'recipient@example.com' });
  await runInTenant(ctx, (tx) => repo.tombstoneDeliveriesForMemberInTx(tx, ctx.slug, memberId));
  const d = await rawSelectDelivery(ctx, deliveryId);
  expect(d.recipient_member_id).toBeNull();
  expect(d.recipient_email_lower).not.toBe('recipient@example.com');
  expect(d.recipient_email_lower).toMatch(/^erased\+/);
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm vitest run -c vitest.integration.config.ts tests/integration/broadcasts/scrub-content-for-member.test.ts`
Expected: FAIL — methods don't exist.

- [ ] **Step 3: Implement `scrubContentForMemberInTx`**

In the broadcasts repo, add (set the GUC on the caller's `tx` first, then the UPDATE):
```ts
async scrubContentForMemberInTx(tx: TenantTx, tenantSlug: string, memberId: string): Promise<{ scrubbedCount: number }> {
  await tx.execute(sql`SET LOCAL app.allow_broadcast_redaction = 'on'`);
  const rows = await tx.execute(sql`
    UPDATE broadcasts
    SET subject = '[redacted]', body_html = '[redacted]', body_source = '[redacted]',
        from_name = '[redacted]', reply_to_email = '[redacted]', custom_recipient_emails = NULL
    WHERE tenant_id = ${tenantSlug}
      AND requested_by_member_id = ${memberId}
      AND status <> 'draft'             -- draft rows aren't trigger-locked; still scrub them
    RETURNING broadcast_id
  `) as unknown as Array<{ broadcast_id: string }>;
  return { scrubbedCount: rows.length };
}
```
Note: include draft rows too (a draft a member authored also holds their PII) — but draft rows don't need the GUC. The single UPDATE with `status <> 'draft'` misses drafts; either drop the `status <> 'draft'` filter (the GUC arm only matters for non-draft rows; the trigger early-returns for draft) OR run two UPDATEs. Simplest + correct: **drop the `status <> 'draft'` filter** — the trigger's `IF OLD.status != 'draft'` already no-ops for drafts, and the GUC being set is harmless for them. Use `WHERE tenant_id = $1 AND requested_by_member_id = $2`. Re-confirm against the trigger that a draft UPDATE under the GUC doesn't RAISE (it returns NEW immediately for draft).

- [ ] **Step 4: Implement `tombstoneDeliveriesForMemberInTx`**

**First read the existing `setMemberIdNull` use-case** (`grep -rl setMemberIdNull src/modules/broadcasts`) — it already does the `ALTER TABLE broadcast_deliveries DISABLE TRIGGER … ; UPDATE … ; ENABLE TRIGGER …` dance for `recipient_member_id`. Mirror its EXACT trigger names + disable/enable structure, extending the UPDATE to also tombstone the email:
```ts
async tombstoneDeliveriesForMemberInTx(tx: TenantTx, tenantSlug: string, memberId: string): Promise<{ tombstonedCount: number }> {
  // broadcast_deliveries is append-only via an UNCONDITIONAL trigger (no GUC arm).
  // The established bypass (mirrors setMemberIdNull) is DISABLE/ENABLE TRIGGER.
  await tx.execute(sql`ALTER TABLE broadcast_deliveries DISABLE TRIGGER broadcast_deliveries_no_update`);
  try {
    const rows = await tx.execute(sql`
      UPDATE broadcast_deliveries
      SET recipient_member_id = NULL,
          recipient_email_lower = 'erased+' || delivery_id || '@erased.invalid'
      WHERE tenant_id = ${tenantSlug} AND recipient_member_id = ${memberId}
      RETURNING delivery_id
    `) as unknown as Array<{ delivery_id: string }>;
    return { tombstonedCount: rows.length };
  } finally {
    await tx.execute(sql`ALTER TABLE broadcast_deliveries ENABLE TRIGGER broadcast_deliveries_no_update`);
  }
}
```
**Confirm the exact trigger name** from `setMemberIdNull` / migration 0065 (it may be `broadcast_deliveries_no_update` AND `_no_delete` — disable the UPDATE one; a UPDATE only trips the no_update trigger). The `finally` re-enables even on a failed UPDATE so the table doesn't stay un-protected. **Caveat:** `ALTER TABLE … DISABLE TRIGGER` takes an ACCESS EXCLUSIVE lock for the disable/enable window — keep the UPDATE tight + member-scoped (the index `broadcast_deliveries_recipient_lookup_idx` doesn't cover `recipient_member_id`; confirm there's an index supporting `WHERE recipient_member_id = $`, else the UPDATE scans — acceptable at SweCham scale but note it).

- [ ] **Step 5: Run — expect PASS; commit**

Run the integration test → green.
```bash
git add src/modules/broadcasts/infrastructure/*broadcasts-repo*.ts tests/integration/broadcasts/scrub-content-for-member.test.ts
git commit -m "feat(broadcasts): scrubContentForMemberInTx + tombstoneDeliveriesForMemberInTx (COMP-1 US2b)"
```

---

## Task 3: `scrubBroadcastContentForMember` use-case + deps factory + barrel

**Files:**
- Create: `src/modules/broadcasts/application/use-cases/scrub-broadcast-content-for-member.ts`
- Modify: `src/modules/broadcasts/infrastructure/broadcasts-deps.ts`, `src/modules/broadcasts/index.ts`
- Test: `tests/unit/broadcasts/application/scrub-broadcast-content-for-member.test.ts`

- [ ] **Step 1: Write the failing unit test (RED)** — mirror the cancel use-case's unit test. Assert: both repo methods called with `(tx, tenantSlug, memberId)`; one `broadcast_content_redacted` audit emitted with the counts; returns `ok({ scrubbedCount, tombstonedCount })`. (Stub the repo's `withTx` to invoke the callback with a fake tx, like the cancel test does.)

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement the use-case** — orchestrate both repo methods inside one `broadcastsRepo.withTx(tx => …)` (the cancel use-case uses `withTx`; reuse it), then emit `broadcast_content_redacted` via `audit.emit(tx, {eventType:'broadcast_content_redacted', summary:'broadcast_content_redacted member='+memberId, payload:{ member_id, scrubbed_count, tombstoned_count, reason }})`. Never-throws → typed `Result`. Deps `{ broadcastsRepo, audit, clock }` like the cancel deps.

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Add `makeScrubBroadcastContentForMemberDeps(tenantId)`** in `broadcasts-deps.ts` (mirror `makeCancelInFlightBroadcastsForMemberDeps`) + barrel-export both the use-case and the factory from `src/modules/broadcasts/index.ts`.

- [ ] **Step 6: True typecheck → 0; commit.**

```bash
git add src/modules/broadcasts/application/use-cases/scrub-broadcast-content-for-member.ts src/modules/broadcasts/infrastructure/broadcasts-deps.ts src/modules/broadcasts/index.ts tests/unit/broadcasts/application/scrub-broadcast-content-for-member.test.ts
git commit -m "feat(broadcasts): scrubBroadcastContentForMember use-case + barrel (COMP-1 US2b)"
```

---

## Task 4: `BroadcastsContentScrubPort` + adapter (members)

**Files:**
- Create: `src/modules/members/application/ports/broadcasts-content-scrub-port.ts`, `src/modules/members/infrastructure/adapters/broadcasts-content-scrub-adapter.ts`

- [ ] **Step 1: Define the port** — mirror `BroadcastsCascadePort`:
```ts
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '../../domain/member';

export interface BroadcastsContentScrubPort {
  scrubContentForMember(
    tenant: TenantContext,
    memberId: MemberId,
    meta: { readonly initiatedByUserId: string | null; readonly requestId: string | null },
  ): Promise<{ readonly outcome: 'ok' | 'failed'; readonly scrubbedCount?: number; readonly tombstonedCount?: number }>;
}
```

- [ ] **Step 2: Implement the adapter** (`broadcasts-content-scrub-adapter.ts`) — mirror `f7BroadcastsCascadeAdapter`: build deps via `makeScrubBroadcastContentForMemberDeps(tenant.slug)`, call `scrubBroadcastContentForMember(deps, { tenant, memberId, … })`, map `!ok → { outcome:'failed' }` (+ `logger.error`), else `{ outcome:'ok', scrubbedCount, tombstonedCount }`. Also export a `noopBroadcastsContentScrubAdapter` for tests.

- [ ] **Step 3: True typecheck → 0; commit.**

```bash
git add src/modules/members/application/ports/broadcasts-content-scrub-port.ts src/modules/members/infrastructure/adapters/broadcasts-content-scrub-adapter.ts
git commit -m "feat(members): BroadcastsContentScrubPort + adapter (COMP-1 US2b)"
```

---

## Task 5: Wire the F7 content cascade into `eraseMember`

**Files:**
- Modify: `src/modules/members/application/use-cases/erase-member.ts`, `src/modules/members/members-deps.ts`
- Test: `tests/unit/members/application/erase-member.test.ts`, `tests/unit/members/members-deps.test.ts`

- [ ] **Step 1: Add failing unit cases (RED)** — add `broadcastsContentScrub` to `buildEraseDeps` (returning `{ outcome:'ok' }`). Cases: (a) happy → port called with `(deps.tenant, 'm-1', …)` + `cascadesComplete:true`; (b) `{ outcome:'failed' }` → `cascadesComplete:false` + no `member_erased`.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Add the dep + cascade block** — add `broadcastsContentScrub: BroadcastsContentScrubPort` to `EraseMemberDeps`; add a `try/catch` block in the post-commit section (after the F1 user cascade if US2a landed, else after F8) that calls `deps.broadcastsContentScrub.scrubContentForMember(deps.tenant, memberId, { initiatedByUserId: meta.actorUserId, requestId: meta.requestId })`, flips `allCascadesClean = false` on `outcome !== 'ok'` or a throw (mirror the existing cascade blocks' logging).

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Wire `buildEraseMemberDeps`** (`broadcastsContentScrub: broadcastsContentScrubAdapter`) + add to the `members-deps.test.ts` guard key-set.

- [ ] **Step 6: True typecheck → 0; commit.**

```bash
git add src/modules/members/application/use-cases/erase-member.ts src/modules/members/members-deps.ts tests/unit/members/application/erase-member.test.ts tests/unit/members/application/erase-member.fixtures.ts tests/unit/members/members-deps.test.ts
git commit -m "feat(members): wire F7 content-scrub cascade into eraseMember (COMP-1 US2b)"
```

---

## Task 6: End-to-end live-Neon — no residual plaintext member email/content

**Files:**
- Test: `tests/integration/members/erase-member-f7-content.test.ts` (create)

- [ ] **Step 1: Write the e2e (RED→GREEN)** — seed a member with a submitted broadcast (distinctive subject) + a delivery (`recipient_member_id = member`, distinctive email). Run the production `eraseMember`. Assert via raw selects:
- the broadcast's `subject`/`body_html`/`body_source`/`from_name`/`reply_to_email` are all `'[redacted]'`, `custom_recipient_emails` NULL;
- the delivery's `recipient_member_id` NULL + `recipient_email_lower` matches `/^erased\+/` (the original email absent);
- **no residual plaintext member email** anywhere in `broadcasts` + `broadcast_deliveries` for this member (assert the seeded email string is absent from a dump of those rows);
- `broadcast_content_redacted` + `member_erased` audits present; `cascadesComplete: true`.

- [ ] **Step 2: Final gates** — unit (erase-member, broadcasts scrub) + integration (the new files + the cancel cascade still green) + lint + true typecheck.

- [ ] **Step 3: Commit.**

```bash
git add tests/integration/members/erase-member-f7-content.test.ts
git commit -m "test(members): eraseMember F7 content+deliveries tombstone e2e (COMP-1 US2b)"
```

---

## Self-Review

**Spec coverage (§5 F7 row, §10 "no residual plaintext member email" oracle):** trigger GUC arm → Task 1 ✓; content scrub (sentinel for the length-CHECK cols) + delivery tombstone (trigger DISABLE/ENABLE) → Task 2 ✓; `broadcast_batch_delivery_events` correctly NOT touched ✓; use-case + port + adapter mirror the cancel cascade → Tasks 3-4 ✓; wired as post-commit best-effort flipping `cascadesComplete` → Task 5 ✓; no-residual-email oracle + GUC-exemption test → Tasks 1, 6 ✓.

**Placeholders:** migration index `0XXX` resolved at Task 1; the delivery trigger name + the `setMemberIdNull` bypass structure are pointers to a real existing use-case to mirror (named, not vague); the draft-row handling decision is made explicit in Task 2 Step 3.

**Type consistency:** `scrubContentForMemberInTx(tx, tenantSlug, memberId)` / `tombstoneDeliveriesForMemberInTx(tx, tenantSlug, memberId)` consistent Task 2 ↔ Task 3. `BroadcastsContentScrubPort.scrubContentForMember(tenant, memberId, meta)` consistent Task 4 (def) ↔ Task 5 (call) ↔ fixture stub. `broadcast_content_redacted` spelled identically across the 4 registration places. `cascadesComplete` used in assertions.

**Scope boundary:** US2b is F7 content/deliveries only. F1 (US2a), F6 (US2c), reconciler (US2d) are separate. The cascade block ordering is independent of US2a (each cascade is self-contained); if US2a hasn't landed, slot the F7 block after F8.
