/**
 * F119 T083 (research R17) — `list-member-broadcast-versions.ts` Application
 * use-case: the approval round of every E-Blast the member originated, for
 * the F9 GDPR archive's `broadcast-versions.json`.
 *
 * Grouped per E-Blast — the versions the member was shown (oldest first) and
 * the member's decisions on them (oldest first) — through the SAME member
 * projection the portal thread uses (`_member-view.ts`): no unsent working
 * copy, no staff user id or name (`authoredBy` is `'member' | 'organisation'`,
 * decisions carry no decider). After an erasure the rows are still here, with
 * the `[redacted]` sentinels the erasure wrote, which is the point: the
 * archive shows what is held, and what is held is the sentinel.
 *
 * Capped: each list is read with `limit + 1` so the caller learns whether it
 * was truncated (newest rows kept), the convention every other archive
 * category follows. Threads run newest activity first.
 *
 * Pure Application — only ports.
 */
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '@/modules/members';
import type { BroadcastDecisionsRepo } from '../ports/broadcast-decisions-repo';
import type { BroadcastVersionsRepo } from '../ports/broadcast-versions-repo';
import type { ApprovalBroadcastsRepo } from './approval/_approval-tx';
import {
  projectDecisionForMember,
  projectVersionForMember,
  type MemberVisibleDecision,
  type MemberVisibleVersion,
} from './approval/_member-view';

export interface ListMemberBroadcastVersionsDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: Pick<ApprovalBroadcastsRepo, 'withTx'>;
  readonly versionsRepo: Pick<BroadcastVersionsRepo, 'listSentByMember'>;
  readonly decisionsRepo: Pick<BroadcastDecisionsRepo, 'listByMember'>;
}

export interface ListMemberBroadcastVersionsInput {
  readonly memberId: MemberId;
  /** The cap on EACH of the two lists (versions, decisions). */
  readonly limit: number;
}

export interface MemberBroadcastVersionThread {
  readonly broadcastId: string;
  readonly versions: readonly MemberVisibleVersion[];
  readonly decisions: readonly MemberVisibleDecision[];
}

export interface ListMemberBroadcastVersionsOutput {
  readonly threads: readonly MemberBroadcastVersionThread[];
  /** True when either list held more than `limit` rows (the newest were kept). */
  readonly truncated: boolean;
}

export async function listMemberBroadcastVersions(
  deps: ListMemberBroadcastVersionsDeps,
  input: ListMemberBroadcastVersionsInput,
): Promise<ListMemberBroadcastVersionsOutput> {
  const slug = deps.tenant.slug;
  const { versions, decisions } = await deps.broadcastsRepo.withTx(async (tx) => ({
    // Sequential on purpose: one tx is one connection.
    versions: await deps.versionsRepo.listSentByMember(slug, input.memberId, input.limit + 1, tx),
    decisions: await deps.decisionsRepo.listByMember(slug, input.memberId, input.limit + 1, tx),
  }));
  const truncated = versions.length > input.limit || decisions.length > input.limit;

  // Both lists arrive newest first; the first time an E-Blast is seen fixes
  // its place in the newest-activity-first order.
  const threads = new Map<string, { versions: MemberVisibleVersion[]; decisions: MemberVisibleDecision[]; latest: number }>();
  const threadOf = (broadcastId: string, at: Date) => {
    const existing = threads.get(broadcastId);
    if (existing !== undefined) {
      existing.latest = Math.max(existing.latest, at.getTime());
      return existing;
    }
    const created = { versions: [], decisions: [], latest: at.getTime() };
    threads.set(broadcastId, created);
    return created;
  };
  for (const v of versions.slice(0, input.limit)) threadOf(v.broadcastId as string, v.createdAt).versions.unshift(projectVersionForMember(v));
  for (const d of decisions.slice(0, input.limit)) threadOf(d.broadcastId as string, d.decidedAt).decisions.unshift(projectDecisionForMember(d));

  return {
    threads: [...threads.entries()]
      .sort(([, a], [, b]) => b.latest - a.latest)
      .map(([broadcastId, t]) => ({
        broadcastId,
        versions: [...t.versions].sort((a, b) => a.versionNo - b.versionNo),
        decisions: t.decisions,
      })),
    truncated,
  };
}
