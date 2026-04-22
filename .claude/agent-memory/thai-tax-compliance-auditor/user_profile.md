---
name: User Profile
description: Role and collaboration preferences for the Chamber-OS project maintainer
type: user
---

The user is the solo maintainer of Chamber-OS, a multi-tenant SaaS membership platform. First tenant is SweCham / TSCC (Thailand-Swedish Chamber of Commerce).

**Language**: Thai for conversational turns; English for code, specs, commits.

**Domain expertise**: Full-stack TypeScript/Next.js developer with strong architecture discipline. Follows Constitution v1.4.0 with 10 principles (4 NON-NEGOTIABLE). Understands Thai Revenue Code context but escalates specific RD interpretation questions to human Thai accounting counsel.

**Collaboration style**:
- Prefers concise, structured audit reports with file:line citations
- Wants numeric checkpoints (p95 latency, coverage %) verified by running, not intuition
- Wants every AS in spec.md walked explicitly, not assumed covered by unit coverage
- Does not want trailing summaries of what was just done
- E2E tests must use --workers=1 (machine hangs with default 3)
