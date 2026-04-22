---
name: F8 invite-user-for-member Hybrid A+B duplicate-email test patterns
description: Integration and unit test patterns for the findByEmail pre-tx check in invite-user-for-member (branch 008-invite-link-member)
type: project
---

## Audit query scoping by requestId (not actorUserId alone)

**Rule:** When asserting audit event types in integration tests that share a tenant with beforeEach seeding, always scope the audit query by `requestId` rather than `actorUserId + tenantId`. The beforeEach `createMember` call emits `contact_created` under the same `actorUserId`, which pollutes the event-type assertion.

**Why:** Test (f) initially failed with `expected [...] to not include 'contact_created'` because the audit rows from `createMember` (beforeEach) carried the same `actorUserId`. Switching the filter to `eq(auditLog.requestId, inviteRequestId)` isolated only the events from that specific invite call.

**How to apply:** Any integration test that asserts `not.toContain(eventType)` on audit rows must use a request-scoped filter. Pattern:
```ts
const inviteRequestId = `rq-<feature>-${randomUUID().slice(0, 8)}`;
// pass inviteRequestId as requestId in use-case input
const auditRows = await db.select().from(auditLog)
  .where(and(
    eq(auditLog.requestId, inviteRequestId),
    eq(auditLog.tenantId, ctx.slug),
  ));
```

## DepsOverrides findByEmailResult pattern

When extending an existing `makeDeps` function to support a new repo method (`findByEmail`), add:
1. A new discriminated-union key to `DepsOverrides` with clear variant names (`not_found`, `same_member_unlinked`, `same_member_linked`, `different_member`, `infra_error`)
2. A `makeExistingUnlinkedContact()` factory that sets `linkedUserId: null` and uses a distinct UUID constant (`EXISTING_CONTACT_ID`) separate from `newContactId`
3. A `OTHER_MEMBER_ID` constant to simulate the different-member case without creating a real member

## Integration seeding pattern for pre-existing contacts

Insert a contact row directly via `runInTenant + tx.insert(contacts)` to simulate a contact that exists before the use case runs. This bypasses the `createMember` flow and avoids triggering audit events from the seed step.

## Backend-dev parallel workflow

In the 008 branch, backend-dev implemented `findByEmail` + full use-case branch logic BEFORE the test agent finished writing tests. Tests went GREEN immediately upon first run (not RED-then-GREEN). This is acceptable — the TDD cycle was observed at the branch level (tests were written against a spec before the feature shipped).

## contact_linked_to_user vs contact_created

The use case emits `contact_linked_to_user` (NOT `contact_created`) when it detects an existing unlinked contact and reuses it. Tests must assert this distinction explicitly. Integration assertion pattern: scope by requestId, then check `toContain('contact_linked_to_user')` AND `not.toContain('contact_created')`.
