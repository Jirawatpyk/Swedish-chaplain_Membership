# void-on-reissue (Sub-project #1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a membership bill is issued through a renewal path, automatically void that member's strictly-older outstanding new-flow membership bills — via a new F4 renewal-scoped composition `issueMembershipBill` — so a member never carries two open bills for overlapping coverage.

**Architecture:** A new F4 Application use-case `issueMembershipBill` composes the **unchanged** `issueInvoice` primitive → a new narrow read `listSupersedableMembershipBills` → `voidInvoice[]` (each in its own tx, post-commit). Placement is a composition, NOT an edit to `issueInvoice` (which returns from inside its own `withTx`, so there is no in-tx hook). Mutual-void is closed by an **asymmetric `(created_at, id) <` match** (the newest bill is never voidable → deterministic single survivor, no lock). The renewal bridge swaps its bare `issueInvoice` call for `issueMembershipBill`. Raw `issueInvoice` stays pristine for import/manual/event issuance.

**Tech Stack:** TypeScript 5.7 strict · Next.js 16 · Drizzle + Neon Postgres (RLS) · Vitest (unit + live-Neon integration) · zod · existing F4 `voidInvoice`/`issueInvoice`/`InvoiceRepo` · `@/lib/metrics` OTel façade · `@/lib/env` zod flags.

Design source: `docs/superpowers/specs/2026-07-17-void-on-reissue-design.md` (rev-3, review-hardened).

## Global Constraints

- **Package manager: `pnpm`** (never npm). Conventional Commits enforced by commit-msg hook.
- **TDD, failing-first:** write the test, run it RED, implement minimal, run GREEN, commit. Money-adjacent paths get a **live-Neon integration test** (config `vitest.integration.config.ts`).
- **Integration test invocation:** pass the file **PATH positionally** — `pnpm test:integration tests/integration/invoicing/issue-membership-bill.test.ts` — NOT `-- <pattern>` (that runs the whole ~40-min suite).
- **Zero schema change / zero migration / zero new audit-enum value.** No `drizzle-kit generate`. The failed-void signal is **metric-only** (see Task 3) precisely to preserve this.
- **Tenant-scoped repo methods MUST thread `tx` from `runInTenant`** (or accept an in-tx handle), never the global `db` — silent RLS bypass otherwise.
- **Never auto-void a `paid` or a legacy §86/4.** The match binds to the new-flow bill shape `bill_document_number_raw IS NOT NULL AND document_number IS NULL`, and `voidInvoice` is called with `requireStatus: 'issued'`.
- **Kill-switch:** everything new is gated by `FEATURE_VOID_ON_REISSUE` (default `false`). Flag OFF ⇒ `issueMembershipBill` = plain issue, zero supersede.
- **Never `git add -A`** (PII risk in the working tree). Stage explicit paths only.
- **Final gate before each commit:** `pnpm typecheck` (it is NOT in the pre-push hook).
- **Branch:** `106-void-on-reissue`. **Ship-gates before flipping the flag** (Task 6): (1) prod legacy-§86/4 pre-check, (2) prove 059+F5 block stale-PI settlement.

---

### Task 1: `voidInvoice` gains `requireStatus` + `suppressCancellationEmail` + `supersededByInvoiceId`

**Files:**
- Modify: `src/modules/invoicing/application/use-cases/void-invoice.ts` (schema ~:97-106, status guard ~:211-218, email gate ~:531-536, payload base ~:480-493)
- Test: `tests/unit/invoicing/void-invoice.test.ts` (extend existing)

**Interfaces:**
- Produces: `voidInvoiceSchema` gains optional `requireStatus: z.literal('issued').optional()`, `suppressCancellationEmail: z.boolean().optional()`, `supersededByInvoiceId: z.string().uuid().optional()`. `VoidInvoiceInput` picks them up via `z.infer`. Behaviour: when `requireStatus === 'issued'`, a locked status other than `'issued'` returns `{ code: 'invalid_status', status }`; when `suppressCancellationEmail === true`, no outbox row; when `supersededByInvoiceId` is set, it is added to the `invoice_voided` payload as `superseded_by_invoice_id`.

- [ ] **Step 1: Write the failing tests** (append to `tests/unit/invoicing/void-invoice.test.ts`)

```ts
describe('void-on-reissue options', () => {
  it('requireStatus:"issued" refuses a paid bill (does not VOID-stamp a §86/4)', async () => {
    const loaded = makePaidMembershipTwoBlob(); // status: 'paid'
    const deps = makeDeps(loaded);
    const res = await voidInvoice(deps, {
      tenantId: 't1', actorUserId: 'admin-1', invoiceId: loaded.invoiceId,
      voidReason: 'auto-void: superseded', requireStatus: 'issued',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toEqual({ code: 'invalid_status', status: 'paid' });
    expect(deps.pdfRender.render).not.toHaveBeenCalled(); // never re-rendered a §86/4
  });

  it('requireStatus:"issued" still voids an issued bill', async () => {
    const loaded = makeIssuedBill(); // status: 'issued', new-flow bill
    const deps = makeDeps(loaded);
    const res = await voidInvoice(deps, {
      tenantId: 't1', actorUserId: 'admin-1', invoiceId: loaded.invoiceId,
      voidReason: 'auto-void: superseded', requireStatus: 'issued',
    });
    expect(res.ok).toBe(true);
  });

  it('suppressCancellationEmail:true enqueues NO outbox row (tenant auto_email_enabled=true)', async () => {
    const loaded = makeIssuedBill();
    const deps = makeDeps(loaded, { settings: { autoEmailEnabled: true } });
    await voidInvoice(deps, {
      tenantId: 't1', actorUserId: 'admin-1', invoiceId: loaded.invoiceId,
      voidReason: 'auto-void: superseded', suppressCancellationEmail: true,
    });
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
  });

  it('manual void (no suppress flag) STILL enqueues the cancellation email (regression)', async () => {
    const loaded = makeIssuedBill();
    const deps = makeDeps(loaded, { settings: { autoEmailEnabled: true } });
    await voidInvoice(deps, {
      tenantId: 't1', actorUserId: 'admin-1', invoiceId: loaded.invoiceId,
      voidReason: 'manual cancel',
    });
    expect(deps.outbox.enqueue).toHaveBeenCalledTimes(1);
  });

  it('supersededByInvoiceId is written to the invoice_voided payload', async () => {
    const loaded = makeIssuedBill();
    const deps = makeDeps(loaded);
    await voidInvoice(deps, {
      tenantId: 't1', actorUserId: 'admin-1', invoiceId: loaded.invoiceId,
      voidReason: 'auto-void: superseded', supersededByInvoiceId: '11111111-1111-1111-1111-111111111111',
    });
    const voidedEmit = deps.audit.emit.mock.calls.find((c) => c[1].eventType === 'invoice_voided');
    expect(voidedEmit?.[1].payload.superseded_by_invoice_id).toBe('11111111-1111-1111-1111-111111111111');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test tests/unit/invoicing/void-invoice.test.ts`
Expected: the 5 new tests FAIL (options not on the schema / behaviour absent).

- [ ] **Step 3: Add the three optional fields to the schema** (`void-invoice.ts` ~:97)

```ts
export const voidInvoiceSchema = z.object({
  tenantId: z.string().min(1),
  actorUserId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  invoiceId: z.string().uuid(),
  voidReason: z.string().trim().min(1).max(500),
  /** void-on-reissue: refuse anything not still `issued` (never VOID a paid/legacy §86/4). */
  requireStatus: z.literal('issued').optional(),
  /** void-on-reissue: suppress the FR-036 cancellation email on an automated supersede. */
  suppressCancellationEmail: z.boolean().optional(),
  /** void-on-reissue: the new bill that supersedes this one (structured audit payload). */
  supersededByInvoiceId: z.string().uuid().optional(),
});
```

- [ ] **Step 4: Narrow the status guard** (`void-invoice.ts` ~:216)

```ts
      if (lockedStatus !== 'issued' && lockedStatus !== 'paid') {
        return err({ code: 'invalid_status', status: lockedStatus });
      }
      // void-on-reissue: the automated path forbids voiding a paid §86/4 even
      // if it raced issued→paid between the caller's list and this row lock.
      if (input.requireStatus === 'issued' && lockedStatus !== 'issued') {
        return err({ code: 'invalid_status', status: lockedStatus });
      }
```

- [ ] **Step 5: Gate the cancellation email** (`void-invoice.ts` ~:534)

```ts
      const shouldAutoEmail =
        !input.suppressCancellationEmail &&
        (loaded.autoEmailOnIssue ?? settings.autoEmailEnabled);
```

- [ ] **Step 6: Add `supersededByInvoiceId` to the void payload base** (`void-invoice.ts` ~:480-493)

Find the `voidedPayloadBase` object (built around line 480) and add the field conditionally:

```ts
      const voidedPayloadBase = {
        // ...existing fields...
        ...(input.supersededByInvoiceId
          ? { superseded_by_invoice_id: input.supersededByInvoiceId }
          : {}),
      };
```

- [ ] **Step 7: Run to verify GREEN**

Run: `pnpm test tests/unit/invoicing/void-invoice.test.ts`
Expected: all pass (existing + 5 new).

- [ ] **Step 8: Typecheck + commit**

Run: `pnpm typecheck`
```bash
git add src/modules/invoicing/application/use-cases/void-invoice.ts tests/unit/invoicing/void-invoice.test.ts
git commit -m "feat(invoicing): voidInvoice requireStatus + suppressCancellationEmail + supersededByInvoiceId options"
```

---

### Task 2: `InvoiceRepo.listSupersedableMembershipBills` read (asymmetric, shape-bound, tenant-scoped)

**Files:**
- Modify: `src/modules/invoicing/application/ports/invoice-repo.ts` (add method to the `InvoiceRepo` interface, near `list` ~:98)
- Modify: `src/modules/invoicing/infrastructure/repos/drizzle-invoice-repo.ts` (implement, following the `list` pattern ~:553)
- Test: `tests/integration/invoicing/list-supersedable-membership-bills.test.ts` (new — live Neon; the shape filter + strictly-older ordering + tenant-scoping cannot be proven with mocks)

**Interfaces:**
- Produces:
```ts
// on InvoiceRepo:
listSupersedableMembershipBills(
  tenantId: string,
  memberId: string,
  bound: { readonly excludeInvoiceId: string; readonly createdAt: Date; readonly invoiceId: string },
): Promise<ReadonlyArray<{ readonly invoiceId: string }>>;
```
Returns membership invoices for `memberId` that are `status='issued' AND bill_document_number_raw IS NOT NULL AND document_number IS NULL AND (created_at, invoice_id) < (bound.createdAt, bound.invoiceId) AND invoice_id <> bound.excludeInvoiceId`, ordered by `(created_at, invoice_id)`. Consumed by Task 3.

- [ ] **Step 1: Write the failing integration test** (`tests/integration/invoicing/list-supersedable-membership-bills.test.ts`)

Mirror `tests/integration/invoicing/void-invoice.test.ts`'s harness (import `createTestTenant`, `createActiveTestUser`, `runInTenant`, `makeDrizzleInvoiceRepo`, the `seedInvoice`/`seedNewFlowRow` helpers). Seed for one member: two `issued` new-flow bills (older `B_old`, newer `B_new`), one `paid` new-flow bill `B_paid`, one legacy `issued` §86/4 `B_legacy` (`document_number` non-null), one `issued` **event** invoice `B_event`. Then:

```ts
it('returns only strictly-older issued new-flow MEMBERSHIP bills for the member', async () => {
  const repo = makeDrizzleInvoiceRepo(tenant.ctx);
  const rows = await repo.listSupersedableMembershipBills(tenant.ctx.slug, memberId, {
    excludeInvoiceId: B_new.invoiceId, createdAt: B_new.createdAt, invoiceId: B_new.invoiceId,
  });
  const ids = rows.map((r) => r.invoiceId);
  expect(ids).toEqual([B_old.invoiceId]);        // ONLY the older issued new-flow bill
  expect(ids).not.toContain(B_new.invoiceId);    // exclude-self / not-strictly-older
  expect(ids).not.toContain(B_paid.invoiceId);   // paid excluded by status
  expect(ids).not.toContain(B_legacy.invoiceId); // legacy §86/4 excluded by shape
  expect(ids).not.toContain(B_event.invoiceId);  // event excluded by subject
}, 60_000);

it('is tenant-scoped (a peer tenant\'s bills are never returned)', async () => {
  // seed the same member-id shape under a second tenant; assert zero cross-tenant rows
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:integration tests/integration/invoicing/list-supersedable-membership-bills.test.ts`
Expected: FAIL — `listSupersedableMembershipBills is not a function`.

- [ ] **Step 3: Add the method to the port** (`invoice-repo.ts`, in the `InvoiceRepo` interface)

```ts
  /**
   * void-on-reissue: the member's strictly-older outstanding new-flow membership
   * bills (status='issued', bill_document_number_raw NOT NULL, document_number
   * NULL, (created_at, invoice_id) < bound). Asymmetric ordering makes the newest
   * bill un-voidable → deterministic single survivor under concurrent issue.
   */
  listSupersedableMembershipBills(
    tenantId: string,
    memberId: string,
    bound: { readonly excludeInvoiceId: string; readonly createdAt: Date; readonly invoiceId: string },
  ): Promise<ReadonlyArray<{ readonly invoiceId: string }>>;
```

- [ ] **Step 4: Implement in Drizzle** (`drizzle-invoice-repo.ts`, following the `list` pattern; `import { and, eq, lt, isNull, isNotNull, sql } from 'drizzle-orm'`)

```ts
    async listSupersedableMembershipBills(tenantIdArg, memberId, bound) {
      return runInTenant(ctx, async (tx) => {
        const rows = await (tx as TenantTx)
          .select({ invoiceId: invoices.invoiceId })
          .from(invoices)
          .where(
            and(
              eq(invoices.tenantId, tenantIdArg),
              eq(invoices.memberId, memberId),
              eq(invoices.invoiceSubject, 'membership'),
              eq(invoices.status, 'issued'),
              isNotNull(invoices.billDocumentNumberRaw),
              isNull(invoices.documentNumber),
              sql`(${invoices.createdAt}, ${invoices.invoiceId}) < (${bound.createdAt}, ${bound.invoiceId})`,
              sql`${invoices.invoiceId} <> ${bound.excludeInvoiceId}`,
            ),
          )
          .orderBy(invoices.createdAt, invoices.invoiceId);
        return rows.map((r) => ({ invoiceId: r.invoiceId }));
      });
    },
```

- [ ] **Step 5: Run to verify GREEN**

Run: `pnpm test:integration tests/integration/invoicing/list-supersedable-membership-bills.test.ts`
Expected: both tests pass.

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck`
```bash
git add src/modules/invoicing/application/ports/invoice-repo.ts src/modules/invoicing/infrastructure/repos/drizzle-invoice-repo.ts tests/integration/invoicing/list-supersedable-membership-bills.test.ts
git commit -m "feat(invoicing): listSupersedableMembershipBills read (asymmetric, shape-bound, tenant-scoped)"
```

---

### Task 3: `issueMembershipBill` composition + flag + metric + barrel exports

**Files:**
- Create: `src/modules/invoicing/application/use-cases/issue-membership-bill.ts`
- Modify: `src/lib/env.ts` (flag ~:342 schema + ~:996 features mapping)
- Modify: `src/lib/metrics.ts` (add `voidOnReissueFailed` to `invoicingMetrics` ~:481-735)
- Modify: `src/modules/invoicing/application/invoicing-deps.ts` (add `makeIssueMembershipBillDeps`)
- Modify: `src/modules/invoicing/index.ts` (barrel exports)
- Test: `tests/unit/invoicing/issue-membership-bill.test.ts` (new — unit, mocked deps)

**Interfaces:**
- Consumes: Task 1 `voidInvoice` options; Task 2 `listSupersedableMembershipBills`; `issueInvoice` (unchanged); `env.features.voidOnReissue`; `invoicingMetrics.voidOnReissueFailed`.
- Produces:
```ts
export interface IssueMembershipBillDeps {
  readonly issueDeps: IssueInvoiceDeps;
  readonly voidDeps: VoidInvoiceDeps;
  readonly invoiceRepo: InvoiceRepo;      // for listSupersedableMembershipBills
  readonly voidOnReissueEnabled: boolean; // env.features.voidOnReissue
}
export type IssueMembershipBillSuccess = IssueInvoiceSuccess & { readonly supersedeWarnings: readonly string[] };
export function issueMembershipBill(
  deps: IssueMembershipBillDeps,
  input: IssueInvoiceInput,
): Promise<Result<IssueMembershipBillSuccess, IssueInvoiceError>>;
export function makeIssueMembershipBillDeps(tenantId: string): IssueMembershipBillDeps;
```

- [ ] **Step 1: Add the env flag** (`env.ts` schema ~:342 + features ~:996)

Schema line (next to `FEATURE_088_TAX_AT_PAYMENT`):
```ts
  FEATURE_VOID_ON_REISSUE: booleanFromString.default(false),
```
Features mapping line:
```ts
    voidOnReissue: raw.FEATURE_VOID_ON_REISSUE,
```

- [ ] **Step 2: Add the metric** (`metrics.ts`, inside `invoicingMetrics`, `safeMetric`-wrapped like `auditEmitFailed`)

```ts
  voidOnReissueFailed(tenant: string): void {
    safeMetric(() => {
      counter(
        'invoicing_void_on_reissue_failed_total',
        'void-on-reissue: an automated supersede-void failed → a dangling duplicate bill remains',
      ).add(1, { tenant });
    });
  },
```

- [ ] **Step 3: Write the failing unit tests** (`tests/unit/invoicing/issue-membership-bill.test.ts`)

Mock `issueInvoice`/`voidInvoice` at the module boundary (`vi.mock('@/modules/invoicing/application/use-cases/issue-invoice', …)` + `…/void-invoice`), and pass an `invoiceRepo` stub whose `listSupersedableMembershipBills` returns fixed ids.

```ts
it('flag OFF → plain issue, no supersede, empty warnings', async () => {
  const deps = makeDeps({ enabled: false, issued: OK_ISSUED, olderBills: ['old-1'] });
  const res = await issueMembershipBill(deps, ISSUE_INPUT);
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.value.supersedeWarnings).toEqual([]);
  expect(voidInvoiceMock).not.toHaveBeenCalled();
});

it('flag ON → voids each strictly-older bill with requireStatus + suppress + supersededByInvoiceId', async () => {
  const deps = makeDeps({ enabled: true, issued: OK_ISSUED /* id:new-1 */, olderBills: ['old-1', 'old-2'] });
  const res = await issueMembershipBill(deps, ISSUE_INPUT);
  expect(res.ok).toBe(true);
  expect(voidInvoiceMock).toHaveBeenCalledTimes(2);
  expect(voidInvoiceMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    invoiceId: 'old-1', requireStatus: 'issued', suppressCancellationEmail: true, supersededByInvoiceId: 'new-1',
  }));
});

it('issue fails → returns the issue error, never lists/voids', async () => {
  const deps = makeDeps({ enabled: true, issueError: { code: 'invalid_status', status: 'draft' } });
  const res = await issueMembershipBill(deps, ISSUE_INPUT);
  expect(res.ok).toBe(false);
  expect(voidInvoiceMock).not.toHaveBeenCalled();
});

it('a void failure is non-fatal: issue still returns ok + warning + metric', async () => {
  const deps = makeDeps({ enabled: true, issued: OK_ISSUED, olderBills: ['old-1'], voidError: { code: 'concurrent_state_change' } });
  const res = await issueMembershipBill(deps, ISSUE_INPUT);
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.value.supersedeWarnings).toHaveLength(1);
  expect(metricSpy.voidOnReissueFailed).toHaveBeenCalledWith('t1');
});

it('invalid_status void (already void / raced to paid) is swallowed as no-op, no warning', async () => {
  const deps = makeDeps({ enabled: true, issued: OK_ISSUED, olderBills: ['old-1'], voidError: { code: 'invalid_status', status: 'paid' } });
  const res = await issueMembershipBill(deps, ISSUE_INPUT);
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.value.supersedeWarnings).toEqual([]); // invalid_status = expected no-op
  expect(metricSpy.voidOnReissueFailed).not.toHaveBeenCalled();
});
```

- [ ] **Step 4: Run to verify they fail**

Run: `pnpm test tests/unit/invoicing/issue-membership-bill.test.ts`
Expected: FAIL — module `issue-membership-bill` not found.

- [ ] **Step 5: Implement the composition** (`issue-membership-bill.ts`)

```ts
import { issueInvoice, type IssueInvoiceDeps, type IssueInvoiceInput, type IssueInvoiceError, type IssueInvoiceSuccess } from './issue-invoice';
import { voidInvoice, type VoidInvoiceDeps } from './void-invoice';
import type { InvoiceRepo } from '../ports/invoice-repo';
import { invoicingMetrics } from '@/lib/metrics';
import { ok, err, type Result } from '@/lib/result';

export interface IssueMembershipBillDeps {
  readonly issueDeps: IssueInvoiceDeps;
  readonly voidDeps: VoidInvoiceDeps;
  readonly invoiceRepo: InvoiceRepo;
  readonly voidOnReissueEnabled: boolean;
}
export type IssueMembershipBillSuccess = IssueInvoiceSuccess & { readonly supersedeWarnings: readonly string[] };

export async function issueMembershipBill(
  deps: IssueMembershipBillDeps,
  input: IssueInvoiceInput,
): Promise<Result<IssueMembershipBillSuccess, IssueInvoiceError>> {
  // 1. Issue the new bill (its own tx; commits before we void anything).
  const issued = await issueInvoice(deps.issueDeps, input);
  if (!issued.ok) return issued;

  // 2. Flag OFF → plain issue, no supersede.
  if (!deps.voidOnReissueEnabled) {
    return ok({ ...issued.value, supersedeWarnings: [] });
  }

  // 3. List the member's strictly-older outstanding new-flow membership bills
  //    (asymmetric (created_at, id) < newBill → the newest is never voided →
  //    deterministic single survivor under concurrent same-member issue).
  const newBill = issued.value;
  const supersedeWarnings: string[] = [];
  let older: ReadonlyArray<{ readonly invoiceId: string }> = [];
  try {
    if (newBill.memberId) {
      older = await deps.invoiceRepo.listSupersedableMembershipBills(
        input.tenantId,
        newBill.memberId,
        { excludeInvoiceId: newBill.invoiceId, createdAt: newBill.createdAt, invoiceId: newBill.invoiceId },
      );
    }
  } catch {
    invoicingMetrics.voidOnReissueFailed(input.tenantId);
    supersedeWarnings.push('supersede: failed to list prior bills');
    return ok({ ...newBill, supersedeWarnings });
  }

  // 4. Void each, own tx, best-effort. Never fatal to the issue.
  for (const bill of older) {
    const voided = await voidInvoice(deps.voidDeps, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      invoiceId: bill.invoiceId,
      voidReason: `auto-void: superseded by renewal reissue ${newBill.invoiceId}`,
      requireStatus: 'issued',
      suppressCancellationEmail: true,
      supersededByInvoiceId: newBill.invoiceId,
    });
    if (!voided.ok) {
      // invalid_status = expected no-op (already void, or raced to paid → correctly preserved).
      if (voided.error.code === 'invalid_status') continue;
      invoicingMetrics.voidOnReissueFailed(input.tenantId);
      supersedeWarnings.push(`supersede: void of ${bill.invoiceId} failed (${voided.error.code})`);
    }
  }
  return ok({ ...newBill, supersedeWarnings });
}
```

*(Note: confirm `newBill.createdAt` + `newBill.memberId` exist on `IssueInvoiceSuccess`/`Invoice`; `memberId` is a domain field (issue-invoice.ts:427) and `createdAt` maps from the `created_at` column — if the read model names it differently, adjust the field name here and in Task 2's `bound`.)*

- [ ] **Step 6: Add the deps factory** (`invoicing-deps.ts`, mirroring `makeVoidInvoiceDeps`/`makeIssueInvoiceDeps`)

```ts
export function makeIssueMembershipBillDeps(tenantId: string): IssueMembershipBillDeps {
  return {
    issueDeps: makeIssueInvoiceDeps(tenantId),
    voidDeps: makeVoidInvoiceDeps(tenantId),
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    voidOnReissueEnabled: env.features.voidOnReissue,
  };
}
```

- [ ] **Step 7: Barrel exports** (`invoicing/index.ts`)

Add to the use-case export block:
```ts
export {
  issueMembershipBill,
  type IssueMembershipBillDeps,
  type IssueMembershipBillSuccess,
} from './application/use-cases/issue-membership-bill';
```
Add `makeIssueMembershipBillDeps` to the composition-root re-export block (with `makeIssueInvoiceDeps`).

- [ ] **Step 8: Run to verify GREEN + typecheck**

Run: `pnpm test tests/unit/invoicing/issue-membership-bill.test.ts && pnpm typecheck`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/modules/invoicing/application/use-cases/issue-membership-bill.ts src/lib/env.ts src/lib/metrics.ts src/modules/invoicing/application/invoicing-deps.ts src/modules/invoicing/index.ts tests/unit/invoicing/issue-membership-bill.test.ts
git commit -m "feat(invoicing): issueMembershipBill composition + FEATURE_VOID_ON_REISSUE + fail metric"
```

---

### Task 4: Route the renewal bridge through `issueMembershipBill` + surface `supersedeWarnings` (live-Neon e2e)

**Files:**
- Modify: `src/modules/renewals/application/ports/f4-invoicing-bridge.ts` (add `supersedeWarnings?` to the `'issued'` result arm ~:99-104)
- Modify: `src/modules/renewals/infrastructure/ports-adapters/f4-invoicing-for-renewal-bridge-drizzle.ts` (swap `issueInvoice`/`makeIssueInvoiceDeps` for `issueMembershipBill`/`makeIssueMembershipBillDeps` ~:77; thread warnings)
- Test: `tests/integration/invoicing/issue-membership-bill.test.ts` (new — live-Neon end-to-end supersede + guard test)

**Interfaces:**
- Consumes: Task 3 `issueMembershipBill` / `makeIssueMembershipBillDeps`.
- Produces: `IssueInvoiceForRenewalResult`'s `'issued'` arm gains `readonly supersedeWarnings?: readonly string[]`.

- [ ] **Step 1: Write the failing live-Neon integration test** (`tests/integration/invoicing/issue-membership-bill.test.ts`)

Harness = the `void-invoice.ts` integration idiom. Seed a member with one OLDER `issued` new-flow membership bill, then issue a NEW membership draft and run `issueMembershipBill` (flag ON via `env.features.voidOnReissue` — set `FEATURE_VOID_ON_REISSUE=true` in the test env, or inject `voidOnReissueEnabled: true` into hand-built deps). Assert:

```ts
it('issuing a new membership bill voids the strictly-older issued bill (flag ON)', async () => {
  // …seed B_old (issued, new-flow), create+issue B_new via issueMembershipBill…
  const bOld = await selectInvoice(B_old.invoiceId);
  const bNew = await selectInvoice(B_new.invoiceId);
  expect(bOld.status).toBe('void');
  expect(bNew.status).toBe('issued');
  const voidedAudit = await selectAudit('invoice_voided', B_old.invoiceId);
  expect(voidedAudit.payload.superseded_by_invoice_id).toBe(B_new.invoiceId);
}, 60_000);

it('a paid bill and a legacy §86/4 are never voided', async () => { /* B_paid stays paid, B_legacy stays issued */ }, 60_000);

it('two concurrent issues for the same member leave exactly one survivor (asymmetric ordering)', async () => {
  // issue B1 and B2 concurrently (Promise.all); assert exactly one ends non-void, never zero
}, 60_000);

it('flag OFF → no supersede', async () => { /* env voidOnReissue false → B_old stays issued */ }, 60_000);
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:integration tests/integration/invoicing/issue-membership-bill.test.ts`
Expected: FAIL (bridge still calls bare `issueInvoice`; B_old stays `issued`).

- [ ] **Step 3: Add `supersedeWarnings` to the bridge port** (`f4-invoicing-bridge.ts` ~:99)

```ts
  | {
      readonly status: 'issued';
      readonly invoiceId: string;
      readonly invoiceNumber: string;
      readonly totalSatang: Satang;
      readonly supersedeWarnings?: readonly string[];
    }
```

- [ ] **Step 4: Swap the bridge call** (`f4-invoicing-for-renewal-bridge-drizzle.ts` ~:77; update imports on ~:16-22)

```ts
    const issueResult = await issueMembershipBill(
      makeIssueMembershipBillDeps(input.tenantId),
      {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        invoiceId: draft.invoiceId,
      },
    );
    if (!issueResult.ok) {
      return { status: 'issue_failed', errorCode: issueResult.error.code,
        detail: 'reason' in issueResult.error ? String(issueResult.error.reason) : issueResult.error.code };
    }
    const issued = issueResult.value;
```
Then include `supersedeWarnings: issued.supersedeWarnings` on the returned `'issued'` object. Update the import line to pull `issueMembershipBill, makeIssueMembershipBillDeps` from the barrel (drop `issueInvoice, makeIssueInvoiceDeps` if now unused).

- [ ] **Step 5: Add the entry-point guard test** (same integration file)

```ts
it('the renewal bridge routes through issueMembershipBill, not bare issueInvoice', () => {
  // static guard: assert the bridge module does not import `issueInvoice` for the issue step
  const src = readFileSync('src/modules/renewals/infrastructure/ports-adapters/f4-invoicing-for-renewal-bridge-drizzle.ts', 'utf8');
  expect(src).toMatch(/issueMembershipBill/);
  expect(src).not.toMatch(/\bissueInvoice\(/); // no bare issueInvoice call remains
});
```

- [ ] **Step 6: Run to verify GREEN + typecheck**

Run: `pnpm test:integration tests/integration/invoicing/issue-membership-bill.test.ts && pnpm typecheck`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/modules/renewals/application/ports/f4-invoicing-bridge.ts src/modules/renewals/infrastructure/ports-adapters/f4-invoicing-for-renewal-bridge-drizzle.ts tests/integration/invoicing/issue-membership-bill.test.ts
git commit -m "feat(renewals): route renewal issuance through issueMembershipBill (void-on-reissue) + supersedeWarnings"
```

---

### Task 5: Retire the manual "void the old bill" runbook copy + i18n

**Files:**
- Modify: `src/i18n/messages/en.json`, `src/i18n/messages/th.json`, `src/i18n/messages/sv.json` (the reactivation callout key(s) carrying "void the old open bill")
- Modify: `src/modules/invoicing/application/use-cases/record-payment.ts` (the `membership_terminated` doc-comment ~:178-186 — note auto-void)
- Modify: `docs/runbooks/*` reactivation runbook (if present)
- Test: existing i18n coverage (`pnpm check:i18n`) + the audit/label build guards

**Interfaces:** none (copy only).

- [ ] **Step 1: Locate the callout key**

Run: `git grep -n "void the old" src/i18n/messages/en.json` (and grep TH/SV for the parallel key). Record the exact key path (an `admin.renewals.*` string per spec §7).

- [ ] **Step 2: Update EN + TH + SV** — remove the "void the old open bill" instruction from the callout (the system now does it automatically). Keep the "Renew Lapsed Member → record payment on the new invoice" guidance. TH must stay Thai script; SV must differ from EN (label-coverage guard).

- [ ] **Step 3: Update the `record-payment.ts` doc-comment** (~:178-186) to note that reactivation now auto-voids the old bill (void-on-reissue).

- [ ] **Step 4: Verify i18n gates**

Run: `pnpm check:i18n`
Expected: pass (no missing keys; all three locales present).

- [ ] **Step 5: Commit**

```bash
git add src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json src/modules/invoicing/application/use-cases/record-payment.ts
git commit -m "docs(renewals): retire the manual void-the-old-bill runbook step (auto-voided now)"
```

---

### Task 6: Ship-gate tooling — prod legacy-§86/4 pre-check + stale-PI verification note

**Files:**
- Create: `scripts/check-legacy-membership-86-4.ts` (read-only prod query, dry-run)
- Modify: `docs/runbooks/db-environment-branching.md` or the reactivation runbook (document both ship-gates + the flag-flip order)

**Interfaces:** none (ops tooling).

- [ ] **Step 1: Write the pre-check script** (`scripts/check-legacy-membership-86-4.ts`, following the read-only `scripts/*` idiom, no writes)

Query and print the count + ids of `invoice_subject='membership' AND status='issued' AND document_number IS NOT NULL` per tenant. Run against prod read-only (`node --env-file=.env.local.bak.prod`). Exit non-zero if any exist (so it can gate a deploy).

```ts
// prints legacy issued §86/4 membership rows that auto-void must NOT touch;
// hand any to the treasurer for manual §86/10/ป.86/2542 cancellation before enabling.
```

- [ ] **Step 2: Run it against prod (read-only)**

Run: `node --env-file=.env.local.bak.prod scripts/check-legacy-membership-86-4.ts`
Expected: prints `0 legacy issued §86/4 membership rows` (or a list to hand off).

- [ ] **Step 3: Document both ship-gates** in the runbook: (1) this pre-check must be clean; (2) prove the 059 portal chokepoint + F5 prevent a stale Stripe PaymentIntent from settling a terminated member's old bill (verify: a terminated member cannot reach the pay-sheet, and F5 does not confirm a pre-termination PI on an old bill). Only then set `FEATURE_VOID_ON_REISSUE=true` in prod env + redeploy.

- [ ] **Step 4: Commit**

```bash
git add scripts/check-legacy-membership-86-4.ts docs/runbooks/db-environment-branching.md
git commit -m "chore(invoicing): void-on-reissue ship-gate pre-check + runbook"
```

---

## Full-suite gate (before opening the PR)

After Task 6, run the touched-module gates:

```bash
pnpm lint && pnpm typecheck && pnpm test tests/unit/invoicing && pnpm test:integration tests/integration/invoicing/issue-membership-bill.test.ts tests/integration/invoicing/list-supersedable-membership-bills.test.ts tests/integration/invoicing/void-invoice.test.ts && pnpm check:i18n
```

The flag ships **OFF** — merge does not change prod behaviour. Enabling is the two Task-6 ship-gates + a deliberate env flip.

---

## Self-Review (writing-plans checklist — run after writing)

**1. Spec coverage** — every rev-3 spec requirement maps to a task:
- §4.1 composition (not inside issueInvoice) → Task 3. · §4.2 asymmetric + shape match → Task 2. · §4.3 requireStatus + suppress + issue-first + own-tx → Tasks 1 + 3. · §4.4 metric-only failed-void (rollback-surviving; NOT invoice_voided) → Task 3 (plan decision: metric-only preserves zero-schema; the spec left the durable-audit choice to plan time). · §4.5 supersededByInvoiceId payload + idempotency → Tasks 1 + 3. · §5 F4 ownership + entry-point guard → Tasks 3 + 4. · §6 zero-schema + kill-switch + 2 ship-gates → Tasks 3 + 6. · §7 runbook/i18n → Task 5. · §8 tests (all 12) → distributed across Tasks 1-4. · §9 assumptions (backfill uses raw issueInvoice; webhook edge = ship-gate) → Tasks 3 (untouched raw path) + 6. · §10 #2 follow-ons → out of scope (correctly).
- Gap check: §8 test 6 (multi-bill partial-failure) → Task 3 unit "void failure non-fatal" covers single; add a 2-bill variant in Task 3 Step 3 if a reviewer wants the loop explicitly. §8 test 9 (subject filter + exclude-self) → Task 2 integration covers it at the read layer.
**2. Placeholder scan** — no TBD/TODO; every code step shows real code; the one "confirm field name" note (Task 3 Step 5) is a named verification, not a placeholder.
**3. Type consistency** — `issueMembershipBill` / `IssueMembershipBillDeps` / `makeIssueMembershipBillDeps` / `listSupersedableMembershipBills` / `supersedeWarnings` / `voidOnReissue` (env) / `voidOnReissueFailed` (metric) used identically across Tasks 2-4.
