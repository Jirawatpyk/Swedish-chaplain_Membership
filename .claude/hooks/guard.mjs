#!/usr/bin/env node
// Claude Code PreToolUse guard (D-016). Kept deliberately small: it blocks only
// what cannot be undone, so Claude Code otherwise works freely.
//   1. A shell command that reads a secrets file (.env*, except .env.example).
//   2. Writing a secrets file.
//   3. Editing a migration that is already on origin/main — it is applied in
//      production; write a new migration instead.
// Exit 2 blocks the call and shows stderr to Claude. Anything unexpected fails
// open (exit 0 with a warning) so a broken hook never stops all work.
import { execFileSync } from 'node:child_process';
import { relative, resolve, basename } from 'node:path';

const READERS = /\b(cat|type|less|more|head|tail|grep|egrep|rg|findstr|sed|awk|bat|nl|strings|xxd|od|gc|get-content|select-string)\b/i;
const SECRET_FILE = /(^|[\s'"=\/\\])\.env(\.(?!example\b)[\w.-]+)?(?=$|[\s'";|&)])/g;

function block(reason) {
  process.stderr.write(`Blocked by the repo guard (.claude/hooks/guard.mjs): ${reason}\n`);
  process.exit(2);
}

function isSecretPath(p) {
  const name = basename(p);
  return /^\.env(\..+)?$/.test(name) && name !== '.env.example';
}

function onMain(relPath) {
  try {
    execFileSync('git', ['cat-file', '-e', `origin/main:${relPath}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  let call;
  try {
    call = JSON.parse(input);
  } catch {
    process.stderr.write('guard: could not parse the hook input; allowing the call\n');
    process.exit(0);
  }
  const tool = call.tool_name ?? '';
  const ti = call.tool_input ?? {};

  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = String(ti.command ?? '');
    const mentionsSecret = [...cmd.matchAll(SECRET_FILE)].length > 0;
    if (mentionsSecret && READERS.test(cmd)) {
      block('this command reads a secrets file (.env*). Use the values through the app or a script that prints only what is needed (e.g. the DB host), never the file itself.');
    }
    process.exit(0);
  }

  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') {
    const file = String(ti.file_path ?? '');
    if (!file) process.exit(0);
    if (isSecretPath(file)) block(`${basename(file)} holds secrets; the user edits it.`);
    const root = process.env.CLAUDE_PROJECT_DIR || call.cwd || process.cwd();
    const rel = relative(resolve(root), resolve(file)).split('\\').join('/');
    if (/^drizzle\/migrations\/\d{4}_[^/]+\.sql$/.test(rel) && onMain(rel)) {
      block(`${rel} is already on main and applied in production. Write a new migration (the new-migration skill) instead of editing it.`);
    }
    process.exit(0);
  }

  process.exit(0);
});
