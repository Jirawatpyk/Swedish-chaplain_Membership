// review-branch — fan-out review of the WHOLE branch against origin/main.
//
// Shape (proven on the F5 refund-lifecycle branch, 123 files / +17.7k — the
// inline /code-review pass produced 6 findings; this shape refuted 5 of them as
// misreads and found 3 real bugs the inline pass never reached):
//
//   Scope      one agent buckets the diff --stat by module + risk band
//   Find       one finder per bucket, FRESH context each (the whole point)
//   Verify     dedup across ALL finders, then skeptics per candidate whose
//              default answer is "refuted" — 3 lenses for BLOCKER/HIGH, 1 otherwise
//   Synthesize whole-branch-reviewer reads the SEAMS the per-module finders
//              cannot see, with the confirmed set as its starting evidence
//
// Invoke (needs the user's explicit opt-in — "use a workflow" / ultracode):
//   Workflow({ name: 'review-branch' })
//   Workflow({ name: 'review-branch', args: { base: 'origin/main', maxGroups: 6,
//              maxVerify: 10, seed: [ { file, line, severity, title, failure_scenario } ],
//              seam: true } })
//   Round 2, after fixing:
//   Workflow({ name: 'review-branch', args: { seen: [...prev.confirmed, ...prev.refuted] } })
//     → same bands are not re-verified; only NEW classes come back (under "suppressed"
//       you get what was skipped, so nothing disappears silently).
//
// Sizing: 1 + groups + (≤3 × candidates) + 1 agents. Defaults (6 groups, 10
// candidates) worst-case ≈ 38, typical ≈ 20. Every cap is log()ged when it bites —
// a silent cap reads as "covered everything".

export const meta = {
  name: 'review-branch',
  description: 'Whole-branch review vs origin/main: per-module finders → dedup → adversarial verify → seam pass → MERGEABLE verdict',
  whenToUse: 'A branch diff too large for one context to read line-by-line (roughly > 40 files or > 5k lines), or any money / tenant / migration / auth branch before the PR opens. For a small diff, dispatch whole-branch-reviewer alone instead.',
  phases: [
    { title: 'Scope', detail: 'diff --stat vs merge-base; bucket files by module and risk band' },
    { title: 'Find', detail: 'one finder per bucket, fresh context, reads every file in full', model: 'opus' },
    { title: 'Verify', detail: 'dedup, then skeptics per candidate — default refuted', model: 'opus' },
    { title: 'Synthesize', detail: 'whole-branch-reviewer hunts the seams; table + verdict' },
  ],
}

// ---------- args ----------
const A = args && typeof args === 'object' ? args : {}
const BASE = typeof A.base === 'string' ? A.base : 'origin/main'
const MAX_GROUPS = Number.isInteger(A.maxGroups) ? A.maxGroups : 6
const MAX_VERIFY = Number.isInteger(A.maxVerify) ? A.maxVerify : 10
const SEED = Array.isArray(A.seed) ? A.seed : []
// Round 2+: pass the previous run's `confirmed` + `refuted` here. A candidate in
// the same file:line band as a seen finding is NOT re-verified, so a re-run after
// fixes reports only NEW classes — the loop the repo actually runs (5–8 review
// rounds per PR) is cross-turn: review → you fix → review, not a loop in here.
const SEEN = Array.isArray(A.seen) ? A.seen : []
const SEAM = A.seam !== false

// ---------- schemas ----------
const SEV = ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW']
const RISK = ['money', 'tenant', 'migration', 'auth', 'cron_webhook', 'ui', 'tests_docs', 'other']

const GROUPS_SCHEMA = {
  type: 'object',
  properties: {
    base_sha: { type: 'string' },
    head_sha: { type: 'string' },
    branch: { type: 'string' },
    total_files: { type: 'integer' },
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          risk: { type: 'string', enum: RISK },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'risk', 'files'],
      },
    },
  },
  required: ['base_sha', 'head_sha', 'branch', 'total_files', 'groups'],
}

const FINDING = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    line: { type: 'integer' },
    severity: { type: 'string', enum: SEV },
    title: { type: 'string' },
    failure_scenario: { type: 'string' },
    evidence: { type: 'string', enum: ['MEASURED', 'ASSUMED'] },
    suggested_fix: { type: 'string' },
  },
  required: ['file', 'line', 'severity', 'title', 'failure_scenario', 'evidence'],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: FINDING },
    read_in_full: { type: 'array', items: { type: 'string' } },
    sampled: { type: 'array', items: { type: 'string' } },
  },
  required: ['findings', 'read_in_full', 'sampled'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    reason: { type: 'string' },
    corrected_severity: { type: 'string', enum: SEV },
  },
  required: ['refuted', 'reason'],
}

const SYNTH_SCHEMA = {
  type: 'object',
  properties: {
    seam_findings: { type: 'array', items: FINDING },
    verdict: { type: 'string', enum: ['MERGEABLE', 'NOT MERGEABLE'] },
    strongest_reason: { type: 'string' },
    report_markdown: { type: 'string' },
  },
  required: ['seam_findings', 'verdict', 'strongest_reason', 'report_markdown'],
}

// ---------- helpers (plain code, never an agent) ----------
const sevRank = (s) => SEV.indexOf(s)
const key = (f) => `${f.file}:${Math.round((f.line || 0) / 5)}` // same file, ±5 lines → same finding
const byRisk = { money: 'financial-integrity-reviewer', migration: 'drizzle-migration-reviewer', tenant: 'security-engineer', auth: 'security-engineer', cron_webhook: 'reliability-guardian' }

// ---------- Phase 1: Scope ----------
phase('Scope')
const scope = await agent(
  `Scope a whole-branch review. Read-only git only — never checkout, stash, or commit.
1. \`git branch --show-current\`; \`git merge-base ${BASE} HEAD\` (that SHA is base_sha; HEAD is head_sha).
2. \`git diff <base_sha>..HEAD --stat\` — this list is the review scope, tests and docs included.
3. Bucket every changed file into at most ${MAX_GROUPS} groups. Bucket by MODULE first (src/modules/<m>/**, src/app/api/**, src/app/(staff)|(member)/**, drizzle/migrations/**, tests/**, docs+specs), then tag each group with its dominant risk band: money (invoicing/payments/renewals billing), tenant (any tenant-scoped repo or RLS), migration, auth (auth/RBAC/proxy), cron_webhook (src/app/api/cron|webhooks), ui, tests_docs, other.
4. Small groups that share a risk band may be merged; a group over ~15 files should be split. Every changed file must appear in exactly one group. Return the structure only.`,
  { label: 'scope:diff-stat', schema: GROUPS_SCHEMA },
)
if (!scope || !scope.groups || scope.groups.length === 0) {
  log('Scope returned nothing — is the branch ahead of ' + BASE + '?')
  // Same shape as the normal return, so a caller reading result.coverage never crashes on the empty path.
  return {
    branch: scope ? scope.branch : null, base: BASE, base_sha: scope ? scope.base_sha : null, head_sha: scope ? scope.head_sha : null,
    groups: [], confirmed: [], refuted: [], dropped: [],
    coverage: { read_in_full: [], sampled: [], unreviewed_groups: [] },
    verdict: 'NOT MERGEABLE', reason: 'scope phase produced no groups', report_markdown: null,
  }
}
const groups = scope.groups.slice(0, MAX_GROUPS)
if (scope.groups.length > MAX_GROUPS) log(`CAP: ${scope.groups.length - MAX_GROUPS} group(s) beyond maxGroups=${MAX_GROUPS} were NOT reviewed: ${scope.groups.slice(MAX_GROUPS).map((g) => g.name).join(', ')}`)
log(`${scope.branch} vs ${BASE}: ${scope.total_files} files in ${groups.length} group(s) — ${groups.map((g) => `${g.name}[${g.risk}:${g.files.length}]`).join(' · ')}`)

// ---------- Phase 2: Find (one fresh context per group) ----------
const finderPrompt = (g) => `You are reviewing ONE bucket of a larger branch: group "${g.name}" (risk band: ${g.risk}). Branch ${scope.branch}, base ${scope.base_sha.slice(0, 9)}, head ${scope.head_sha.slice(0, 9)}.

Files in your bucket (read EACH ONE IN FULL at HEAD, not just the hunks — a hunk can be correct while the function around it became wrong; compare with \`git show ${scope.base_sha}:<path>\` when you need the before-state):
${g.files.map((f) => '- ' + f).join('\n')}

Read-only git only: git show / git diff / git log -p. Never checkout, stash, or commit.

For every touched port, union member, error code, route error switch, or i18n key, grep the repo for every consumer AND every test double — grep tests/ for the SYMBOL, not the folder you think owns it. A stale vi.fn() stub or toHaveBeenCalledWith is invisible to tsc.

Report only what you can SHOW with a concrete failure scenario (input / state → wrong output, crash, wrong money, leaked tenant). Mark each finding MEASURED (you traced the live path or ran the check) or ASSUMED. Do not report style. Before calling anything a landmine, establish that the code is REACHABLE — dead destructive code is LOW, and say it is dead. Never make a claim stronger than the code supports. List which files you read in full and which you only sampled.`

// A barrier IS correct here: the dedup that follows needs every finder's output
// at once, and an empty candidate set should skip verification entirely.
// (Each agent also carries phase:'Find' explicitly — the documented way to keep
// the progress grouping race-free inside parallel().)
phase('Find')
const finderResults = await parallel(
  groups.map((g) => () =>
    agent(finderPrompt(g), {
      label: `find:${g.name}`,
      phase: 'Find',
      schema: FINDINGS_SCHEMA,
      model: 'opus',
      ...(byRisk[g.risk] ? { agentType: byRisk[g.risk] } : {}),
    }),
  ),
)
const finders = finderResults.filter(Boolean)
if (finders.length < groups.length) log(`${groups.length - finders.length} finder(s) returned nothing (skipped or died) — their groups are UNREVIEWED`)

const raw = [...SEED.map((f) => ({ ...f, evidence: f.evidence || 'ASSUMED', source: 'seed' })), ...finders.flatMap((r, i) => (r.findings || []).map((f) => ({ ...f, source: groups[i] ? groups[i].name : 'finder' })))]
const seen = new Map()
for (const f of raw) {
  const k = key(f)
  const prev = seen.get(k)
  if (!prev || sevRank(f.severity) < sevRank(prev.severity)) seen.set(k, f) // keep the more severe phrasing of a duplicate
}
const candidates = [...seen.values()].sort((a, b) => sevRank(a.severity) - sevRank(b.severity))
log(`${raw.length} raw finding(s) → ${candidates.length} after dedup (${SEED.length} seeded from the inline pass)`)

const seenKeys = new Set(SEEN.map(key))
const alreadySeen = candidates.filter((f) => seenKeys.has(key(f)))
const fresh = candidates.filter((f) => !seenKeys.has(key(f)))
if (SEEN.length) log(`${alreadySeen.length} candidate(s) sit in a file:line band from args.seen (${SEEN.length} earlier findings) and are NOT re-verified — only new classes are reported; they are returned under "suppressed"`)

const toVerify = fresh.slice(0, MAX_VERIFY)
const dropped = fresh.slice(MAX_VERIFY)
if (dropped.length) log(`CAP: ${dropped.length} lower-severity candidate(s) beyond maxVerify=${MAX_VERIFY} were NOT verified — they are returned under "dropped", not discarded`)

phase('Verify')
const LENSES = [
  'CORRECTNESS: trace the exact code path with the stated input; does the wrong output actually occur, or is there a guard, type, or earlier check the finder missed?',
  'REPRODUCE: could you write a failing test for this today from the stated scenario? If the scenario needs a state the system cannot reach, it is refuted.',
  'INTENT: read the surrounding docblock, spec, ADR or runbook — is this documented, deliberate behaviour that the finder read as a defect?',
]
const verified = toVerify.length === 0 ? [] : await parallel(
  toVerify.map((f) => () => {
    const votes = sevRank(f.severity) <= 1 ? 3 : 1 // BLOCKER/HIGH get all three lenses; MEDIUM/LOW one
    return parallel(
      LENSES.slice(0, votes).map((lens, li) => () =>
        agent(
          `Try to REFUTE this review finding. Default to refuted=true if you cannot confirm it from the code.
Branch ${scope.branch}, head ${scope.head_sha.slice(0, 9)}. Read-only git only.

Finding [${f.severity}] ${f.file}:${f.line} — ${f.title}
Claimed failure: ${f.failure_scenario}
Evidence level claimed by the finder: ${f.evidence}

Your lens — ${lens}

Read the file in full at HEAD. State the ONE fact that decides it. If it stands but at a different severity, say so in corrected_severity.`,
          { label: `verify:${f.file.split('/').pop()}:${f.line}:${['correct', 'repro', 'intent'][li]}`, phase: 'Verify', schema: VERDICT_SCHEMA, model: 'opus' },
        ),
      ),
    ).then((vs) => {
      const cast = vs.filter(Boolean)
      const standing = cast.filter((v) => !v.refuted)
      const survives = cast.length > 0 && standing.length * 2 > cast.length // strict majority of votes actually cast
      const sev = standing.map((v) => v.corrected_severity).filter(Boolean).sort((a, b) => sevRank(b) - sevRank(a))[0] || f.severity
      return { ...f, severity: survives ? sev : f.severity, survives, votes: cast.map((v) => ({ refuted: v.refuted, reason: v.reason })) }
    })
  }),
)
const confirmed = verified.filter(Boolean).filter((v) => v.survives).sort((a, b) => sevRank(a.severity) - sevRank(b.severity))
const refuted = verified.filter(Boolean).filter((v) => !v.survives)
log(`verify: ${confirmed.length} confirmed · ${refuted.length} refuted · ${dropped.length} unverified`)

// ---------- Phase 4: Synthesize (seams) ----------
phase('Synthesize')
const fmt = (f) => `- [${f.severity}] ${f.file}:${f.line} — ${f.title} (${f.evidence}${f.source ? ', via ' + f.source : ''})\n    ${f.failure_scenario}`
// The seam pass names a project agent; if that file is absent (fresh clone before
// .claude/agents/whole-branch-reviewer.md is committed) agent() throws, and the
// verdict below still falls out of the confirmed set rather than the whole run dying.
let synth = null
if (SEAM) {
  try {
    synth = await agent(
      `Final pass on branch ${scope.branch} (base ${scope.base_sha.slice(0, 9)} → head ${scope.head_sha.slice(0, 9)}, ${scope.total_files} files).

Per-module finders and an adversarial verify already ran. Do NOT redo their work. Their CONFIRMED findings:
${confirmed.length ? confirmed.map(fmt).join('\n') : '(none)'}

Findings they REFUTED — do not re-raise these unless you have NEW evidence:
${refuted.length ? refuted.map((f) => `- ${f.file}:${f.line} — ${f.title} → refuted: ${f.votes.map((v) => v.reason).join(' | ')}`).join('\n') : '(none)'}

Findings already handled in an EARLIER round (args.seen) — do not re-raise; if one is still present in the code, say so in one line under a "still open" note rather than as a new finding:
${SEEN.length ? SEEN.map((f) => `- ${f.file}:${f.line} — ${f.title || ''}`).join('\n') : '(none)'}

Your job is the SEAM: what only appears when the whole branch is read at once — contract drift between an early commit and a late caller, two paths that must agree and no longer do, flag polarity, ordering across commits, and what this branch says about itself (tasks.md ticks, docblocks, runbooks) versus what the code does. For any feature flag in the diff, list what is NOT behind it and therefore live on merge.

Return seam_findings (new findings only, same evidence discipline), the verdict, the strongest reason in one sentence, and report_markdown: a severity-sorted table of confirmed + seam findings, then "Read in full / sampled" and "Refuted" lists, ending with the exact line \`fresh re-review: MERGEABLE | NOT MERGEABLE — <reason>\`.`,
      { label: 'seam:whole-branch-reviewer', schema: SYNTH_SCHEMA, agentType: 'whole-branch-reviewer' },
    )
  } catch (e) {
    log(`seam pass unavailable (${e && e.message ? e.message : String(e)}) — is .claude/agents/whole-branch-reviewer.md present? Verdict falls back to the confirmed set`)
  }
}

const seamFindings = synth && Array.isArray(synth.seam_findings) ? synth.seam_findings : []
const all = [...confirmed, ...seamFindings.map((f) => ({ ...f, source: 'seam', survives: true }))].sort((a, b) => sevRank(a.severity) - sevRank(b.severity))
const verdict = synth ? synth.verdict : all.some((f) => sevRank(f.severity) <= 1) ? 'NOT MERGEABLE' : 'MERGEABLE'
const reason = synth ? synth.strongest_reason : all.length ? `${all[0].severity}: ${all[0].title}` : 'no confirmed findings'
log(`fresh re-review: ${verdict} — ${reason}`)

return {
  branch: scope.branch,
  base: BASE,
  base_sha: scope.base_sha,
  head_sha: scope.head_sha,
  groups: groups.map((g) => ({ name: g.name, risk: g.risk, files: g.files.length })),
  confirmed: all,
  refuted,
  dropped,
  suppressed: alreadySeen,
  coverage: {
    read_in_full: finders.flatMap((r) => r.read_in_full || []),
    sampled: finders.flatMap((r) => r.sampled || []),
    unreviewed_groups: scope.groups.slice(MAX_GROUPS).map((g) => g.name),
  },
  verdict,
  reason,
  report_markdown: synth ? synth.report_markdown : null,
}
