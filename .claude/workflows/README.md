# `.claude/workflows/` — saved Workflow scripts

Named, reusable scripts for the Claude Code **Workflow** tool: deterministic orchestration of many subagents (fan-out, verify, synthesize), where the control flow lives in code rather than in a model's judgement. One `.js` file per workflow; the file's `meta.name` is the name you invoke.

**Invocation is opt-in.** Claude will not start a workflow on its own — say "use a workflow" / "run review-branch", or put `ultracode` in the message. The session's default size guideline is ~15 agents per workflow (`/config` → *Dynamic workflow size*); a script may exceed it when the task calls for it, and every script here `log()`s each cap it applies so a bounded run never reads as "covered everything".

| Workflow | When | Agents (typical) |
|---|---|---|
| `review-branch` | A branch diff too large for one context to read line-by-line (> ~40 files or > ~5k lines), or any money / tenant / migration / auth branch before the PR opens. For a small diff, dispatch `whole-branch-reviewer` alone. Round 2 after fixes: pass `seen: [...prev.confirmed, ...prev.refuted]` and only NEW classes come back. | ~20 (1 scope + ≤6 finders + ≤3 skeptics × ≤10 candidates + 1 seam pass) |
| `sweep-class` | A defect class was found once and must be closed EVERYWHERE — audit-truth literals, fail-open `default` arms, a widened union, a renamed port. Pass the known instances as `examples`; they are the positive control. Not for one known file — grep that yourself. | ~15–25 (3 form modalities + 1 buckets + finders × rounds + 1 critic × rounds + skeptics on every `exempt`) |
| `spec-review-panel` | A spec touching money, tax, tenant isolation, PII, auth or a migration — after `/speckit.clarify`, before `/speckit.plan` or `/speckit.tasks`. Not a `/speckit-*` skill and not a replacement for `/speckit.critique-run` (two lenses, one context, run by Claude itself). | ~10–15 (1 scope + 4–10 lenses + ≤2 skeptics × ≤12 findings + 1 synthesis) |

## Why these three

**`review-branch`** — on the F5 refund-lifecycle branch (123 files / +17.7k) the inline `/code-review` pass had to scope itself down and produced 6 findings. The same review as a fan-out — per-module finders with fresh context → dedup → skeptics prompted to **refute** — refuted 5 of those 6 as misreads and found 3 real bugs the inline pass never reached. The last stage hands the confirmed set to `whole-branch-reviewer`, whose job is the seam between commits that per-module finders cannot see.

**`sweep-class`** — sweeps here finish one hop short: the actor-role truth sweep took five rounds because each fix's blind spot caused the next; the `err:` sweep declared itself complete and missed the multi-line shape the previous round had warned about by name. So the script separates FORMS (three modalities enumerate how the class can be spelled) from PLACES (one finder per bucket), requires the known examples to be found (else it says **SWEEP IS BLIND**), and puts a completeness critic between rounds whose only question is "what did we not search?". Every `exempt` is re-checked by a skeptic, because a wrong exempt is the next round's blind spot. Never edits — you fix, sequentially, and re-run with `seen`.

**`spec-review-panel`** — a defect a spec mandates is found at review round 7, after implementation, tests and a migration have been built on it ("a plan can mandate a defect"; a 5-agent audit found 7 blockers in a spec that had passed a two-lens critique). Lenses are project agents chosen from what the spec touches; each must check the spec's PREMISES against the code — "what already in the codebase would be pointless if this premise held?". Findings are verified with "any refutation kills it", because an amendment must not rest on a contested claim. Synthesis runs on the session model (design work) and returns amendments as text plus `GO / GO WITH AMENDMENTS / NO-GO`.

## Dry-run harness (proven contract, zero real agents)

All three were exercised under a stub harness that `new Function()`s the real script with fake `agent()` / `parallel()`, dispatches canned schema-shaped answers by label prefix, validates every schema's `required ⊆ properties`, and **asserts** the contract per mode — 10 modes, all passing at the time of writing: `review-branch` default + seen · `sweep-class` default + blind + nocls + maxrounds · `spec-review-panel` default + notfound + nospec + synthfail. The harness lives in the session scratchpad, not the repo; the pattern is ~120 lines and worth recreating before changing a script's control flow. It proves the *plumbing*, not finding quality — the first live run of each should be on work that already has a review to compare against.

## Conventions

- **Script = plain JavaScript**, not TypeScript. Top-level `await` and `return` are fine (the body runs inside an async context). `Date.now()`, `Math.random()` and argless `new Date()` throw — they would break resume.
- **`meta` is a pure literal** — no variables, calls, spreads or template strings. `phases[].title` must match the `phase('…')` calls exactly.
- **Reviewer agents run on `opus`**; the final seam pass inherits the session model (the `whole-branch-reviewer` exception). Set `model` per stage in `meta.phases` and on the `agent()` call.
- **Prefer `pipeline()`; use `parallel()` only as a real barrier** — `review-branch` uses one before dedup because dedup needs every finder's output at once and an empty candidate set should skip verification entirely.
- **Read-only git inside review workflows**: `git show <sha>:<path>`, `git diff`, `git log -p`. Never `checkout` / `stash` / `commit` — the working tree is shared, and a review run once left it on the wrong branch.
- **Dry-run before committing a script change**: the scratch harness pattern is to `new Function()` the script with stubbed `agent()` / `parallel()` that return schema-shaped canned data, then assert the call count, the phases, the dedup and the return shape. It costs zero agents and catches a schema whose `required` names a missing property, which otherwise only fails at the first live `agent()` call.

## Iterating on a run

Every invocation persists its script under the session directory and returns the path plus a `runId`. Edit that copy and relaunch with `{ scriptPath, resumeFromRunId }` — unchanged `agent()` calls return cached results instantly; only the first edited call and everything after it runs live. Before diagnosing an empty result, read `<transcriptDir>/journal.jsonl`.
