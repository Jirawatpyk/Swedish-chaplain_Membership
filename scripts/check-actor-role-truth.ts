/**
 * check:actor-role-truth — no audit row states a role its actor did not hold.
 *
 * ## Why this exists
 *
 * `actor_role` / `actorType` is the field a forensic query answers "WHO did
 * this?" with. It is written to append-only tables — a wrong value cannot be
 * corrected later, only annotated. And it is invisible to type-checking: a
 * literal `'admin'` in that position compiles forever, no matter who the
 * actor actually was.
 *
 * That class shipped four separate times in this repo:
 *
 *   1. 016 T033 fixed some renewals emitters and missed 14 routes — every
 *      post-Migration-C super_admin was filed as 'admin' on money-path rows.
 *   2. The fix for (1) widened the SCHEMAS but 13 of 14 use-case BODIES kept
 *      a hardcoded literal at the emit — 1,672 tests stayed green because
 *      they pinned what the schema ACCEPTS, not what the emitter RECEIVES.
 *   3. The renewals-only tripwire added for (2) could not see invoicing
 *      (7 cross-tenant probe payloads), events (18 `actorType` stamps — where
 *      MARKETING holds `events.write`, so two populations were folded into
 *      one), or the F7 members-bridge.
 *   4. The bridge in (3) hardcoded `'admin'` to satisfy F3's OWN
 *      authorization check, which therefore admitted every caller including
 *      the Resend webhook.
 *
 * So the gate is codebase-wide, not module-scoped: every staff-role literal
 * in an actor-role VALUE position must be justified by name.
 *
 * ## What it checks
 *
 * Scans `src/modules/**` + `src/app/**` + `src/lib/**` + `scripts/**` for
 *   `actorRole|actor_role|actorType|actor_type: '<staff role>'`
 * in a VALUE position (type unions like `actorRole: 'admin' | 'super_admin'`
 * are declarations, not stamps, and are skipped), on comment-stripped text so
 * prose and examples cannot trip it. Anything not in ALLOWED below fails.
 *
 * ## Honest limits
 *
 * A literal laundered through a const (`const R = 'admin'; actorRole: R`) or
 * a helper return is NOT caught — same limit the sibling role-literal gate
 * documents. The behavioural net for that shape is the per-module emit tests
 * that assert the received context. What this gate guarantees is that the
 * DIRECT form cannot come back silently a fifth time.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { lineOfIndex, stripCommentLines } from './lib/source-scan';

const ROOT = process.cwd();
// `scripts/` included: several import/backfill scripts write real audit
// rows and can be run against prod (017 security review #9).
const SCOPE = ['src/modules', 'src/app', 'src/lib', 'scripts'] as const;

/**
 * Every accepted staff-role literal, by `path:line-anchor` + why it is TRUE.
 * A new entry needs a reason a reviewer can check against the code beside it —
 * "the actor really is that role at this point", never "it's convenient".
 */
const ALLOWED: ReadonlyArray<{ file: string; contains: string; why: string }> = [
  {
    file: 'src/app/api/admin/events/_lib/role-violation-audit.ts',
    contains: "actorRole: 'manager'",
    why:
      'the MANAGER denial branch — this arm is only reached when the session ' +
      "role IS 'manager' (checked one line above), so the literal is the truth",
  },
];

const STAFF = '(admin|manager|super_admin|marketing)';
const QUOTE = '[\'"`]';
/**
 * Value position only: a `|` after the literal means it is a TYPE union.
 *
 * Hardened after the 017 security review MEASURED four evasions of the first
 * version, each of which compiles and lints clean in this repo (there is no
 * `quotes` ESLint rule and prettier is banned here):
 *   - `actorRole: "admin"`             — double quotes
 *   - actorRole: \`admin\`               — template literal
 *   - `'actorRole': 'admin'`           — quoted key
 *   - `dispatchedByActorRole: 'admin'` — SUFFIXED key
 *
 * The last one is not academic: that exact shape was live in
 * `run-test-webhook.ts` — a hardcoded role feeding the very audit row whose
 * docstring calls it a role-enforcement drift detector — and the first
 * version of this gate walked straight past it.
 *
 * So the KEY half matches any identifier ending in an actor-role word
 * (optionally quoted), and the VALUE half accepts all three quote styles.
 */
const STAMP = new RegExp(
  // Optional prefix — `actorRole` (bare) and `dispatchedByActorRole` (suffixed)
  // must BOTH match. Making the prefix mandatory broke the bare form, and the
  // positive control below caught it on the very next run; that is what the
  // control is for.
  `${QUOTE}?(?:[A-Za-z_$][\\w$]*?)?[Aa]ctor_?(?:[Rr]ole|[Tt]ype)${QUOTE}?\\s*:\\s*` +
    `${QUOTE}${STAFF}${QUOTE}(?!\\s*\\|)`,
  'g',
);

/**
 * This file is skipped: it is the SCANNER, so its `ALLOWED` entries quote the
 * literals they authorise and would otherwise match themselves. Skipping it
 * costs nothing — a scanner emits no audit rows — and the alternative
 * (obfuscating the allowlist strings) would make the allowlist unreadable,
 * which is the one thing it must not be.
 */
const SELF = 'scripts/check-actor-role-truth.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

const findings: string[] = [];
let scanned = 0;
let allowed = 0;

for (const root of SCOPE) {
  const abs = join(ROOT, root);
  let files: string[];
  try {
    files = walk(abs);
  } catch {
    console.error(`check:actor-role-truth ABORT — scope root missing: ${root}`);
    process.exit(1);
  }
  for (const file of files) {
    if (relative(ROOT, file).replace(/\\/g, '/') === SELF) continue;
    scanned += 1;
    const raw = readFileSync(file, 'utf8');
    const code = stripCommentLines(raw).join('\n');
    STAMP.lastIndex = 0;
    for (const m of code.matchAll(STAMP)) {
      const shown = relative(ROOT, file).replace(/\\/g, '/');
      const line = lineOfIndex(code, m.index!) + 1;
      const ok = ALLOWED.some(
        (a) => a.file === shown && m[0].includes(a.contains),
      );
      if (ok) {
        allowed += 1;
        continue;
      }
      findings.push(`  ✗ ${shown}:${line}: ${m[0]}`);
    }
  }
}

if (allowed !== ALLOWED.length) {
  // POSITIVE CONTROL. `scanned === 0` catches a wrong scope root but not a
  // dead regex: if the pattern stops matching (or the comment stripper
  // changes shape), `findings` goes empty and this gate prints OK while
  // seeing nothing — the exact T065 failure mode this file's header cites.
  // Every ALLOWED entry is a literal known to exist, so all of them must be
  // FOUND on every run.
  console.error(
    `check:actor-role-truth ABORT — allowlist drift: ${allowed} of ` +
      `${ALLOWED.length} justified literal(s) were found. Either an entry is ` +
      'stale (delete it) or the scanner stopped seeing them.',
  );
  process.exit(1);
}

if (scanned === 0) {
  // A walk that found nothing means the scope is wrong, not that the code is
  // clean — the failure mode this repo's other gates were burned by.
  console.error('check:actor-role-truth ABORT — scanned 0 files.');
  process.exit(1);
}

if (findings.length > 0) {
  console.error(
    `check:actor-role-truth — ${findings.length} hardcoded actor-role literal(s):\n` +
      findings.join('\n') +
      '\n\nAn audit row must state the role its actor ACTUALLY held. Thread the ' +
      "literal session role in (the `role === 'super_admin' ? … : 'admin'` idiom " +
      'with an `rbac-narrow-ok` comment), or — for a genuinely actor-less path ' +
      "(cron, webhook, replay) — stamp the honest system value ('system' / " +
      "'cron' / 'webhook') rather than a human role. If the literal really IS " +
      'the truth at that point, add it to ALLOWED in this script with the reason.',
  );
  process.exit(1);
}

console.log(
  `check:actor-role-truth — OK (${scanned} file(s); 0 fabricated, ${allowed} justified literal(s)).`,
);
