---
name: Contract test patterns — Chamber-OS
description: Confirmed idioms for writing contract tests in tests/contract/ — dynamic import, mock wiring, public endpoint vs admin endpoint shape
type: feedback
---

Use dynamic `await import(...)` inside each `it()` block for the route under test (matches existing tests/contract/members/ pattern). Top-level static import would also work with vi.mock hoisting but breaks directory consistency.

**Why:** The members/ contract tests use dynamic imports — mixing patterns in the same directory causes confusion in code review.

**How to apply:** Always use `const { POST } = await import('@/app/api/...')` inside each test case, not at the top of the file.

---

For public endpoints with route-level rate limiting (not use-case-level), mock `rateLimiter` from `@/lib/auth-deps` directly. The rate limiter check shape is `{ success, remaining, reset }` where `reset` is milliseconds epoch. The handler computes `retry-after` as `Math.ceil((rl.reset - Date.now()) / 1000)` — assert the header exists and is a positive number, not an exact value, to avoid timing flakiness.

**Why:** `Date.now()` at assertion time differs from `Date.now()` at handler execution time by a few ms — exact value assertions flake.

**How to apply:** `expect(Number(retryAfter)).toBeGreaterThan(0)` rather than `toBe('60')`.

---

When a route handler has a `switch` on use-case error codes, each `case` is a separate branch that must be tested individually — even if they all return the same HTTP status. The `not_found` and `wrong_type` cases in the email-change revert route both return 400 but are distinct switch branches.

**Why:** Coverage thresholds require 100% branch on security-critical use cases. Missing a switch branch drops branch coverage silently.

**How to apply:** Always read the route handler source before writing tests; count every `case` in every `switch` and add a dedicated test per case.

---

For `buildPublicEmailChangeLookup`, the mock pattern is:
```typescript
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: (...args: unknown[]) => buildMembersDepsMock(...args),
  buildPublicEmailChangeLookup: () => buildPublicEmailChangeLookupMock(),
}));
```
The outer mock factory returns an object with `findActiveToken`, which is then replaced with `findActiveTokenMock`. The double-layer (mock the builder, builder returns object with mock fn) is required because the route calls `buildPublicEmailChangeLookup().findActiveToken(...)` in two separate steps.
