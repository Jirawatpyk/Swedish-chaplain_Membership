# Member Erasure — US2c (F6 Registration Fan-out) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Hard-delete every F6 event registration matched to an erased member (each carries the attendee's email/name/company), crediting back any consumed benefit quota per registration — by reusing the existing single-registration `eraseAttendeePii` in a new `eraseAllRegistrationsForMember` fan-out, wired into `eraseMember` as a post-commit best-effort cascade.

**Architecture:** A net-new `eraseAllRegistrationsForMember` use-case in the **events** module enumerates the member's registration ids (`matched_member_id = member`) via a new repo list method, then loops calling the existing `eraseAttendeePii` once per registration — **each in its own `runInTenant` tx** so one failure doesn't roll back the others (best-effort, mirroring the `eraseMember` post-commit cascade philosophy). `eraseAttendeePii` already does the per-registration advisory lock (`eventcreate-quota:<tenant>:<member>:<event>`), the `quota_credit_back_archive` audits per consumed scope, the idempotency probe (prior `pii_erasure_completed` audit), and the hard-delete. The members module reaches the fan-out via a new `EventRegistrationErasurePort` + adapter (through the events barrel + a composition factory, keeping RLS/Principle I intact). Idempotent: a re-run enumerates 0 registrations (already deleted).

**Tech Stack:** TypeScript 5.7 strict · Drizzle ORM + Neon Postgres (RLS+FORCE, `runInTenant`, `pg_advisory_xact_lock`) · Vitest · `Result<T,E>` · Clean Architecture.

---

## Pre-flight (read before Task 1)

- **`eraseAttendeePii`** — `src/modules/events/application/use-cases/erase-attendee-pii.ts`. Signature: `eraseAttendeePii(input: EraseAttendeePiiInput, deps: EraseAttendeePiiDeps): Promise<Result<EraseAttendeePiiOutput, EraseAttendeePiiError>>`. `EraseAttendeePiiInput = { tenantId: TenantId; eventId: EventId; registrationId: RegistrationId; actorUserId: UserId; reasonText: string; occurredAt: Date }`. `EraseAttendeePiiOutput = { alreadyErased: boolean; quotaReversals: { partnership: number; cultural: number } }`. Deps `{ eventsRepo, registrationsRepo, advisoryLockAcquirer, audit }`. It: (1) `registrationsRepo.findById(tenantId, registrationId)` → idempotency probe via `audit.findPriorErasureCompletion` if null; (2) path guard `registration.eventId === input.eventId`; (3) emit `pii_erasure_requested`; (4) if `countedAgainstPartnership`/`countedAgainstCulturalQuota` AND `matchedMemberId !== null` → advisory-lock `buildQuotaLockKey(tenantId, memberId, eventId)` + emit `quota_credit_back_archive` per scope; (5) `registrationsRepo.hardDelete(tenantId, registrationId)`; (6) emit `pii_erasure_completed`. **It is NOT barrel-exported** (Task 3 fixes that).
- **`event_registrations` schema** — `src/modules/events/infrastructure/schema.ts:120-209`. Member link: `matchedMemberId` (`matched_member_id` `uuid` nullable). PII: `attendeeEmail`/`attendeeName`/`attendeeCompany`. PK `(tenant_id, registration_id)`. **Index `event_regs_tenant_matched_member_idx (tenant_id, matched_member_id)` already exists** — the member-keyed list query uses it; no new index needed.
- **`RegistrationsRepository`** — `src/modules/events/application/ports/registrations-repository.ts` + drizzle impl `src/modules/events/infrastructure/drizzle-registrations-repository.ts` (`makeDrizzleRegistrationsRepository(executor: TenantTx)` — threads the caller's `tx`; `findById` :271-291, `hardDelete` :947-980). **No member-keyed list method exists** — Task 1 adds one.
- **Advisory lock** — `buildQuotaLockKey(tenantId, memberId, eventId)` (`src/modules/events/application/use-cases/apply-quota-effect.ts:180-186`), namespace `eventcreate-quota:` (disjoint from `invoicing:`/`payments:`/`broadcasts:`/`renewals:`). Barrel-exported (`index.ts:294`). `eraseAttendeePii` already acquires it internally — the fan-out does NOT add its own lock.
- **Events barrel** — `src/modules/events/index.ts`. Cross-module callers use a **composition factory** `make…ForTenant(tx): <Application-port-shaped deps>` (e.g. `makeEventRegistrationLookupForTenant(tx): Pick<RegistrationsRepository,'findById'>` :545-551). `tests/unit/architecture/events-barrel.test.ts` forbids re-exporting raw infra factories. So Task 3 adds: barrel-export `eraseAttendeePii` + `eraseAllRegistrationsForMember` + a `makeEraseAllRegistrationsForMemberDeps(tx)` factory (F4-bridge style).
- **F6 audit** — `F6AuditPort` (`src/modules/events/application/ports/audit-port.ts`) + `makePinoAuditPort(tx)`. The fan-out emits **no new** audit type — `eraseAttendeePii` already emits `pii_erasure_requested`/`pii_erasure_completed`/`quota_credit_back_archive` per registration (all existing F6 events). The fan-out MAY emit a single summary line via the logger (not an audit).
- **eraseMember wiring** — `EraseMemberDeps` `:62-72`; post-commit cascade section ~`:260-403`; new block before `// 4. Completion proof` (~`:405`).
- **Run commands** — as US2a/b. Confirm next migration index if any (US2c likely needs NO migration — no schema/enum change).

**File-structure map:**
- Modify `src/modules/events/application/ports/registrations-repository.ts` + `…/infrastructure/drizzle-registrations-repository.ts` — add `listMemberRegistrationsInTx`.
- Create `src/modules/events/application/use-cases/erase-all-registrations-for-member.ts`.
- Modify `src/modules/events/index.ts` — barrel-export `eraseAttendeePii`, `eraseAllRegistrationsForMember`, `makeEraseAllRegistrationsForMemberDeps`.
- Create `src/modules/members/application/ports/event-registration-erasure-port.ts` + `…/infrastructure/adapters/event-registration-erasure-adapter.ts`.
- Modify `erase-member.ts` + `members-deps.ts` — new dep + cascade block + wiring.
- Tests: events unit + integration (fan-out + throw-path), members unit cascade cases + deps guard, eraseMember e2e.

---

## Task 1: `RegistrationsRepository.listMemberRegistrationsInTx`

**Files:**
- Modify: `src/modules/events/application/ports/registrations-repository.ts`, `src/modules/events/infrastructure/drizzle-registrations-repository.ts`
- Test: `tests/integration/events/list-member-registrations.test.ts` (create)

- [ ] **Step 1: Write the failing integration test (RED)** — seed 3 registrations for member M (2 different events) + 1 for another member; assert the method returns exactly the 3 `{ registrationId, eventId }` for M:
```ts
it('returns every registration id + eventId matched to the member', async () => {
  const { memberId, regs } = await seedRegistrationsForMember(ctx, [{ eventId: 'e1' }, { eventId: 'e1' }, { eventId: 'e2' }]);
  await seedRegistrationsForMember(ctx, [{ eventId: 'e1' }]); // a different member
  const rows = await runInTenant(ctx, (tx) => makeDrizzleRegistrationsRepository(tx).listMemberRegistrationsInTx(ctx.slug, memberId));
  expect(rows).toHaveLength(3);
  expect(new Set(rows.map((r) => r.registrationId))).toEqual(new Set(regs.map((r) => r.registrationId)));
});
```

- [ ] **Step 2: Run — FAIL** (`listMemberRegistrationsInTx is not a function`).

- [ ] **Step 3: Add the port method + impl**

Port:
```ts
  listMemberRegistrationsInTx(
    tenantId: TenantId,
    memberId: string,
  ): Promise<ReadonlyArray<{ readonly registrationId: RegistrationId; readonly eventId: EventId }>>;
```
Impl (drizzle, threads the executor `tx`; uses the existing `(tenant_id, matched_member_id)` index):
```ts
async listMemberRegistrationsInTx(tenantId, memberId) {
  const rows = await executor
    .select({ registrationId: eventRegistrations.registrationId, eventId: eventRegistrations.eventId })
    .from(eventRegistrations)
    .where(and(eq(eventRegistrations.tenantId, tenantId), eq(eventRegistrations.matchedMemberId, memberId)));
  return rows.map((r) => ({ registrationId: asRegistrationId(r.registrationId), eventId: asEventId(r.eventId) }));
}
```
Use the file's existing branded-id constructors (`asRegistrationId`/`asEventId` or equivalent) + `and`/`eq` imports.

- [ ] **Step 4: Run — PASS; commit.**

```bash
git add src/modules/events/application/ports/registrations-repository.ts src/modules/events/infrastructure/drizzle-registrations-repository.ts tests/integration/events/list-member-registrations.test.ts
git commit -m "feat(events): RegistrationsRepository.listMemberRegistrationsInTx (COMP-1 US2c)"
```

---

## Task 2: `eraseAllRegistrationsForMember` use-case (best-effort fan-out)

**Files:**
- Create: `src/modules/events/application/use-cases/erase-all-registrations-for-member.ts`
- Test: `tests/unit/events/application/erase-all-registrations-for-member.test.ts`

This is the throw-path-critical piece (design §10): a failure on one registration must NOT silently abort the rest.

- [ ] **Step 1: Write the failing unit test (RED)** — stub `listMemberRegistrationsInTx` → 3 rows; stub `eraseAttendeePii` to succeed for reg1/reg3 and THROW for reg2; assert the fan-out returns a summary `{ erasedCount: 2, failedCount: 1, alreadyErasedCount: 0 }` (NOT a silent abort), reg1 + reg3 were attempted, and the result is `ok` (best-effort) but flags `failedCount > 0`:
```ts
it('continues past a throwing registration (best-effort, not silent abort)', async () => {
  const deps = buildDeps();
  deps.list = vi.fn(async () => [{ registrationId: 'r1', eventId: 'e1' }, { registrationId: 'r2', eventId: 'e1' }, { registrationId: 'r3', eventId: 'e2' }]);
  deps.eraseOne = vi.fn(async (regId) => {
    if (regId === 'r2') throw new Error('boom');
    return { ok: true, value: { alreadyErased: false, quotaReversals: { partnership: 0, cultural: 0 } } };
  });
  const res = await eraseAllRegistrationsForMember({ tenantId: 't', memberId: 'm', actorUserId: 'a', requestId: 'req', occurredAt: new Date() }, deps);
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.value).toMatchObject({ erasedCount: 2, failedCount: 1 });
  expect(deps.eraseOne).toHaveBeenCalledTimes(3); // r2 threw but r3 still ran
});

it('idempotent — alreadyErased registrations count separately, not as failures', async () => {
  const deps = buildDeps();
  deps.list = vi.fn(async () => [{ registrationId: 'r1', eventId: 'e1' }]);
  deps.eraseOne = vi.fn(async () => ({ ok: true, value: { alreadyErased: true, quotaReversals: { partnership: 0, cultural: 0 } } }));
  const res = await eraseAllRegistrationsForMember({ tenantId: 't', memberId: 'm', actorUserId: 'a', requestId: 'req', occurredAt: new Date() }, deps);
  expect(res.ok && res.value).toMatchObject({ erasedCount: 0, failedCount: 0, alreadyErasedCount: 1 });
});
```
The deps shape abstracts the two collaborators: `{ list(tenantId, memberId): Promise<{registrationId,eventId}[]>, eraseOne(registrationId, eventId, input): Promise<Result<EraseAttendeePiiOutput, …>> }` — so the use-case is unit-testable without a real tx. The composition factory (Task 3) wires `list` → `listMemberRegistrationsInTx` and `eraseOne` → a per-registration `runInTenant(tx => eraseAttendeePii({…}, makeEraseAttendeePiiDeps(tx)))`.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** — enumerate once, loop with per-item try/catch, tally `erasedCount`/`alreadyErasedCount`/`failedCount`, log each failure with `{ registrationId, err }`. Return `ok({ erasedCount, alreadyErasedCount, failedCount })`. A `failedCount > 0` is NOT an `err` (best-effort) — the caller (eraseMember cascade) treats `failedCount > 0` as not-clean so the reconciler re-drives.
```ts
export interface EraseAllRegistrationsForMemberDeps {
  list(tenantId: string, memberId: string): Promise<ReadonlyArray<{ registrationId: string; eventId: string }>>;
  eraseOne(registrationId: string, eventId: string, input: { tenantId: string; actorUserId: string; reasonText: string; occurredAt: Date }): Promise<Result<{ alreadyErased: boolean }, unknown>>;
}
export async function eraseAllRegistrationsForMember(input, deps): Promise<Result<{ erasedCount: number; alreadyErasedCount: number; failedCount: number }, never>> {
  const regs = await deps.list(input.tenantId, input.memberId);
  let erasedCount = 0, alreadyErasedCount = 0, failedCount = 0;
  for (const { registrationId, eventId } of regs) {
    try {
      const r = await deps.eraseOne(registrationId, eventId, { tenantId: input.tenantId, actorUserId: input.actorUserId, reasonText: `member_erasure ${input.memberId}`, occurredAt: input.occurredAt });
      if (!r.ok) { failedCount++; logger.error({ registrationId, memberId: input.memberId }, 'erase-all-registrations: eraseOne not ok'); }
      else if (r.value.alreadyErased) alreadyErasedCount++;
      else erasedCount++;
    } catch (e) {
      failedCount++;
      logger.error({ registrationId, memberId: input.memberId, err: e instanceof Error ? e.message : String(e) }, 'erase-all-registrations: eraseOne threw');
    }
  }
  return ok({ erasedCount, alreadyErasedCount, failedCount });
}
```

- [ ] **Step 4: Run — PASS; commit.**

```bash
git add src/modules/events/application/use-cases/erase-all-registrations-for-member.ts tests/unit/events/application/erase-all-registrations-for-member.test.ts
git commit -m "feat(events): eraseAllRegistrationsForMember best-effort fan-out (COMP-1 US2c)"
```

---

## Task 3: Barrel-export + composition factory

**Files:**
- Modify: `src/modules/events/index.ts`

- [ ] **Step 1: Barrel-export** `eraseAttendeePii` (+ its input/output/error types), `eraseAllRegistrationsForMember` (+ its types), and a composition factory:
```ts
export function makeEraseAllRegistrationsForMemberDeps(tenant: TenantContext): EraseAllRegistrationsForMemberDeps {
  return {
    list: (tenantId, memberId) =>
      runInTenant(asTenantContext(tenantId), (tx) => makeDrizzleRegistrationsRepository(tx).listMemberRegistrationsInTx(tenantId as TenantId, memberId)),
    eraseOne: (registrationId, eventId, input) =>
      runInTenant(tenant, (tx) =>
        eraseAttendeePii(
          { tenantId: input.tenantId as TenantId, eventId: asEventId(eventId), registrationId: asRegistrationId(registrationId), actorUserId: input.actorUserId as UserId, reasonText: input.reasonText, occurredAt: input.occurredAt },
          { eventsRepo: makeDrizzleEventsRepository(tx), registrationsRepo: makeDrizzleRegistrationsRepository(tx), advisoryLockAcquirer: makeAdvisoryLockAcquirer(tx), audit: makePinoAuditPort(tx) },
        ),
    ),
  };
}
```
Adjust the `runInTenant`/branded-id imports + the exact `makeEraseAttendeePiiDeps`-equivalent (there may already be a `makeEraseAttendeePiiDeps` in `src/lib/events-admin-deps.ts` — REUSE it instead of hand-assembling the 4 deps; grep `eraseAttendeePii` in `src/lib`). Find the real advisory-lock acquirer factory name. The `architecture/events-barrel.test.ts` must still pass (no raw infra factory re-exported — the composition factory returns Application-shaped deps, which is allowed).

- [ ] **Step 2: True typecheck → 0; run `tests/unit/architecture/events-barrel.test.ts` → green; commit.**

```bash
git add src/modules/events/index.ts
git commit -m "feat(events): barrel-export erase fan-out + composition factory (COMP-1 US2c)"
```

---

## Task 4: `EventRegistrationErasurePort` + adapter (members)

**Files:**
- Create: `src/modules/members/application/ports/event-registration-erasure-port.ts`, `…/infrastructure/adapters/event-registration-erasure-adapter.ts`

- [ ] **Step 1: Port** (mirror the cascade ports):
```ts
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '../../domain/member';

export interface EventRegistrationErasurePort {
  eraseAllForMember(
    tenant: TenantContext,
    memberId: MemberId,
    meta: { readonly actorUserId: string; readonly requestId: string | null },
  ): Promise<{ readonly outcome: 'ok' | 'partial' | 'failed'; readonly erasedCount?: number; readonly failedCount?: number }>;
}
```

- [ ] **Step 2: Adapter** — call `eraseAllRegistrationsForMember(input, makeEraseAllRegistrationsForMemberDeps(tenant))` via the events barrel; map: result `ok` with `failedCount === 0` → `{ outcome:'ok', erasedCount }`; `ok` with `failedCount > 0` → `{ outcome:'partial', erasedCount, failedCount }`; a throw → `{ outcome:'failed' }` (+ logger.error). Export a `noopEventRegistrationErasureAdapter` for tests.

- [ ] **Step 3: True typecheck → 0; commit.**

```bash
git add src/modules/members/application/ports/event-registration-erasure-port.ts src/modules/members/infrastructure/adapters/event-registration-erasure-adapter.ts
git commit -m "feat(members): EventRegistrationErasurePort + adapter (COMP-1 US2c)"
```

---

## Task 5: Wire the F6 fan-out cascade into `eraseMember`

**Files:**
- Modify: `src/modules/members/application/use-cases/erase-member.ts`, `src/modules/members/members-deps.ts`
- Test: `tests/unit/members/application/erase-member.test.ts`, `tests/unit/members/members-deps.test.ts`

- [ ] **Step 1: Add failing unit cases (RED)** — add `eventRegistrationErasure` to `buildEraseDeps` (default `{ outcome:'ok' }`). Cases: (a) happy → port called with `(deps.tenant, 'm-1', …)` + `cascadesComplete:true`; (b) `{ outcome:'partial', failedCount:1 }` → `cascadesComplete:false` + no `member_erased`; (c) `{ outcome:'failed' }` → `cascadesComplete:false`.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Add the dep + cascade block** — `eventRegistrationErasure: EventRegistrationErasurePort` in `EraseMemberDeps`; a `try/catch` block in the post-commit section calling `deps.eventRegistrationErasure.eraseAllForMember(deps.tenant, memberId, { actorUserId: meta.actorUserId, requestId: meta.requestId })`, flipping `allCascadesClean = false` on `outcome !== 'ok'` (both `'partial'` and `'failed'`) or a throw (mirror the existing cascade blocks' logging — log `erasedCount`/`failedCount` on partial).

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Wire `buildEraseMemberDeps`** (`eventRegistrationErasure: eventRegistrationErasureAdapter`) + the `members-deps.test.ts` guard key-set.

- [ ] **Step 6: True typecheck → 0; commit.**

```bash
git add src/modules/members/application/use-cases/erase-member.ts src/modules/members/members-deps.ts tests/unit/members/application/erase-member.test.ts tests/unit/members/application/erase-member.fixtures.ts tests/unit/members/members-deps.test.ts
git commit -m "feat(members): wire F6 registration fan-out cascade into eraseMember (COMP-1 US2c)"
```

---

## Task 6: End-to-end live-Neon — fan-out hard-deletes all matched registrations + the throw-path

**Files:**
- Test: `tests/integration/members/erase-member-f6-registrations.test.ts` (create)

- [ ] **Step 1: Write the e2e (RED→GREEN)** — seed a member with 3 matched registrations across 2 events (≥1 with `counted_against_partnership = true` so a credit-back audit fires) + 1 registration matched to a DIFFERENT member. Run the production `eraseMember`. Assert via raw selects:
- all 3 of the erased member's registrations are GONE (`SELECT … WHERE matched_member_id = member` → 0 rows);
- the OTHER member's registration is untouched;
- `pii_erasure_completed` audits = 3, `quota_credit_back_archive` ≥ 1; `member_erased` present; `cascadesComplete: true`;
- **no residual attendee email** for the member anywhere in `event_registrations`.

- [ ] **Step 2: Throw-path integration (design §10)** — a second test: seed 3 registrations, monkeypatch/inject a deps that makes `eraseOne` fail on the 2nd (e.g. via a wrapper deps in a direct `eraseAllRegistrationsForMember` call, since injecting a failure through the full `eraseMember` is hard) → assert registrations 1 + 3 ARE deleted, `failedCount === 1`, and a re-run completes registration 2 (idempotent re-drive). This proves best-effort + resumability, not a silent abort.

- [ ] **Step 3: Final gates** — unit (erase-member, events fan-out) + integration (the new files) + lint + true typecheck.

- [ ] **Step 4: Commit.**

```bash
git add tests/integration/members/erase-member-f6-registrations.test.ts tests/integration/events/*erase-all*.test.ts
git commit -m "test(members): eraseMember F6 fan-out e2e + throw-path resumability (COMP-1 US2c)"
```

---

## Self-Review

**Spec coverage (§5 F6 row, §10 "F6 fan-out throw-path" oracle):** member-keyed list method → Task 1 ✓; `eraseAllRegistrationsForMember` reusing `eraseAttendeePii` semantics (quota credit-back + advisory lock per registration, idempotent) → Tasks 2-3 ✓; **best-effort throw-path (continue past a failure, re-drive, not silent abort)** → Task 2 unit + Task 6 integration ✓; barrel-export + composition factory (RLS-safe per-registration tx) → Task 3 ✓; port/adapter mirror → Task 4 ✓; wired post-commit best-effort flipping `cascadesComplete` (partial OR failed) → Task 5 ✓.

**Placeholders:** the composition factory (Task 3) points to reusing a real existing `makeEraseAttendeePiiDeps` / advisory-lock acquirer (grep-located, not invented); the deps abstraction in Task 2 makes the use-case unit-testable. No `0XXX` migration (US2c needs no schema/enum change — all F6 audit events already exist).

**Type consistency:** `listMemberRegistrationsInTx(tenantId, memberId) → {registrationId, eventId}[]` consistent Task 1 ↔ Task 3. `EraseAllRegistrationsForMemberDeps.{list,eraseOne}` consistent Task 2 ↔ Task 3. `eraseAllRegistrationsForMember(input, deps) → {erasedCount, alreadyErasedCount, failedCount}` consistent Task 2 ↔ Task 4. `EventRegistrationErasurePort.eraseAllForMember(tenant, memberId, meta)` consistent Task 4 (def) ↔ Task 5 (call) ↔ fixture. `cascadesComplete` (not `completed`).

**Scope boundary:** US2c is F6 only. F1 (US2a), F7 (US2b), reconciler (US2d) separate. The cascade block is order-independent of the others.
