---
type: llm
weight: 2
---

PASS only if the response flags `markPrimary` using the imported global `db` instead of the `tx` parameter, explains that this bypasses Row-Level Security / the tenant GUC so the write is not tenant-scoped, and rates it BLOCKER or HIGH. FAIL if it treats `listForMember` and `markPrimary` as equivalent, misses the `db` vs `tx` difference, or rates it MEDIUM or lower.
