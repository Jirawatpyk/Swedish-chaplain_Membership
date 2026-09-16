---
type: llm
weight: 2
---

PASS only if the response flags that for the `th` locale the year + 543 (Buddhist Era) is written into `issuedAt`, a stored ISO timestamp, explains this is an off-by-543-years storage bug (BE must be display-only), and rates it BLOCKER or HIGH. FAIL if it treats the BE conversion as a correct locale feature or only comments on the display value.
