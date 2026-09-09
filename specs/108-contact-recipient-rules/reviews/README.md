# 108 — Review ledger

One file per PR (`pr-a.md`, `pr-b.md`, `pr-d.md`, `pr-c.md`) recording the gate output
(T028 / T041 / T060 / T092) and the review rounds. This README fixes the reviewer stack
and the co-sign format so every PR is signed the same way.

## Phase 9 cutover — the import build (not a PR-lettered scope)

Branch `108-phase9-cutover` replaced the batch dispatch path with the Resend
Contacts-Import build. It is reviewed as its own scope because it deletes a
subsystem rather than adding one, so the stack is wider than any single PR's.

| Round | File | Verdicts | Outcome |
|---|---|---|---|
| 1 (2026-09-08) | [`review-20260908-223000.md`](review-20260908-223000.md) | 3 NOT MERGEABLE / BLOCK / NOT SHIP-READY, 4 conditional | 56 findings, **52 closed** across 15 commits |
| 2 (2026-09-09) | [`review-20260909-081200.md`](review-20260909-081200.md) | 3 blocking, 4 conditional | 56 findings — **five of them introduced by round 1's fixes** |

Stack (7 read-only reviewers, concurrent, all on `opus`): `security-engineer` ·
`reliability-guardian` · `drizzle-migration-reviewer` ·
`pdpa-gdpr-compliance-officer` · `observability-instrumentor` ·
`chamber-os-qa-engineer` · `enterprise-ux-designer`. Closed with
`whole-branch-reviewer` (on `fable`) as the last pass.

**The rule this scope establishes: re-review the FIXES, not just the code.**
Round 2 exists because round 1's remediation was not re-reviewed, and it found
that three of the five new defects write a falsehood into an append-only table
or into a member's inbox — where the bug they replaced recorded nothing. One is
on the leg that is live at merge. Budget a round 3 for the same reason.

## Reviewer stack per PR

| PR | Scope | Read-only reviewers (concurrent) | Rounds | Checklists co-signed |
|---|---|---|---|---|
| **A** (US1) | money-email recipient, F5 billing email | `financial-integrity-reviewer`, `pci-saqa-guardian`, `security-engineer` | ≥3 `/speckit.review` → 1 `/speckit.staff-review` → fresh-agent re-review | `money.md`, `security.md` |
| **B** (US2) | one-primary invariant, DB triggers | `security-engineer`, `reliability-guardian`, `drizzle-migration-reviewer` | 3 → staff-review → re-review | `reliability.md` |
| **D** (US4+US6) | RBAC key, opt-out columns, audience page | `security-engineer`, `pdpa-gdpr-compliance-officer`, `enterprise-ux-designer` | 3 → staff-review → re-review | `privacy.md`, `ux.md` |
| **C** (US3+US5) | 1:N audience resolver, Resend import | `financial-integrity-reviewer` (quota/money-adjacent), `security-engineer`, `performance-slo-guardian` | 3 → staff-review → re-review | `operations.md` |

Rules that apply to every round (CLAUDE.md § Spec Kit workflow, memory
`feedback_no_concurrent_committers`): file-mutating agents run **sequentially**; read-only
reviewers may run concurrently. Any UI-touching PR (B, D, C) gets an additional
`enterprise-ux-designer` pass even when it is not in the table above.

## Co-sign footer (Constitution v1.4.2, solo-maintainer substitute)

Append verbatim at the bottom of each co-signed checklist file:

```markdown
## Co-Sign Footer

**T{nnn} Operator Gate — {Checklist Name} Co-Sign**

- **Co-signer**: {AI maintainer identity or human name}
- **Date**: YYYY-MM-DD
- **Branch**: {git branch}
- **Branch HEAD at co-sign**: `{git sha}` ({commit subject})
- **Verification method**: {how each item was verified}
- **Result**: **N/N PASS** · M DEFERRED · K N/A (+ rationale line per non-PASS)
- **Key evidence per category**: bulleted list, one per category, each citing
  file:line OR §FR-xxx OR commit SHA
- **Constitution v1.4.2**: per-principle PASS/PARTIAL/N/A with 1-line rationale

**Co-sign verdict**: {Checklist Name} (CHK{nnn}-CHK{mmm}) is **CO-SIGNED** [with
N documented deferrals].

— Signed in good faith based on {verification-method-summary}. Any future
{class-of-regression} surfaced post-co-sign requires new round + re-sign.
```

The **Verification method** field is load-bearing: "bulk tick without spot-check" is not a
co-sign. Name the actual audit (agent + scope, gate command + output, live probe).
