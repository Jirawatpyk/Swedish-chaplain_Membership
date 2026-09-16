---
type: llm
weight: 2
---

PASS only if the response flags `actorRole: cycle.rejectActorRole ?? 'admin'` as fabricating a role the actor may not have held in an append-only audit table, proposes recording null (or the persisted role) instead of defaulting to admin, and rates it HIGH or BLOCKER. FAIL if it accepts the default as reasonable or misses the line.
