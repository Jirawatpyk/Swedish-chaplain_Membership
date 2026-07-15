# Renewal ↔ SweCham Payment-Terms Alignment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the F8 renewal lifecycle with SweCham's official member-fees payment-terms spec — record a per-member billing cycle, gate benefits until first payment, drive termination off the invoice due date (+60 days), and print a statutory termination notice on the bill.

**Architecture:** Small, targeted changes across three bounded contexts. F3 gains a foundation-only `members.billing_cycle` column. F8 changes two seams: the new-member cycle start-status (a 1-key addition) and the lapse cron's clock (invoice-`due_date`-driven, not `expires_at`-driven). F4 gains an `isBill`-gated, version-pinned termination notice on the invoice PDF. No F5/F6 changes; no renewal-anchor rework (the gapless renewer model already matches the spec).

**Tech Stack:** TypeScript 5.7 strict, Drizzle ORM + Neon Postgres (RLS), Next.js 16 / React 19, `@react-pdf/renderer`, `@js-joda/core` (Bangkok date math), next-intl (EN/TH/SV), Vitest (unit + live-Neon integration).

## Global Constraints

- **Design source of truth:** `docs/superpowers/specs/2026-07-15-renewal-swecham-alignment-design.md` (review-clean, 2 rounds). Every task's requirements implicitly include it.
- **§5.2 ⇄ §5.3 coupling:** §5.3 creates `awaiting_payment` cycles with a far-future `expires_at` (~now + 12 months). §5.2's candidate selection MUST NOT pre-filter by `expires_at` or those members are hidden for ~12 months. Implement Task 4 with Task 3's cohort in mind.
- **Never gate on `anchored_at` as "never paid"** — it is null on renewal cycles AND the imported 110-member prod cohort. Gating is done ONLY by the initial-cycle start-status (Task 3). Do NOT touch `scripts/import-members.ts` or `create-next-cycle-on-paid.ts`.
- **Termination notice: `isBill`-gated only** — never render on a §86/4 tax invoice/receipt. New template version = **v12** (v11 is deployed; do not redefine it). Text rides the immutable `TenantIdentitySnapshot` (SC-003 byte-determinism).
- **Timestamps ISO 8601 UTC in storage;** Bangkok (`Asia/Bangkok`, no DST) only for calendar-date boundaries. Buddhist Era is display-only.
- **Migrations are hand-written** in this repo (drizzle-kit can't emit enum/backfill/CHECK). Statement separator: `--> statement-breakpoint`. Apply (`pnpm db:migrate`) + `pnpm test:integration` BEFORE committing a schema change. Verify the next free migration number against `origin/main` at implement time (parallel-branch collision) — this plan assumes `0254`/`0255` but RENUMBER if main moved.
- **PII:** never `git add -A` (member data). Stage explicit paths only.
- **Gates before each commit:** `pnpm typecheck` (final gate after last edit) + `pnpm lint` + relevant `pnpm test` / `pnpm test:integration`. Push with `SKIP_INTEGRATION_PREPUSH=1 FEATURE_F6_EVENTCREATE=true git push` if the pre-push integration gate trips on shared-Neon drift.
- **Governance:** touches membership termination + audit + PII → Review gate needs **≥2 reviewers** (or solo-maintainer substitute).
- **Statutory copy (invoice notice + reminder emails) is PLACEHOLDER** pending SweCham legal approval — ships empty/dark on the invoice (nullable columns) and as clearly-marked placeholder in reminder copy.

---

### Task 1: `billing_cycle` schema + derive-from-dates backfill migration (F3 data)

**Files:**
- Modify: `src/modules/members/infrastructure/db/schema-members.ts` (enum block ~32-38, column block ~65-121)
- Create: `drizzle/migrations/0254_members_billing_cycle.sql`
- Modify: `drizzle/migrations/meta/_journal.json` (append one entry)
- Test: `tests/integration/members/billing-cycle-backfill.integration.test.ts`

**Interfaces:**
- Produces: `members.billing_cycle` DB column (`'calendar' | 'rolling'`, NOT NULL, default `'rolling'`); drizzle `billingCycleEnum` + `members.billingCycle`. Consumed by Task 2 (form/serialise) and future auto-invoice phase (not this round).

- [ ] **Step 1: Add the enum + column to the Drizzle schema**

In `schema-members.ts`, add to the `// --- Enums ---` block (after `memberStatusEnum`, ~line 38):
```ts
export const billingCycleEnum = pgEnum('billing_cycle', ['calendar', 'rolling']);
```
Add to the members column block (after `isVatRegistered`, ~line 71):
```ts
    // 065 renewal-swecham-alignment (§5.1) — per-member billing cadence.
    // FREE per-member choice (not derivable from plan/dates), RECORDED not
    // inferred. Foundation-only this round: drives NO lifecycle behaviour yet;
    // consumed by the future auto-invoice phase (calendar → issue Dec 1;
    // rolling → issue T-30 anniversary). Default 'rolling' = today's de-facto
    // anchor behaviour. Backfilled from period dates in migration 0254.
    billingCycle: billingCycleEnum('billing_cycle').notNull().default('rolling'),
```

- [ ] **Step 2: Hand-write the migration**

Create `drizzle/migrations/0254_members_billing_cycle.sql` (mirror the 0094 add→backfill→verify→tighten pattern and the 0245/0250 members-column style):
```sql
-- 065 renewal-swecham-alignment (§5.1) — members.billing_cycle.
--
-- FREE per-member choice (calendar-year 1/1-31/12 vs rolling anniversary),
-- RECORDED not derived. Foundation-only: drives no behaviour this round; the
-- future auto-invoice phase reads it (calendar → Dec 1 batch; rolling → T-30).
--
-- Backfill is BEST-EFFORT from the member's latest renewal cycle: period_from
-- = January 1 (Asia/Bangkok) → 'calendar', else 'rolling'; no cycle → default
-- 'rolling'. KNOWN LIMITATION: a rolling member whose FIRST payment landed in
-- January has period_from = Jan 1 and is indistinguishable by date from a
-- calendar member — it is over-marked 'calendar'. Because the column drives no
-- behaviour this round, this is tolerable; the admin-review pass (§9.2) is
-- mandatory before the auto-invoice phase consumes the column.

-- 1. New enum type (fresh type, not an ADD VALUE — no isolation needed).
CREATE TYPE "billing_cycle" AS ENUM('calendar', 'rolling');--> statement-breakpoint

-- 2. Add the column NOT NULL DEFAULT 'rolling' (every existing row seeded
--    'rolling', then step 3 flips the calendar-aligned ones).
ALTER TABLE "members"
  ADD COLUMN "billing_cycle" "billing_cycle" NOT NULL DEFAULT 'rolling';--> statement-breakpoint

-- 3. Backfill: flip to 'calendar' for members whose LATEST cycle starts Jan 1
--    (Asia/Bangkok). DISTINCT ON picks the most-recent cycle per member.
UPDATE "members" m
SET "billing_cycle" = 'calendar'
FROM (
  SELECT DISTINCT ON (rc."member_id")
    rc."tenant_id", rc."member_id", rc."period_from"
  FROM "renewal_cycles" rc
  ORDER BY rc."member_id", rc."created_at" DESC, rc."cycle_id" DESC
) latest
WHERE latest."tenant_id" = m."tenant_id"
  AND latest."member_id" = m."member_id"
  AND EXTRACT(MONTH FROM (latest."period_from" AT TIME ZONE 'Asia/Bangkok')) = 1
  AND EXTRACT(DAY   FROM (latest."period_from" AT TIME ZONE 'Asia/Bangkok')) = 1;--> statement-breakpoint
```
Append to `drizzle/migrations/meta/_journal.json` `entries[]` (after the current tail; bump `idx` +1 and `when` +100000 from the previous entry — verify the actual tail values at implement time):
```json
    {
      "idx": 256,
      "version": "7",
      "when": 1798538200000,
      "tag": "0254_members_billing_cycle",
      "breakpoints": true
    }
```

- [ ] **Step 3: Write the failing integration test**

Create `tests/integration/members/billing-cycle-backfill.integration.test.ts`. Mirror the module's existing integration setup (copy the imports + `runInTenant`/seed helpers from a sibling like `tests/integration/members/*.integration.test.ts`). Assert three cases against live Neon after seeding members + cycles:
```ts
// after seeding: member A latest cycle period_from = 2026-01-01T00:00:00+07 (Bangkok Jan 1)
//                member B latest cycle period_from = 2026-03-15T00:00:00+07 (mid-year)
//                member C has NO cycle
it('backfills billing_cycle from the latest cycle period_from (Bangkok Jan 1 → calendar)', async () => {
  expect(await readBillingCycle(tenantId, memberA)).toBe('calendar');
  expect(await readBillingCycle(tenantId, memberB)).toBe('rolling');
  expect(await readBillingCycle(tenantId, memberC)).toBe('rolling'); // default, no cycle
});
it('over-marks a rolling member who first-paid in January as calendar (documented limitation)', async () => {
  // member D latest cycle period_from = 2026-01-01 but is genuinely rolling
  expect(await readBillingCycle(tenantId, memberD)).toBe('calendar'); // known heuristic collision
});
```
(`readBillingCycle` = a `SELECT billing_cycle FROM members WHERE ...` inside `runInTenant`.)

- [ ] **Step 4: Apply the migration + run the test to verify it fails then passes**

Run: `pnpm db:migrate` then `pnpm test:integration -- billing-cycle-backfill`
Expected: migration applies; test passes (author the test AFTER the migration since backfill is a data migration, not app code — TDD here means the test proves the migration's data outcome).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm typecheck` → Expected: clean.
```bash
git add src/modules/members/infrastructure/db/schema-members.ts drizzle/migrations/0254_members_billing_cycle.sql drizzle/migrations/meta/_journal.json tests/integration/members/billing-cycle-backfill.integration.test.ts
git commit -m "feat(members): add billing_cycle column + derive-from-dates backfill (065 §5.1)"
```

---

### Task 2: `billing_cycle` on the member form + server + i18n (F3 presentation)

**Files:**
- Modify: `src/components/members/member-form/schema.ts` (add field ~after line 85)
- Modify: `src/components/members/member-form/sections/membership-section.tsx` (add Select)
- Modify: server create/update use-cases + serialise (grep sites, see Step 1)
- Modify: `src/i18n/messages/{en,th,sv}.json` (`admin.members.create.fields.*`)
- Test: `tests/unit/components/members/member-form-billing-cycle.test.tsx` + extend the server-use-case unit tests

**Interfaces:**
- Consumes: `billingCycleEnum` values from Task 1.
- Produces: `billing_cycle` on `MemberFormValues` + the create/update member payloads.

- [ ] **Step 1: Map every mirror site**

Run: `grep -rn "is_vat_registered\|legal_entity_type" src/app/api/members src/modules/members/application src/components/members | grep -v test`
Expected: the exact files to thread a new member field through — the client zod (`member-form/schema.ts`), the server zod + use-cases (`src/modules/members/application/use-cases/create-member.ts` + `update-member.ts`), and the serialise/read paths (`src/app/api/members/_serialise.ts`, `src/app/api/portal/profile/route.ts`). Add `billing_cycle` to each the same way `is_vat_registered` is threaded.

- [ ] **Step 2: Write the failing form test**

Create `tests/unit/components/members/member-form-billing-cycle.test.tsx` — render the form (mirror an existing member-form render test), assert the billing-cycle Select is present with both options and defaults sensibly:
```tsx
it('renders a required billing_cycle picker with calendar + rolling options', () => {
  renderMemberForm({ mode: 'create' });
  const trigger = screen.getByLabelText(/billing cycle/i);
  expect(trigger).toBeInTheDocument();
  // open + assert options
  fireEvent.click(trigger);
  expect(screen.getByRole('option', { name: /calendar/i })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: /rolling/i })).toBeInTheDocument();
});
```
Run: `pnpm test -- member-form-billing-cycle` → Expected: FAIL (no such field).

- [ ] **Step 3: Add the zod field**

In `member-form/schema.ts`, after the `legal_entity_type` field (~line 85):
```ts
  // 065 §5.1 — required free choice; no empty-string arm (unlike optional
  // legal_entity_type): every member must carry a billing cycle (DB is NOT
  // NULL). On edit the backfilled value loads; on create the admin must pick.
  billing_cycle: z.enum(['calendar', 'rolling'], {
    errorMap: () => ({ message: tf('errors.required') }),
  }),
```

- [ ] **Step 4: Add the Select to the membership section**

In `membership-section.tsx`, mirror the `plan_id` Controller/Select block (lines 62-106). Add after the plan picker:
```tsx
          <Label htmlFor="billing_cycle">
            {tf('billingCycle')}
            <RequiredMark />
          </Label>
          <Controller
            control={control}
            name="billing_cycle"
            render={({ field }) => (
              <Select value={field.value ?? ''} onValueChange={(v) => field.onChange(v)}>
                <SelectTrigger
                  id="billing_cycle"
                  aria-required="true"
                  aria-invalid={Boolean(errors.billing_cycle)}
                  aria-describedby={errors.billing_cycle ? 'billing_cycle-error' : undefined}
                  className="w-full"
                >
                  <TranslatedSelectValue
                    placeholder={tf('billingCyclePlaceholder')}
                    translate={(value) =>
                      value === 'calendar' || value === 'rolling' ? tf(`billingCycleOptions.${value}`) : null
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="calendar">{tf('billingCycleOptions.calendar')}</SelectItem>
                  <SelectItem value="rolling">{tf('billingCycleOptions.rolling')}</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
          <FieldError id="billing_cycle-error" message={errors.billing_cycle?.message} />
```

- [ ] **Step 5: Add i18n keys to all three locales (identical positions)**

In `src/i18n/messages/en.json` under `admin.members.create.fields` (near `plan`, ~line 1382):
```json
            "billingCycle": "Billing cycle",
            "billingCyclePlaceholder": "Select a billing cycle…",
            "billingCycleOptions": { "calendar": "Calendar year (Jan–Dec)", "rolling": "Rolling (anniversary)" },
```
`th.json` (same position):
```json
            "billingCycle": "รอบการเรียกเก็บ",
            "billingCyclePlaceholder": "เลือกรอบการเรียกเก็บ…",
            "billingCycleOptions": { "calendar": "ปีปฏิทิน (ม.ค.–ธ.ค.)", "rolling": "ตามวันครบรอบ" },
```
`sv.json` (same position):
```json
            "billingCycle": "Faktureringscykel",
            "billingCyclePlaceholder": "Välj faktureringscykel…",
            "billingCycleOptions": { "calendar": "Kalenderår (jan–dec)", "rolling": "Rullande (årsdag)" },
```

- [ ] **Step 6: Run tests + i18n + typecheck**

Run: `pnpm test -- member-form-billing-cycle` → Expected: PASS.
Run: `pnpm check:i18n` → Expected: parity green.
Run: `pnpm typecheck` → Expected: clean (also confirms every server/serialise mirror site now handles `billing_cycle`; fix any that don't compile).
Extend the create-member / update-member unit tests to assert `billing_cycle` round-trips (mirror the `is_vat_registered` assertions).

- [ ] **Step 7: Commit**
```bash
git add src/components/members/member-form src/modules/members/application src/app/api/members src/app/api/portal/profile src/i18n/messages tests/unit/components/members/member-form-billing-cycle.test.tsx
git commit -m "feat(members): billing_cycle picker on member form + server + i18n (065 §5.1)"
```

---

### Task 3: New-enrolment benefit gating via start-status (F8, §5.3)

**Files:**
- Modify: `src/modules/renewals/infrastructure/ports-adapters/f8-on-create-member-callbacks.ts` (the `createCycleInTx` input, ~line 75-90)
- Test: `tests/integration/renewals/new-enrolment-gating.integration.test.ts`

**Interfaces:**
- Consumes: the EXISTING `createCycleInTx` `startStatus?: 'upcoming' | 'awaiting_payment'` param (already defined; used by admin-comeback).
- Produces: a new member's initial cycle born `awaiting_payment` → `deriveMembershipAccess` = `suspended` until first payment.

- [ ] **Step 1: Write the failing invariant integration test**

Create `tests/integration/renewals/new-enrolment-gating.integration.test.ts` (live Neon). The three invariants from §5.3:
```ts
it('a brand-new member is suspended until first payment, then full', async () => {
  const memberId = await createMemberViaListener(tenantId); // runs f8OnCreateMemberCallbacks
  const cycle = await loadLatestCycleForMember(tenantId, memberId);
  expect(deriveMembershipAccess(cycle, NOW).access).toBe('suspended'); // was 'full'
  await recordFirstPaymentOffline(tenantId, memberId); // classify → first_payment → reanchor → upcoming+anchored
  const after = await loadLatestCycleForMember(tenantId, memberId);
  expect(deriveMembershipAccess(after, NOW).access).toBe('full');
});
it('an imported-cohort member (cycle born upcoming) stays full — MUST NOT regress', async () => {
  const memberId = await createMemberViaImportScript(tenantId); // scripts/import-members.ts path
  const cycle = await loadLatestCycleForMember(tenantId, memberId);
  expect(deriveMembershipAccess(cycle, NOW).access).toBe('full');
});
it('a paid renewer in coverage stays full even with an unpaid later renewal', async () => {
  const memberId = await seedPaidRenewerWithUnpaidNextInvoice(tenantId);
  const cycle = await loadLatestCycleForMember(tenantId, memberId);
  expect(deriveMembershipAccess(cycle, NOW).access).toBe('full');
});
```
Run: `pnpm test:integration -- new-enrolment-gating` → Expected: FAIL on the first assertion (new member currently returns `full`).

- [ ] **Step 2: Add the start-status to the new-member call site (the ONLY change)**

In `f8-on-create-member-callbacks.ts`, in the `createCycleInTx` input object (after `correlationId: evt.correlationId,`, alongside `anchorToCurrentPeriod`):
```ts
            // 065 §5.3 — a new member has NO benefits until the first invoice is
            // paid. Born 'awaiting_payment' → deriveMembershipAccess = suspended.
            // First payment classifies 'first_payment' → reanchorFirstPaymentCycleInTx
            // sets 'upcoming' + anchored → full. Do NOT replicate this on the
            // import (scripts/import-members.ts) or renewal (create-next-cycle-on-paid)
            // paths — imported/renewer cycles must stay 'upcoming' = full.
            startStatus: 'awaiting_payment',
```

- [ ] **Step 3: Run the invariant test to verify it passes**

Run: `pnpm test:integration -- new-enrolment-gating` → Expected: all three PASS (new member suspended→full; imported stays full; renewer stays full).

- [ ] **Step 4: Guard against side-effects**

Run: `grep -rn "renewal_entered_awaiting_payment\|enteredAwaitingPayment" src/modules/renewals` — confirm no reminder/at-risk logic requires an `upcoming→awaiting_payment` TRANSITION event for the initial cycle (it is born in that state, so no transition fires). If any does, note it for the reviewer; the born-state posture is intended.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm typecheck` → clean.
```bash
git add src/modules/renewals/infrastructure/ports-adapters/f8-on-create-member-callbacks.ts tests/integration/renewals/new-enrolment-gating.integration.test.ts
git commit -m "feat(renewals): gate new-member benefits until first payment via start-status (065 §5.3)"
```

---

### Task 4: Termination clock → invoice `due_date + 60` (F8, §5.2)

**Files:**
- Modify: `src/modules/renewals/application/ports/invoice-due-bridge.ts` (add a method)
- Modify: `src/modules/renewals/infrastructure/ports-adapters/invoice-due-bridge-drizzle.ts` (implement it)
- Modify: `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts` (`listCyclesEligibleForLapse` ~956-986)
- Modify: `src/modules/renewals/application/use-cases/lapse-cycles-on-grace-expiry.ts` (cutoff ~186-197, `processOne` ~286-434, stale comments 57/127-128)
- Test: `tests/integration/renewals/termination-due-plus-60.integration.test.ts`

**Interfaces:**
- Consumes: Task 3's born-`awaiting_payment` cohort (far-future `expires_at`).
- Produces: termination fires at `due_date + 60` (member-scoped oldest-due unpaid membership invoice), with `expires_at + grace` as the no-invoice backstop.

- [ ] **Step 1: Write the failing integration test (incl. the born-awaiting cohort)**

Create `tests/integration/renewals/termination-due-plus-60.integration.test.ts` (live Neon):
```ts
it('terminates at due_date + 60, not before', async () => {
  const m = await seedAwaitingMemberWithMembershipInvoice(tenantId, { dueDate: '2026-01-01' });
  await runLapse(tenantId, { now: bkk('2026-03-01') }); // due+59
  expect((await access(tenantId, m))).toBe('suspended');
  await runLapse(tenantId, { now: bkk('2026-03-03') }); // due+61
  expect((await access(tenantId, m))).toBe('terminated');
});
it('defers while the invoice is not yet due (059 guard preserved)', async () => {
  const m = await seedAwaitingMemberWithMembershipInvoice(tenantId, { dueDate: '2026-06-01' });
  await runLapse(tenantId, { now: bkk('2026-05-01') });
  expect((await access(tenantId, m))).toBe('suspended'); // not terminated
});
it('terminates a born-awaiting new member (far-future expires_at) at due+60 — the §5.2⇄§5.3 coupling', async () => {
  // initial cycle: awaiting_payment, expires_at ≈ now+12mo, membership invoice due 2026-01-01
  const m = await seedBornAwaitingNewMember(tenantId, { invoiceDueDate: '2026-01-01' });
  await runLapse(tenantId, { now: bkk('2026-03-03') }); // due+61, expires_at still ~9mo away
  expect((await access(tenantId, m))).toBe('terminated'); // NOT hidden by the expires_at gate
});
it('no-invoice backstop: terminates at expires_at + grace when the member has no membership invoice', async () => {
  const m = await seedAwaitingMemberNoInvoice(tenantId, { expiresAt: '2026-01-01', grace: 60 });
  await runLapse(tenantId, { now: bkk('2026-03-03') });
  expect((await access(tenantId, m))).toBe('terminated');
});
```
Run: `pnpm test:integration -- termination-due-plus-60` → Expected: FAIL (current clock is `expires_at + grace`; born-awaiting case is hidden by the selection gate).

- [ ] **Step 2: Add the due-date lookup to the port**

In `invoice-due-bridge.ts`, add to the `InvoiceDueBridge` interface (keep `hasUnpaidNotYetDueMembershipInvoice` — some callers still use it; the lapse use-case switches to the new one):
```ts
export interface OldestUnpaidMembershipInvoiceDueDateInput {
  readonly tenantId: string;
  readonly memberId: string;
}
```
```ts
  /**
   * 065 §5.2 — the `due_date` (Bangkok calendar date `YYYY-MM-DD`) of the
   * member's OLDEST-DUE unpaid (`status='issued'`) membership invoice, or
   * `null` if the member has none. Member-scoped (NOT linked_invoice_id: a
   * new member's initial cycle has linked_invoice_id = NULL and its first
   * invoice is paid via the unlinked-payment hook, never linked). The lapse
   * cron derives defer / terminate@due+60 / backstop from this one value.
   */
  oldestUnpaidMembershipInvoiceDueDate(
    input: OldestUnpaidMembershipInvoiceDueDateInput,
  ): Promise<string | null>;
```

- [ ] **Step 3: Implement it in the adapter**

In `invoice-due-bridge-drizzle.ts` (add alongside the existing method; import `sql` from `drizzle-orm`):
```ts
    async oldestUnpaidMembershipInvoiceDueDate(
      input: OldestUnpaidMembershipInvoiceDueDateInput,
    ): Promise<string | null> {
      return runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select({ dueDate: invoicesTable.dueDate })
          .from(invoicesTable)
          .where(
            and(
              eq(invoicesTable.tenantId, input.tenantId),
              eq(invoicesTable.memberId, input.memberId),
              eq(invoicesTable.invoiceSubject, 'membership'),
              eq(invoicesTable.status, 'issued'),
              isNotNull(invoicesTable.dueDate),
            ),
          )
          .orderBy(sql`${invoicesTable.dueDate} ASC`)
          .limit(1);
        return rows[0]?.dueDate ?? null;
      });
    },
```

- [ ] **Step 4: Widen the candidate selection to ALL `awaiting_payment`**

In `drizzle-renewal-cycle-repo.ts` `listCyclesEligibleForLapse` (~956-986), remove the `expires_at < cutoff` predicate so far-future-expiry born-awaiting cycles are surfaced. Change the arg to drop `cutoffDate`:
```ts
    async listCyclesEligibleForLapse(
      _tenantId: string,
      args: { readonly pageSize: number },
    ): Promise<RenewalCyclePage> {
      return runInTenant(tenant, async (tx) => {
        // 065 §5.2 — candidate = ALL awaiting_payment cycles; the due_date+60
        // vs no-invoice-backstop decision is made per-cycle in the use-case.
        // We must NOT pre-filter by expires_at: a §5.3 born-awaiting new member
        // has expires_at ≈ now+12mo and would be hidden for ~12 months.
        const rows = await tx
          .select()
          .from(renewalCycles)
          .where(eq(renewalCycles.status, 'awaiting_payment'))
          .orderBy(sql`${renewalCycles.expiresAt} ASC`)
          .limit(args.pageSize);
        return { items: rows.map(rowToDomain), nextCursor: null };
      });
    },
```
Update the `RenewalCycleRepo` port type for `listCyclesEligibleForLapse` to the new `{ pageSize }` arg (grep for the interface declaration and any mock in tests).

- [ ] **Step 5: Rewrite the `processOne` decision + the cron cutoff**

In `lapse-cycles-on-grace-expiry.ts`, add the constant + a Bangkok date-add helper near the top (import `LocalDate` from `@js-joda/core`):
```ts
const TERMINATION_DAYS_AFTER_DUE = 60;
```
Change the cron entry (~186-197) — stop computing/passing `cutoffDate` for selection; still read `gracePeriodDays` for the backstop:
```ts
  const gracePeriodDays = settings.gracePeriodDays;
  const page = await deps.cyclesRepo.listCyclesEligibleForLapse(
    input.tenantId,
    { pageSize },
  );
```
Replace the credit-window guard at the top of `processOne` (the `hasUnpaidNotYetDueMembershipInvoice` block) with the due-date-driven decision. The new prelude (keeping the fail-SAFE contract + the deferred-not-due audit for the not-yet-due branch):
```ts
  const todayBkk = bangkokLocalDate(now.toISOString());
  let dueDate: string | null;
  try {
    dueDate = await deps.invoiceDueBridge.oldestUnpaidMembershipInvoiceDueDate({
      tenantId,
      memberId: cycle.memberId,
    });
  } catch (e) {
    logger.error(
      { errorId: 'F8.LAPSE.INVOICE_DUE_GUARD_FAILED', tenantId, cycleId: cycle.cycleId,
        err: e instanceof Error ? e : new Error(String(e)) },
      '[lapse-cycles-on-grace-expiry] invoiceDueBridge threw — failing SAFE (member NOT lapsed)',
    );
    renewalsMetrics.lapseInvoiceDueGuardErrors.add(1, { tenant_id: tenantId });
    return 'deferred_guard_error';
  }

  if (dueDate !== null) {
    if (dueDate >= todayBkk) {
      // Not yet due → defer (059 guard). Emit the existing forensic audit.
      await deps.auditEmitter.emit(
        { type: 'renewal_lapse_deferred_invoice_not_due' as const,
          payload: { cycle_id: cycle.cycleId as CycleId, member_id: asMemberId(cycle.memberId),
            invoice_subject: 'membership' as const, due_date_frontier: todayBkk } },
        { tenantId, actorUserId: null, actorRole: 'cron', correlationId },
      );
      return 'deferred_invoice_not_due';
    }
    const terminateAfter = LocalDate.parse(dueDate).plusDays(TERMINATION_DAYS_AFTER_DUE).toString();
    if (todayBkk <= terminateAfter) {
      // Past due but within the 60-day termination window → stay suspended.
      return 'deferred_within_termination_window';
    }
    // else today > due_date + 60 → fall through to terminate.
  } else {
    // No membership invoice → backstop on expires_at + grace.
    const backstopCutoffIso = new Date(now.getTime() - gracePeriodDays * MS_PER_DAY).toISOString();
    if (cycle.expiresAt >= backstopCutoffIso) {
      return 'deferred_no_invoice_backstop';
    }
    // else expires_at + grace passed → fall through to terminate.
  }
  // ---- terminate: existing failed-attempt count → transitionStatus → audit ----
```
Keep the existing terminate block (failed-attempt count, advisory lock, re-read, `transitionStatus` to `lapsed`, `renewal_lapsed` audit) unchanged below this prelude.

- [ ] **Step 6: Wire the two new outcomes into the result tally**

Add `'deferred_within_termination_window'` and `'deferred_no_invoice_backstop'` to the `ProcessOneOutcome` union and fold them into the same "deferred" bucket the caller already reports for `deferred_invoice_not_due` (grep the caller's `switch`/tally over `ProcessOneOutcome` in the same file and add the two arms). Add matching metric counters mirroring `deferredInvoiceNotDue` if the result object exposes per-reason counts.

- [ ] **Step 7: Fix the stale comments**

In `lapse-cycles-on-grace-expiry.ts` line 57 and 127-128, replace "F4's 90-day net terms" with "F4's 30-day net terms (`tenant_invoice_settings.default_net_days`, default 30)".

- [ ] **Step 8: Run the test + typecheck + commit**

Run: `pnpm test:integration -- termination-due-plus-60` → Expected: all PASS (incl. born-awaiting cohort).
Run: `pnpm typecheck && pnpm lint` → clean.
```bash
git add src/modules/renewals/application/ports/invoice-due-bridge.ts src/modules/renewals/infrastructure/ports-adapters/invoice-due-bridge-drizzle.ts src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts src/modules/renewals/application/use-cases/lapse-cycles-on-grace-expiry.ts tests/integration/renewals/termination-due-plus-60.integration.test.ts
git commit -m "feat(renewals): terminate at invoice due_date + 60, member-scoped, born-awaiting-safe (065 §5.2)"
```

---

### Task 5: Statutory notice — schema column + snapshot field (F4)

**Files:**
- Modify: `src/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings.ts` (~86-92)
- Modify: `src/modules/invoicing/domain/value-objects/tenant-identity-snapshot.ts` (interface)
- Modify: `src/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo.ts` (`identity` block ~60-85)
- Create: `drizzle/migrations/0255_tenant_invoice_settings_termination_notice.sql` + journal entry
- Test: `tests/integration/invoicing/termination-notice-snapshot.integration.test.ts`

**Interfaces:**
- Produces: `tenant_invoice_settings.termination_notice_th/_en` (nullable) + `TenantIdentitySnapshot.termination_notice_th/_en` (optional), pinned into the invoice snapshot at issue. Consumed by Task 6 (render) + Task 7 (admin set).

- [ ] **Step 1: Add the columns + migration**

Schema (`schema-tenant-invoice-settings.ts`, after `whtNoteEn` ~line 87):
```ts
    // 065 §5.4 — statutory termination notice. Rendered on the ใบแจ้งหนี้ (bill)
    // ONLY (isBill-gated in the template), NEVER on a §86/4 tax invoice/receipt.
    // NULL ⇒ render nothing (ships dark until SweCham supplies approved wording).
    // Pinned into the immutable TenantIdentitySnapshot at issue (SC-003).
    terminationNoticeTh: text('termination_notice_th'),
    terminationNoticeEn: text('termination_notice_en'),
```
Migration `drizzle/migrations/0255_tenant_invoice_settings_termination_notice.sql`:
```sql
-- 065 §5.4 — bilingual statutory termination notice on tenant_invoice_settings.
-- Rendered on the bill ONLY (never §86/4). Both NULL for every existing row
-- (ships dark until SweCham approves the legal wording). No CHECK needed.
ALTER TABLE "tenant_invoice_settings"
  ADD COLUMN IF NOT EXISTS "termination_notice_th" text;--> statement-breakpoint
ALTER TABLE "tenant_invoice_settings"
  ADD COLUMN IF NOT EXISTS "termination_notice_en" text;--> statement-breakpoint
```
Append the journal entry (idx +1, when +100000 after 0254).

- [ ] **Step 2: Add the optional snapshot fields**

In `tenant-identity-snapshot.ts`, after `wht_note_en` in the `TenantIdentitySnapshot` interface:
```ts
  /**
   * 065 §5.4 — statutory termination notice, rendered on the bill ONLY
   * (isBill-gated) via a v12 template gate. Rides this pinned snapshot
   * (immutable at issue, SC-003) — NEVER a template literal. OPTIONAL /
   * undefined-guarded for historical snapshots (template: `?? null`).
   */
  readonly termination_notice_th?: string | null;
  readonly termination_notice_en?: string | null;
```

- [ ] **Step 3: Pin them at issue (repo `identity` block)**

In `drizzle-tenant-settings-repo.ts` `rowToView` `identity` object (after `wht_note_en: row.whtNoteEn,`):
```ts
      termination_notice_th: row.terminationNoticeTh,
      termination_notice_en: row.terminationNoticeEn,
```
(No change needed in `issue-invoice.ts` — it copies `settings.identity` verbatim.)

- [ ] **Step 4: Failing integration test (snapshot pin)**

Create `tests/integration/invoicing/termination-notice-snapshot.integration.test.ts` — set the notice in `tenant_invoice_settings`, issue a membership bill, assert the issued invoice's `tenant_identity_snapshot` carries the notice text (mirror an existing snapshot-pin test for `wht_note`).
Run: `pnpm db:migrate && pnpm test:integration -- termination-notice-snapshot` → FAIL then PASS.

- [ ] **Step 5: Typecheck + commit**
```bash
git add src/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings.ts src/modules/invoicing/domain/value-objects/tenant-identity-snapshot.ts src/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo.ts drizzle/migrations/0255_tenant_invoice_settings_termination_notice.sql drizzle/migrations/meta/_journal.json tests/integration/invoicing/termination-notice-snapshot.integration.test.ts
git commit -m "feat(invoicing): pin termination_notice_th/_en into the tenant identity snapshot (065 §5.4)"
```

---

### Task 6: Statutory notice — bill-only render + v12 version gate (F4)

**Files:**
- Modify: `src/modules/invoicing/infrastructure/pdf/template-registry.ts` (`CURRENT_TEMPLATE_VERSION`, `TEMPLATE_VERSIONS`, log ~199-206)
- Modify: `src/modules/invoicing/infrastructure/pdf/templates/invoice-template.tsx` (new const + style + block near the bank block ~921)
- Test: `tests/integration/invoicing/termination-notice-scope.integration.test.ts`

**Interfaces:**
- Consumes: `TenantIdentitySnapshot.termination_notice_th/_en` from Task 5.
- Produces: the notice on `isBill` documents at `templateVersion >= 12`; never on §86/4.

- [ ] **Step 1: Bump the registry to v12**

In `template-registry.ts` (~203-206):
```ts
export const CURRENT_TEMPLATE_VERSION = 12 as const;
export const TEMPLATE_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
```
Add a log entry in the registry docblock: `v12 (065 §5.4) — isBill-gated statutory termination notice; pinned pre-v12 documents re-render byte-stable with no notice.`

- [ ] **Step 2: Write the failing template test (bill-only)**

Create `tests/integration/invoicing/termination-notice-scope.integration.test.ts` — mirror `wht-note-scope.integration.test.ts`'s harness (`makeInput`, `pagesOf`, `pageText`), extend `tenantWithNoteAndBank()` with `termination_notice_th/_en`. Assert:
```ts
const NOTICE_EN = 'PLACEHOLDER: SweCham is regulatory-bound to terminate members with unpaid fees.';
it('renders the notice on the bill (kind=invoice, billMode=true, v12)', () => {
  const t = pageText(pagesOf(InvoiceTemplate(makeInput({ templateVersion: 12, kind: 'invoice', billMode: true })))[0]);
  expect(t).toContain(NOTICE_EN);
});
it('does NOT render the notice on the §86/4 tax receipt (receipt_combined, v12)', () => {
  for (const p of pagesOf(InvoiceTemplate(makeInput({ templateVersion: 12, kind: 'receipt_combined', invoiceSubject: 'membership' })))) {
    expect(pageText(p)).not.toContain(NOTICE_EN);
  }
});
it('does NOT render on §105 receipt_separate or §86/10 credit_note', () => {
  for (const kind of ['receipt_separate', 'credit_note'] as const) {
    const t = pageText(pagesOf(InvoiceTemplate(makeInput({ templateVersion: 12, kind }))).flatMap((p) => [pageText(p)]).join(''));
    expect(t).not.toContain(NOTICE_EN);
  }
});
it('does NOT render on a pre-v12 bill (byte-determinism)', () => {
  const t = pageText(pagesOf(InvoiceTemplate(makeInput({ templateVersion: 11, kind: 'invoice', billMode: true })))[0]);
  expect(t).not.toContain(NOTICE_EN);
});
```
Run: `pnpm test:integration -- termination-notice-scope` → FAIL (no render block).

- [ ] **Step 3: Add the version const + style + render block**

In `invoice-template.tsx`, add the const next to the other `*_MIN_VERSION` (after `TAX_ID_REGISTRANT_GATE_MIN_VERSION = 11`, ~line 417):
```ts
const TERMINATION_NOTICE_MIN_VERSION = 12;
```
Add a style (near `whtNoteBlock`/`whtNoteLine` ~159):
```ts
  terminationNoticeBlock: { marginTop: 12, width: '100%' },
  terminationNoticeLine: { fontSize: 8, color: '#555', maxWidth: '100%', marginBottom: 2 },
```
Add the render block as a SIBLING of the bank block, using the SAME `isBill` gate (place it just before or after the `{isBill && input.templateVersion >= WHT_AND_BANK_BLOCK_MIN_VERSION && (...)}` block ~921):
```tsx
      {/* 065 §5.4 — statutory termination notice on the ใบแจ้งหนี้ (bill) ONLY
          (isBill-gated, like the bank block — NEVER the §86/4 receipt). Gated
          v>=12 so pinned pre-v12 documents re-render byte-stable. Each language
          line guarded independently. */}
      {isBill && input.templateVersion >= TERMINATION_NOTICE_MIN_VERSION &&
        (input.tenant.termination_notice_th != null || input.tenant.termination_notice_en != null) && (
          <View style={styles.terminationNoticeBlock}>
            {input.tenant.termination_notice_th != null && (
              <Text style={styles.terminationNoticeLine}>{shapeThai(input.tenant.termination_notice_th)}</Text>
            )}
            {input.tenant.termination_notice_en != null && (
              <Text style={styles.terminationNoticeLine}>{input.tenant.termination_notice_en}</Text>
            )}
          </View>
        )}
```

- [ ] **Step 4: Run the test + typecheck + commit**

Run: `pnpm test:integration -- termination-notice-scope` → all PASS.
Run: `pnpm typecheck` → clean.
```bash
git add src/modules/invoicing/infrastructure/pdf/template-registry.ts src/modules/invoicing/infrastructure/pdf/templates/invoice-template.tsx tests/integration/invoicing/termination-notice-scope.integration.test.ts
git commit -m "feat(invoicing): render statutory termination notice on the bill only, v12-gated (065 §5.4)"
```

---

### Task 7: Statutory notice — admin settings wiring (F4)

**Files:**
- Modify: `src/modules/invoicing/application/use-cases/update-tenant-invoice-settings.ts` (zod + mapping)
- Modify: the invoice-settings admin form (grep `wht_note` under `src/app/(staff)/admin/settings/invoicing/**` + `src/components/**`)
- Modify: `src/i18n/messages/{en,th,sv}.json` (settings labels)
- Test: extend the existing `update-tenant-invoice-settings` unit/integration test

**Interfaces:**
- Consumes: the columns from Task 5.
- Produces: admins can set `termination_notice_th/_en` in the invoicing settings UI.

- [ ] **Step 1: Locate every `wht_note` settings site**

Run: `grep -rn "wht_note\|whtNote" src/modules/invoicing/application src/app/(staff)/admin/settings src/components | grep -v test`
Expected: the update use-case zod schema + mapping, the settings form field(s), and the read/serialise path. Thread `termination_notice_th/_en` identically (both optional `text`, nullable).

- [ ] **Step 2: Write the failing test**

Extend the update-settings test: set `termination_notice_th/_en`, assert they persist and read back.
Run: `pnpm test -- update-tenant-invoice-settings` → FAIL.

- [ ] **Step 3: Add the zod fields + mapping**

In `update-tenant-invoice-settings.ts`, mirror `whtNoteTh/En` in the input schema (`z.string().trim().max(...).nullable().optional()` — match the exact `wht_note` shape) and in the row-update mapping.

- [ ] **Step 4: Add the form fields + i18n labels**

Mirror the `wht_note` textarea(s) in the settings form; add EN/TH/SV labels (e.g. `admin.settings.invoicing.terminationNoticeTh/En`) at matching positions in all three locales.

- [ ] **Step 5: Run tests + i18n + typecheck + commit**

Run: `pnpm test -- update-tenant-invoice-settings && pnpm check:i18n && pnpm typecheck` → all green.
```bash
git add src/modules/invoicing/application/use-cases/update-tenant-invoice-settings.ts src/app/\(staff\)/admin/settings src/components src/i18n/messages tests
git commit -m "feat(invoicing): admin can set the statutory termination notice (065 §5.4)"
```

---

### Task 8: Reminder statutory-warning copy (F8, §5.5)

**Files:**
- Modify: `src/modules/renewals/infrastructure/email/templates/copy.ts` (post-expiry steps: `*.t+7` / `premium.t+14` / `partnership.t+30`, EN/TH/SV)
- Test: extend the copy unit test (or add `tests/unit/renewals/reminder-statutory-copy.test.ts`)

**Interfaces:**
- Produces: post-due reminder emails carry the statutory-obligation warning (placeholder wording).

- [ ] **Step 1: Write the failing test**

Add a test asserting every post-expiry step body contains the statutory warning marker in all three locales:
```ts
const POST_EXPIRY: CopyKey[] = ['thai_alumni.t+7','start_up.t+7','regular.t+7','premium.t+14','partnership.t+30'];
it('every post-expiry reminder carries the statutory termination warning (all locales)', () => {
  for (const locale of ['en','th','sv'] as const)
    for (const key of POST_EXPIRY)
      expect(RENEWAL_COPY[locale][key]?.body).toMatch(/regulatory|ระเบียบ|föreskriv/i);
});
```
Run: `pnpm test -- reminder-statutory-copy` → FAIL.

- [ ] **Step 2: Append the warning sentence to each post-expiry step body**

For each of the 5 post-expiry steps, append (keeping the existing body; PLACEHOLDER pending SweCham approval — mark clearly). EN example on `premium.t+14`:
```ts
    body: 'Hi {firstName}, your {tier} membership for {companyName} expired on {expiresAt}. Reactivate now to restore Premium benefits. PLACEHOLDER: SweCham is regulatory-bound to terminate members with unpaid fees within 60 days of the invoice due date.',
```
TH (`premium.t+14`): append `PLACEHOLDER: SweCham มีหน้าที่ตามระเบียบต้องยุติสมาชิกภาพของผู้ค้างชำระภายใน 60 วันนับจากวันครบกำหนดชำระ`
SV (`premium.t+14`): append `PLACEHOLDER: SweCham är enligt föreskrift skyldig att avsluta medlemmar med obetalda avgifter inom 60 dagar från fakturans förfallodag.`
Repeat for `thai_alumni.t+7`, `start_up.t+7`, `regular.t+7`, `partnership.t+30` (same three placeholder sentences).

- [ ] **Step 3: Run the test + typecheck + commit**

Run: `pnpm test -- reminder-statutory-copy && pnpm typecheck` → green.
```bash
git add src/modules/renewals/infrastructure/email/templates/copy.ts tests/unit/renewals/reminder-statutory-copy.test.ts
git commit -m "feat(renewals): statutory termination warning on post-due reminders (placeholder) (065 §5.5)"
```

---

## Operator gates (post-merge, human) — carry from design §9

1. Confirm `FEATURE_088_TAX_AT_PAYMENT = ON` in prod (tax-safety of Tasks 4 + 6 depends on the pre-payment document being a non-tax `bill`).
2. Review the `billing_cycle` backfill; correct Rolling members over-marked `calendar` (esp. January first-payers).
3. Confirm the prod `grace_period_days` value (now the no-invoice backstop only).
4. SweCham to supply/approve the final statutory wording (invoice notice Task 5/7 + reminder copy Task 8), EN/TH/SV; replace the `PLACEHOLDER:` text before go-live.

## Self-review notes

- **Spec coverage:** §5.1 → Tasks 1-2; §5.2 → Task 4 (+ coupling to Task 3); §5.3 → Task 3; §5.4 → Tasks 5-7; §5.5 → Task 8; §5.6 → no task (design defers F6). ✔
- **Type consistency:** `billing_cycle` enum values `'calendar'|'rolling'` identical across schema/zod/form/i18n; `startStatus: 'awaiting_payment'` matches the existing param union; `oldestUnpaidMembershipInvoiceDueDate` signature identical in port + adapter + test; `TERMINATION_NOTICE_MIN_VERSION = 12` matches the registry bump. ✔
- **Migration numbers `0254`/`0255` are provisional** — verify against `origin/main` at implement time and renumber + re-journal if main moved (Global Constraints).
