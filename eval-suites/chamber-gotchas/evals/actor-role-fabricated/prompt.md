---
max_turns: 8
allowed_tools: [Skill]
tags: [review, gotcha]
---

You are reviewing a Chamber-OS change before merge. Chamber-OS is a multi-tenant membership SaaS (Next.js 16, Drizzle ORM, Neon Postgres with Row-Level Security, Thai tax invoices, append-only `audit_log`).

Review the file below for defects. Report each defect as: `file:line` — severity (BLOCKER / HIGH / MEDIUM / LOW) — what is wrong — a concrete failure scenario (input or state → wrong outcome) — the fix. Do not report style. If you find nothing, say so.

```ts
// src/modules/renewals/application/use-cases/replay-rejected-cycle.ts (fixture)
import type { AuditPort } from '../ports/audit-port';
import type { RenewalCycle } from '../../domain/renewal-cycle';

export async function replayRejectedCycle(cycle: RenewalCycle, audit: AuditPort, tenantId: string) {
  await audit.emit({
    tenantId,
    eventType: 'renewal_cycle_rejected',
    actorUserId: cycle.rejectActorUserId ?? null,
    actorRole: cycle.rejectActorRole ?? 'admin',
    payload: { cycle_id: cycle.id, member_id: cycle.memberId, replayed: true },
  });
}
```
