# 114 — Review ledger

One file per PR (`pr-1.md`, `pr-2.md`, `pr-3.md`) recording the gate output and the review
rounds, plus `quickstart-run-<date>.md` (T113) and `cutover.md` (T114). This README fixes the
reviewer stack and the co-sign format so every PR is signed the same way (T003).

Delivery is three PRs, each dark behind `FEATURE_MEMBER_CHANGE_APPROVAL` (default OFF):

| PR | Scope | Phases | Read-only reviewers (concurrent) | Checklists co-signed |
|---|---|---|---|---|
| **1** | foundation + US1 submit → US2 decide → US3 resubmit (the complete loop) | 1–5 | `security-engineer`, `pdpa-gdpr-compliance-officer`, `reliability-guardian`, `drizzle-migration-reviewer` (migration `0300`), `thai-tax-compliance-auditor` (FR-019 / FR-022 buyer block), `enterprise-ux-designer` (portal form, banners, review page) | `security.md`, `privacy.md`, `tax.md` |
| **2** | US4 history + US5 withdraw / replace / cap | 6–7 | `security-engineer`, `pdpa-gdpr-compliance-officer` (erasure scrub, DSAR export), `reliability-guardian` (rate cap, races), `performance-slo-guardian` (T119 queue budget), `enterprise-ux-designer` | `reliability.md`, `privacy.md` (re-sign) |
| **3** | US6 tenant switch + dashboard + gauges, polish, cutover | 8–9 | `security-engineer`, `observability-instrumentor`, `enterprise-ux-designer`, `i18n-translation-reviewer` | `ux.md`, `operations.md` |

Every PR closes with `whole-branch-reviewer` as the last pass (the seam pass), or the
`review-branch` workflow on explicit opt-in when the diff exceeds ~40 files. Rules that apply to
every round (CLAUDE.md § Spec Kit workflow, memory `feedback_no_concurrent_committers`):
file-mutating agents run **sequentially**; read-only reviewers may run concurrently; any
UI-touching PR gets an `enterprise-ux-designer` pass even when the table would not require one;
**re-review the FIXES, not just the code** (108 rule 1); **grep the assertion, not the sentence**
(108 rule 2).

Constitution v1.4.2 Principle IX — this is a PII + RBAC + audit surface, so the default is ≥ 2
human reviewers; the **solo-maintainer substitute** (plan § Complexity Tracking #1) replaces that
with the 6 required CI checks + the agent passes above + the co-sign footer below, signed by the
staff-review agent and the maintainer.

## Co-sign footer (Constitution v1.4.2, solo-maintainer substitute)

Append verbatim at the bottom of each co-signed checklist file
(`checklists/{security,privacy,ux,reliability,operations,tax}.md`), field order unchanged:

```markdown
## Co-Sign Footer

**T112 Review Gate — {Checklist Name} Co-Sign**

- **Co-signer**: {AI maintainer identity or human name}
- **Date**: YYYY-MM-DD
- **Branch**: 114-member-change-approval
- **Branch HEAD at co-sign**: `{git sha}` ({commit subject})
- **Verification method**: {how each item was verified — category-by-category audit via a
  read-only agent, automated gate, manual probe; name the agent and the gate}
- **Result**: **N/N PASS** · M DEFERRED · K N/A (+ rationale line per non-PASS)
- **Key evidence per category**: one bullet per category, each citing file:line OR §FR-xxx OR
  a commit SHA
- **Constitution v1.4.2**: per-principle PASS / PARTIAL / N/A with a 1-line rationale

**Co-sign verdict**: {Checklist Name} (CHK001–CHKnnn) is **CO-SIGNED** [with N documented
deferrals to PR-{n} / a follow-up feature].

— Signed in good faith based on {verification-method-summary}. Any future
{class-of-regression} surfaced post-co-sign requires a new round + re-sign.
```

The "Verification method" field is load-bearing: "bulk tick without spot-check" is
insufficient; "category-by-category audit via `<agent>` + `pnpm check:<gate>` output" is
sufficient. Checkboxes in the checklist files stay reviewer-owned and are ticked only at
`/speckit.review` (T112), never during implementation.
