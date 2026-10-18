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
const NODE_RUNNER = /^(node|tsx|bun|deno)(\.cmd|\.exe)?$/i;
// A prod env file named anywhere in a word: `.env.production`, `.env.prod*`,
// the `*.bak.prod` backup.
const PROD_ENV_NAME = /(^|[=\/\\])\.env\.prod|\.bak\.prod$/i;
// Commands that run what follows them: `timeout -k 5 600 pnpm …`, `env -u X
// pnpm …`, `bash -o pipefail -c "pnpm …"`, `cmd /d /c …`, `Start-Process
// -FilePath pnpm …`. After one, the runner is the next pnpm / node word.
const WRAPPERS = new Set(['timeout', 'env', 'nohup', 'nice', 'time', 'exec', 'command', 'sudo', 'npx', 'corepack', 'xargs', 'bash', 'sh', 'zsh', 'dash', 'pwsh', 'powershell', 'cmd', 'start-process', 'start']);
// Commands that only carry text. A prod env file or script named in their
// arguments (a commit message, an echo) runs nothing, so it is not blocked.
const TEXT_ONLY = new Set(['git', 'gh', 'echo', 'printf', 'write-output', 'write-host']);
// pnpm / npm flags that take a separate value word
const PM_VALUE_FLAGS = new Set(['--dir', '-C', '--filter', '-F', '--prefix', '--workspace', '-w']);
// node flags whose value is another module that runs (tsx itself is the loader)
const NODE_MODULE_FLAGS = new Set(['--import', '-r', '--require', '--loader', '--experimental-loader']);
const EVAL_FLAG = new Set(['-e', '--eval', '-p', '--print']);

const base = (w) => (w.split(/[\\/]/).pop() ?? '').toLowerCase();
const unquote = (w) => w.replace(/^["']+|["']+$/g, '');

// A heredoc body is text for the command that reads it, so it is dropped,
// unless a shell or node reads it, in which case it runs.
function dropTextHeredocs(cmd) {
  return cmd.replace(/^(.*?)<<-?\s*(['"]?)(\w+)\2[^\n]*\n[\s\S]*?\n\3[ \t]*(?=\r?\n|$)/gm, (all, head) => {
    const first = base(unquote(head.trim().replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, '').split(/\s+/)[0] ?? ''));
    return WRAPPERS.has(first) || NODE_RUNNER.test(first) ? all : head;
  });
}

// The simple commands in a shell line: split on ; && || | & ( ) { } ` and
// newlines, so a subshell or `$( … )` is its own segment.
function segments(cmd) {
  return dropTextHeredocs(cmd)
    .split(/&&|\|\||[;|&\r\n(){}`]/)
    .map((s) => s.trim().replace(/^\$/, ''))
    .filter(Boolean);
}

// The words from the command that actually runs: past `VAR=value`
// assignments, and past a wrapper to the next pnpm / node word.
function runnerWords(seg) {
  const words = seg.split(/\s+/).map(unquote).filter(Boolean);
  let i = 0;
  while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i])) i += 1;
  if (WRAPPERS.has(base(words[i] ?? ''))) {
    const j = words.findIndex((w, k) => k > i && (PACKAGE_MANAGER.test(base(w)) || NODE_RUNNER.test(base(w))));
    if (j > i) i = j;
  }
  return words.slice(i);
}

// The script a package-manager call runs: the first non-flag word after it,
// past `run` / `run-script` and the value of a flag that takes one.
function packageScript(words) {
  for (let k = 1; k < words.length; k += 1) {
    const w = words[k];
    if (PM_VALUE_FLAGS.has(w)) { k += 1; continue; }
    if (w.startsWith('-')) continue;
    if (w === 'run' || w === 'run-script') continue;
    return w;
  }
  return null;
}

// Only `node … scripts/verify-schema.ts`: no other script (a positional file
// or a module passed to --import / -r / --loader), and no eval.
function runsOnlyVerifySchema(words) {
  if (!NODE_RUNNER.test(base(words[0] ?? ''))) return false;
  const modules = [];
  for (let k = 1; k < words.length; k += 1) {
    const [flag, inline] = words[k].split(/=(.*)/s);
    if (EVAL_FLAG.has(flag)) return false;
    if (NODE_MODULE_FLAGS.has(flag)) {
      const value = inline ?? words[(k += 1)];
      if (value && !/^tsx(\/|$)/.test(value)) modules.push(value);
    } else if (/\.(?:[cm]?[jt]s)$/i.test(words[k])) {
      modules.push(words[k]);
    }
  }
  return modules.length === 1 && READ_ONLY_PROD_FILE.test(modules[0]);
}

function prodWriteReason(cmd) {
  for (const seg of segments(cmd)) {
    const words = runnerWords(seg);
    const first = base(words[0] ?? '');
    if (TEXT_ONLY.has(first)) continue;
    if (PACKAGE_MANAGER.test(first)) {
      const script = packageScript(words);
      if (script && /^[\w.-]+(:[\w.-]+)*:prod$/.test(script) && !READ_ONLY_PROD_SCRIPTS.has(script)) {
        return `\`${script}\` writes to production. The user runs it; Claude may run only the read-only ${[...READ_ONLY_PROD_SCRIPTS].join(', ')}.`;
      }
    }
    if (words.some((w) => PROD_ENV_NAME.test(w)) && !runsOnlyVerifySchema(words)) {
      return 'this command loads or copies the production env file, which can write to production. The user runs it; Claude may run only the read-only `pnpm db:verify:prod`.';
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
