---
type: llm
weight: 2
---

PASS only if the response flags the audit payload key `memberId` (camelCase) and explains that Chamber-OS conventions/triggers expect snake_case `member_id` (so the member recency trigger will not fire), rates it HIGH or MEDIUM, and proposes `member_id`. FAIL if it does not mention the payload key naming at all.
