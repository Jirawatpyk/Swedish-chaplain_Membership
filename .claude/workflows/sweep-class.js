// sweep-class — find EVERY instance of a defect class across the codebase, then
// prove the sweep was not blind.
//
// Why this exists: sweeps here have a habit of "finishing" one hop short. The
// actor-role truth sweep took five rounds because each fix's blind spot caused
// the next; the `err:` sweep declared "all 6 swept" and missed the MULTI-LINE
// shape the round before had warned about by name; `return _exhaustive` still
// has ~11 instances after a review that fixed three. The pattern is always the
// same — the sweep searched the syntactic forms it had already seen, in the
// modules it had already looked at.
//
// So this script separates FORMS from PLACES, and puts a critic between rounds:
//
//   Forms    three agents, three modalities (regex / type-and-AST shape / test-double
//            and call-site), each enumerating how the class can be spelled — union
//   Buckets  one cheap agent lists the search space (src/modules/*, src/app, src/lib,
//            scripts, tests)
//   Find     one finder per bucket, ALL forms, fresh context; returns instances
//            classified fix / exempt / unsure, with the reason
//   Control  the KNOWN examples you passed in must be among the instances found —
//            if not, the sweep is blind and says so (the round still counts, the
//            result is flagged)
//   Critic   "which form or bucket did we not search?" — new forms/buckets feed
//            the next round; loop until the critic has nothing and a round is dry
//   Verify   an `exempt` is a claim; a wrong exempt IS the next round's blind
//            spot. Skeptics re-check exempt/unsure instances (capped, logged)
//
// This script never edits a file. It returns the full instance list; you fix
// (one committer, sequentially) and can re-run with `seen` to confirm dryness.
//
// Invoke (opt-in only):
//   Workflow({ name: 'sweep-class', args: {
//     cls: 'default: { return _exhaustive } — returns the value at runtime, so an unknown variant is accepted',
//     examples: [ { file: 'src/modules/payments/domain/tenant-payment-settings.ts', line: 114 } ],
//     buckets: undefined,          // optional override: [{ name, paths: [] }]
//     maxRounds: 3, maxFinders: 10, maxVerify: 12, seen: [] } })

export const meta = {
  name: 'sweep-class',
  description: 'Codebase-wide sweep of one defect class: multi-modal form discovery → per-bucket finders → positive control → completeness critic → loop until dry',
  whenToUse: 'A defect class was found once and must be closed EVERYWHERE (audit-truth, fail-open arms, a widened union, a renamed port). Not for a single known file — grep it yourself.',
  phases: [
    { title: 'Forms', detail: 'three modalities enumerate how the class can be spelled', model: 'opus' },
    { title: 'Buckets', detail: 'list the search space' },
    { title: 'Find', detail: 'one finder per bucket per round, all forms, fresh context', model: 'opus' },
    { title: 'Critic', detail: 'positive control + "what did we not search?"', model: 'opus' },
    { title: 'Verify', detail: 'skeptics re-check every exempt / unsure', model: 'opus' },
  ],
}

// ---------- args ----------
const A = args && typeof args === 'object' ? args : {}
const CLS = typeof A.cls === 'string' && A.cls.trim() ? A.cls.trim() : null
const EXAMPLES = Array.isArray(A.examples) ? A.examples.filter((e) => e && typeof e.file === 'string') : []
const BUCKET_OVERRIDE = Array.isArray(A.buckets) && A.buckets.length ? A.buckets : null
const MAX_ROUNDS = Number.isInteger(A.maxRounds) ? A.maxRounds : 3
const MAX_FINDERS = Number.isInteger(A.maxFinders) ? A.maxFinders : 10
const MAX_VERIFY = Number.isInteger(A.maxVerify) ? A.maxVerify : 12
const SEEN = Array.isArray(A.seen) ? A.seen : []

const EMPTY = (reason) => ({ cls: CLS, forms: [], instances: { fix: [], exempt: [], unsure: [] }, suppressed: [], rounds: [], positive_control: { passed: false, missing_examples: EXAMPLES }, coverage: { buckets: [], unsearched_buckets: [] }, complete: false, reason, report_markdown: null })
if (!CLS) {
  log('sweep-class needs args.cls — a one-paragraph description of the defect class')
  return EMPTY('no class description')
}

// ---------- schemas ----------
const FORM = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    rg_pattern: { type: 'string' },
    example_snippet: { type: 'string' },
    modality: { type: 'string', enum: ['regex', 'type_ast', 'test_double_callsite', 'critic'] },
  },
  required: ['name', 'description', 'modality'],
}
const FORMS_SCHEMA = { type: 'object', properties: { forms: { type: 'array', items: FORM } }, required: ['forms'] }

const BUCKETS_SCHEMA = {
  type: 'object',
  properties: {
    buckets: {
      type: 'array',
      items: { type: 'object', properties: { name: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } }, required: ['name', 'paths'] },
    },
  },
  required: ['buckets'],
}

const INSTANCE = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    line: { type: 'integer' },
    form: { type: 'string' },
    snippet: { type: 'string' },
    classification: { type: 'string', enum: ['fix', 'exempt', 'unsure'] },
    reason: { type: 'string' },
  },
  required: ['file', 'line', 'form', 'classification', 'reason'],
}
const INSTANCES_SCHEMA = {
  type: 'object',
  properties: {
    instances: { type: 'array', items: INSTANCE },
    files_scanned: { type: 'integer' },
    forms_with_zero_hits: { type: 'array', items: { type: 'string' } },
  },
  required: ['instances', 'files_scanned', 'forms_with_zero_hits'],
}

const CRITIC_SCHEMA = {
  type: 'object',
  properties: {
    missing_forms: { type: 'array', items: FORM },
    missing_buckets: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } }, required: ['name', 'paths'] } },
    blind_spot_explanation: { type: 'string' },
    complete: { type: 'boolean' },
  },
  required: ['missing_forms', 'missing_buckets', 'blind_spot_explanation', 'complete'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: { classification: { type: 'string', enum: ['fix', 'exempt'] }, reason: { type: 'string' } },
  required: ['classification', 'reason'],
}

// ---------- helpers ----------
const ikey = (x) => `${x.file}:${Math.round((x.line || 0) / 3)}` // same file, ±3 lines → same instance
const near = (a, b) => a.file === b.file && Math.abs((a.line || 0) - (b.line || 0)) <= 5
const fmtForms = (fs) => fs.map((f) => `- ${f.name} [${f.modality}]: ${f.description}${f.rg_pattern ? `  (rg: ${f.rg_pattern})` : ''}${f.example_snippet ? `\n    e.g. ${f.example_snippet}` : ''}`).join('\n')
const exampleText = EXAMPLES.length ? EXAMPLES.map((e) => `- ${e.file}:${e.line}${e.snippet ? ` — ${e.snippet}` : ''}`).join('\n') : '(none given — the positive control cannot run; say so in the report)'

// ---------- Phase 1: Forms (three modalities, barrier justified: union before any finder) ----------
phase('Forms')
const MODALITIES = [
  ['regex', 'You think in TEXT. Enumerate every spelling: single-line and MULTI-LINE layouts, with/without braces, arrow vs block bodies, template literals, comments that carry the pattern, and the negated/inverted spelling. Give an rg pattern per form and state what each pattern would MISS.'],
  ['type_ast', 'You think in TYPES and AST SHAPE. Enumerate every structural form: which node kinds carry it (switch default, ternary, nullish default, catch fallback, exhaustive-never helpers, object spread), how a widened union or a new enum member reaches it, and where the compiler is BLIND to it.'],
  ['test_double_callsite', 'You think in CALL SITES and TEST DOUBLES. Enumerate every place the class hides outside the obvious file: vi.fn() stubs and toHaveBeenCalledWith assertions in tests/, adapters and bridges between modules, scripts/, cron and webhook routes, generated or copied code, and docs/runbooks that describe the old behaviour.'],
]
const formSets = await parallel(
  MODALITIES.map(([mod, brief]) => () =>
    agent(
      `Defect class to sweep:
${CLS}

Known instances (ground truth — your forms MUST cover every one of these):
${exampleText}

${brief}

Read the known instances in full first. Return forms with modality "${mod}". Do not search the codebase for instances — that is the next phase. Be exhaustive on FORMS, not on locations.`,
      { label: `forms:${mod}`, phase: 'Forms', schema: FORMS_SCHEMA, model: 'opus' },
    ),
  ),
)
const formByName = new Map()
for (const set of formSets.filter(Boolean)) for (const f of set.forms || []) if (!formByName.has(f.name)) formByName.set(f.name, f)
let forms = [...formByName.values()]
if (formSets.filter(Boolean).length < MODALITIES.length) log(`${MODALITIES.length - formSets.filter(Boolean).length} modality agent(s) returned nothing — form discovery is INCOMPLETE on that axis`)
if (forms.length === 0) { log('no forms enumerated — cannot sweep'); return EMPTY('form discovery produced nothing') }
log(`${forms.length} form(s) from ${formSets.filter(Boolean).length} modalities: ${forms.map((f) => f.name).join(' · ')}`)

// ---------- Phase 2: Buckets ----------
phase('Buckets')
let buckets = BUCKET_OVERRIDE
if (!buckets) {
  const b = await agent(
    `List the search space for a codebase-wide sweep as buckets of paths. Read-only. One bucket per src/modules/<name> (list them with ls), plus src/app, src/lib + src/components + src/config + src/hooks + src/i18n, scripts, drizzle/migrations, and tests (unit / contract / integration / e2e as ONE bucket named tests). Skip node_modules, .next, .claude/worktrees. Return at most ${MAX_FINDERS} buckets — merge the smallest src/modules together if there are more.`,
    { label: 'buckets:list', phase: 'Buckets', schema: BUCKETS_SCHEMA, effort: 'low' },
  )
  buckets = b && Array.isArray(b.buckets) ? b.buckets : []
}
if (buckets.length === 0) { log('no buckets — cannot sweep'); return EMPTY('bucket listing produced nothing') }
const unsearched = buckets.slice(MAX_FINDERS)
buckets = buckets.slice(0, MAX_FINDERS)
if (unsearched.length) log(`CAP: ${unsearched.length} bucket(s) beyond maxFinders=${MAX_FINDERS} are NOT searched: ${unsearched.map((b) => b.name).join(', ')}`)

// ---------- Phases 3–4: Find + Critic, looped ----------
const found = new Map() // ikey → instance
const seenKeys = new Set(SEEN.map(ikey))
const rounds = []
let positive = { passed: EXAMPLES.length === 0 ? null : false, missing_examples: [] }
let searchForms = forms
let searchBuckets = buckets
let round = 0
let dry = 0

const finderPrompt = (b, fs, r) => `Round ${r} of a codebase-wide sweep. Bucket "${b.name}":
${b.paths.map((p) => '- ' + p).join('\n')}

Defect class:
${CLS}

Forms to search — search EVERY form in EVERY file of this bucket, using rg where a pattern is given and reading the file where the form is structural:
${fmtForms(fs)}

For each hit return file, line, the form name, a one-line snippet, and a classification: "fix" (the class applies and the code should change), "exempt" (the pattern is present but the class does NOT apply — you must give the concrete reason, e.g. the value is discarded on the next line), or "unsure". An exempt without a reason is a fix. Report forms_with_zero_hits so the critic can tell "searched, nothing" from "not searched". Read-only; never edit, checkout or stash.`

while (round < MAX_ROUNDS) {
  round++
  phase('Find')
  const results = await parallel(
    searchBuckets.map((b) => () => agent(finderPrompt(b, searchForms, round), { label: `find:r${round}:${b.name}`, phase: 'Find', schema: INSTANCES_SCHEMA, model: 'opus' })),
  )
  const ok = results.filter(Boolean)
  if (ok.length < searchBuckets.length) log(`round ${round}: ${searchBuckets.length - ok.length} finder(s) returned nothing — those buckets are UNSEARCHED this round`)
  const hits = results.flatMap((r, i) => (r && r.instances ? r.instances.map((x) => ({ ...x, bucket: searchBuckets[i].name, round })) : []))
  const fresh = hits.filter((x) => !found.has(ikey(x)))
  for (const x of fresh) found.set(ikey(x), x)
  const zeroHitForms = ok.flatMap((r) => r.forms_with_zero_hits || [])

  // Positive control — the known examples must be among what we found.
  if (EXAMPLES.length) {
    const missing = EXAMPLES.filter((e) => ![...found.values()].some((x) => near(x, e)))
    positive = { passed: missing.length === 0, missing_examples: missing }
    if (missing.length) log(`round ${round}: SWEEP IS BLIND — ${missing.length} known example(s) NOT found: ${missing.map((e) => `${e.file}:${e.line}`).join(', ')}. Forms or buckets are wrong; the critic is told.`)
  }

  phase('Critic')
  const critic = await agent(
    `You are the completeness critic for round ${round} of a codebase-wide sweep. Your only question: WHAT DID WE NOT SEARCH?

Defect class:
${CLS}

Forms searched so far (${forms.length}):
${fmtForms(forms)}

Buckets searched (${buckets.length}): ${buckets.map((b) => b.name).join(', ')}${unsearched.length ? `\nBuckets NOT searched (capped): ${unsearched.map((b) => b.name).join(', ')}` : ''}

Instances found so far: ${found.size} (this round: ${hits.length}, new: ${fresh.length}). Forms that hit ZERO files in every bucket this round: ${zeroHitForms.length ? [...new Set(zeroHitForms)].join(', ') : '(none)'}.
Positive control: ${EXAMPLES.length ? (positive.passed ? 'PASSED — every known example was found' : `FAILED — not found: ${positive.missing_examples.map((e) => `${e.file}:${e.line}`).join(', ')}. Open those files and explain which FORM or BUCKET would have caught them; that is your first missing_form or missing_bucket.`) : 'not run (no examples given)'}

Then reason one hop past the sweep: a syntactic form nobody listed (multi-line layout, an alias, a helper that wraps the pattern, a generated file), a bucket outside src (scripts, tests doubles, docs that describe the old behaviour), and the INVERSE — a place the class was "fixed" in a way that reintroduces it. Read a few of the found instances and ask what a sibling of each would look like. Return only NEW forms and buckets; return complete=true only if you genuinely have nothing to add.`,
    { label: `critic:r${round}`, phase: 'Critic', schema: CRITIC_SCHEMA, model: 'opus' },
  )
  const newForms = critic && Array.isArray(critic.missing_forms) ? critic.missing_forms.filter((f) => f && f.name && !formByName.has(f.name)).map((f) => ({ ...f, modality: 'critic' })) : []
  const newBuckets = critic && Array.isArray(critic.missing_buckets) ? critic.missing_buckets.filter((b) => b && b.name && !buckets.some((x) => x.name === b.name)) : []
  rounds.push({ round, forms_searched: searchForms.length, buckets_searched: searchBuckets.length, hits: hits.length, fresh: fresh.length, critic_new_forms: newForms.length, critic_new_buckets: newBuckets.length, critic_complete: critic ? critic.complete : null, blind_spot: critic ? critic.blind_spot_explanation : 'critic returned nothing' })
  log(`round ${round}: ${hits.length} hit(s), ${fresh.length} new, total ${found.size} · critic: +${newForms.length} form(s) +${newBuckets.length} bucket(s)${critic && critic.complete ? ' · COMPLETE' : ''}`)

  if (fresh.length === 0) dry++
  else dry = 0
  if (!critic) { log('critic returned nothing — stopping; treat coverage as UNVERIFIED'); break }
  if (newForms.length === 0 && newBuckets.length === 0) {
    if (critic.complete || dry >= 1) break
    // critic added nothing but does not call it complete and the round was not dry: one more full pass is the cheapest honest move
    searchForms = forms
    searchBuckets = buckets
    continue
  }
  for (const f of newForms) formByName.set(f.name, f)
  forms = [...formByName.values()]
  buckets = [...buckets, ...newBuckets]
  // Next round: new forms across ALL buckets, plus ALL forms across the new buckets.
  searchForms = newBuckets.length ? forms : newForms
  searchBuckets = newForms.length ? buckets : newBuckets
  if (newForms.length && newBuckets.length) { searchForms = forms; searchBuckets = buckets }
}
if (round >= MAX_ROUNDS) log(`CAP: stopped at maxRounds=${MAX_ROUNDS} — the last critic still ${rounds[rounds.length - 1] && rounds[rounds.length - 1].critic_complete ? 'called it complete' : 'had open questions; coverage is NOT proven'}`)

// ---------- Phase 5: Verify exempt / unsure ----------
const all = [...found.values()]
const suppressed = all.filter((x) => seenKeys.has(ikey(x)))
const live = all.filter((x) => !seenKeys.has(ikey(x)))
if (SEEN.length) log(`${suppressed.length} instance(s) match args.seen and are returned under "suppressed"`)
const toCheck = live.filter((x) => x.classification !== 'fix')
const checked = toCheck.slice(0, MAX_VERIFY)
const uncheckedTail = toCheck.slice(MAX_VERIFY)
if (uncheckedTail.length) log(`CAP: ${uncheckedTail.length} exempt/unsure instance(s) beyond maxVerify=${MAX_VERIFY} keep the finder's classification UNVERIFIED — listed under unsure`)

phase('Verify')
const verdicts = checked.length === 0 ? [] : await parallel(
  checked.map((x) => () =>
    agent(
      `A sweep finder classified this instance as "${x.classification}" with the reason: "${x.reason}". Try to REFUTE the exemption — default to classification "fix" unless the code itself proves the class does not apply here.

Defect class:
${CLS}

Instance: ${x.file}:${x.line} (form: ${x.form})
${x.snippet ? 'Snippet: ' + x.snippet : ''}

Read the file in full. A wrong exempt is exactly the blind spot that costs the next sweep round, so the bar is the CODE, not the finder's argument. State the one fact that decides it.`,
      { label: `verify:${x.file.split('/').pop()}:${x.line}`, phase: 'Verify', schema: VERDICT_SCHEMA, model: 'opus' },
    ).then((v) => ({ x, v })),
  ),
)
const finalOf = new Map(live.map((x) => [ikey(x), { ...x, verified: false }]))
for (const r of verdicts.filter(Boolean)) {
  if (!r.v) continue
  finalOf.set(ikey(r.x), { ...r.x, classification: r.v.classification, reason: r.v.reason, verified: true, finder_said: r.x.classification })
}
for (const x of uncheckedTail) finalOf.set(ikey(x), { ...x, classification: 'unsure', verified: false, finder_said: x.classification })
const finals = [...finalOf.values()]
const instances = {
  fix: finals.filter((x) => x.classification === 'fix').sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
  exempt: finals.filter((x) => x.classification === 'exempt').sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
  unsure: finals.filter((x) => x.classification === 'unsure').sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
}
const lastRound = rounds[rounds.length - 1]
const complete = Boolean(lastRound && lastRound.critic_complete) && (positive.passed !== false) && unsearched.length === 0 && round < MAX_ROUNDS + 1
log(`sweep: ${instances.fix.length} to fix · ${instances.exempt.length} exempt · ${instances.unsure.length} unsure · ${suppressed.length} suppressed · positive control ${positive.passed === null ? 'not run' : positive.passed ? 'PASSED' : 'FAILED'} · ${complete ? 'COMPLETE' : 'NOT proven complete'}`)

const row = (x) => `| ${x.file}:${x.line} | ${x.form} | ${x.verified ? 'verified' : 'finder'} | ${x.reason} |`
const report = [
  `# sweep-class — ${CLS.split('\n')[0]}`,
  '',
  `Rounds: ${rounds.length} · forms: ${forms.length} · buckets: ${buckets.length}${unsearched.length ? ` (+${unsearched.length} NOT searched)` : ''} · positive control: ${positive.passed === null ? 'not run' : positive.passed ? 'passed' : 'FAILED — ' + positive.missing_examples.map((e) => `${e.file}:${e.line}`).join(', ')}`,
  '',
  `## Fix (${instances.fix.length})`, '| where | form | by | reason |', '|---|---|---|---|', ...instances.fix.map(row),
  '',
  `## Exempt (${instances.exempt.length})`, '| where | form | by | reason |', '|---|---|---|---|', ...instances.exempt.map(row),
  '',
  `## Unsure (${instances.unsure.length})`, '| where | form | by | reason |', '|---|---|---|---|', ...instances.unsure.map(row),
  '',
  '## Rounds', ...rounds.map((r) => `- r${r.round}: ${r.hits} hits / ${r.fresh} new · critic +${r.critic_new_forms} forms +${r.critic_new_buckets} buckets · ${r.critic_complete ? 'complete' : 'open'} — ${r.blind_spot}`),
  '',
  complete ? 'Coverage: COMPLETE by the critic, positive control passed.' : 'Coverage: NOT proven complete — see the last round and any CAP lines.',
].join('\n')

return {
  cls: CLS,
  forms,
  instances,
  suppressed,
  rounds,
  positive_control: positive,
  coverage: { buckets: buckets.map((b) => b.name), unsearched_buckets: unsearched.map((b) => b.name) },
  complete,
  reason: complete ? 'critic complete + positive control passed' : 'see rounds / caps',
  report_markdown: report,
}
