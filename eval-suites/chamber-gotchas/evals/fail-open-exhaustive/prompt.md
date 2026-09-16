---
max_turns: 8
allowed_tools: [Skill]
tags: [review, gotcha]
---

You are reviewing a Chamber-OS change before merge. Chamber-OS is a multi-tenant membership SaaS (Next.js 16, Drizzle ORM, Neon Postgres with Row-Level Security, Thai tax invoices, append-only `audit_log`).

Review the file below for defects. Report each defect as: `file:line` — severity (BLOCKER / HIGH / MEDIUM / LOW) — what is wrong — a concrete failure scenario (input or state → wrong outcome) — the fix. Do not report style. If you find nothing, say so.

```ts
// src/modules/broadcasts/domain/orphan-reason.ts (fixture)
export type OrphanReason = 'member_removed' | 'contact_removed' | 'email_missing';

export function auditEventForOrphan(reason: OrphanReason): 'orphan_member_removed' | 'orphan_contact_removed' | 'orphan_email_missing' {
  switch (reason) {
    case 'member_removed':
      return 'orphan_member_removed';
    case 'contact_removed':
      return 'orphan_contact_removed';
    case 'email_missing':
      return 'orphan_email_missing';
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}
```
