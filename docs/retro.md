# Retro log

One line per retro (`docs/workflow.md` § Continuous improvement): **date · what went wrong or slow · why · the change that stops it recurring** (with a link to the PR, commit or issue). Newest first.

| Date | What went wrong or slow | Why | Change |
|---|---|---|---|
| 2026-10-17 | R53's first two runs failed on infrastructure, not on the change: `next dev` refused a `node_modules` junction, then the worktree had no `.env.local` (500s), and a stopped runner kept writing into the next run's log | The run recipe allowed a junction for a dev-server worktree and didn't say the env file must be copied; stopping a background bash left its children running | `run-chamber-os` § 1: real install for any worktree that runs the app, copy `.env.local`; the runner copies it when missing; kill the worktree's processes (not just the task) before re-running |
| 2026-10-17 | `CLAUDE.md` said migrations were "at 0302" and F114 "ships DARK" weeks after both had changed | State that changes per PR lived in a file loaded every session, with no owner | Flag state moved to `docs/operational-state.md`, updated in the PR that moves it; DoD line added (#570, #571) |
| 2026-10-16 | The 32 px reflow test on the invoice page passed review but failed on verify (405 px from the payment timeline) | The title's overflow hid a second overflow; review read the diff, not the rendered page | Verify step runs 320 px and a 32 px default font on every UI change (`docs/workflow.md` step 7) |
