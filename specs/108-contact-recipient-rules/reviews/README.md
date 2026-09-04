# 108 — Review ledger

One file per PR (`pr-a.md`, `pr-b.md`, `pr-d.md`, `pr-c.md`) recording the gate output
(T028 / T041 / T060 / T092) and the review rounds. This README fixes the reviewer stack
and the co-sign format so every PR is signed the same way.

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
