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
    env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
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
