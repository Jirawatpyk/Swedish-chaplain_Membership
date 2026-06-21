# COMP-1 US3-A — Admin Erase-member Route + UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the admin-facing trigger (standalone destructive button → gated confirmation dialog → `POST /api/members/[memberId]/erase`) that lets a chamber admin initiate a GDPR Art.17 / PDPA §33 member erasure, plus the permanent `ErasedBanner` and the in-dialog Art.12 identity attestation recorded in the audit.

**Architecture:** Reuse the member-ARCHIVE pattern wholesale (route shell, idempotency, RBAC, confirmation dialog, state banner). The route runs the already-shipped `eraseMember` use-case synchronously via `buildEraseMemberDeps`. The only core change is an additive, backward-compatible extension of `eraseMemberSchema` so the route can thread the Art.12 attestation into the existing `member_erasure_requested` audit (no new audit event type — F3 count stays 31). The detail page gains one narrow read (`getMemberErasureStatus`) to drive the banner and hide write affordances once erased.

**Tech Stack:** Next.js 16 App Router (route handler + RSC page), React 19 client component, shadcn/ui (AlertDialog, RadioGroup, Select, Checkbox, Input, Textarea), zod, next-intl (EN/TH/SV), Drizzle raw SQL (narrow read), Vitest (unit + contract + live-Neon integration), Playwright + axe-core (e2e).

**Design:** `docs/superpowers/specs/2026-06-19-member-erasure-us3a-admin-ui-design.md` (reviewed across compliance / architecture / security / tax / UX / a11y).

**Security:** This touches the `eraseMember` core input + the `member_erasure_requested` audit payload on a security-signed PII/erasure surface. The Review gate requires ≥2 reviewers, one signing the security checklist (IDOR/tenant-isolation, attestation cannot be bypassed, no PII in logs, no US1-core regression). Task 9 covers this.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/modules/members/application/use-cases/erase-member.ts` | Add OPTIONAL `identityVerified`/`verificationMethod`/`note` to `eraseMemberSchema`; thread into the `member_erasure_requested` payload; export `verificationMethodSchema` + `VERIFICATION_METHODS` + `VerificationMethod`. | Modify |
| `src/modules/members/index.ts` | Re-export the three new symbols through the public barrel. | Modify |
| `src/modules/members/infrastructure/db/member-erasure-status.ts` | New free-function narrow read `getMemberErasureStatus(ctx, memberId) → { erasedAt, completed }` for the detail-page banner. | Create |
| `src/app/api/members/[memberId]/erase/route.ts` | `POST` handler: RBAC → param/body parse (`eraseRouteSchema`, attestation REQUIRED) → idempotency → `eraseMember` → error-map. | Create |
| `src/components/members/erase-member-button.tsx` | Standalone `destructive-outline` trigger + gated `AlertDialog` (reason radio, Art.12 checkbox, method select, optional note, type-to-confirm; a11y per `confirmation-dialog.tsx`). | Create |
| `src/components/members/erased-banner.tsx` | Permanent state banner (no undelete); "completion pending" line when `!completed`. | Create |
| `src/app/(staff)/admin/members/[memberId]/page.tsx` | Call `getMemberErasureStatus`; render `EraseMemberButton` + `ErasedBanner`; gate Edit/Archive/Add-contact/Erase on `!isErased`. | Modify |
| `src/i18n/messages/{en,th,sv}.json` | New `admin.members.erase` block (dialog/banner/toasts/gate-checklist). | Modify |
| `tests/unit/members/application/erase-member.test.ts` | Add cases: attestation threaded into payload; `{ reason }`-only call still valid (reconciler back-compat). | Modify |
| `tests/integration/members/member-erasure-status.test.ts` | Live-Neon: non-erased → `{null,false}`; erased-complete → `{date,true}`. | Create |
| `tests/contract/members/erase-route.contract.test.ts` | Wire contract: 401/403/404/400(missing reason / `identityVerified!==true` / bad method / long note)/idempotency replay+conflict/200 happy. | Create |
| `tests/integration/members/erase-route-attestation.test.ts` | Live-Neon: `eraseMember` with route-shaped input → `member_erasure_requested` payload carries `identity_verified`/`verification_method`/`note`; `erased_at` set; cross-tenant → `not_found`. | Create |
| `tests/e2e/members/erase-member.spec.ts` | Playwright + axe: gating, success→banner, absent from directory, `@a11y` + `@i18n`. | Create |

---

## Task 1: Core schema extension + attestation in the requested-audit payload

**Files:**
- Modify: `src/modules/members/application/use-cases/erase-member.ts:44-50` (schema) and `:198-220` (requested-audit emit)
- Modify: `src/modules/members/index.ts:347-355` (barrel re-exports)
- Test: `tests/unit/members/application/erase-member.test.ts`

Context: `eraseMemberSchema` today is `z.object({ reason }).strict()`. `.strict()` REJECTS extra keys, so the route cannot pass attestation fields until the core schema accepts them. They are **optional in the core** (so the US2d reconciler's `{ reason }`-only re-drive at `reconcile-erasures/route.ts:130` stays valid) and **required at the route boundary** (Task 3). The `member_erasure_requested` emit at `erase-member.ts:201-207` runs only on a first request (`!alreadyErased`); a reconciler re-drive over an already-erased member skips it — so the attestation is recorded exactly once, on the originating admin request.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/members/application/erase-member.test.ts` (reuse the existing fixtures/`makeDeps` helper in that file — it builds a stub `deps` with a spy `audit.recordInTx`). If the file's helper is named differently, match it; the assertions below are the contract:

```ts
describe('US3-A — Art.12 attestation in member_erasure_requested payload', () => {
  it('threads identityVerified + verificationMethod + note into the requested-audit payload', async () => {
    const deps = makeDeps(); // existing helper: fresh member, spies on audit.recordInTx
    const res = await eraseMember(
      MEMBER_ID,
      {
        reason: 'gdpr_erasure_request',
        identityVerified: true,
        verificationMethod: 'in_person',
        note: 'DPO-2026-014',
      },
      { actorUserId: 'admin-1', requestId: 'req-1' },
      deps,
    );
    expect(res.ok).toBe(true);
    const requestedCall = deps.audit.recordInTx.mock.calls.find(
      (c) => (c[2] as { type: string }).type === 'member_erasure_requested',
    );
    expect(requestedCall).toBeDefined();
    expect((requestedCall![2] as { payload: Record<string, unknown> }).payload).toMatchObject({
      member_id: MEMBER_ID,
      reason: 'gdpr_erasure_request',
      identity_verified: true,
      verification_method: 'in_person',
      note: 'DPO-2026-014',
    });
  });

  it('reconciler-shaped { reason }-only input stays valid and omits attestation keys', async () => {
    const deps = makeDeps();
    const res = await eraseMember(
      MEMBER_ID,
      { reason: 'pdpa_deletion_request' },
      { actorUserId: 'system:cron', requestId: 'system:erase-reconcile' },
      deps,
    );
    expect(res.ok).toBe(true);
    const requestedCall = deps.audit.recordInTx.mock.calls.find(
      (c) => (c[2] as { type: string }).type === 'member_erasure_requested',
    );
    const payload = (requestedCall![2] as { payload: Record<string, unknown> }).payload;
    expect(payload).toMatchObject({ reason: 'pdpa_deletion_request' });
    expect(payload).not.toHaveProperty('identity_verified');
    expect(payload).not.toHaveProperty('verification_method');
    expect(payload).not.toHaveProperty('note');
  });

  it('rejects an unknown verificationMethod', async () => {
    const deps = makeDeps();
    const res = await eraseMember(
      MEMBER_ID,
      { reason: 'gdpr_erasure_request', identityVerified: true, verificationMethod: 'telepathy' },
      { actorUserId: 'admin-1', requestId: 'req-1' },
      deps,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.type).toBe('invalid_body');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/unit/members/application/erase-member.test.ts -t "US3-A"`
Expected: FAIL — `.strict()` rejects `identityVerified` → `invalid_body` on the first test; the new methods are unknown.

- [ ] **Step 3: Implement — extend the schema + export the method schema**

In `erase-member.ts`, replace the schema block (`:44-50`):

```ts
/**
 * COMP-1 US3-A — the Art.12 identity-verification METHOD (how identity was
 * confirmed), recorded for accountability (compliance H-1: not a bare boolean).
 * Exported so the admin route's stricter `eraseRouteSchema` + the dialog reuse
 * the SAME source of truth.
 */
export const verificationMethodSchema = z.enum([
  'verified_account_login',
  'in_person',
  'email_confirmation_loop',
  'official_document',
]);
export type VerificationMethod = z.infer<typeof verificationMethodSchema>;
export const VERIFICATION_METHODS = verificationMethodSchema.options;

export const eraseMemberSchema = z
  .object({
    reason: z.enum(['gdpr_erasure_request', 'pdpa_deletion_request']),
    // COMP-1 US3-A — OPTIONAL Art.12 accountability fields. OPTIONAL in the
    // CORE schema so the US2d reconciler's `{ reason }`-only re-drive
    // (reconcile-erasures/route.ts) stays valid; REQUIRED at the admin-route
    // boundary (eraseRouteSchema), where the human attestation belongs. A
    // system re-drive does not re-attest.
    identityVerified: z.boolean().optional(),
    verificationMethod: verificationMethodSchema.optional(),
    note: z.string().max(500).nullish(),
  })
  .strict();
```

Then in the requested-audit emit (`:201-207`), replace the `payload` with:

```ts
          payload: {
            member_id: memberId,
            reason,
            // COMP-1 US3-A — Art.12 accountability record, present ONLY on the
            // originating admin request (the route requires these fields). A
            // US2d reconciler re-drive sends `{ reason }` only AND, being a
            // re-drive over an already-erased member, never reaches this emit —
            // so the attestation is recorded exactly once. Append-only DPO log.
            ...(parsed.data.identityVerified !== undefined
              ? { identity_verified: parsed.data.identityVerified }
              : {}),
            ...(parsed.data.verificationMethod !== undefined
              ? { verification_method: parsed.data.verificationMethod }
              : {}),
            ...(parsed.data.note != null ? { note: parsed.data.note } : {}),
          },
```

- [ ] **Step 4: Export through the barrel**

In `src/modules/members/index.ts`, extend the COMP-1 US1 export block (`:347-355`):

```ts
export {
  eraseMember,
  eraseMemberSchema,
  verificationMethodSchema,
  VERIFICATION_METHODS,
  type VerificationMethod,
  type EraseMemberInput,
  type EraseMemberError,
  type EraseMemberResult,
  type EraseMemberDeps,
  type EraseMemberMeta,
} from './application/use-cases/erase-member';
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm vitest run tests/unit/members/application/erase-member.test.ts`
Expected: PASS (new + all existing erase-member unit tests).
Run the TRUE typecheck (dev server masks `pnpm typecheck`): see the repo's temp-tsconfig recipe — `npx tsc -p tsconfig.typecheck.json` excluding `.next`. Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/members/application/use-cases/erase-member.ts src/modules/members/index.ts tests/unit/members/application/erase-member.test.ts
git commit -m "feat(members): eraseMemberSchema accepts optional Art.12 attestation; threaded into requested-audit (COMP-1 US3-A)"
```

---

## Task 2: `getMemberErasureStatus` narrow read + barrel export

**Files:**
- Create: `src/modules/members/infrastructure/db/member-erasure-status.ts`
- Modify: `src/modules/members/index.ts` (barrel)
- Test: `tests/integration/members/member-erasure-status.test.ts`

Context: the member-detail page must know (a) whether the member is erased (`erased_at`) to hide write affordances + render the banner, and (b) whether the `member_erased` completion proof exists (banner "completion pending" line). `getMember`/`findById` does NOT carry `erased_at` (the `Member` aggregate omits it). Rather than widen the heavily-reviewed `MemberRepo` interface (stub churn), add a free function exported through the barrel — the established pattern for narrow reads (`countActiveMembersOnPlan`, `memberTinPresenceByIdsInTx`). `audit_log` uses a PERMISSIVE RLS policy, so the explicit `al.tenant_id = <slug>` filter in the EXISTS subquery is load-bearing.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/members/member-erasure-status.test.ts`. Model the seed/teardown on the sibling `tests/integration/members/erase-member.test.ts` (same module, live Neon, `runInTenant`, the shared member-seed helper). Skeleton:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getMemberErasureStatus, eraseMember } from '@/modules/members';
import { buildEraseMemberDeps } from '@/modules/members/members-deps';
import { asTenantContext } from '@/modules/tenants';
// Reuse the integration seed helpers used by erase-member.test.ts
// (seedMember / cleanupTenant / TENANT_SLUG). Import from the shared
// integration fixtures the sibling test uses.

const tenant = asTenantContext(TENANT_SLUG);

describe('getMemberErasureStatus (COMP-1 US3-A, live Neon)', () => {
  it('non-erased member → { erasedAt: null, completed: false }', async () => {
    const memberId = await seedMember(tenant); // active member + 1 contact
    const status = await getMemberErasureStatus(tenant, memberId);
    expect(status.erasedAt).toBeNull();
    expect(status.completed).toBe(false);
  });

  it('erased + cascades complete → { erasedAt: <Date>, completed: true }', async () => {
    const memberId = await seedMember(tenant);
    const res = await eraseMember(
      memberId,
      { reason: 'gdpr_erasure_request' },
      { actorUserId: 'admin-1', requestId: 'req-it-1' },
      buildEraseMemberDeps(tenant),
    );
    expect(res.ok && res.value.cascadesComplete).toBe(true); // clean run emits member_erased
    const status = await getMemberErasureStatus(tenant, memberId);
    expect(status.erasedAt).toBeInstanceOf(Date);
    expect(status.completed).toBe(true);
  });

  it('unknown member id → { erasedAt: null, completed: false }', async () => {
    const status = await getMemberErasureStatus(
      tenant,
      '00000000-0000-4000-8000-000000000000' as never,
    );
    expect(status.erasedAt).toBeNull();
    expect(status.completed).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:integration -- tests/integration/members/member-erasure-status.test.ts`
Expected: FAIL — `getMemberErasureStatus` does not exist.

- [ ] **Step 3: Implement the free function**

Create `src/modules/members/infrastructure/db/member-erasure-status.ts`:

```ts
/**
 * COMP-1 US3-A — narrow read for the member-detail ErasedBanner.
 *
 * Returns `members.erased_at` plus whether the `member_erased` completion
 * proof exists, in ONE round-trip (single-row SELECT + EXISTS subquery). The
 * page uses `erasedAt !== null` to hide write affordances + render the banner,
 * and `completed` to decide the banner's "completion pending" line.
 *
 * Free function (NOT a MemberRepo method) — the established narrow-read pattern
 * (countActiveMembersOnPlan / memberTinPresenceByIdsInTx) avoids widening the
 * MemberRepo interface and its many test stubs.
 *
 * RLS: `members` is RLS-scoped, so `m.member_id = <id>` inside runInTenant
 * returns only this tenant's row. `audit_log` uses a PERMISSIVE policy
 * (tenant_id IS NULL OR = current_setting), so the explicit
 * `al.tenant_id = <slug>` filter in the EXISTS is load-bearing — without it a
 * tenant-NULL or foreign row could satisfy the subquery. Threads the
 * runInTenant tx (the RLS gotcha), never the global db.
 */
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '../../domain/member';

export type MemberErasureStatus = {
  readonly erasedAt: Date | null;
  /** true ⇔ a `member_erased` completion audit exists for this member. */
  readonly completed: boolean;
};

export async function getMemberErasureStatus(
  ctx: TenantContext,
  memberId: MemberId,
): Promise<MemberErasureStatus> {
  const rows = (await runInTenant(ctx, (tx) =>
    tx.execute(sql`
      SELECT
        m.erased_at AS erased_at,
        EXISTS (
          SELECT 1 FROM audit_log al
          WHERE al.tenant_id = ${ctx.slug}
            AND al.event_type = 'member_erased'
            AND al.payload->>'member_id' = m.member_id::text
        ) AS completed
      FROM members m
      WHERE m.member_id = ${memberId}
      LIMIT 1
    `),
  )) as unknown as Array<{
    erased_at: Date | string | null;
    completed: boolean;
  }>;

  const row = rows[0];
  if (row === undefined) return { erasedAt: null, completed: false };

  const erasedAt =
    row.erased_at === null
      ? null
      : row.erased_at instanceof Date
        ? row.erased_at
        : new Date(row.erased_at);
  return { erasedAt, completed: row.completed === true };
}
```

- [ ] **Step 4: Export through the barrel**

In `src/modules/members/index.ts`, add near the other infrastructure free-function exports (after the `memberTinPresenceByIdsInTx` export, ~`:197`):

```ts
// COMP-1 US3-A — narrow erasure-status read for the member-detail ErasedBanner.
export {
  getMemberErasureStatus,
  type MemberErasureStatus,
} from './infrastructure/db/member-erasure-status';
```

- [ ] **Step 5: Run the integration test + typecheck**

Run: `pnpm test:integration -- tests/integration/members/member-erasure-status.test.ts`
Expected: PASS (3 cases).
Run the temp-tsconfig typecheck. Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/members/infrastructure/db/member-erasure-status.ts src/modules/members/index.ts tests/integration/members/member-erasure-status.test.ts
git commit -m "feat(members): getMemberErasureStatus narrow read (erased_at + member_erased proof) for the detail banner (COMP-1 US3-A)"
```

---

## Task 3: `POST /api/members/[memberId]/erase` route + contract test

**Files:**
- Create: `src/app/api/members/[memberId]/erase/route.ts`
- Test: `tests/contract/members/erase-route.contract.test.ts`

Context: mirror `src/app/api/members/[memberId]/archive/route.ts` exactly (RBAC → param parse → body parse → idempotency → use-case → error-map), swapping `archiveMember`→`eraseMember`, the body schema for the stricter `eraseRouteSchema` (attestation REQUIRED), and the response for `{ memberId, erasedAt, cascadesComplete }`. `requireAdminContext` checks session presence (401) BEFORE role (403). A `cascadesComplete:false` is still a 200 (the scrub committed; the US2d reconciler finishes the rest).

- [ ] **Step 1: Write the failing contract test**

Create `tests/contract/members/erase-route.contract.test.ts` (model the mock shape on `tests/contract/members/archive-undelete.test.ts:14-67`):

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const eraseMemberMock = vi.fn();
const buildEraseMemberDepsMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/modules/members/members-deps', () => ({
  buildEraseMemberDeps: (...args: unknown[]) => buildEraseMemberDepsMock(...args),
}));
vi.mock('@/modules/members', async () => {
  const actual = await vi.importActual<typeof import('@/modules/members')>('@/modules/members');
  return { ...actual, eraseMember: (...args: unknown[]) => eraseMemberMock(...args) };
});
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));
vi.mock('@/lib/idempotency', () => ({
  parseIdempotencyKey: (headers: Headers) => {
    const key = headers.get('idempotency-key');
    if (!key) return { ok: false, reason: 'missing' };
    return { ok: true, key };
  },
  classifyIdempotencyRequest: vi.fn(async () => ({ kind: 'first' })),
  reserveIdempotencyRecord: vi.fn(async () => ({ ok: true, value: { kind: 'reserved' as const } })),
  rememberIdempotentResponse: vi.fn(async () => undefined),
  hashRequestBody: vi.fn(() => 'hash'),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const adminContext = {
  current: { user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active', displayName: 'A' }, session: { id: 's1' } },
  sourceIp: '203.0.113.5',
  requestId: 'req-1',
};
const MEMBER_ID = '11111111-1111-4111-8111-111111111111';
const VALID_BODY = {
  reason: 'gdpr_erasure_request',
  identityVerified: true,
  verificationMethod: 'in_person',
  note: 'DPO-2026-014',
};

function makeRequest(body: unknown, headers: Record<string, string> = { 'idempotency-key': 'idem-1' }): NextRequest {
  return new NextRequest(`http://localhost/api/members/${MEMBER_ID}/erase`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function invoke(body: unknown, headers?: Record<string, string>) {
  const { POST } = await import('@/app/api/members/[memberId]/erase/route');
  return POST(makeRequest(body, headers), { params: Promise.resolve({ memberId: MEMBER_ID }) });
}

describe('contract: POST /api/members/[memberId]/erase (COMP-1 US3-A)', () => {
  afterEach(() => vi.clearAllMocks());

  it('200 happy path → eraseMember called with route-validated input', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildEraseMemberDepsMock.mockReturnValueOnce({});
    const erasedAt = new Date('2026-06-19T00:00:00Z');
    eraseMemberMock.mockResolvedValueOnce(ok({ memberId: MEMBER_ID, erasedAt, cascadesComplete: true }));
    const res = await invoke(VALID_BODY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memberId: string; erasedAt: string; cascadesComplete: boolean };
    expect(body).toEqual({ memberId: MEMBER_ID, erasedAt: erasedAt.toISOString(), cascadesComplete: true });
    expect(eraseMemberMock).toHaveBeenCalledTimes(1);
    expect(eraseMemberMock.mock.calls[0]![1]).toMatchObject({
      reason: 'gdpr_erasure_request', identityVerified: true, verificationMethod: 'in_person', note: 'DPO-2026-014',
    });
  });

  it('200 with cascadesComplete:false (reconciler will finish) is still 200', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildEraseMemberDepsMock.mockReturnValueOnce({});
    eraseMemberMock.mockResolvedValueOnce(ok({ memberId: MEMBER_ID, erasedAt: new Date(), cascadesComplete: false }));
    const res = await invoke(VALID_BODY);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { cascadesComplete: boolean }).cascadesComplete).toBe(false);
  });

  it('401 when no session (requireAdminContext returns its 401 response)', async () => {
    requireAdminContextMock.mockResolvedValueOnce({ response: new Response(JSON.stringify({ error: 'no-session' }), { status: 401 }) });
    const res = await invoke(VALID_BODY);
    expect(res.status).toBe(401);
    expect(eraseMemberMock).not.toHaveBeenCalled();
  });

  it('403 when manager (requireAdminContext returns its 403 response)', async () => {
    requireAdminContextMock.mockResolvedValueOnce({ response: new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }) });
    const res = await invoke(VALID_BODY);
    expect(res.status).toBe(403);
    expect(eraseMemberMock).not.toHaveBeenCalled();
  });

  it('400 when reason missing', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const res = await invoke({ identityVerified: true, verificationMethod: 'in_person' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_body');
    expect(eraseMemberMock).not.toHaveBeenCalled();
  });

  it('400 when identityVerified is false (attestation cannot be bypassed)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const res = await invoke({ ...VALID_BODY, identityVerified: false });
    expect(res.status).toBe(400);
    expect(eraseMemberMock).not.toHaveBeenCalled();
  });

  it('400 when identityVerified is absent', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const { identityVerified: _omit, ...noAttest } = VALID_BODY;
    const res = await invoke(noAttest);
    expect(res.status).toBe(400);
    expect(eraseMemberMock).not.toHaveBeenCalled();
  });

  it('400 when verificationMethod is unknown', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const res = await invoke({ ...VALID_BODY, verificationMethod: 'telepathy' });
    expect(res.status).toBe(400);
    expect(eraseMemberMock).not.toHaveBeenCalled();
  });

  it('400 when note exceeds 500 chars', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const res = await invoke({ ...VALID_BODY, note: 'x'.repeat(501) });
    expect(res.status).toBe(400);
    expect(eraseMemberMock).not.toHaveBeenCalled();
  });

  it('400 missing_idempotency_key when header absent', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const res = await invoke(VALID_BODY, {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('missing_idempotency_key');
  });

  it('404 when eraseMember returns not_found (cross-tenant / unknown)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildEraseMemberDepsMock.mockReturnValueOnce({});
    eraseMemberMock.mockResolvedValueOnce(err({ type: 'not_found' }));
    const res = await invoke(VALID_BODY);
    expect(res.status).toBe(404);
  });

  it('500 when eraseMember returns server_error', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildEraseMemberDepsMock.mockReturnValueOnce({});
    eraseMemberMock.mockResolvedValueOnce(err({ type: 'server_error', message: 'boom' }));
    const res = await invoke(VALID_BODY);
    expect(res.status).toBe(500);
  });

  it('409 idempotency_conflict on same key + different body', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const idem = await import('@/lib/idempotency');
    (idem.classifyIdempotencyRequest as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ kind: 'conflict' });
    const res = await invoke(VALID_BODY);
    expect(res.status).toBe(409);
    expect(eraseMemberMock).not.toHaveBeenCalled();
  });

  it('200 replay returns the remembered response without calling eraseMember', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const idem = await import('@/lib/idempotency');
    (idem.classifyIdempotencyRequest as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      kind: 'replay',
      previousResponse: { status: 200, body: { memberId: MEMBER_ID, erasedAt: '2026-06-19T00:00:00.000Z', cascadesComplete: true } },
    });
    const res = await invoke(VALID_BODY);
    expect(res.status).toBe(200);
    expect(eraseMemberMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/contract/members/erase-route.contract.test.ts`
Expected: FAIL — the route module does not exist.

- [ ] **Step 3: Implement the route**

Create `src/app/api/members/[memberId]/erase/route.ts`:

```ts
/**
 * POST /api/members/[memberId]/erase (COMP-1 US3-A).
 *
 * Admin-only GDPR Art.17 / PDPA §33 permanent erasure trigger. Mirrors the
 * archive route shell (RBAC → parse → idempotency → use-case → error-map) but
 * runs `eraseMember` (anonymise-in-place + cascades) and records the in-dialog
 * Art.12 identity attestation into the `member_erasure_requested` audit.
 *
 * The attestation is REQUIRED here (not in the core eraseMemberSchema, which
 * keeps it optional so the US2d reconciler's `{ reason }`-only re-drive stays
 * valid): `identityVerified` MUST be literally true and `verificationMethod`
 * MUST be a known method, else 400 before eraseMember is called.
 *
 * Error mapping:
 *   400 invalid_body          — eraseRouteSchema fail (missing reason,
 *                               identityVerified !== true, unknown method,
 *                               note > 500, malformed JSON)
 *   400 missing_idempotency_key
 *   401 / 403                 — RBAC (requireAdminContext; 401 no-session first)
 *   404 not_found             — member absent or cross-tenant
 *   409 idempotency_conflict
 *   503 idempotency_reservation_failed — Upstash outage
 *   200 { memberId, erasedAt, cascadesComplete } — happy path (a
 *       cascadesComplete:false is STILL 200; the reconciler finishes the rest)
 *   500 server_error
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  parseIdempotencyKey,
  classifyIdempotencyRequest,
  reserveIdempotencyRecord,
  rememberIdempotentResponse,
  hashRequestBody,
} from '@/lib/idempotency';
import { logger } from '@/lib/logger';
import { eraseMember, verificationMethodSchema } from '@/modules/members';
import type { MemberId } from '@/modules/members';
import { buildEraseMemberDeps } from '@/modules/members/members-deps';

const paramsSchema = z.object({ memberId: z.string().uuid() });

// Route-boundary schema — STRICTER than the core eraseMemberSchema: the Art.12
// attestation is mandatory at the human entry point.
const eraseRouteSchema = z
  .object({
    reason: z.enum(['gdpr_erasure_request', 'pdpa_deletion_request']),
    identityVerified: z.literal(true),
    verificationMethod: verificationMethodSchema,
    note: z.string().max(500).nullish(),
  })
  .strict();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ memberId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, { resource: 'members', action: 'write' });
  if ('response' in ctx) return ctx.response;

  const resolved = await params;
  const parsedParams = paramsSchema.safeParse(resolved);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Member not found.' } },
      { status: 404 },
    );
  }
  const memberId = parsedParams.data.memberId as MemberId;

  let rawBody: unknown = {};
  try {
    const text = await request.text();
    if (text.length > 0) rawBody = JSON.parse(text);
  } catch {
    return NextResponse.json(
      { error: { code: 'invalid_body', message: 'Body must be valid JSON.' } },
      { status: 400 },
    );
  }

  const parsedBody = eraseRouteSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_body',
          message: 'Body failed validation.',
          details: {
            issues: parsedBody.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
        },
      },
      { status: 400 },
    );
  }

  const keyCheck = parseIdempotencyKey(request.headers);
  if (!keyCheck.ok) {
    return NextResponse.json(
      {
        error: {
          code: 'missing_idempotency_key',
          message:
            keyCheck.reason === 'missing'
              ? 'Idempotency-Key header is required.'
              : 'Idempotency-Key header is malformed.',
        },
      },
      { status: 400 },
    );
  }

  const tenant = resolveTenantFromRequest(request);
  const bodyHash = hashRequestBody(rawBody, `POST /api/members/${memberId}/erase`);
  const classification = await classifyIdempotencyRequest(tenant, keyCheck.key, bodyHash);
  if (classification.kind === 'replay') {
    return NextResponse.json(classification.previousResponse.body, {
      status: classification.previousResponse.status,
    });
  }
  if (classification.kind === 'conflict') {
    return NextResponse.json(
      {
        error: {
          code: 'idempotency_conflict',
          message: 'Idempotency-Key was reused with a different body.',
        },
      },
      { status: 409 },
    );
  }
  const reserved = await reserveIdempotencyRecord(tenant, keyCheck.key, bodyHash);
  if (!reserved.ok) {
    return NextResponse.json(
      {
        error: {
          code: 'idempotency_reservation_failed',
          message: 'Idempotency reservation temporarily unavailable. Retry shortly.',
        },
      },
      { status: 503, headers: { 'Retry-After': '5' } },
    );
  }

  const deps = buildEraseMemberDeps(tenant);
  const result = await eraseMember(
    memberId,
    parsedBody.data,
    { actorUserId: ctx.current.user.id, requestId: ctx.requestId },
    deps,
  );

  if (result.ok) {
    const responseBody = {
      memberId: result.value.memberId,
      erasedAt: result.value.erasedAt.toISOString(),
      cascadesComplete: result.value.cascadesComplete,
    };
    await rememberIdempotentResponse(tenant, keyCheck.key, bodyHash, { status: 200, body: responseBody });
    return NextResponse.json(responseBody, { status: 200 });
  }

  switch (result.error.type) {
    case 'invalid_body':
      return NextResponse.json(
        { error: { code: 'invalid_body', message: 'Body failed validation.', details: { issues: result.error.issues } } },
        { status: 400 },
      );
    case 'not_found':
      return NextResponse.json(
        { error: { code: 'not_found', message: 'Member not found.' } },
        { status: 404 },
      );
    case 'server_error':
    default:
      logger.error({ requestId: ctx.requestId, err: result.error }, 'erase-member: unhandled');
      return NextResponse.json(
        { error: { code: 'server_error', message: 'Internal server error.' } },
        { status: 500 },
      );
  }
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm vitest run tests/contract/members/erase-route.contract.test.ts`
Expected: PASS (all cases).
Run the temp-tsconfig typecheck. Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/members/[memberId]/erase/route.ts" tests/contract/members/erase-route.contract.test.ts
git commit -m "feat(members): POST /api/members/[memberId]/erase admin route (RBAC + attestation + idempotency) (COMP-1 US3-A)"
```

---

## Task 4: `EraseMemberButton` component + i18n (en/th/sv)

**Files:**
- Create: `src/components/members/erase-member-button.tsx`
- Modify: `src/i18n/messages/en.json` (add `admin.members.erase` after the `archive` block at `:1393`)
- Modify: `src/i18n/messages/th.json`, `src/i18n/messages/sv.json` (mirror keys)

Context: standalone `destructive-outline` trigger + gated `AlertDialog`. a11y mirrors `src/components/shell/confirmation-dialog.tsx` (NOT archive-member-button): `initialFocus` → Cancel; the gated action uses `aria-disabled` + `aria-describedby` + a `role=status` checklist (a native `disabled` button is neither focusable nor announced). Gate: reason selected AND attestation checked AND method selected AND typed value `=== memberNumberDisplay` (exact, case-sensitive).

- [ ] **Step 1: Add the i18n keys (EN canonical first)**

In `src/i18n/messages/en.json`, add a sibling block right after the `"archive": { … }` block closes at line 1393 (inside `admin.members`):

```json
      "erase": {
        "eraseCta": "Erase (GDPR/PDPA)…",
        "dialogTitle": "Erase member (permanent)",
        "permanenceCallout": "This anonymises ALL personal data for {companyName} ({memberNumber}). It is permanent and cannot be undone.",
        "reasonLegend": "Legal basis",
        "reasonGdpr": "GDPR Art. 17 (right to erasure)",
        "reasonPdpa": "PDPA §33 (right to deletion)",
        "attestationLabel": "I confirm the data subject's identity was verified per GDPR Art. 12 / PDPA §30.",
        "methodLabel": "How was identity verified?",
        "methodPlaceholder": "Select verification method",
        "method": {
          "verified_account_login": "Verified account login (signed-in request)",
          "in_person": "In person (ID checked)",
          "email_confirmation_loop": "Email confirmation loop",
          "official_document": "Official document"
        },
        "noteLabel": "DPO reference / note (optional)",
        "notePlaceholder": "e.g. DPO ticket DPO-2026-014",
        "noteHelper": "Up to 500 characters. Recorded in the erasure audit.",
        "confirmLabel": "Type the member number {memberNumber} to confirm",
        "gateHeading": "Before you can erase, complete:",
        "gateReason": "Select a legal basis",
        "gateAttestation": "Confirm identity verification",
        "gateMethod": "Select the verification method",
        "gateTyped": "Type the member number exactly",
        "cancel": "Cancel",
        "confirmCta": "Erase permanently",
        "erasingInProgress": "Erasing…",
        "eraseSuccess": "{companyName} erased.",
        "eraseSuccessPending": "{companyName} erasure started — completion pending.",
        "eraseError": "Could not erase. Please try again.",
        "bannerTitle": "Personal data erased on {date}",
        "bannerBody": "This member's personal data was erased (GDPR Art. 17 / PDPA §33). Permanent — cannot be undone.",
        "bannerPending": "Completion pending — the automated reconciler will finish the remaining steps."
      },
```

In `src/i18n/messages/th.json` add the same key block (draft — the i18n-translation-reviewer validates in Task 9):

```json
      "erase": {
        "eraseCta": "ลบข้อมูล (GDPR/PDPA)…",
        "dialogTitle": "ลบสมาชิก (ถาวร)",
        "permanenceCallout": "การดำเนินการนี้จะลบข้อมูลส่วนบุคคลทั้งหมดของ {companyName} ({memberNumber}) แบบไม่ระบุตัวตน เป็นการถาวรและไม่สามารถย้อนกลับได้",
        "reasonLegend": "ฐานทางกฎหมาย",
        "reasonGdpr": "GDPR มาตรา 17 (สิทธิในการลบข้อมูล)",
        "reasonPdpa": "PDPA มาตรา 33 (สิทธิในการลบข้อมูล)",
        "attestationLabel": "ฉันยืนยันว่าได้ตรวจสอบตัวตนของเจ้าของข้อมูลตาม GDPR มาตรา 12 / PDPA มาตรา 30 แล้ว",
        "methodLabel": "ตรวจสอบตัวตนด้วยวิธีใด?",
        "methodPlaceholder": "เลือกวิธีตรวจสอบตัวตน",
        "method": {
          "verified_account_login": "ยืนยันผ่านการเข้าสู่ระบบบัญชี (คำขอที่ลงชื่อเข้าใช้)",
          "in_person": "พบด้วยตนเอง (ตรวจบัตรประจำตัว)",
          "email_confirmation_loop": "ยืนยันผ่านอีเมล",
          "official_document": "เอกสารราชการ"
        },
        "noteLabel": "เลขอ้างอิง DPO / หมายเหตุ (ไม่บังคับ)",
        "notePlaceholder": "เช่น เลขที่ DPO-2026-014",
        "noteHelper": "ไม่เกิน 500 ตัวอักษร บันทึกไว้ในบันทึกการตรวจสอบการลบข้อมูล",
        "confirmLabel": "พิมพ์หมายเลขสมาชิก {memberNumber} เพื่อยืนยัน",
        "gateHeading": "ก่อนลบข้อมูล กรุณาดำเนินการให้ครบ:",
        "gateReason": "เลือกฐานทางกฎหมาย",
        "gateAttestation": "ยืนยันการตรวจสอบตัวตน",
        "gateMethod": "เลือกวิธีตรวจสอบตัวตน",
        "gateTyped": "พิมพ์หมายเลขสมาชิกให้ตรงกัน",
        "cancel": "ยกเลิก",
        "confirmCta": "ลบถาวร",
        "erasingInProgress": "กำลังลบ…",
        "eraseSuccess": "ลบ {companyName} แล้ว",
        "eraseSuccessPending": "เริ่มลบ {companyName} แล้ว — รอดำเนินการให้เสร็จสมบูรณ์",
        "eraseError": "ไม่สามารถลบได้ กรุณาลองอีกครั้ง",
        "bannerTitle": "ลบข้อมูลส่วนบุคคลเมื่อ {date}",
        "bannerBody": "ข้อมูลส่วนบุคคลของสมาชิกรายนี้ถูกลบแล้ว (GDPR มาตรา 17 / PDPA มาตรา 33) เป็นการถาวร ไม่สามารถย้อนกลับได้",
        "bannerPending": "รอดำเนินการให้เสร็จสมบูรณ์ — ระบบ reconciler อัตโนมัติจะดำเนินการขั้นตอนที่เหลือ"
      },
```

In `src/i18n/messages/sv.json` add the same key block (draft):

```json
      "erase": {
        "eraseCta": "Radera (GDPR/PDPA)…",
        "dialogTitle": "Radera medlem (permanent)",
        "permanenceCallout": "Detta anonymiserar ALL persondata för {companyName} ({memberNumber}). Det är permanent och kan inte ångras.",
        "reasonLegend": "Rättslig grund",
        "reasonGdpr": "GDPR art. 17 (rätt till radering)",
        "reasonPdpa": "PDPA §33 (rätt till radering)",
        "attestationLabel": "Jag intygar att den registrerades identitet har verifierats enligt GDPR art. 12 / PDPA §30.",
        "methodLabel": "Hur verifierades identiteten?",
        "methodPlaceholder": "Välj verifieringsmetod",
        "method": {
          "verified_account_login": "Verifierad kontoinloggning (inloggad begäran)",
          "in_person": "Personligen (ID kontrollerat)",
          "email_confirmation_loop": "E-postbekräftelse",
          "official_document": "Officiellt dokument"
        },
        "noteLabel": "DPO-referens / anteckning (valfritt)",
        "notePlaceholder": "t.ex. DPO-ärende DPO-2026-014",
        "noteHelper": "Upp till 500 tecken. Sparas i raderingsloggen.",
        "confirmLabel": "Skriv medlemsnumret {memberNumber} för att bekräfta",
        "gateHeading": "Innan du kan radera, slutför:",
        "gateReason": "Välj en rättslig grund",
        "gateAttestation": "Bekräfta identitetsverifiering",
        "gateMethod": "Välj verifieringsmetod",
        "gateTyped": "Skriv medlemsnumret exakt",
        "cancel": "Avbryt",
        "confirmCta": "Radera permanent",
        "erasingInProgress": "Raderar…",
        "eraseSuccess": "{companyName} raderad.",
        "eraseSuccessPending": "Radering av {companyName} påbörjad — slutförs strax.",
        "eraseError": "Kunde inte radera. Försök igen.",
        "bannerTitle": "Personuppgifter raderade {date}",
        "bannerBody": "Den här medlemmens personuppgifter raderades (GDPR art. 17 / PDPA §33). Permanent — kan inte ångras.",
        "bannerPending": "Slutförs strax — den automatiska reconcilern avslutar de återstående stegen."
      },
```

- [ ] **Step 2: Verify i18n parity**

Run: `pnpm check:i18n`
Expected: PASS (no missing EN keys; TH/SV present). If it reports missing keys, the three blocks are out of sync — fix before continuing.

- [ ] **Step 3: Write the component**

Create `src/components/members/erase-member-button.tsx`:

```tsx
'use client';

/**
 * COMP-1 US3-A — Erase action for the member detail page.
 *
 * GDPR Art.17 / PDPA §33 permanent erasure trigger. Standalone
 * destructive-outline button (NOT an overflow-menu item — ux-standards § 19
 * forbids destructive/irreversible actions inside a "More actions" menu) that
 * opens an AlertDialog. The destructive action is gated until the admin
 * (1) picks a legal basis, (2) attests Art.12 identity verification AND picks a
 * method, and (3) types the member number exactly.
 *
 * a11y: mirrors confirmation-dialog.tsx (NOT archive-member-button) —
 * initialFocus → Cancel; the gated action uses aria-disabled +
 * aria-describedby + a role=status checklist of remaining conditions so
 * screen-reader users learn WHY it is blocked (a native `disabled` button is
 * neither focusable nor announced).
 */

import { useState, useRef, useTransition, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ShieldXIcon, Loader2Icon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { VERIFICATION_METHODS, type VerificationMethod } from '@/modules/members';

type Reason = 'gdpr_erasure_request' | 'pdpa_deletion_request';

type Props = {
  readonly memberId: string;
  readonly companyName: string;
  /** Formatted member number, e.g. "SCCM-0042" — the type-to-confirm target. */
  readonly memberNumberDisplay: string;
};

export function EraseMemberButton({ memberId, companyName, memberNumberDisplay }: Props) {
  const t = useTranslations('admin.members.erase');
  const router = useRouter();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<Reason | null>(null);
  const [identityVerified, setIdentityVerified] = useState(false);
  const [method, setMethod] = useState<VerificationMethod | null>(null);
  const [note, setNote] = useState('');
  const [typedConfirm, setTypedConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [, startTransition] = useTransition();

  const resetState = useCallback(() => {
    setReason(null);
    setIdentityVerified(false);
    setMethod(null);
    setNote('');
    setTypedConfirm('');
    setLoading(false);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) resetState();
      setOpen(next);
    },
    [resetState],
  );

  const reasonOk = reason !== null;
  const methodOk = method !== null;
  const typedOk = typedConfirm === memberNumberDisplay;
  const canConfirm = reasonOk && identityVerified && methodOk && typedOk;

  async function handleConfirm() {
    if (!canConfirm || reason === null || method === null) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/members/${memberId}/erase`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          reason,
          identityVerified: true,
          verificationMethod: method,
          note: note.trim() || null,
        }),
      });
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { cascadesComplete?: boolean };
        toast.success(
          data.cascadesComplete === false
            ? t('eraseSuccessPending', { companyName })
            : t('eraseSuccess', { companyName }),
        );
        setOpen(false);
        resetState();
        startTransition(() => router.refresh());
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        toast.error(data.error?.message ?? t('eraseError'));
      }
    } catch {
      toast.error(t('eraseError'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger
        className={buttonVariants({ variant: 'destructive-outline' })}
        aria-label={t('eraseCta')}
      >
        <ShieldXIcon className="size-4" aria-hidden="true" />
        {t('eraseCta')}
      </AlertDialogTrigger>
      <AlertDialogContent initialFocus={cancelRef}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('dialogTitle')}</AlertDialogTitle>
          {/* Prominent permanence callout (UX M3) — destructive treatment, not
              a muted AlertDialogDescription. */}
          <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm font-medium text-destructive">
            {t('permanenceCallout', { companyName, memberNumber: memberNumberDisplay })}
          </p>
        </AlertDialogHeader>

        <div className="flex flex-col gap-4">
          {/* Reason — legal basis */}
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">{t('reasonLegend')}</legend>
            <RadioGroup value={reason ?? ''} onValueChange={(v) => setReason(v as Reason)}>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="gdpr_erasure_request" id="erase-reason-gdpr" />
                <Label htmlFor="erase-reason-gdpr" className="font-normal">{t('reasonGdpr')}</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="pdpa_deletion_request" id="erase-reason-pdpa" />
                <Label htmlFor="erase-reason-pdpa" className="font-normal">{t('reasonPdpa')}</Label>
              </div>
            </RadioGroup>
          </fieldset>

          {/* Art.12 attestation */}
          <div className="flex items-start gap-2">
            <Checkbox
              id="erase-attestation"
              checked={identityVerified}
              onCheckedChange={(c) => setIdentityVerified(c === true)}
            />
            <Label htmlFor="erase-attestation" className="font-normal leading-snug">
              {t('attestationLabel')}
            </Label>
          </div>

          {/* Verification method */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="erase-method">{t('methodLabel')}</Label>
            <Select value={method ?? ''} onValueChange={(v) => setMethod(v as VerificationMethod)}>
              <SelectTrigger id="erase-method" aria-label={t('methodLabel')}>
                <SelectValue placeholder={t('methodPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {VERIFICATION_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {t(`method.${m}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Optional note */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="erase-note">{t('noteLabel')}</Label>
            <Textarea
              id="erase-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={2}
              placeholder={t('notePlaceholder')}
            />
            <p className="text-xs text-muted-foreground">{t('noteHelper')}</p>
          </div>

          {/* Type-to-confirm */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="erase-confirm">
              {t('confirmLabel', { memberNumber: memberNumberDisplay })}
            </Label>
            <Input
              id="erase-confirm"
              value={typedConfirm}
              onChange={(e) => setTypedConfirm(e.target.value)}
              placeholder={memberNumberDisplay}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>

          {/* a11y M1 — remaining-conditions checklist, announced politely. */}
          {!canConfirm && (
            <div
              id="erase-gate-checklist"
              role="status"
              className="rounded-md bg-muted p-3 text-xs text-muted-foreground"
            >
              <p className="font-medium">{t('gateHeading')}</p>
              <ul className="mt-1 list-disc pl-4">
                {!reasonOk && <li>{t('gateReason')}</li>}
                {!identityVerified && <li>{t('gateAttestation')}</li>}
                {!methodOk && <li>{t('gateMethod')}</li>}
                {!typedOk && <li>{t('gateTyped')}</li>}
              </ul>
            </div>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef} disabled={loading}>
            {t('cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            aria-disabled={!canConfirm || undefined}
            aria-describedby={!canConfirm ? 'erase-gate-checklist' : undefined}
            aria-busy={loading}
            className={buttonVariants({ variant: 'destructive' })}
            onClick={(e) => {
              e.preventDefault();
              if (!canConfirm) return;
              void handleConfirm();
            }}
          >
            {loading && (
              <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            )}
            {loading ? t('erasingInProgress') : t('confirmCta')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

- [ ] **Step 4: Typecheck + lint**

Run the temp-tsconfig typecheck + `pnpm lint` (full lint — the react-hooks/preserve-manual-memoization class only surfaces under full lint). Expected: clean. If `lucide-react` lacks `ShieldXIcon` in the pinned version, fall back to `Trash2Icon` (verify the export name resolves).

- [ ] **Step 5: Commit**

```bash
git add src/components/members/erase-member-button.tsx src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json
git commit -m "feat(members): EraseMemberButton gated confirmation dialog + erase i18n (en/th/sv) (COMP-1 US3-A)"
```

---

## Task 5: `ErasedBanner` component

**Files:**
- Create: `src/components/members/erased-banner.tsx`
- (i18n keys already added in Task 4: `bannerTitle` / `bannerBody` / `bannerPending`.)

Context: mirrors `archived-banner.tsx`'s destructive Card treatment but has NO undelete affordance — erasure is permanent. Presentational only (ISO date + `completed` flag as props). BE display for th-TH via the shared locale-aware formatter (storage stays Gregorian ISO).

- [ ] **Step 1: Write the component**

Create `src/components/members/erased-banner.tsx`:

```tsx
'use client';

/**
 * COMP-1 US3-A — ErasedBanner.
 *
 * Shown on the member detail page when `erased_at IS NOT NULL`. Mirrors
 * ArchivedBanner's destructive Card treatment but has NO undelete affordance —
 * GDPR Art.17 / PDPA §33 erasure is permanent. When the post-commit cascades
 * have not yet completed (`completed=false`, i.e. no `member_erased` proof),
 * appends a "completion pending" line (the US2d reconciler finishes the rest).
 *
 * Presentational only — receives the ISO date + completed flag as props; BE
 * display for th-TH via the shared locale-aware formatter (storage stays
 * Gregorian ISO).
 */
import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangleIcon } from 'lucide-react';
import { getDateFormatLocale } from '@/lib/format-date-localised';
import { Card } from '@/components/ui/card';

type Props = {
  readonly erasedAtIso: string;
  readonly completed: boolean;
};

export function ErasedBanner({ erasedAtIso, completed }: Props) {
  const t = useTranslations('admin.members.erase');
  const locale = useLocale();

  // BE display for th-TH per CLAUDE.md (display-only); storage stays Gregorian.
  const erasedDate = new Date(erasedAtIso);
  let isoDate: string;
  try {
    isoDate = new Intl.DateTimeFormat(getDateFormatLocale(locale), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(erasedDate);
  } catch {
    isoDate = erasedDate.toISOString().slice(0, 10);
  }

  return (
    <Card className="border-destructive/40 bg-destructive/5 p-4">
      <div className="flex gap-3">
        <AlertTriangleIcon className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
        <div>
          <p className="text-sm font-semibold">{t('bannerTitle', { date: isoDate })}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('bannerBody')}</p>
          {!completed && (
            <p className="mt-1 text-sm text-muted-foreground">{t('bannerPending')}</p>
          )}
        </div>
      </div>
    </Card>
  );
}
```

- [ ] **Step 2: Typecheck**

Run the temp-tsconfig typecheck. Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/members/erased-banner.tsx
git commit -m "feat(members): ErasedBanner permanent state banner (no undelete) (COMP-1 US3-A)"
```

---

## Task 6: Wire into the member-detail page

**Files:**
- Modify: `src/app/(staff)/admin/members/[memberId]/page.tsx`

Context: call `getMemberErasureStatus` after `getMember` resolves; compute `isErased`; render `EraseMemberButton` (shown for any non-erased member, incl. archived — UX M2) + `ErasedBanner`; gate the existing Edit/Archive/Add-contact affordances on `!isErased` (post-erase state S5). The Erase button sits LEFT of Archive (most destructive, leftmost).

- [ ] **Step 1: Add the imports**

After the existing `ArchiveMemberButton` import (`:64`), add:

```ts
import { EraseMemberButton } from '@/components/members/erase-member-button';
import { ErasedBanner } from '@/components/members/erased-banner';
```

And add `getMemberErasureStatus` to the existing `@/modules/members` import group (`:34-39`):

```ts
import {
  getMember,
  archiveWindowStatus,
  formatMemberNumber,
  resolveMemberNumberPrefix,
  getMemberErasureStatus,
} from '@/modules/members';
```

- [ ] **Step 2: Add the erasure-status read to the Promise.all**

In the `Promise.all` destructure (`:561-651`), add a fifth element. Change the destructure to:

```ts
  const [
    pendingInvitationsByContactId,
    planLookup,
    memberPrefix,
    subscriptionResult,
    erasureStatus,
  ] = await Promise.all([
```

and append as the final array element (after the `resolveContactSubscriptions({...})` call, before the closing `]`):

```ts
      // COMP-1 US3-A — narrow erasure-status read (erased_at + member_erased
      // completion proof). Drives the ErasedBanner and hides write affordances
      // once erased. Independent of the other reads — folds into the same RTT.
      getMemberErasureStatus(tenant, member.memberId),
```

- [ ] **Step 3: Derive `isErased`**

After `const windowStatus = …` (`:667-670`), add:

```ts
  const isErased = erasureStatus.erasedAt !== null;
```

- [ ] **Step 4: Replace the header `actions` block**

Replace the `actions={…}` prop (`:719-759`) with:

```tsx
        actions={
          <>
            {env.features.f9Dashboard && (
              <Link
                href={`/admin/members/${member.memberId}/benefits`}
                className={buttonVariants({ variant: 'outline' })}
              >
                <PackageOpenIcon className="size-4" />
                {t('sections.benefits')}
              </Link>
            )}
            {/* COMP-1 US3-A — write affordances all hidden once erased (post-
                erase state S5). Erase sits LEFT of Archive/Edit (most
                destructive, leftmost; Fitts's Law keeps Edit rightmost). The
                Erase trigger is shown for any non-erased member INCLUDING
                archived ones (UX M2) — erasure is orthogonal to archive; only
                Archive/Edit keep the `status !== 'archived'` gate. */}
            {canWrite && !isErased && (
              <>
                <EraseMemberButton
                  memberId={member.memberId}
                  companyName={member.companyName}
                  memberNumberDisplay={memberNumberDisplay}
                />
                {member.status !== 'archived' && (
                  <>
                    <ArchiveMemberButton
                      memberId={member.memberId}
                      companyName={member.companyName}
                    />
                    <Link
                      href={`/admin/members/${member.memberId}/edit`}
                      className={buttonVariants()}
                    >
                      <PencilIcon className="size-4" />
                      {t('editCta')}
                    </Link>
                  </>
                )}
              </>
            )}
          </>
        }
```

- [ ] **Step 5: Render `ErasedBanner` + gate `ArchivedBanner`**

Immediately after `<PageHeader … />` closes (`:760`), and BEFORE the `ArchivedBanner` block (`:762`), insert the erased banner; then gate the existing `ArchivedBanner` on `!isErased`:

```tsx
      {isErased && erasureStatus.erasedAt && (
        <ErasedBanner
          erasedAtIso={erasureStatus.erasedAt.toISOString()}
          completed={erasureStatus.completed}
        />
      )}

      {!isErased &&
        member.status === 'archived' &&
        member.archivedAt &&
        windowStatus &&
        (windowStatus.state === 'within_window' ||
          windowStatus.state === 'window_expired') && (
          <ArchivedBanner
            memberId={member.memberId}
            archivedAtIso={member.archivedAt.toISOString()}
            windowStatus={windowStatus}
          />
        )}
```

(Replace the existing `member.status === 'archived' && …` ArchivedBanner block with the `!isErased && …` version above.)

- [ ] **Step 6: Gate the Add-contact affordance**

In the Contacts CardHeader, change the add-contact gate (`:1050`) from:

```tsx
              {canWrite && member.status !== 'archived' && (
```

to:

```tsx
              {canWrite && !isErased && member.status !== 'archived' && (
```

- [ ] **Step 7: Typecheck + lint + check:layout**

Run: the temp-tsconfig typecheck, then `pnpm lint`, then `pnpm check:layout`.
Expected: all clean (the page already has a `DetailContainer`; no layout regression).

- [ ] **Step 8: Commit**

```bash
git add "src/app/(staff)/admin/members/[memberId]/page.tsx"
git commit -m "feat(members): wire Erase button + ErasedBanner into member detail; hide write actions once erased (COMP-1 US3-A)"
```

---

## Task 7: Integration test — attestation payload + cross-tenant (live Neon)

**Files:**
- Create: `tests/integration/members/erase-route-attestation.test.ts`

Context: the unit test (Task 1) asserts the payload threading against a stub; this asserts it against live Neon via the REAL `buildEraseMemberDeps` + `eraseMember`, plus the Principle I cross-tenant block (Review-gate blocker). The route's IDOR guard is inherited from `eraseMember` being tenant-scoped (`findErasedAtById` via RLS → `not_found` for a foreign member). Model seed/teardown on `tests/integration/members/erase-member.test.ts` + `erase-member-cross-tenant.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { eraseMember } from '@/modules/members';
import { buildEraseMemberDeps } from '@/modules/members/members-deps';
import { asTenantContext } from '@/modules/tenants';
import { runInTenant } from '@/lib/db';
import { sql } from 'drizzle-orm';
// Reuse the integration seed helpers (seedMember / TENANT_SLUG / a SECOND
// tenant slug) from the existing erase-member integration fixtures.

const tenantA = asTenantContext(TENANT_SLUG);

describe('erase route attestation + cross-tenant (COMP-1 US3-A, live Neon)', () => {
  it('records identity_verified + verification_method + note in member_erasure_requested', async () => {
    const memberId = await seedMember(tenantA);
    const res = await eraseMember(
      memberId,
      {
        reason: 'gdpr_erasure_request',
        identityVerified: true,
        verificationMethod: 'official_document',
        note: 'DPO-2026-014',
      },
      { actorUserId: 'admin-1', requestId: 'req-it-attest' },
      buildEraseMemberDeps(tenantA),
    );
    expect(res.ok).toBe(true);

    const rows = (await runInTenant(tenantA, (tx) =>
      tx.execute(sql`
        SELECT payload FROM audit_log
        WHERE tenant_id = ${tenantA.slug}
          AND event_type = 'member_erasure_requested'
          AND payload->>'member_id' = ${memberId}
        ORDER BY created_at DESC LIMIT 1
      `),
    )) as unknown as Array<{ payload: Record<string, unknown> }>;
    expect(rows[0]?.payload).toMatchObject({
      member_id: memberId,
      reason: 'gdpr_erasure_request',
      identity_verified: true,
      verification_method: 'official_document',
      note: 'DPO-2026-014',
    });
  });

  it('cross-tenant erase attempt → not_found (Principle I IDOR guard)', async () => {
    const memberInA = await seedMember(tenantA);
    const tenantB = asTenantContext(SECOND_TENANT_SLUG);
    const res = await eraseMember(
      memberInA,
      { reason: 'gdpr_erasure_request', identityVerified: true, verificationMethod: 'in_person' },
      { actorUserId: 'admin-b', requestId: 'req-it-xtenant' },
      buildEraseMemberDeps(tenantB),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.type).toBe('not_found');

    // The member in tenant A is untouched (still not erased).
    const rows = (await runInTenant(tenantA, (tx) =>
      tx.execute(sql`SELECT erased_at FROM members WHERE member_id = ${memberInA}`),
    )) as unknown as Array<{ erased_at: Date | null }>;
    expect(rows[0]?.erased_at).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails, then passes once the implementation is in place**

Run: `pnpm test:integration -- tests/integration/members/erase-route-attestation.test.ts`
Expected after Task 1: PASS (the schema/payload change is already implemented; this test independently confirms it on live Neon). If `SECOND_TENANT_SLUG` is not available in the fixtures, mirror the two-tenant setup from `erase-member-cross-tenant.test.ts`.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/members/erase-route-attestation.test.ts
git commit -m "test(members): live-Neon attestation payload + cross-tenant IDOR for erase (COMP-1 US3-A)"
```

---

## Task 8: E2E — gating, success→banner, absent from directory (@a11y/@i18n)

**Files:**
- Create: `tests/e2e/members/erase-member.spec.ts`

Context: Playwright + axe. Sign in as admin (`E2E_ADMIN_*` from `.env.local`; staff sign in at `/admin/sign-in`). Use a THROWAWAY member (seed via the existing E2E member-seed helper / `x-tenant` throwaway-tenant override) — NEVER a real member. Run with `--workers=1`.

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
// Reuse the e2e helpers: signInAsAdmin(), seedThrowawayMember() → { memberId, memberNumberDisplay, companyName }

test.describe('@members erase member (COMP-1 US3-A)', () => {
  test('gates the destructive button until reason + attestation + method + typed number', async ({ page }) => {
    await signInAsAdmin(page);
    const { memberId, memberNumberDisplay } = await seedThrowawayMember(page);
    await page.goto(`/admin/members/${memberId}`);

    await page.getByRole('button', { name: /Erase \(GDPR\/PDPA\)/i }).click();
    const erase = page.getByRole('alertdialog');
    const confirmBtn = erase.getByRole('button', { name: /^Erase permanently$/i });

    // Gated (aria-disabled) until all four conditions met.
    await expect(confirmBtn).toHaveAttribute('aria-disabled', 'true');
    await erase.getByLabel(/GDPR Art\. 17/i).check();
    await erase.getByLabel(/identity was verified/i).check();
    await erase.getByLabel(/How was identity verified/i).click();
    await page.getByRole('option', { name: /In person/i }).click();
    await erase.getByLabel(new RegExp(`Type the member number ${memberNumberDisplay}`)).fill(memberNumberDisplay);
    await expect(confirmBtn).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('successful erase shows the ErasedBanner and removes the member from the directory', async ({ page }) => {
    await signInAsAdmin(page);
    const { memberId, memberNumberDisplay, companyName } = await seedThrowawayMember(page);
    await page.goto(`/admin/members/${memberId}`);

    await page.getByRole('button', { name: /Erase \(GDPR\/PDPA\)/i }).click();
    const erase = page.getByRole('alertdialog');
    await erase.getByLabel(/PDPA §33/i).check();
    await erase.getByLabel(/identity was verified/i).check();
    await erase.getByLabel(/How was identity verified/i).click();
    await page.getByRole('option', { name: /Official document/i }).click();
    await erase.getByLabel(new RegExp(`Type the member number ${memberNumberDisplay}`)).fill(memberNumberDisplay);
    await erase.getByRole('button', { name: /^Erase permanently$/i }).click();

    await expect(page.getByText(/Personal data erased on/i)).toBeVisible();
    // No Edit / Archive / Erase actions remain.
    await expect(page.getByRole('button', { name: /Erase \(GDPR\/PDPA\)/i })).toHaveCount(0);

    // Absent from the directory.
    await page.goto('/admin/members');
    await expect(page.getByText(companyName)).toHaveCount(0);
  });

  test('@a11y erase dialog has no axe violations', async ({ page }) => {
    await signInAsAdmin(page);
    const { memberId } = await seedThrowawayMember(page);
    await page.goto(`/admin/members/${memberId}`);
    await page.getByRole('button', { name: /Erase \(GDPR\/PDPA\)/i }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    const results = await new AxeBuilder({ page }).include('[role="alertdialog"]').analyze();
    expect(results.violations).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the e2e**

Run: `pnpm test:e2e --grep "@members erase" --workers=1`
Expected: PASS. (Local @a11y reflow/target-size flakes are preview-only noise per the calibration note — focus on the gating + banner + directory-absence assertions, which are deterministic locally.)

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/members/erase-member.spec.ts
git commit -m "test(members): e2e erase gating + banner + directory-absence (@a11y/@i18n) (COMP-1 US3-A)"
```

---

## Task 9: Full gate sweep + security checklist sign-off

**Files:** none (verification + review)

Context: erasure surfaces are security-sensitive (≥2 reviewers, one signs the security checklist). This task runs the full local CI sweep and dispatches the security review.

- [ ] **Step 1: Full local gate sweep**

Run (reproduce CI locally):
```bash
pnpm lint && pnpm check:i18n && pnpm check:layout && pnpm vitest run tests/contract/members tests/unit/members && pnpm test:integration -- tests/integration/members/member-erasure-status.test.ts tests/integration/members/erase-route-attestation.test.ts
```
Then the temp-tsconfig typecheck (excludes `.next`). Expected: all green. Confirm the F3 audit-event-type count test still asserts **31** (no new event type was added).

- [ ] **Step 2: Spec-compliance audit**

Dispatch `spec-compliance-auditor` against `docs/superpowers/specs/2026-06-19-member-erasure-us3a-admin-ui-design.md` — walk every design decision (standalone destructive button not ⋯ menu, shown on archived members, optional note, required method, attestation recorded once, post-erase state, banner pending line, a11y gated-button pattern) against the implemented code path.

- [ ] **Step 3: Security review + checklist sign-off**

Dispatch `security-engineer` on the diff: IDOR/tenant-isolation on the new route (cross-tenant → 404), attestation cannot be spoofed to bypass the accountability record (route requires `identityVerified === true`), no PII in logs (ids/counts only), the US1-core input extension introduces no regression to the reconciler call path, idempotency replay/conflict correctness. Sign the security checklist.

- [ ] **Step 4: a11y + UX review**

Dispatch `mobile-a11y-ux-reviewer` + `chamber-os-ux-architect` on the dialog + banner + page wiring: initialFocus→Cancel, aria-disabled + aria-describedby + role=status checklist, finalFocus return, 320px reflow, target ≥44px, the destructive-outline placement (not an overflow menu).

- [ ] **Step 5: Address findings + re-run gates; finish the branch**

Fix any findings (sequential commits — no concurrent committers). Re-run the Step 1 sweep. Then use `superpowers:finishing-a-development-branch`.

---

## Self-Review (against the design spec)

**1. Spec coverage:**
- §1/§2 standalone destructive-outline button (not ⋯), shown on archived, prominent permanence callout, optional note, required method, type-to-confirm member number → Task 4 (component) + Task 6 (placement, incl. archived). ✓
- §3 `eraseMember` input extension (optional in core, required at route), attestation recorded once → Task 1 (schema + payload) + Task 3 (route eraseRouteSchema). ✓
- §4 `ErasedBanner` (no undelete) + completion-pending + post-erase page state (S5) → Task 5 (banner) + Task 6 (page gating). ✓
- §a11y (mirror confirmation-dialog: initialFocus=Cancel, aria-disabled + aria-describedby + role=status, finalFocus) → Task 4 component. ✓
- Cross-cutting: RBAC admin-only (route + hidden button) → Task 3 + Task 6; tenant isolation + cross-tenant test → Task 7; idempotency → Task 3; audit/no-PII-logs → Tasks 1/3/9; i18n EN+TH+SV → Task 4; testing contract/integration/e2e → Tasks 3/7/8; security sign-off → Task 9. ✓
- Open items: erased_at exposure resolved (getMemberErasureStatus, Task 2); "⋯ menu copy" obsolete (standalone button decided). ✓

**2. Placeholder scan:** every code step contains complete code. The TH/SV i18n blocks are full drafts (validated by the i18n-translation-reviewer in Task 9), not placeholders. The integration/e2e tests reference existing seed helpers by name (the implementer wires the exact import from the sibling test in the same directory) — this is the one spot requiring the implementer to match the local fixture names; flagged explicitly in each test task.

**3. Type consistency:** `VerificationMethod`/`verificationMethodSchema`/`VERIFICATION_METHODS` defined once in `erase-member.ts`, exported via the barrel, reused by the route schema + the dialog. `eraseRouteSchema` (route) is stricter than `eraseMemberSchema` (core). Response shape `{ memberId, erasedAt:string, cascadesComplete }` is consistent across route, contract test, and the dialog's `cascadesComplete` toast branch. `getMemberErasureStatus` returns `{ erasedAt: Date|null, completed }`, consumed by the page as `isErased` + passed to `ErasedBanner` as `erasedAtIso`/`completed`.

**4. Ambiguity:** the "completion pending" banner state reads from `getMemberErasureStatus.completed` (member_erased EXISTS) on page load, AND the just-erased toast switches on the POST's `cascadesComplete` — both wired explicitly. The type-to-confirm target is the FORMATTED display (`memberNumberDisplay`, e.g. `SCCM-0042`), passed from the page's existing `formatMemberNumber(...)` result.
