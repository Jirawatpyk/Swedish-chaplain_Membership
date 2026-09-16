---
max_turns: 8
allowed_tools: [Skill]
tags: [review, gotcha]
---

You are reviewing a Chamber-OS change before merge. Chamber-OS is a multi-tenant membership SaaS (Next.js 16, Drizzle ORM, Neon Postgres with Row-Level Security, Thai tax invoices, append-only `audit_log`).

Review the file below for defects. Report each defect as: `file:line` — severity (BLOCKER / HIGH / MEDIUM / LOW) — what is wrong — a concrete failure scenario (input or state → wrong outcome) — the fix. Do not report style. If you find nothing, say so.

```ts
// src/modules/events/application/use-cases/record-attendance.ts (fixture, excerpt)
export async function recordAttendance(tx: Tx, deps: Deps, tenantId: string, memberId: string, eventId: string) {
  await deps.registrations.markAttended(tx, tenantId, memberId, eventId);
  await deps.audit.emit(tx, {
    tenantId,
    eventType: 'event_attendance_recorded',
    actorUserId: null,
    actorRole: 'system',
    payload: { memberId, eventId, source: 'csv_import' },
  });
}
```
