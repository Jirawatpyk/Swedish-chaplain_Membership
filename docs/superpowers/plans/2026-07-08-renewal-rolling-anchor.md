# Renewal Rolling-Anchor Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align F8 renewal cycles and F4 invoice coverage with TSCC's rolling 12-month membership policy: the first payment anchors the cycle, every payment path settles renewal state through one shared classifier, invoices stop printing calendar-year coverage.

**Architecture:** A pure Domain classifier (`classifyMembershipPayment`) is consumed at four sites — a new unlinked-invoice on-paid hook, `markCycleCompleteInTx`, `mark-paid-offline`, and the New-invoice form preview. Re-anchoring writes through a new guarded repo method (`reanchorPeriodInTx`) that also resets reminder-idempotency rows and re-freezes plan fields across fiscal-year boundaries. `F4InvoicePaidEvent` gains required `invoiceSubject` + `paymentDate` fields. All settlement writes run inside the F4 payment transaction (Principle VIII).

**Tech Stack:** TypeScript 5.7 strict · Next.js 16 · Drizzle/Neon Postgres · Vitest (+ live-Neon integration) · next-intl · zero new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-07-08-renewal-rolling-anchor-design.md` (rev 2). Read it before starting any task.

## Global Constraints

- Branch: `renewal-rolling-anchor` off `main`. Conventional Commits.
- Tenant-scoped queries inside `runInTenant`/caller `tx` ONLY — never the global `db` (silent RLS bypass).
- Audit rows commit in the SAME tx as the state change (Principle VIII).
- Migration = `drizzle/migrations/0238_*` (0237 is the latest). **Apply to dev Neon (`pnpm db:migrate`) + run the touched integration tests BEFORE committing the schema change.**
- New audit enum value = 4 touch-points: pgEnum (`src/modules/auth/infrastructure/db/schema.ts:45`), F8 port const (`src/modules/renewals/application/ports/renewal-audit-emitter.ts`), F8 adapter const (`src/modules/renewals/infrastructure/drizzle/drizzle-renewal-audit-emitter.ts`), and the two audit-count parity tests (`pnpm check:audit-counts` names them on failure) + `REQUIRED_ENUM_VALUES` in `scripts/lib/enum-migration-guard.ts` + its test fixtures.
- i18n: EN canonical + TH + SV, all keys added in the same commit (`pnpm check:i18n`).
- Money: satang `bigint` only; never float. Dates: ISO 8601 UTC storage; Buddhist Era display-only.
- Tax-document text is stored per line at draft time and NEVER mutated after issue.
- `pnpm typecheck` is the FINAL gate after the last edit of every task; run full `pnpm lint` before任何 review gate.
- E2E always `--workers=1`. Never kill/start the user's dev server on :3100.

## File Map (who owns what)

| File | Task | Responsibility |
|---|---|---|
| `drizzle/migrations/0238_renewal_rolling_anchor.sql` (create) | 1 | columns + audit enum value |
| `src/modules/renewals/domain/classify-membership-payment.ts` (create) | 2 | pure classifier |
| `src/modules/invoicing/domain/f4-invoice-paid-event.ts` (modify) | 3 | +invoiceSubject +paymentDate |
| `src/modules/renewals/application/ports/renewal-cycle-repo.ts` + drizzle repo (modify) | 4 | 3 new methods + domain fields |
| `src/modules/renewals/application/use-cases/resolve-unlinked-membership-payment.ts` (create) | 5 | the hook |
| `src/modules/renewals/application/use-cases/mark-cycle-complete-from-invoice-paid.ts` (modify) | 5+6 | hook wiring + linked-path classification |
| `src/modules/renewals/application/use-cases/mark-paid-offline.ts` (modify) | 7 | outcome union + re-anchor branch |
| `src/modules/invoicing/application/use-cases/create-invoice-draft.ts` (modify) | 8 | membershipCoverage |
| `src/app/(staff)/admin/invoices/_components/invoice-form.tsx` (modify) | 9 | context line + duplicate warning |
| `src/modules/renewals/application/use-cases/_lib/dispatch-one-cycle.ts` (modify) | 10 | skip-guard |
| `src/modules/renewals/infrastructure/drizzle/drizzle-member-renewal-flags-repo.ts` + `drizzle-at-risk-scorer.ts` (modify) | 10+11 | invoice reads |

---

### Task 1: Migration 0238 — anchor columns + `renewal_cycle_reanchored` audit event

**Files:**
- Create: `drizzle/migrations/0238_renewal_rolling_anchor.sql`
- Modify: `drizzle/migrations/meta/_journal.json` (append entry, idx after 0237's, `when` = prior + 100000)
- Modify: `src/modules/renewals/infrastructure/schema-renewal-cycles.ts` (2 columns)
- Modify: `src/modules/auth/infrastructure/db/schema.ts:45` pgEnum values (append `'renewal_cycle_reanchored'`)
- Modify: `src/modules/renewals/application/ports/renewal-audit-emitter.ts` (const tuple + payload shape)
- Modify: `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-audit-emitter.ts` (adapter const list)
- Modify: `scripts/lib/enum-migration-guard.ts` (`REQUIRED_ENUM_VALUES.audit_event_type` += `'renewal_cycle_reanchored'` + doc comment `+= (0238)`)
- Test: `tests/unit/scripts/enum-migration-guard.test.ts` (fixtures: present-maps gain the value; `typeExists:false` missing-list gains it; default-set assertion)
- Test: the two audit-count parity tests (`pnpm check:audit-counts` will name them; bump F8 catalogue count by 1)

**Interfaces:**
- Produces: columns `renewal_cycles.anchored_at timestamptz NULL`, `renewal_cycles.anchor_invoice_id uuid NULL`; audit type `'renewal_cycle_reanchored'` with payload `{cycle_id, member_id, invoice_id: string|null, old_period_from: string|null, old_period_to: string|null, new_period_from, new_period_to, old_status, refroze_plan_fields: boolean, reminder_events_reset: number}` (add to `F8AuditPayloadShapes`).

- [ ] **Step 1: Write the failing parity/guard tests** — bump the F8 audit-catalogue count in both parity tests, add `'renewal_cycle_reanchored'` to `REQUIRED_ENUM_VALUES` fixture expectations (mirror how `members_backup_exported` appears in `tests/unit/scripts/enum-migration-guard.test.ts:111,124,140,156`).
- [ ] **Step 2: Run to verify RED** — `pnpm vitest run tests/unit/scripts/enum-migration-guard.test.ts` + the parity tests. Expected: FAIL (value missing from tuple/map).
- [ ] **Step 3: Write the migration**

```sql
-- 0238 — renewal rolling-anchor (spec 2026-07-08 rev 2)
-- anchored_at: discriminator "this cycle has been anchored to a real payment"
--   (set by re-anchor AND by the R4 backfill script; NULL = provisional
--   registration_date anchor from onboarding).
-- anchor_invoice_id: forensic reference to the anchoring invoice (NULL for
--   backfilled pre-system payments). Deliberately NOT linked_invoice_id —
--   that column stays free for the renewal-invoice machinery (linkInvoice
--   I1 guard refuses overwrite).
ALTER TABLE "renewal_cycles" ADD COLUMN IF NOT EXISTS "anchored_at" timestamptz;--> statement-breakpoint
ALTER TABLE "renewal_cycles" ADD COLUMN IF NOT EXISTS "anchor_invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "renewal_cycles" ADD CONSTRAINT "renewal_cycles_anchor_invoice_fk"
  FOREIGN KEY ("tenant_id","anchor_invoice_id")
  REFERENCES "invoices"("tenant_id","invoice_id")
  ON DELETE SET NULL;--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_cycle_reanchored';--> statement-breakpoint
```

(Match the composite-FK column pair against migration 0087's existing `linked_invoice_fk` — if that FK references `invoices(invoice_id)` single-column, mirror THAT shape instead; copy exactly what 0087 does for `linked_invoice_id`.)

- [ ] **Step 4: Drizzle schema columns** — in `schema-renewal-cycles.ts` beside `linkedInvoiceId` (line 72):

```ts
    anchoredAt: timestamp('anchored_at', { withTimezone: true }),
    anchorInvoiceId: uuid('anchor_invoice_id'),
```

- [ ] **Step 5: Enum + const + payload plumbing** — append `'renewal_cycle_reanchored'` to the pgEnum array, the port const tuple (after `'renewal_completed_post_lapse'`, line ~93), the adapter const list, and add the payload interface to the port's payload-shapes map. Extend `REQUIRED_ENUM_VALUES`.
- [ ] **Step 6: Apply + verify GREEN** — `pnpm db:migrate` (dev Neon), then re-run Step-2 tests + `pnpm check:audit-counts`. Expected: PASS.
- [ ] **Step 7: typecheck + commit** — `pnpm typecheck` then commit `feat(renewals): migration 0238 — anchor columns + renewal_cycle_reanchored event`.

---

### Task 2: Pure Domain classifier

**Files:**
- Create: `src/modules/renewals/domain/classify-membership-payment.ts`
- Test: `tests/unit/renewals/classify-membership-payment.test.ts`
- Modify: `src/modules/renewals/index.ts` (barrel export — needed by Task 9's form preview)

**Interfaces:**
- Produces (verbatim — every later task uses these exact names):

```ts
export interface MembershipPaymentClassificationInput {
  /** ALL cycle rows the member has ever had, any status. */
  readonly cycleCountForMember: number;
  /** The member's open cycle (status upcoming|awaiting_payment), or null. */
  readonly openCycle: {
    readonly status: 'upcoming' | 'awaiting_payment';
    readonly anchoredAt: string | null;
  } | null;
  readonly memberErased: boolean;
}

export type MembershipPaymentClassification =
  | { readonly kind: 'first_payment' }
  | { readonly kind: 'renewal' }
  | { readonly kind: 'heal_no_cycle' }
  | { readonly kind: 'not_applicable'; readonly reason: 'erased' | 'terminal_only' };

export function classifyMembershipPayment(
  input: MembershipPaymentClassificationInput,
): MembershipPaymentClassification;
```

- [ ] **Step 1: Failing tests** — table-driven over the spec's classification table:

```ts
import { describe, expect, it } from 'vitest';
import { classifyMembershipPayment } from '@/modules/renewals/domain/classify-membership-payment';

const open = (status: 'upcoming' | 'awaiting_payment', anchoredAt: string | null) =>
  ({ status, anchoredAt });

describe('classifyMembershipPayment', () => {
  it('erased member → not_applicable(erased) regardless of cycles', () => {
    expect(
      classifyMembershipPayment({ cycleCountForMember: 1, openCycle: open('upcoming', null), memberErased: true }),
    ).toEqual({ kind: 'not_applicable', reason: 'erased' });
  });
  it('zero cycles ever → heal_no_cycle', () => {
    expect(
      classifyMembershipPayment({ cycleCountForMember: 0, openCycle: null, memberErased: false }),
    ).toEqual({ kind: 'heal_no_cycle' });
  });
  it('only cycle ever, upcoming, unanchored → first_payment', () => {
    expect(
      classifyMembershipPayment({ cycleCountForMember: 1, openCycle: open('upcoming', null), memberErased: false }),
    ).toEqual({ kind: 'first_payment' });
  });
  it('only cycle ever, awaiting_payment (post-T-0 provisional), unanchored → first_payment', () => {
    expect(
      classifyMembershipPayment({ cycleCountForMember: 1, openCycle: open('awaiting_payment', null), memberErased: false }),
    ).toEqual({ kind: 'first_payment' });
  });
  it('open cycle already anchored → renewal', () => {
    expect(
      classifyMembershipPayment({ cycleCountForMember: 1, openCycle: open('upcoming', '2026-07-08T00:00:00Z'), memberErased: false }),
    ).toEqual({ kind: 'renewal' });
  });
  it('open cycle + predecessor cycles → renewal even when unanchored', () => {
    expect(
      classifyMembershipPayment({ cycleCountForMember: 3, openCycle: open('awaiting_payment', null), memberErased: false }),
    ).toEqual({ kind: 'renewal' });
  });
  it('cycles exist but none open (terminal only) → not_applicable(terminal_only)', () => {
    expect(
      classifyMembershipPayment({ cycleCountForMember: 2, openCycle: null, memberErased: false }),
    ).toEqual({ kind: 'not_applicable', reason: 'terminal_only' });
  });
});
```

- [ ] **Step 2: RED** — `pnpm vitest run tests/unit/renewals/classify-membership-payment.test.ts` → module not found.
- [ ] **Step 3: Implement** (pure — no imports beyond types; Domain 100% line coverage applies):

```ts
/**
 * Rolling-anchor payment classification (spec 2026-07-08 rev 2 §1).
 * ONE source of truth consumed by: the unlinked-invoice on-paid hook,
 * markCycleCompleteInTx, mark-paid-offline, and the New-invoice form
 * preview. `'reminded'` is a declared-but-never-written status (no writer
 * in src/) — callers loading the open cycle treat it as 'upcoming'.
 */
export function classifyMembershipPayment(
  input: MembershipPaymentClassificationInput,
): MembershipPaymentClassification {
  if (input.memberErased) return { kind: 'not_applicable', reason: 'erased' };
  if (input.cycleCountForMember === 0) return { kind: 'heal_no_cycle' };
  if (input.openCycle === null) return { kind: 'not_applicable', reason: 'terminal_only' };
  if (input.cycleCountForMember === 1 && input.openCycle.anchoredAt === null) {
    return { kind: 'first_payment' };
  }
  return { kind: 'renewal' };
}
```

- [ ] **Step 4: GREEN + barrel export + typecheck + commit** `feat(renewals): classifyMembershipPayment domain rule`.

---

### Task 3: `F4InvoicePaidEvent` — required `invoiceSubject` + `paymentDate`

**Files:**
- Modify: `src/modules/invoicing/domain/f4-invoice-paid-event.ts`
- Modify: `src/modules/invoicing/application/use-cases/record-payment.ts:1075` (evt literal)
- Modify: `src/modules/invoicing/application/use-cases/issue-event-invoice-as-paid.ts:760` (evt literal)
- Test: extend the existing record-payment contract/unit suites that assert the event shape (grep `F4InvoicePaidEvent` under `tests/`); add cases for both new fields.

**Interfaces:**
- Produces on the event (verbatim):

```ts
  /** Invoice subject partition — F8's hook acts ONLY on 'membership'. REQUIRED so the compiler forces every emit site. */
  readonly invoiceSubject: 'membership' | 'event';
  /**
   * Admin-entered actual payment date (YYYY-MM-DD, Bangkok business date)
   * when the rail carries one (record-payment / mark-paid-offline);
   * null on rails where only paidAt exists (Stripe webhook). Rolling-anchor
   * consumers prefer this over paidAt (recording lag on bank transfers).
   */
  readonly paymentDate: string | null;
```

- [ ] **Step 1: Failing test** — extend the record-payment test that builds/asserts the emitted event: expect `invoiceSubject: 'membership'` and `paymentDate` equal to the input's payment date; expect the event-invoice path to emit `invoiceSubject: 'event'`, `paymentDate: null`.
- [ ] **Step 2: RED** — typecheck fails first (missing required fields) — that IS the point.
- [ ] **Step 3: Implement** — add both fields to the interface; at `record-payment.ts:1075` add:

```ts
        invoiceSubject: loaded.invoiceSubject,
        paymentDate: input.paymentDate ?? null,
```

(the Invoice DU carries `invoiceSubject: 'membership' | 'event'`; `input.paymentDate` already exists on the record-payment input schema — verify and, if optional-undefined, coalesce to null). At `issue-event-invoice-as-paid.ts:760` add:

```ts
          invoiceSubject: 'event' as const,
          // Event fees never drive membership anchoring; the hook skips
          // subject='event' before ever reading this field.
          paymentDate: null,
```

- [ ] **Step 4: GREEN + typecheck (must be clean — the compiler proves both emit sites) + commit** `feat(invoicing): F4InvoicePaidEvent carries invoiceSubject + paymentDate`.

---

### Task 4: Repo surface — `countCyclesForMemberInTx` / `findOpenCycleForMemberInTx` / `reanchorPeriodInTx` + domain fields

**Files:**
- Modify: `src/modules/renewals/domain/renewal-cycle.ts` — add to `RenewalCycleBase` (line ~120, beside `linkedCreditNoteId`):

```ts
  /** Rolling-anchor discriminator — non-null once a real payment (or the R4 backfill) anchored this cycle. */
  readonly anchoredAt: string | null;
  /** Forensic reference to the anchoring invoice; null for backfilled pre-system payments. */
  readonly anchorInvoiceId: string | null;
```

- Modify: `src/modules/renewals/application/ports/renewal-cycle-repo.ts` — 3 method signatures (below)
- Modify: `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts` — implementations + `rowToDomain` mapping for the 2 new columns
- Test: `tests/integration/renewals/reanchor-period.test.ts` (live Neon)

**Interfaces:**
- Produces (port, verbatim):

```ts
  /** ALL cycle rows for the member, any status. In-tx (classification must see uncommitted writes). */
  countCyclesForMemberInTx(tx: unknown, tenantId: string, memberId: string): Promise<number>;

  /** The member's open cycle (status IN upcoming|reminded|awaiting_payment), or null. At most one by invariant; 'reminded' folded into the open set defensively (vestigial status). */
  findOpenCycleForMemberInTx(tx: unknown, tenantId: string, memberId: string): Promise<RenewalCycle | null>;

  /**
   * Rolling first-payment re-anchor (spec rev 2 §2). Guarded single UPDATE:
   * only an un-anchored open cycle qualifies; status resets to 'upcoming'
   * (sanctioned TRANSITIONS bypass — documented at the SQL); linked_invoice_id
   * cleared so the future renewal links cleanly; frozen fields replaced when
   * the caller re-resolved them (pass current values otherwise). Deletes the
   * cycle's renewal_reminder_events rows in the same tx and returns their
   * count. Returns null when the guard matched 0 rows (race — caller re-reads
   * and reclassifies).
   */
  reanchorPeriodInTx(
    tx: unknown,
    tenantId: string,
    cycleId: CycleId,
    args: {
      readonly periodFrom: string;
      readonly periodTo: string;
      readonly anchoredAt: string;
      readonly anchorInvoiceId: string | null;
      readonly frozenPlanPriceThb: ThbDecimal;
      readonly frozenPlanTermMonths: number;
    },
  ): Promise<{ readonly cycle: RenewalCycle; readonly reminderEventsReset: number } | null>;
```

- [ ] **Step 1: Failing integration test** (live Neon; follow the seeding helpers used by `tests/integration/renewals/self-service-renewal-tx.test.ts` — tenant seed + member + `createCycleInTx`): assert (a) re-anchor of a fresh `upcoming` cycle moves period_from/to, stamps anchored_at + anchor_invoice_id, resets status to `upcoming`, syncs `expires_at` (trigger), returns reminderEventsReset=0; (b) re-anchor of an `awaiting_payment` unanchored cycle succeeds + status back to `upcoming`; (c) second re-anchor attempt returns null (anchored_at guard); (d) seeded `renewal_reminder_events` row for the cycle is deleted and counted; (e) cross-tenant probe: tenant B cannot re-anchor tenant A's cycle (RLS → null).
- [ ] **Step 2: RED** — `pnpm test:integration -- tests/integration/renewals/reanchor-period.test.ts`.
- [ ] **Step 3: Implement** — `rowToDomain` gains `anchoredAt: toIso(row.anchoredAt)`, `anchorInvoiceId: row.anchorInvoiceId ?? null` (mirror existing null handling at `drizzle-renewal-cycle-repo.ts:119`). Count + open-cycle reads are 5-line Drizzle selects (`WHERE member_id`, status filter `inArray(status, ['upcoming','reminded','awaiting_payment'])` for the open read). Re-anchor implementation:

```ts
    async reanchorPeriodInTx(tx, _tenantId, cycleId, args) {
      const txDb = tx as typeof db;
      const updated = await txDb
        .update(renewalCycles)
        .set({
          periodFrom: new Date(args.periodFrom),
          periodTo: new Date(args.periodTo),
          status: 'upcoming', // sanctioned TRANSITIONS bypass — spec rev 2 §2
          anchoredAt: new Date(args.anchoredAt),
          anchorInvoiceId: args.anchorInvoiceId,
          linkedInvoiceId: null,
          frozenPlanPriceThb: args.frozenPlanPriceThb,
          frozenPlanTermMonths: args.frozenPlanTermMonths,
        })
        .where(
          and(
            eq(renewalCycles.cycleId, cycleId),
            inArray(renewalCycles.status, ['upcoming', 'reminded', 'awaiting_payment']),
            isNull(renewalCycles.anchoredAt),
          ),
        )
        .returning();
      const row = updated[0];
      if (!row) return null;
      const deleted = await txDb
        .delete(renewalReminderEvents)
        .where(eq(renewalReminderEvents.cycleId, cycleId))
        .returning({ id: renewalReminderEvents.reminderEventId });
      return { cycle: rowToDomain(row), reminderEventsReset: deleted.length };
    },
```

(Adjust column identifiers to the actual `schema-renewal-reminder-events.ts` names; the timestamp `.set` values must match how `insert` writes them in this repo — copy its Date/string convention.)

- [ ] **Step 4: GREEN (integration) + typecheck + commit** `feat(renewals): reanchorPeriodInTx + open-cycle/count reads + anchor fields`.

---

### Task 5: The hook — `resolveUnlinkedMembershipPayment` + wiring + degraded-mode refusal

**Files:**
- Create: `src/modules/renewals/application/use-cases/resolve-unlinked-membership-payment.ts`
- Create: `src/modules/renewals/application/use-cases/_lib/payment-anchor-date.ts` (Bangkok date helper)
- Modify: `src/modules/renewals/application/use-cases/mark-cycle-complete-from-invoice-paid.ts` — the `if (!cycle)` branch (line 128) calls the hook instead of returning immediately; `MarkCycleCompleteDeps` widens to include `planLookupForRenewal`, `cycleIdFactory`, `memberRenewalFlagsRepo` (already there), `clock`
- Modify: `src/modules/renewals/infrastructure/renewals-deps.ts` — degraded-mode (non-TenantTx) path must SKIP the hook (existing wrapper already dispatches InTx vs wrapper; the wrapper variant passes a flag `allowUnlinkedResolution: false`)
- Modify: `src/lib/metrics.ts` `renewalsMetrics` — add outcome counter `unlinkedPaymentResolved(outcome: 'reanchored'|'renewed'|'healed'|'skipped')` (mirror the existing `remindersSkipped` counter shape)
- Test: `tests/unit/renewals/resolve-unlinked-membership-payment.test.ts` + `tests/integration/renewals/rolling-anchor-payment.test.ts`

**Interfaces:**
- Consumes: Task 2 classifier, Task 3 event fields, Task 4 repo methods, existing `createCycleInTx`, `markCycleCompleteInTx` completion internals (`autoComplete`), `readReactivationGuardsInTx`, `deriveFiscalYear`, `addMonthsUtc`, `loadPlanFrozenFields`.
- Produces: `resolveUnlinkedMembershipPaymentInTx(deps, evt, tx): Promise<UnlinkedResolutionOutcome>` where

```ts
export type UnlinkedResolutionOutcome =
  | { readonly kind: 'reanchored'; readonly cycleId: string }
  | { readonly kind: 'renewed'; readonly cycleId: string }
  | { readonly kind: 'healed'; readonly cycleId: string }
  | { readonly kind: 'skipped'; readonly reason: 'event_invoice' | 'erased' | 'terminal_only' | 'race_lost' };
```

**Behaviour (write tests first for each):**

1. `evt.invoiceSubject !== 'membership'` → `skipped:event_invoice`, no reads.
2. Erased member (`readReactivationGuardsInTx().erased`) → `skipped:erased` + info log.
3. `heal_no_cycle` → `createCycleInTx` with `periodFrom = anchorDate(evt)`, then `reanchorPeriodInTx` is NOT needed — instead stamp anchor by passing `startStatus: 'upcoming'` and immediately updating `anchored_at`/`anchor_invoice_id` via `reanchorPeriodInTx` on the fresh cycle (guard passes: unanchored+upcoming) — one code path for stamping. Emit `renewal_cycle_reanchored` with `old_period_* : null`.
4. `first_payment` → resolve anchor date; re-freeze plan fields if `deriveFiscalYear(newFrom) !== deriveFiscalYear(cycle.periodFrom)` via `loadPlanFrozenFields({planId: cycle.planIdAtCycleStart, fiscalYear: newFY, mode:'freeze'})` — unresolvable → keep old fields + `logger.error` + `refroze_plan_fields:false`; call `reanchorPeriodInTx`; null → re-read via `findOpenCycleForMemberInTx` and reclassify once (renewal fall-through) else `skipped:race_lost`; emit audit with old/new periods + `reminder_events_reset`.
5. `renewal` → transition open cycle → `completed` (`closedReason:'paid'`, `linkedInvoiceId: evt.invoiceId` — `transitionStatus` overwrites the link, verified by review) + `createNextCycleOnPaidInTx`-style next cycle: call `createCycleInTx` with `periodFrom: cycle.periodTo, planId: cycle.planIdAtCycleStart` (copy the exact call from `create-next-cycle-on-paid.ts:70-78`). If the cycle was linked to a DIFFERENT invoice: `logger.error` "orphaned dispatched invoice — staff must void" with both ids. Emit `renewal_completed` (existing payload shape, same as `autoComplete` at `mark-cycle-complete-from-invoice-paid.ts:261-280`).
6. Anchor date helper (`payment-anchor-date.ts`):

```ts
/** Rolling anchor = FIRST DAY of the payment month, Bangkok time (spec rev 3 —
 *  verified against TSCC's records: paid 2026-03-16 → period 2026-03-01;
 *  TSCC operates month-boundary periods). Prefer the admin-entered paymentDate
 *  (Bangkok-local YYYY-MM-DD); fall back to paidAt converted to the
 *  Asia/Bangkok calendar date (UTC+7 fixed offset, no DST). */
export function paymentAnchorMonthStartUtc(evt: {
  readonly paymentDate: string | null;
  readonly paidAt: string;
}): string {
  let y: number;
  let m: string;
  if (evt.paymentDate !== null) {
    y = Number(evt.paymentDate.slice(0, 4));
    m = evt.paymentDate.slice(5, 7);
  } else {
    const bkk = new Date(Date.parse(evt.paidAt) + 7 * 3600_000);
    y = bkk.getUTCFullYear();
    m = String(bkk.getUTCMonth() + 1).padStart(2, '0');
  }
  return `${y}-${m}-01T00:00:00.000Z`;
}
```

Unit-test: paymentDate mid-month → 1st of same month; paidAt `2026-03-31T23:30:00Z`
(= Bangkok 1 Apr 06:30) → `2026-04-01` — the UTC-vs-Bangkok month-boundary case;
paymentDate precedence over paidAt.

7. Wiring: in `markCycleCompleteInTx`'s `!cycle` branch, call the hook and map outcomes to the existing `MarkCycleCompleteOutcome` (`no_cycle_for_invoice` stays the return kind for skipped; add outcome pass-through fields to the log). Degraded (wrapper) path: the wrapper variant passes `allowUnlinkedResolution: false` → branch returns the old plain no-op + `logger.error` + `renewalsMetrics.unlinkedPaymentResolved('skipped')`.
8. Callback interplay tests: after `first_payment`/`heal`, a subsequent `createNextCycleOnPaidInTx(evt)` in the same tx finds the ACTIVE cycle → no next cycle (assert count unchanged); after `renewal`, it finds the invoice→completed cycle and `createCycleInTx` idempotency no-ops (assert exactly one next cycle).

- [ ] **Step 1–2: failing unit tests (all behaviours above, mock repos) → RED**
- [ ] **Step 3: implement use-case + helper + wiring**
- [ ] **Step 4: GREEN unit; then integration test** `rolling-anchor-payment.test.ts` (live Neon): pay unlinked first invoice via `recordPayment` with F8 callbacks registered → cycle re-anchored to paymentDate + audit row exists; pay second unlinked invoice → cycle completed + next cycle at periodTo; re-fire same event → no-op; zero-cycle member → healed; cross-tenant probe.
- [ ] **Step 5: typecheck + commit** `feat(renewals): rolling-anchor resolution hook for unlinked membership payments`.

---

### Task 6: Linked path — `markCycleCompleteInTx` first-payment classification

**Files:**
- Modify: `src/modules/renewals/application/use-cases/mark-cycle-complete-from-invoice-paid.ts` — after resolving `cycle` (line 123-134) and BEFORE the `status !== 'awaiting_payment'` guard: classify; on `first_payment` (this covers confirm-renewal's pre-linked invoice), call `reanchorPeriodInTx` with `anchorInvoiceId: evt.invoiceId` (the guard tolerates the existing `linked_invoice_id = evt.invoiceId` row because re-anchor clears it), emit `renewal_cycle_reanchored`, return a new outcome `{ kind: 'reanchored', cycleId, memberId }` (extend `MarkCycleCompleteOutcome` union).
- Test: extend `tests/unit/renewals/mark-cycle-complete-from-invoice-paid.test.ts` (existing suite — grep it): linked invoice + only-cycle-unanchored member → reanchored, NOT completed; linked invoice + anchored cycle → existing completed behaviour unchanged.

Wait — Task 4's guard is `isNull(anchoredAt)` + status filter; the confirm-renewal cycle at payment time is `awaiting_payment` + linked to THIS invoice: the re-anchor UPDATE clears `linked_invoice_id` and moves the invoice id to `anchor_invoice_id` — pass `anchorInvoiceId: evt.invoiceId`. **Note for implementer:** `reanchorPeriodInTx`'s WHERE does not condition on `linked_invoice_id`, so this works without changes; assert in the test that after re-anchor `linkedInvoiceId === null` and `anchorInvoiceId === evt.invoiceId`.

- [ ] **Step 1–2: failing unit tests → RED**
- [ ] **Step 3: implement (classification call + branch + union extension; update `f8OnPaidCallbacks` outcome logging switch if it narrows on kinds)**
- [ ] **Step 4: GREEN + integration case in `rolling-anchor-payment.test.ts`: full confirm-renewal flow for a never-paid member → cycle re-anchored to payment date, then a LATER confirm-renewal (renewal season) links + completes cleanly — the C1 regression.**
- [ ] **Step 5: typecheck + commit** `feat(renewals): linked-path first-payment re-anchor (confirm-renewal correctness)`.

---

### Task 7: `mark-paid-offline` — outcome union + re-anchor branch

**Files:**
- Modify: `src/modules/renewals/application/use-cases/mark-paid-offline.ts`:
  - `MarkPaidOfflineOutput` → `{ readonly outcome: 'completed' | 'reanchored'; readonly cycleStatus: 'completed' | 'upcoming'; readonly invoiceId: string; readonly newExpiresAt: string }`
  - Before the F4 chain: classify (count + open-cycle reads on a short `runInTenant` read, then re-verify under the in-tx lock as the existing code does for status). On `first_payment`: the `onPaid` closure re-anchors (Task 4 method) instead of `transitionStatus→completed`; `newExpiresAt = addMonthsUtc(anchorDate, frozenPlanTermMonths)`; audit `renewal_cycle_reanchored` (NOT `renewal_cycle_completed_offline`); `createNextCycleOnPaidInTx` still runs afterwards and must no-op (active cycle) — assert in test.
- Modify: the route/component consuming the output (grep `markPaidOffline(` under `src/app` — the renewals cycle-detail action) — toast copy per branch; i18n keys `admin.renewals.markPaidOffline.successReanchored` (EN: "Payment recorded — membership period now starts {date}."; TH: "บันทึกการชำระแล้ว — รอบสมาชิกเริ่มนับ {date}"; SV: "Betalning registrerad — medlemsperioden börjar {date}.") in all 3 locale files.
- Test: extend the existing mark-paid-offline unit + integration suites: first-payment cycle → `outcome:'reanchored'`, status stays `upcoming`, correct audit event, exactly zero next cycles created; anchored/predecessor cycle → `outcome:'completed'` byte-identical to today.

- [ ] Steps: failing tests → RED → implement → GREEN → `pnpm check:i18n` → typecheck → commit `feat(renewals): mark-paid-offline re-anchor branch + outcome union`.

---

### Task 8: `createInvoiceDraft` — `membershipCoverage` line text

**Files:**
- Modify: `src/modules/invoicing/application/use-cases/create-invoice-draft.ts`:
  - Schema (after `renewalSignal`, line 65-67):

```ts
  /** Rolling-anchor coverage wording (spec 2026-07-08 rev 2 §3). Default
   *  'from_payment' — the FY-boundary text is wrong under rolling policy. */
  membershipCoverage: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('window'), fromIso: z.string().regex(/^\d{4}-\d{2}-\d{2}/), toIso: z.string().regex(/^\d{4}-\d{2}-\d{2}/) }),
      z.object({ kind: z.literal('from_payment') }),
    ])
    .optional(),
```

  - Replace the description block (lines 256-281): delete the `fiscalYearBoundaryForYear` coverage call + the `ปี {planYear}` token; build:

```ts
    const coverage = input.membershipCoverage ?? { kind: 'from_payment' as const };
    const windowText =
      coverage.kind === 'window'
        ? { th: `(ระยะเวลา ${coverage.fromIso.slice(0, 10)} ถึง ${coverage.toIso.slice(0, 10)})`,
            en: `(coverage ${coverage.fromIso.slice(0, 10)} to ${coverage.toIso.slice(0, 10)})` }
        : { th: '(12 เดือน เริ่มตั้งแต่เดือนที่ชำระค่าธรรมเนียม)',
            en: '(12 months, effective from the month of payment)' };
    const membershipDescTh =
      `ค่าสมาชิก ${planLabelTh}${windowText.th}` +
      (proRateFactor === '1.0000' ? '' : ` (pro-rate ${proRateFactor}, ตั้งแต่ ${proRateAnchor})`);
    const membershipDescEn =
      `Membership ${planLabelEn}${windowText.en}` +
      (proRateFactor === '1.0000' ? '' : ` (pro-rated ${proRateFactor}, from ${proRateAnchor})`);
```

  (`fiscalYearBoundaryForYear` stays — the pro-rate math above it still uses fyStart/fyEnd.)
- Modify callers to pass `window`:
  - `src/modules/renewals/infrastructure/ports-adapters/f4-invoice-bridge.ts:134` (`issueAndMarkPaid` — has the cycle via its input; add `coverageFromIso/coverageToIso` to `IssueAndMarkPaidInput`, supplied by `mark-paid-offline` from the locked cycle: **renewal-classified → `periodTo → addMonthsUtc(periodTo, frozenPlanTermMonths)`; first-payment-classified → omit (from_payment text)**)
  - the confirm-renewal invoicing bridge (`f4-invoicing-for-renewal-bridge-drizzle.ts` — same pattern)
- Test: unit tests on the two text kinds (TH+EN, assert NO `ปี {planYear}` token, assert stored verbatim on the line); existing draft tests updated for the new default text.

- [ ] Steps: failing tests → RED → implement → GREEN → typecheck → commit `feat(invoicing): membershipCoverage rolling-window line text (drops FY-boundary coverage)`.

---

### Task 9: New-invoice form — renewal context line + duplicate warning

**Files:**
- Modify: `src/app/(staff)/admin/invoices/_components/invoice-form.tsx` (and its server wrapper/page that fetches form data — follow the existing data flow: if the form receives server-fetched props, extend that fetch; if it fetches client-side, add fields to the response of the member-selection endpoint it already calls)
- Create: `src/app/(staff)/admin/invoices/_lib/member-renewal-context.ts` — server-side read: given memberId, `runInTenant` → `countCyclesForMemberInTx` + `findOpenCycleForMemberInTx` + member erased flag → run `classifyMembershipPayment` + return `{ classification, periodTo, termMonths, hasUnpaidMembershipInvoice }` (unpaid check: existing invoice list read filtered `status='issued' AND invoice_subject='membership' AND member_id=?` — reuse the invoicing barrel's list use-case, presentation orchestrating both barrels)
- Modify: `src/i18n/messages/{en,th,sv}.json` — keys under `admin.invoices.form.renewalContext.*`:
  - `renewal`: EN "Current period ends {periodTo} — paying this bill renews the membership ({from} to {to})." TH "รอบปัจจุบันถึง {periodTo} — จ่ายบิลนี้ = ต่ออายุ (รอบใหม่ {from} ถึง {to})" SV "Nuvarande period slutar {periodTo} — betalning av denna faktura förnyar medlemskapet ({from} till {to})."
  - `firstPayment`: EN "Membership period has not started — paying this bill starts the 12-month period from the payment date." TH "ยังไม่เริ่มรอบสมาชิกภาพ — จ่ายบิลนี้ = เริ่มนับ 12 เดือนจากวันชำระ" SV "Medlemsperioden har inte börjat — betalning startar 12-månadersperioden från betalningsdatumet."
  - `notApplicable`: EN "No active membership period — this bill will not affect renewals (use the reactivation flow for lapsed members)." TH "ไม่มีรอบสมาชิกที่ดำเนินอยู่ — บิลนี้จะไม่กระทบระบบต่ออายุ (ใช้ flow reactivate สำหรับสมาชิกที่พ้นสภาพ)" SV "Ingen aktiv medlemsperiod — denna faktura påverkar inte förnyelser (använd återaktiveringsflödet för utgångna medlemmar)."
  - `duplicateWarning`: EN "This member already has an unpaid membership invoice, or their current period runs {periodTo} — another paid bill buys a further year." TH "สมาชิกรายนี้มีบิลค่าสมาชิกค้างชำระอยู่แล้ว หรือรอบปัจจุบันถึง {periodTo} — บิลอีกใบที่จ่ายจะเป็นการซื้อเพิ่มอีก 1 ปี" SV "Medlemmen har redan en obetald medlemsfaktura, eller så löper nuvarande period till {periodTo} — ytterligare en betald faktura köper ett år till."
- UI: context line = muted text with `Info` lucide icon under the member/plan fields; warning = existing amber alert pattern (grep an existing non-destructive `Alert` usage in the admin invoices components and match it); icon + text, never colour-alone; ≥24px targets untouched.
- Warning condition: `hasUnpaidMembershipInvoice || (classification.kind==='renewal' && periodTo more than 6 months from today)`.
- Test: `tests/unit/components/invoice-form-renewal-context.test.tsx` — render with each classification prop → correct i18n string (use real `en.json` per the zod-i18n render-test convention); warning shows/hides per condition.

- [ ] Steps: failing component tests → RED → implement (server read + prop threading + UI) → GREEN → `pnpm check:i18n` → typecheck → commit `feat(invoices): renewal-context line + duplicate-billing warning on New invoice form`.

---

### Task 10: Dispatcher skip-guard `unreconciled_paid_membership_invoice`

**Files:**
- Modify: `src/modules/renewals/application/use-cases/_lib/dispatch-one-cycle.ts` — `SKIP_REASONS` += `'unreconciled_paid_membership_invoice'` (13 → 14; update the `_AssertSkipReasonCount` literal at line 101); add the gate AFTER the member/cycle gates and BEFORE `not_due_today` (each gate short-circuits — copy an adjacent gate's shape, e.g. the `member_opted_out` block): when the flag read returns true → `emitSkipAudit(..., 'unreconciled_paid_membership_invoice')` + `logger.error` (staff must reconcile) + return skipped.
- Modify: `src/modules/renewals/application/ports/member-renewal-flags-repo.ts` + `src/modules/renewals/infrastructure/drizzle/drizzle-member-renewal-flags-repo.ts` — new method:

```ts
  /** TRUE when the member has a paid membership invoice from the last 12
   *  months that is neither any cycle's linked_invoice_id nor any cycle's
   *  anchor_invoice_id — an unreconciled out-of-band payment (deploy→backfill
   *  gap safety net; spec rev 2 §4). */
  hasUnreconciledPaidMembershipInvoice(tenantId: string, memberId: string): Promise<boolean>;
```

  SQL (inside `runInTenant`, tenant filters explicit — defence-in-depth like the file's other reads):

```sql
SELECT EXISTS (
  SELECT 1 FROM invoices i
  WHERE i.tenant_id = ${tenantId} AND i.member_id = ${memberId}
    AND i.invoice_subject = 'membership'
    AND i.status IN ('paid','partially_credited')
    AND i.paid_at > NOW() - INTERVAL '12 months'
    AND NOT EXISTS (SELECT 1 FROM renewal_cycles c
      WHERE c.tenant_id = i.tenant_id
        AND (c.linked_invoice_id = i.invoice_id OR c.anchor_invoice_id = i.invoice_id))
) AS unreconciled
```

- Test: unit test on the gate ordering + skip emit (mock repo true/false); integration test: paid-but-unreconciled invoice → dispatch skips with the new reason; reconciled (anchored) invoice → dispatch proceeds. Update the skip-reason exhaustiveness switch in `emitSkipAudit` (the K7 `_remaining` switch will force this at compile time).

- [ ] Steps: failing tests → RED → implement → GREEN → typecheck → commit `feat(renewals): dispatcher skip-guard for unreconciled paid membership invoices`.

---

### Task 11: F-3 — at-risk `last_paid_at` status filter

**Files:**
- Modify: `src/modules/renewals/infrastructure/drizzle/drizzle-member-renewal-flags-repo.ts:574` — the LATERAL:

```sql
            MAX(paid_at) FILTER (WHERE status IN ('paid','partially_credited')) AS last_paid_at
```

- Modify: `src/modules/renewals/infrastructure/drizzle/drizzle-at-risk-scorer.ts` (~line 152 — the single-member scorer's equivalent `MAX(paid_at)` read): same status filter.
- Test: extend the existing at-risk integration suite: member whose ONLY paid invoice is fully `credited` → `lastPaidAtIso` null → `daysSinceLastPayment` factor fires; a `partially_credited` invoice still counts.

- [ ] Steps: failing test → RED → implement both scorers → GREEN → typecheck → commit `fix(renewals): credited/void invoices no longer count as last payment in at-risk scoring`.

---

### Task 12: Final gates + runbook + docs

**Files:**
- Modify: `docs/runbooks/cron-jobs.md` (or the renewals runbook if separate) — ship-day ops step: `UPDATE tenant_invoice_settings … grace`: exact SQL `UPDATE tenant_renewal_settings SET grace_period_days = 30 WHERE tenant_id = 'swecham';` + note "TSCC 30-day rule officially unconfirmed (source: public site)".
- Create: `scripts/backfill-cycle-anchors.ts` — STUB IS FORBIDDEN; write the full script now, run later. **Input reality (verified 2026-07-08 against `docs/Membership Database_Since 2025.xlsx` — PII, git-ignored, NEVER commit):** TSCC's records key on COMPANY NAME, not member number. The script reads a CSV (`company_name,payment_date,period_from?,period_to?`), normalises names (lowercase, strip punctuation, collapse whitespace), matches against `members.company_name` per tenant, and for each match `runInTenant` → `findOpenCycleForMemberInTx` → `reanchorPeriodInTx` with `anchorInvoiceId: null`, `anchoredAt = now`. Period derivation: explicit `period_from/period_to` columns WIN when present (the ~6 legacy "full year" members get their fixed calendar-year window, e.g. 2026-01-01→2026-12-31); otherwise `payment_date → first day of its month → +12 months` (month-start anchor, spec rev 3 — TSCC's 19 recorded period pairs all run 1st→month-end). NO member-level term-type column exists or is added — full-year vs rolling is entirely encoded in the cycle period, and gapless renewal continuation preserves each member's rhythm automatically (design decision 2026-07-08). `--dry-run` (default) prints matched/unmatched/would-change WITHOUT writing; writing requires explicit `--confirm-prod`. Skip + report: unmatched names, members with no open cycle, future-dated payment dates (>today — the workbook contains at least one), and duplicate rows (keep MAX(payment_date)). Unit-test the CSV parsing + name normalisation + dry-run plan builder (pure parts). Data coverage measured: 103/112 current members have a payment date; ~7 paid-but-undated early-2025 members need TSCC follow-up or INV-date fallback (staff decision at run time, NOT auto-fallback).
- Modify: `docs/Bug/2026-07-08-renewal-paid-invoice-disconnect.md` — flip the Follow-ups checkboxes implemented here.
- [ ] **Run the full local pipeline** (`pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm check:layout && pnpm check:fixme && pnpm check:template-seed && pnpm test:integration`) then the renewals+invoicing E2E specs (`pnpm test:e2e --workers=1 --grep "renewal|invoice"`); fix fallout.
- [ ] **E2E addition**: `tests/e2e/renewals/rolling-anchor.spec.ts` — admin creates member → New invoice (assert first-payment context line visible) → record payment with backdated paymentDate → member detail Renewal card shows period anchored at that date → create second invoice → duplicate warning visible.
- [ ] Commit `feat(renewals): rolling-anchor backfill script + runbook + E2E`.

---

## Self-review notes (already applied)

- Spec coverage: R1→T4/5/6/7, R2→T8, R3→T2/5/6/7, skip-guard→T10, F-3→T11, grace-30+backfill→T12, UI→T9, event→T3, audit/enum→T1. No spec section unowned.
- Type consistency: `classifyMembershipPayment` input/output names match across T2/5/6/7/9; `reanchorPeriodInTx` signature matches across T4/5/6/7/12.
- Known judgement calls for implementers: (a) FK shape in 0238 must mirror 0087's `linked_invoice_id` FK exactly; (b) `record-payment` input `paymentDate` optionality — coalesce to null; (c) the invoice-form data flow (server props vs client fetch) — follow whatever the form does today, do not restructure.
