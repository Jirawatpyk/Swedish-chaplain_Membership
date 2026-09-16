---
max_turns: 8
allowed_tools: [Skill]
tags: [review, gotcha]
---

You are reviewing a Chamber-OS change before merge. Chamber-OS is a multi-tenant membership SaaS (Next.js 16, Drizzle ORM, Neon Postgres with Row-Level Security, Thai tax invoices, append-only `audit_log`).

Review the file below for defects. Report each defect as: `file:line` — severity (BLOCKER / HIGH / MEDIUM / LOW) — what is wrong — a concrete failure scenario (input or state → wrong outcome) — the fix. Do not report style. If you find nothing, say so.

```ts
// src/modules/members/application/use-cases/change-requests/submit-change-request.ts (fixture, excerpt)
import { runInTenant } from '@/modules/tenants';
import { ok, err, type Result } from '@/lib/result';

export async function submitChangeRequest(ctx: TenantContext, input: Input, deps: Deps): Promise<Result<{ id: string }, 'rate_capped' | 'member_not_found'>> {
  return runInTenant(ctx, async (tx) => {
    const member = await deps.members.findByIdInTx(tx, input.memberId);
    if (!member) return err('member_not_found');

    const id = await deps.changeRequests.insertPending(tx, { memberId: input.memberId, fields: input.fields });
    await deps.audit.emit(tx, { eventType: 'member_change_request_submitted', payload: { member_id: input.memberId, change_request_id: id } });

    const openCount = await deps.changeRequests.countOpenForMember(tx, input.memberId);
    if (openCount > deps.cap) return err('rate_capped');

    return ok({ id });
  });
}
```
