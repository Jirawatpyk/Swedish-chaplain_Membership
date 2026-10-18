/**
 * The Claude Code PreToolUse guard (`.claude/hooks/guard.mjs`, D-016).
 *
 * Deliberately small: the maintainer wants Claude Code to work freely, so the
 * hook blocks only what cannot be undone — reading or writing a secrets file
 * from the shell, and editing a migration that is already on `main` (and so
 * already applied in production). Everything else is allowed. These tests
 * drive the real script with the JSON Claude Code sends, so each block AND
 * each allowed neighbour is shown.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const HOOK = join(ROOT, '.claude/hooks/guard.mjs');

function run(toolName: string, toolInput: Record<string, unknown>) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: ROOT, tool_name: toolName, tool_input: toolInput }),
    encoding: 'utf8',
    // HEAD stands in for main: a CI checkout has no origin/main ref, and the
    // migration cases only need a committed file vs an uncommitted one.
    env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT, CLAUDE_GUARD_MAIN_REF: 'HEAD' },
  });
  return { code: res.status, stderr: res.stderr };
}

describe('Claude guard hook — secrets in shell commands', () => {
  it.each([
    ['Bash', 'cat .env.local'],
    ['Bash', 'grep DATABASE_URL .env.production'],
    ['Bash', 'head -5 ../main/.env.local.bak.prod'],
    ['PowerShell', 'Get-Content .env.local'],
    ['PowerShell', 'Select-String DATABASE_URL .env.production'],
  ])('blocks %s: %s', (tool, command) => {
    const r = run(tool, { command });
    expect(r.code, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/guard/i);
  });

  it.each([
    'cat .env.example',
    'cp ../main/.env.local .env.local',
    'node --env-file=.env.local --import tsx scripts/run-migrations.ts',
    'git stash list',
    'git add -A',
    'pnpm check',
    'curl -s http://localhost:3100/admin/sign-in',
  ])('allows %s', (command) => {
    const r = run('Bash', { command });
    expect(r.code, r.stderr).toBe(0);
  });
});

// D-016 + D-025: `permissions.deny` matches a command by prefix, so a prod
// write script was still reachable by another spelling. The guard closes
// those spellings; the read-only `db:verify:prod` (D-024) stays allowed.
describe('Claude guard hook — prod write scripts', () => {
  it.each([
    ['Bash', 'pnpm db:migrate:prod'],
    ['Bash', 'pnpm run db:migrate:prod'],
    ['Bash', 'pnpm -s db:migrate:prod'],
    ['Bash', 'pnpm --silent run seed:system-actors:prod'],
    ['Bash', 'npm run db:migrate:prod'],
    ['Bash', 'cd "/c/repo" && pnpm db:migrate:prod 2>&1 | tail -5'],
    ['Bash', 'FOO=1 pnpm seed:system-actors:prod'],
    ['PowerShell', 'Set-Location C:\\repo; pnpm run db:migrate:prod'],
    ['PowerShell', '& pnpm db:migrate:prod'],
    ['Bash', 'pnpm some-future-job:prod'],
    ['Bash', 'node --env-file=.env.production --import tsx scripts/run-migrations.ts'],
    ['Bash', 'node --env-file .env.production --import tsx scripts/seed-system-actors.ts'],
    ['Bash', 'node --env-file=../main/.env.local.bak.prod --import tsx scripts/run-migrations.ts'],
    ['Bash', 'pnpm exec tsx --env-file=.env.production scripts/run-migrations.ts'],
    ['PowerShell', 'node --env-file=.env.production --import tsx scripts/run-migrations.ts'],
    // review round 1 (#590): wrappers, nested shells, subshells, -if-exists,
    // and the verify-schema allowance used as a smuggling name
    ['Bash', 'timeout 600 pnpm db:migrate:prod'],
    ['Bash', 'env pnpm db:migrate:prod'],
    ['Bash', 'nohup pnpm seed:system-actors:prod'],
    ['Bash', 'bash -c "pnpm db:migrate:prod"'],
    ['Bash', 'sh -lc \'pnpm run db:migrate:prod\''],
    ['PowerShell', 'cmd /c pnpm db:migrate:prod'],
    ['Bash', '(pnpm db:migrate:prod)'],
    ['Bash', 'echo $(pnpm db:migrate:prod)'],
    ['Bash', '/c/tools/pnpm.cmd db:migrate:prod'],
    ['Bash', 'node --env-file-if-exists=.env.production --import tsx scripts/run-migrations.ts'],
    ['Bash', 'node --env-file=.env.production --import tsx scripts/run-migrations.ts scripts/verify-schema.ts'],
    ['Bash', 'node --env-file=.env.production -e "import(\'./scripts/run-migrations.ts\')" scripts/verify-schema.ts'],
    // security review (#590): env loaded without --env-file, flagged wrappers,
    // and a second script smuggled in through --import / -r
    ['Bash', 'set -a; . ./.env.production; set +a; node --import tsx scripts/run-migrations.ts'],
    ['Bash', 'source .env.production && pnpm exec tsx scripts/seed-system-actors.ts'],
    ['Bash', 'cp .env.production /tmp/p && node --env-file=/tmp/p --import tsx scripts/run-migrations.ts'],
    ['Bash', 'timeout -k 5 600 pnpm db:migrate:prod'],
    ['Bash', 'bash -o pipefail -c "pnpm db:migrate:prod"'],
    ['PowerShell', 'pwsh -ExecutionPolicy Bypass -Command "pnpm db:migrate:prod"'],
    ['PowerShell', 'cmd /d /c pnpm db:migrate:prod'],
    ['PowerShell', "Start-Process -FilePath pnpm -ArgumentList 'db:migrate:prod'"],
    ['Bash', 'env -u FOO pnpm db:migrate:prod'],
    ['Bash', 'nice pnpm db:migrate:prod'],
    ['Bash', 'pnpm --dir ../main db:migrate:prod'],
    ['Bash', 'node --env-file=.env.production --import tsx --import ./scripts/run-migrations scripts/verify-schema.ts'],
    ['Bash', 'node --env-file=.env.production -r ./scripts/run-migrations scripts/verify-schema.ts'],
    ['Bash', "bash <<'EOF'\npnpm db:migrate:prod\nEOF"],
  ])('blocks %s: %s', (tool, command) => {
    const r = run(tool, { command });
    expect(r.code, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/prod/i);
  });

  it.each([
    'pnpm db:verify:prod',
    'pnpm run db:verify:prod',
    'node --env-file=.env.production --import tsx scripts/verify-schema.ts',
    'node --env-file=.env.production --import tsx scripts\\verify-schema.ts',
    'timeout 280 pnpm exec vitest run tests/unit/architecture/claude-guard-hook.test.ts',
    'pnpm db:migrate',
    'pnpm db:verify',
    'node --env-file=.env.local --import tsx scripts/run-migrations.ts',
    'git commit -m "docs: never run pnpm db:migrate:prod by hand"',
    'grep -n "db:migrate:prod" package.json',
    'gh pr view 588 --json body',
    // false positives the security review found (#590)
    'git commit -m "docs: never pass --env-file=.env.production by hand"',
    "git commit -q -F - <<'EOF'\nfix: x\n\npnpm run db:migrate:prod stays the user's\nEOF",
    'pnpm exec vitest run -t "blocks pnpm db:migrate:prod"',
    'pnpm run db:verify:prod',
  ])('allows %s', (command) => {
    const r = run('Bash', { command });
    expect(r.code, r.stderr).toBe(0);
  });
});

describe('Claude guard hook — file writes', () => {
  it.each([
    ['Write', '.env.local'],
    ['Edit', '.env.production'],
    // a migration already on origin/main has been applied in production
    ['Edit', 'drizzle/migrations/0014_audit_event_portal_invite_queued.sql'],
    ['Write', 'drizzle/migrations/0014_audit_event_portal_invite_queued.sql'],
  ])('blocks %s on %s', (tool, file) => {
    const r = run(tool, { file_path: join(ROOT, file) });
    expect(r.code, r.stderr).toBe(2);
  });

  it.each([
    ['Edit', '.env.example'],
    ['Edit', 'src/lib/env.ts'],
    ['Write', 'drizzle/migrations/9999_not_yet_on_main.sql'],
    ['Edit', 'drizzle/migrations/meta/_journal.json'],
  ])('allows %s on %s', (tool, file) => {
    const r = run(tool, { file_path: join(ROOT, file) });
    expect(r.code, r.stderr).toBe(0);
  });

  it('lets other tools through untouched', () => {
    expect(run('Read', { file_path: join(ROOT, 'CLAUDE.md') }).code).toBe(0);
  });

  it('fails open with a warning on input it cannot parse, rather than blocking all work', () => {
    const res = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/could not parse/i);
  });
});
