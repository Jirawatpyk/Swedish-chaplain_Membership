#!/usr/bin/env node
// Claude Code PreToolUse guard (D-016). Kept deliberately small: it blocks only
// what cannot be undone, so Claude Code otherwise works freely.
//   1. A shell command that reads a secrets file (.env*, except .env.example).
//   2. Writing a secrets file.
//   3. Editing a migration that is already on origin/main — it is applied in
//      production; write a new migration instead.
//   4. Running a prod write script by any spelling (D-025).
// Exit 2 blocks the call and shows stderr to Claude. Anything unexpected fails
// open (exit 0 with a warning) so a broken hook never stops all work.
import { execFileSync } from 'node:child_process';
import { relative, resolve, basename } from 'node:path';

const READERS = /\b(cat|type|less|more|head|tail|grep|egrep|rg|findstr|sed|awk|bat|nl|strings|xxd|od|gc|get-content|select-string)\b/i;
const SECRET_FILE = /(^|[\s'"=\/\\])\.env(\.(?!example\b)[\w.-]+)?(?=$|[\s'";|&)])/g;

// A package script ending in `:prod` writes to production unless it is listed
// here as read-only (D-024). `permissions.deny` matches by prefix, so
// `pnpm run x:prod`, `pnpm -s x:prod` or `npm run x:prod` slipped past it (D-025).
const READ_ONLY_PROD_SCRIPTS = new Set(['db:verify:prod']);
const READ_ONLY_PROD_FILE = /^scripts[\\/]verify-schema\.ts$/;
const PACKAGE_MANAGER = /^(pnpm|npm|yarn|bun)(\.cmd|\.exe)?$/i;
// `--env-file[-if-exists]=<p>` / `… <p>` naming a prod env file
const PROD_ENV_FILE = /--env-file(?:-if-exists)?(?:=|\s+)["']?[^\s"']*(\.env\.production|\.env\.prod|\.bak\.prod)\b/i;
// Words that run the command after them: `timeout 600 pnpm …`, `env pnpm …`,
// `bash -c "pnpm …"`, `cmd /c pnpm …`. Stripped before the first word is read.
const WRAPPER = /^(?:timeout\s+\S+|env|nohup|time|exec|command|sudo|npx|corepack|(?:ba|z|da)?sh(?:\.exe)?(?:\s+-\w+)*|(?:pwsh|powershell)(?:\.exe)?(?:\s+-\w+)*|cmd(?:\.exe)?\s+\/[ck]|start-process)\s+/i;
const EVAL_FLAG = /(^|\s)(-e|--eval|-p|--print)(\s|=|$)/;

// The simple commands in a shell line: split on ; && || | & ( ) { } ` and
// newlines (so a subshell or `$( … )` is its own segment), then drop leading
// `VAR=value` assignments, quotes and wrapper words.
function segments(cmd) {
  return cmd
    .split(/&&|\|\||[;|&\r\n(){}`]/)
    .map((s) => {
      let seg = s.trim();
      for (let prev = ''; prev !== seg; ) {
        prev = seg;
        seg = seg
          .replace(/^\$/, '')
          .replace(/^["']+/, '')
          .replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, '')
          .replace(WRAPPER, '')
          .trim();
      }
      return seg;
    })
    .filter(Boolean);
}

// Only `node … scripts/verify-schema.ts` with no other script and no eval.
function runsOnlyVerifySchema(words, seg) {
  const files = words.filter((w) => /\.(?:[cm]?[jt]s)$/i.test(w));
  return files.length === 1 && READ_ONLY_PROD_FILE.test(files[0]) && !EVAL_FLAG.test(seg);
}

function prodWriteReason(cmd) {
  for (const seg of segments(cmd)) {
    const words = seg.split(/\s+/).map((w) => w.replace(/^["']+|["']+$/g, ''));
    const first = (words[0] ?? '').split(/[\\/]/).pop() ?? '';
    if (PACKAGE_MANAGER.test(first)) {
      const script = words.slice(1).find((w) => /^[\w.-]+(:[\w.-]+)*:prod$/.test(w));
      if (script && !READ_ONLY_PROD_SCRIPTS.has(script)) {
        return `\`${script}\` writes to production. The user runs it; Claude may run only the read-only ${[...READ_ONLY_PROD_SCRIPTS].join(', ')}.`;
      }
    }
    if (PROD_ENV_FILE.test(seg) && !runsOnlyVerifySchema(words, seg)) {
      return 'this command runs a script with the production env file, which can write to production. The user runs it; Claude may run only the read-only `pnpm db:verify:prod`.';
    }
  }
  return null;
}

function block(reason) {
  process.stderr.write(`Blocked by the repo guard (.claude/hooks/guard.mjs): ${reason}\n`);
  process.exit(2);
}

function isSecretPath(p) {
  const name = basename(p);
  return /^\.env(\..+)?$/.test(name) && name !== '.env.example';
}

// The ref that stands for "applied in production". CLAUDE_GUARD_MAIN_REF
// overrides it (the tests pin it, because a CI checkout has no origin/main).
const MAIN_REFS = process.env.CLAUDE_GUARD_MAIN_REF ? [process.env.CLAUDE_GUARD_MAIN_REF] : ['origin/main', 'main'];

function onMain(relPath, cwd) {
  for (const ref of MAIN_REFS) {
    try {
      execFileSync('git', ['cat-file', '-e', `${ref}:${relPath}`], { stdio: 'ignore', cwd });
      return true;
    } catch {
      // try the next ref; none found means "not on main" (fail open)
    }
  }
  return false;
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
    const prod = prodWriteReason(cmd);
    if (prod) block(prod);
    process.exit(0);
  }

  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') {
    const file = String(ti.file_path ?? '');
    if (!file) process.exit(0);
    if (isSecretPath(file)) block(`${basename(file)} holds secrets; the user edits it.`);
    const root = process.env.CLAUDE_PROJECT_DIR || call.cwd || process.cwd();
    const rel = relative(resolve(root), resolve(file)).split('\\').join('/');
    if (/^drizzle\/migrations\/\d{4}_[^/]+\.sql$/.test(rel) && onMain(rel, root)) {
      block(`${rel} is already on main and applied in production. Write a new migration (the new-migration skill) instead of editing it.`);
    }
    process.exit(0);
  }

  process.exit(0);
});
