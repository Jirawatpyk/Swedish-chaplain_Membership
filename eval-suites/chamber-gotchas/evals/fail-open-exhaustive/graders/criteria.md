---
type: llm
weight: 2
---

PASS only if the response identifies that the `default` arm returns `_exhaustive` (the reason value itself) at runtime, explains that an unknown variant is therefore ACCEPTED rather than refused (fail-open), cites the `default` block line, and rates it HIGH or BLOCKER. FAIL if it says the switch is safe because of the `never` type, if it only mentions style, or if it misses the default arm.
