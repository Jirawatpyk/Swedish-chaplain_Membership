---
max_turns: 8
allowed_tools: [Skill]
tags: [review, gotcha]
---

You are reviewing a Chamber-OS change before merge. Chamber-OS is a multi-tenant membership SaaS (Next.js 16, Drizzle ORM, Neon Postgres with Row-Level Security, Thai tax invoices, append-only `audit_log`).

Review the file below for defects. Report each defect as: `file:line` — severity (BLOCKER / HIGH / MEDIUM / LOW) — what is wrong — a concrete failure scenario (input or state → wrong outcome) — the fix. Do not report style. If you find nothing, say so.

```ts
// src/modules/members/infrastructure/db/drizzle-contacts-repo.ts (fixture)
import { db } from '@/lib/db';
import { eq, and } from 'drizzle-orm';
import { contacts } from './schema';
import type { Tx } from '@/lib/tx';

export class DrizzleContactsRepo {
  async listForMember(tx: Tx, tenantId: string, memberId: string) {
    return tx.select().from(contacts).where(and(eq(contacts.tenantId, tenantId), eq(contacts.memberId, memberId)));
  }

  async markPrimary(tx: Tx, tenantId: string, contactId: string) {
    await db
      .update(contacts)
      .set({ isPrimary: true })
      .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)));
  }
}
```
