---
name: F4 Cross-Border Transfer Assessment
description: Singapore hosting deviation documented in F1 plan.md; PDPA §28 + GDPR SCCs cover all F-stream features; no new cross-border surface in F4
type: project
---

All F-stream features (F1–F4 confirmed) inherit the Singapore hosting deviation documented in F1 `specs/001-auth-rbac/plan.md` Complexity Tracking row 1.

**Approved transfer destinations:**
- Vercel sin1 (Singapore): PDPA §28 + GDPR SCCs
- Neon ap-southeast-1 (Singapore): PDPA §28 + GDPR SCCs
- Upstash Singapore (Redis): PDPA §28
- Resend (transactional email): Processor DPA (SOC2 + GDPR-DPA-signed) per research §8a
- Vercel Blob (sin1): PDPA §28 + GDPR SCCs — added in F4 for PDF storage

**F4-specific:** Vercel Blob is the only new cross-border surface in F4. It is covered by the same GDPR SCCs as Vercel Functions (same data processor). No separate SCC negotiation required.

**How to apply:** For F5+ reviews, do not re-litigate the Singapore hosting deviation unless a new third-party processor (not in the list above) is introduced. New processors require explicit DPA + SCC documentation before code merges.
