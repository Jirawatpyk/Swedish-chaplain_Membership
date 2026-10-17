---
name: run-chamber-os
description: The recipe for running a Chamber-OS branch locally so it can be verified — a worktree dev server on :3400 against the Neon dev branch, sign-in personas, Playwright attached to it, and the viewport/font/locale probes. The launch recipe /run and /verify follow; use at feature-flow step 7 or whenever a change must be watched working in the running app.
---

# Run Chamber-OS for verification

This skill only starts the app. **What** to check comes from the change's Done-when lines (`docs/workflow.md` step 7).

## Rules

- **Verify the branch's own code.** :3100 is the main checkout's `pnpm dev` (Claude may start it and open it in the built-in browser), so it serves `main`, not the branch. A branch is verified on **:3400** from its own worktree. Don't kill a :3100 server the user is using.
- The database is the Neon **`dev`** branch, through `.env.local`. Never use prod. Prod reads are refused here; don't route around that.
- Don't `rm -rf .next` in the main checkout; only in the worktree.
- At most two heavy jobs at once (a dev server counts as one, and so does an e2e run).

## 1. Worktree

```bash
git fetch -q origin
git worktree add "C:/Users/<you>/AppData/Local/Temp/fNN" <branch-or-sha>   # short path: long ones hit "Filename too long"
```

Then provide `node_modules` with **`pnpm install --frozen-lockfile`** in the worktree. A junction to the main checkout's `node_modules` is fine for lint, typecheck and unit tests, but **`next dev` refuses it** ("Symlink [project]/node_modules is invalid, it points out of the filesystem root"), so a worktree that runs the app needs a real install. Remove a junction with `cmd /c rmdir <path>` (never `rm -rf`, which follows it).

Copy `.env.local` from the main checkout (`cp`, never print it): without it the app answers 500 with "Environment validation failed". It is gitignored, so never commit it and never print its values. Before you start, confirm it points at the dev host, not prod, by printing only the host: `node -e "console.log(new URL(require('fs').readFileSync('.env.local','utf8').match(/^DATABASE_URL=[\"']?([^\"'\\r\\n]+)/m)[1]).host)"`. Reading the file itself (`cat`, `grep`, `Get-Content`) is blocked by the repo guard, and `TEST_DB_HOST_BLOCKLIST` *names* the prod host, so a grep would give a false match anyway.

## 2. Start the server cold

```bash
cd <worktree>
rm -rf .next                                                   # a stale Turbopack cache panics after a kill
ALLOW_TEST_ROUTES=1 pnpm exec next dev --turbopack --port 3400 > <scratch>/dev.log 2>&1 &
# wait for "Ready in" in dev.log with a background until-loop or a Monitor, never a foreground sleep
curl -s -o /dev/null -w '%{http_code}\n' --max-time 180 http://localhost:3400/admin/sign-in   # expect 200
```

- Run the server in the background (the Bash tool's `run_in_background`), never as a foreground sleep.
- The first request to each route compiles it, which takes 10–60 s. Before you measure anything, open each page you will measure once. Don't read a slow first hit as a performance bug.
- To stop the server: find the PID listening on `:3400` with `netstat -ano`, then `taskkill //F //T //PID <pid>`. Before the next start, run `rm -rf .next` again.

## 3. Sign in

- Personas come from `.env.local` (`E2E_ADMIN_EMAIL`, and the manager / marketing / member ones). Use the helpers in `tests/e2e/helpers/` (`admin-session.ts`, `manager-session.ts`, `member-session.ts`, `layout.ts`'s `signInViaForm`). Never type a real or production password.
- `e2e-member` is **lapsed**. For a member in good standing, use `e2e-member-empty`.
- `/admin/users` is super-admin only; the e2e admin sees "Page not available" there.
- Sign-in is rate-limited. `pnpm db:clear-ratelimit` clears the buckets on dev.
- Fixture IDs come from global setup (e.g. `E2E_PAID_ONLINE_INVOICE_ID`).

## 4. Drive it

**Browser:** `/run` or the Browser pane (`mcp__Claude_Browser__*`), at `http://localhost:3400`. `/verify` runs only when the user invokes it. Prefer `read_page` / `get_page_text` over screenshots for reading. Take a screenshot as evidence.

**e2e against the running server:**
```bash
E2E_BASE_URL=http://localhost:3400 pnpm exec playwright test --config=playwright.attach.config.ts tests/e2e/<spec>.spec.ts \
  --project=chromium --workers=1 --retries=0 --reporter=list
```
- Run one spec file and one project per process, on both `chromium` and `mobile-chrome`.
- Read `error-context.md` before the next run wipes it.
- A red is real only if it also fails solo, on a cold server. If it is also red on `main`, report it as pre-existing, with that evidence.

**A one-off probe:** write a throwaway spec in the scratchpad, copy it into `tests/e2e/` for the run, delete it afterwards, and never commit it. Have it print one JSON line (`console.log('PROBE ' + JSON.stringify(out))`) and parse that line.

## 5. UI probes (every UI change)

| Probe | How | Pass |
|---|---|---|
| Phone reflow | `setViewportSize({ width: 320, height: 727 })` on `mobile-chrome` | `innerWidth === 320` and `scrollWidth <= 320`. A phone **widens its layout viewport** instead of scrolling, so check `innerWidth`, not only the difference |
| Large text | CDP `Page.setFontSizes({ fontSizes: { standard: 32, fixed: 32 } })` at 390 × 844 | `innerWidth === 390`; every action reachable by Tab and fully on screen |
| 400 % zoom | 320 × 256 | nothing fixed covers content; every action reachable by scrolling and by Tab |
| Locales | cookie `NEXT_LOCALE` = `en` / `th` / `sv` | no overflow, no `MISSING_MESSAGE`, BE dates in TH only |
| Theme | `emulateMedia({ colorScheme: 'dark' })` | contrast holds; no light-only colour |
| Overflow culprit | list the visible elements whose right edge is past the viewport and that contain no other such element | names the element to fix |

Scope locators to `:visible`. Next keeps the previous segment's DOM hidden after a client navigation, so `.first()` can pick a hidden copy.

## 6. Clean up

Stop the :3400 server, remove any probe specs, and leave the worktree in place until the user says to clear it. Then remove it with `git worktree remove --force`, followed by a robocopy-mirror delete. Remove the `node_modules` junction **before** removing the worktree. Deleting session folders needs the user's approval.
