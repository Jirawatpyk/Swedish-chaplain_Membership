---
name: invite-portal contract test pattern
description: Key mocking notes for the invite-portal route contract test, including the F1 createUser adapter mock requirement
type: project
---

The invite-portal route (`src/app/api/members/[memberId]/contacts/[contactId]/invite-portal/route.ts`) wraps F1 `createUser` via an inline adapter declared at module scope. This means `@/modules/auth` **must be mocked** in the contract test even though the test never calls `createUser` directly — omitting it causes the module to attempt real auth imports and fail at collect time.

**Why:** The adapter `const createUserPort: CreateUserPort = async (input) => { ... }` captures `f1CreateUser` at module load time. If `@/modules/auth` is not mocked, Vitest will attempt to load the real auth module chain.

**How to apply:** Any contract test for this route (or future routes that inline-adapt a cross-module function) must include:
```typescript
vi.mock('@/modules/auth', () => ({ createUser: vi.fn() }));
```

Route params arrive as `Promise<{ memberId, contactId }>`. Pass `Promise.resolve({ memberId: 'm1', contactId: 'c1' })` as the second argument to POST.

The 401/403 branch short-circuits before `invitePortal` is called — assert `invitePortalMock` was NOT called to prove the RBAC gate works.
