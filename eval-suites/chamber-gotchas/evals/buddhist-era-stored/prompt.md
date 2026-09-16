---
max_turns: 8
allowed_tools: [Skill]
tags: [review, gotcha]
---

You are reviewing a Chamber-OS change before merge. Chamber-OS is a multi-tenant membership SaaS (Next.js 16, Drizzle ORM, Neon Postgres with Row-Level Security, Thai tax invoices, append-only `audit_log`).

Review the file below for defects. Report each defect as: `file:line` — severity (BLOCKER / HIGH / MEDIUM / LOW) — what is wrong — a concrete failure scenario (input or state → wrong outcome) — the fix. Do not report style. If you find nothing, say so.

```ts
// src/modules/invoicing/application/use-cases/issue-membership-bill.ts (fixture, excerpt)
import { ZonedDateTime, ZoneId } from '@js-joda/core';

export function billIssueDate(now: Date, locale: 'en' | 'th' | 'sv'): { issuedAt: string; displayYear: number } {
  const bkk = ZonedDateTime.ofInstant(now.toISOString() as never, ZoneId.of('Asia/Bangkok'));
  const year = locale === 'th' ? bkk.year() + 543 : bkk.year();
  const issuedAt = `${year}-${String(bkk.monthValue()).padStart(2, '0')}-${String(bkk.dayOfMonth()).padStart(2, '0')}T00:00:00Z`;
  return { issuedAt, displayYear: year };
}
```
