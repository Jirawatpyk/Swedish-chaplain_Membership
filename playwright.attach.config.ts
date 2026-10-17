/**
 * Attach Playwright to an ALREADY-RUNNING dev server; start none.
 *
 * The base config's `webServer` points at :3100 — the maintainer's own dev
 * server — and starts one there when that URL does not answer. Verification
 * runs a branch's server in its own worktree on another port (the
 * `run-chamber-os` skill uses :3400), so it must never start or reuse :3100.
 *
 *   E2E_BASE_URL=http://localhost:3400 pnpm exec playwright test --config=playwright.attach.config.ts <spec>
 */
import base from './playwright.config';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3400';
// global-setup.ts reads E2E_BASE_URL (default :3100) for its warm-ups and
// sign-in, so pin it here too: otherwise they would hit the maintainer's :3100.
process.env.E2E_BASE_URL = baseURL;

const attachConfig = {
  ...base,
  webServer: undefined,
  use: { ...base.use, baseURL },
};

export default attachConfig;
