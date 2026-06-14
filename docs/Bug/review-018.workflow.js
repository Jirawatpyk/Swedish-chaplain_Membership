export const meta = {
  name: 'code-review-018-p1-4',
  description: 'xhigh recall review of branch 018 (P1-4 quota insights)',
  phases: [
    { title: 'Find', detail: '9 finder angles' },
    { title: 'Verify', detail: '1-vote 3-state' },
    { title: 'Sweep', detail: 'gap hunt' },
    { title: 'VerifySweep', detail: 'verify sweep' },
  ],
}

const DIFF = 'docs/Bug/review_018.diff'

const PROJECT = [
  'PROJECT: Chamber-OS (Next.js 16 / React 19 / TS strict / Drizzle / Neon Postgres / next-intl).',
  'This diff is branch 018-f9-quota-insights (range main...HEAD): ONE feature commit implementing',
  'go-live finding P1-4 = FR-004 cross-member quota insights in the F9 insights module. It adds the',
  'two dashboard cards that shipped as dead zeros (unused_eblast_quota + underused_event_tickets) and',
  'the underDeliveredBenefitCount headline KPI (was hardcoded 0).',
  '',
  'ARCHITECTURE (Approach C-hybrid): constant query count (no N+1), all aggregate SQL inside F9 infra.',
  '- domain/quota-underuse.ts: pure countUnderUsedQuota(members, eblastUsedByMember, culturalUsedByMember,',
  '  entitlementByPlanKey) returns {unusedEblastMembers, underusedTicketMembers, underDeliveredEither}.',
  '  Threshold = "any shortfall": a member counts for a benefit IFF entitlement>0 AND used<entitlement.',
  '  underDeliveredEither = de-duped UNION (Set). Missing plan entitlement => member excluded. planKey(id,year).',
  '- ports/source-ports.ts: MemberEnumerationSource.listActiveWithPlan + ',
  '  BenefitConsumptionAggregateSource.eblastUsedByMember/culturalUsedByMember(ctx, year) returning a Map.',
  '- infra/member-enumeration-adapter.ts: paginates members barrel directorySearchWithCount, status active only,',
  '  PAGE_SIZE=100 (clamp), accumulates MemberPlanRef list.',
  '- infra/benefit-consumption-aggregate-adapter.ts: 2 batched GROUP BY inside runInTenant.',
  "  eblast: broadcasts WHERE tenantId=ctx.slug AND status=sent AND quotaYearConsumed=membershipYear GROUP BY requestedByMemberId.",
  '  cultural: eventRegistrations JOIN events WHERE tenantId=ctx.slug AND isCulturalEvent=true AND startDate in',
  '  [yearStart, min(yearEnd, now)] AND piiPseudonymisedAt IS NULL AND archivedAt IS NULL AND matchedMemberId IS NOT NULL',
  '  GROUP BY matchedMemberId. toCountMap drops null group-keys. Fail-loud (rejects, never empty map).',
  '- use-case compute-dashboard-snapshot.ts: added the 3 reads to the existing Promise.all, then builds a',
  '  distinct-plan memo (planKey to entitlement via planSource.getEntitlements, null skipped), calls',
  '  countUnderUsedQuota, pushes count>0 cards (after at_risk), sets underDeliveredBenefitCount.',
  '',
  'HIGH-RISK INVARIANTS to weigh (a violation of any is a real bug):',
  '- SQL-FILTER EQUIVALENCE: the batched GROUP BY filters MUST match the per-member sources',
  '  (drizzle-broadcasts-repo.countForMemberQuota: status=sent AND quotaYearConsumed=year; the per-member',
  '  event source: isCulturalEvent + tenant-tz [yearStart, min(yearEnd,now)] + pii/archived null). A drift =',
  '  wrong counts. An equivalence integration test exists, but check the filters by reading BOTH sides.',
  '- YEAR ALIGNMENT: the use-case computes year = calendar year in tenant tz (Intl en-CA). The eblast aggregate',
  '  filters quotaYearConsumed=year; the per-member quota counter derives its OWN quotaYear from',
  '  currentQuotaYear(clock.now(), tz). Could they diverge at the tenant-tz New-Year boundary?',
  '- TENANT ISOLATION: aggregate queries run inside runInTenant(ctx) (RLS) + explicit eq(tenantId, ctx.slug).',
  '  Verify no global-db reach; verify the events query tenant predicate is on the right table.',
  '- THRESHOLD/UNION: used===entitlement NOT counted; used>entitlement NOT counted; absent member => 0 counted;',
  '  entitlement 0 excluded; underDeliveredEither de-dups; missing plan excluded.',
  '- MEMOIZATION: distinctPlans keyed by planKey; getEntitlements null => not added (member excluded).',
  '- PAGINATION: PAGE_SIZE=100 clamp; offset advances by items.length; termination (items<pageSize OR offset>=total).',
  '  Off-by-one / infinite loop / undercount?',
  '- FAIL-LOUD: a DB error must NOT become a false-zero count (would suppress a real under-use card).',
  '- DRIZZLE: gte/lte on a timestamp column expects Date (not ISO string); COUNT(*)::int cast; status enum value.',
  '- TEST QUALITY: vacuous assertions; setup/teardown asymmetry; chain-mock fidelity; date-boundary fragility',
  '  (THIS_YEAR = yearStart + 1h: robust except the first hour of the year?).',
  '',
  'Read the diff at ' + DIFF + '. For any suspect hunk ALSO Read the enclosing function in the repo and Grep',
  'callers/callees. Bugs in unchanged lines of a touched function are IN SCOPE. Report only defects with a',
  'NAMEABLE failure scenario. Pass through anything you half-believe; the verify step filters.',
].join('\n')

const FINDER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['candidates'],
  properties: {
    candidates: {
      type: 'array', maxItems: 8, items: {
        type: 'object', additionalProperties: false,
        required: ['file', 'line', 'summary', 'failure_scenario', 'category', 'severity'],
        properties: {
          file: { type: 'string' }, line: { type: 'number' },
          summary: { type: 'string' }, failure_scenario: { type: 'string' },
          category: { type: 'string', enum: ['correctness', 'cleanup', 'altitude'] },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
}
const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['vote', 'evidence'],
  properties: {
    vote: { type: 'string', enum: ['CONFIRMED', 'PLAUSIBLE', 'REFUTED'] },
    evidence: { type: 'string' },
  },
}

const ANGLES = [
  { key: 'A-line-by-line', brief: 'Read every hunk line by line + the enclosing function. Inverted/wrong conditions, off-by-one, null deref, missing await, falsy-zero, wrong-variable copy-paste, swallowed errors. Focus on countUnderUsedQuota branches, the use-case roll-up block, and the pagination loop.' },
  { key: 'B-removed-behavior', brief: 'The use-case REPLACED the ternary candidates init and the hardcoded underDeliveredBenefitCount 0. Did the replacement preserve the at_risk gate + dismissal-filter semantics exactly? Did widening the Promise.all change any prior index/destructuring? Did the header-comment change hide a still-true caveat?' },
  { key: 'C-cross-file-tracer', brief: 'computeDashboardSnapshot deps widened (3 new required fields). Grep ALL callers + ALL test deps-builders + the cron path: does every construction of ComputeDashboardSnapshotDeps now supply memberEnumeration/consumptionAggregate/planSource? A missing field is a runtime undefined.listActiveWithPlan. Check makeComputeDashboardSnapshotDeps + every test that builds the deps inline.' },
  { key: 'D-language-pitfall', brief: 'Drizzle/JS/TS pitfalls: gte/lte Date-vs-string on events.startDate; eq(status, sent) enum; COUNT(*)::int; Map.get falsy-zero (?? 0 vs ||); Number/Intl year parse; tenant-tz year boundary; new Date(startMs+3600000) robustness; Promise.all rejection semantics (fail-loud).' },
  { key: 'E-wrapper-proxy', brief: 'The aggregate adapter reaches into broadcasts/events SCHEMA (cross-module infra). Verify: the eblast query filters broadcasts.tenantId; the cultural query filters eventRegistrations.tenantId (not events.tenantId only) + the join predicate; toCountMap drops null keys; the adapter forwards membershipYear; no reach into broadcasts/events application/domain.' },
  { key: 'Reuse', brief: 'Does the diff re-implement something existing? The pagination loop duplicates member-source-adapter.joinDistribution; the year window duplicates the per-member event source. Is there a shared helper that should be used? Name it.' },
  { key: 'Simplification', brief: 'Unnecessary complexity: redundant state, the distinctPlans Map + entitlementByPlanKey Map (could it be one pass?), deep nesting, dead code. Name the simpler form.' },
  { key: 'Efficiency', brief: 'Wasted work: the use-case now does TWO full active-member scans (joinDistribution all-status + the new enumeration active-only). Redundant? The Promise.all over distinct plans, sequential vs parallel? Per-row I/O? Name the cheaper alternative.' },
  { key: 'Altitude', brief: 'Right depth or bandaid? The SQL-filter duplication between the batched adapter and the per-member sources (drift risk): is the equivalence test enough, or should the filter be shared? Is reaching foreign schema the right altitude vs a barrel method?' },
]

phase('Find')
const finderResults = await parallel(ANGLES.map((a) => () =>
  agent(PROJECT + '\n\nYOUR ANGLE - ' + a.key + ':\n' + a.brief + '\n\nReturn UP TO 8 candidates with a real failure scenario.',
    { label: 'find:' + a.key, phase: 'Find', schema: FINDER_SCHEMA },
  ).then((r) => (r && r.candidates ? r.candidates : []).map((c) => ({ ...c, angle: a.key })))
))
const allCandidates = finderResults.filter(Boolean).flat()
const byKey = new Map()
for (const c of allCandidates) {
  const key = c.file + '::' + c.line + '::' + (c.summary || '').toLowerCase().slice(0, 30)
  const prev = byKey.get(key)
  if (!prev || (c.failure_scenario || '').length > (prev.failure_scenario || '').length) byKey.set(key, c)
}
const deduped = [...byKey.values()]
log('Find: ' + allCandidates.length + ' raw -> ' + deduped.length + ' deduped')

phase('Verify')
const verified = await parallel(deduped.map((c) => () =>
  agent(PROJECT + '\n\nVERIFY ONE CANDIDATE (1-vote, 3-state). Read ' + DIFF + ' + the actual repo file + enclosing function before voting.\n\nCANDIDATE:\n  file: ' + c.file + '\n  line: ' + c.line + '\n  category: ' + c.category + ' | severity: ' + c.severity + ' | angle: ' + c.angle + '\n  summary: ' + c.summary + '\n  failure_scenario: ' + c.failure_scenario + '\n\nVote CONFIRMED (quote the triggering line), PLAUSIBLE (real mechanism, uncertain trigger), or REFUTED (quote the disproving line/guard). Recall mode: refute ONLY when constructibly disproven.',
    { label: 'verify:' + c.file.split('/').pop() + ':' + c.line, phase: 'Verify', schema: VERDICT_SCHEMA },
  ).then((v) => (v && v.vote !== 'REFUTED') ? { ...c, vote: v.vote, evidence: v.evidence } : null)
))
const survivors = verified.filter(Boolean)
log('Verify: ' + survivors.length + '/' + deduped.length + ' survived')

phase('Sweep')
const sweepList = survivors.map((s) => '- [' + s.vote + '] ' + s.file + ':' + s.line + ' - ' + s.summary).join('\n')
const sweepRaw = await agent(
  PROJECT + '\n\nFRESH reviewer with the already-verified findings below. Re-read ' + DIFF + ' + enclosing functions; surface ONLY defects NOT already listed. Hunt what the first pass misses: the new tests (vacuous assertions, chain-mock fidelity, date-boundary fragility, setup/teardown), the T022 assertion update correctness, the dismissal cycle-key for the quota keys, the Promise.all index alignment. Up to 8 NEW candidates; empty if none.\n\nALREADY FOUND:\n' + (sweepList || '(none)'),
  { label: 'sweep', phase: 'Sweep', schema: FINDER_SCHEMA },
)
const sweepCandidates = (sweepRaw && sweepRaw.candidates ? sweepRaw.candidates : []).map((c) => ({ ...c, angle: 'Sweep' }))
log('Sweep: ' + sweepCandidates.length + ' new')

phase('VerifySweep')
const sweepVerified = await parallel(sweepCandidates.map((c) => () =>
  agent(PROJECT + '\n\nVERIFY ONE SWEEP CANDIDATE (1-vote, 3-state). Read ' + DIFF + ' + repo file + enclosing function.\n\nCANDIDATE:\n  file: ' + c.file + '\n  line: ' + c.line + '\n  summary: ' + c.summary + '\n  failure_scenario: ' + c.failure_scenario + '\n\nVote CONFIRMED / PLAUSIBLE / REFUTED with evidence (quote lines).',
    { label: 'verify-sweep:' + c.file.split('/').pop() + ':' + c.line, phase: 'VerifySweep', schema: VERDICT_SCHEMA },
  ).then((v) => (v && v.vote !== 'REFUTED') ? { ...c, vote: v.vote, evidence: v.evidence } : null)
))

const all = [...survivors, ...sweepVerified.filter(Boolean)]
const catRank = { correctness: 0, altitude: 1, cleanup: 2 }
const sevRank = { high: 0, medium: 1, low: 2 }
const voteRank = { CONFIRMED: 0, PLAUSIBLE: 1 }
all.sort((x, y) =>
  (catRank[x.category] - catRank[y.category]) ||
  (sevRank[x.severity] - sevRank[y.severity]) ||
  (voteRank[x.vote] - voteRank[y.vote]))

return {
  counts: { raw: allCandidates.length, deduped: deduped.length, survivors: survivors.length, sweepNew: sweepVerified.filter(Boolean).length, total: all.length },
  findings: all.slice(0, 15).map((f) => ({ file: f.file, line: f.line, summary: f.summary, failure_scenario: f.failure_scenario, category: f.category, severity: f.severity, vote: f.vote, angle: f.angle, evidence: f.evidence })),
}
