/**
 * F119 T117 / T119 — the staff E-Blast dashboard's page of rows, ONE loader
 * for both of its readers: the `/admin/broadcasts` page and
 * `GET /api/admin/broadcasts` (contracts/dashboard-and-notifications.md § 1.2).
 * They used to build the row twice, each with its own member-name lookup;
 * FR-030 says the dashboard is ONE list, so it is one projection too.
 *
 * Each row carries what FR-026 asks for — member, subject, stage, whose turn,
 * time in stage (`stage_entered_at`, also the row's last activity), round,
 * proposed and confirmed send times — plus FR-029's delivery results on sent
 * rows, read for the whole page in one grouped query (never per row).
 *
 * FR-036: nothing here selects a contact-level field. The member name is the
 * existing `members.company_name` projection; delivery results are counts.
 *
 * `src/lib/**` is the composition layer: the repo, the queue reads and the
 * Domain stage vocabulary meet here; Presentation calls this.
 */
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import {
  hasConfirmedSendTime,
  isWaitingView,
  makeBroadcastQueueReads,
  makeGetBroadcastDeps,
  stageOf,
  turnOf,
  type BroadcastStage,
  type BroadcastStatus,
  type DeliveryResult,
  type ListByTenantStatusSort,
  type WhoseTurn,
} from '@/modules/broadcasts';
import type { TenantContext } from '@/modules/tenants';

export interface AdminQueueQuery {
  readonly statusFilter: readonly BroadcastStatus[];
  readonly memberId?: string;
  readonly cursor?: string;
  readonly pageSize: number;
  readonly sort: ListByTenantStatusSort;
  /** The Upcoming sends preset's lower bound on `scheduled_for`. */
  readonly scheduledFrom?: Date;
}

/** One dashboard row — ISO strings, so it crosses the server → client and JSON boundaries unchanged. */
export interface AdminQueueItem {
  readonly broadcastId: string;
  readonly status: BroadcastStatus;
  readonly stage: BroadcastStage;
  readonly whoseTurn: WhoseTurn;
  readonly subject: string;
  readonly requestedByMemberId: string;
  readonly requestedByMemberDisplayName: string;
  readonly actorRole: string;
  readonly segmentType: string;
  readonly estimatedRecipientCount: number;
  readonly submittedAt: string | null;
  readonly createdAt: string;
  /** Entry into the current stage — time in stage, and the row's last activity. */
  readonly stageEnteredAt: string;
  /** Versions sent to the member so far (0 = never formatted). */
  readonly currentRound: number;
  /** The member's proposal; null on a row that predates 0305 ("not recorded"). */
  readonly proposedSendAt: string | null;
  /** `scheduled_for` once marketing confirmed it (Scheduled onwards); null before. */
  readonly confirmedSendAt: string | null;
  /** FR-029 — on sent rows only; null on every other row. */
  readonly delivery: DeliveryResult | null;
}

export interface AdminQueuePage {
  readonly items: readonly AdminQueueItem[];
  readonly nextCursor: string | null;
}

/** The statuses whose rows report delivery results (the retired two are historical sends). */
const SENT_STATUSES: ReadonlySet<BroadcastStatus> = new Set<BroadcastStatus>([
  'sent',
  'partially_sent',
  'partial_delivery_accepted',
]);

const NO_DELIVERY_EVENTS: DeliveryResult = { recipients: 0, delivered: 0, bounced: 0, complained: 0 };

/**
 * UX review H1 — the dashboard's order when the URL names none, for the page
 * AND the list API: the Upcoming sends preset in send-time order; a view of
 * waiting stages only, longest in stage first; every other view (Sent, Closed,
 * show-all), most recent first — else its first page is the 50 OLDEST rows.
 */
export function queueSortFor(
  statusFilter: readonly BroadcastStatus[],
  upcoming: boolean,
): ListByTenantStatusSort {
  if (upcoming) return 'scheduled_for_asc';
  return isWaitingView(statusFilter) ? 'stage_entered_at_asc' : 'stage_entered_at_desc';
}

/** The Upcoming sends preset's `from` token: `now` is the only one (anything else is not a bound). */
export function upcomingFrom(token: string | undefined): Date | undefined {
  return token === 'now' ? new Date() : undefined;
}

async function readMemberNames(tenant: TenantContext, memberIds: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (memberIds.length === 0) return names;
  // `members` is tenant-scoped under RLS; the ANY-array keeps it on the
  // `(tenant_id, member_id)` primary key for ≤ 100 ids.
  const rows = (await runInTenant(tenant, async (tx) =>
    tx.execute(sql`
      SELECT member_id, company_name FROM members
      WHERE tenant_id = ${tenant.slug}
        AND member_id::text = ANY(ARRAY[${sql.join(
          memberIds.map((id) => sql`${id}`),
          sql`, `,
        )}]::text[])
    `),
  )) as unknown as Array<{ member_id: string; company_name: string }>;
  for (const r of rows) names.set(r.member_id, r.company_name);
  return names;
}

export async function loadAdminBroadcastQueue(
  tenant: TenantContext,
  query: AdminQueueQuery,
): Promise<AdminQueuePage> {
  const list = await makeGetBroadcastDeps(tenant.slug).broadcastsRepo.listByTenantStatus(tenant.slug, {
    pageSize: query.pageSize,
    sort: query.sort,
    ...(query.statusFilter.length > 0 && { statusFilter: query.statusFilter }),
    ...(query.memberId !== undefined && { memberIdFilter: query.memberId }),
    ...(query.cursor !== undefined && { cursor: query.cursor }),
    ...(query.scheduledFrom !== undefined && { scheduledFrom: query.scheduledFrom }),
  });

  const memberIds = [...new Set(list.rows.map((r) => r.requestedByMemberId))];
  const sentIds = list.rows.filter((r) => SENT_STATUSES.has(r.status)).map((r) => r.broadcastId as string);
  const [names, deliveries] = await Promise.all([
    readMemberNames(tenant, memberIds),
    sentIds.length > 0
      ? makeBroadcastQueueReads(tenant.slug).deliveryCountsFor(tenant, sentIds)
      : Promise.resolve(new Map<string, DeliveryResult>()),
  ]);

  const items = list.rows.map(
    (row): AdminQueueItem => ({
      broadcastId: row.broadcastId as string,
      status: row.status,
      stage: stageOf(row.status),
      whoseTurn: turnOf(row.status),
      subject: row.subject,
      requestedByMemberId: row.requestedByMemberId,
      requestedByMemberDisplayName: names.get(row.requestedByMemberId) ?? row.requestedByMemberId,
      actorRole: row.actorRole,
      segmentType: row.segmentType,
      estimatedRecipientCount: row.estimatedRecipientCount,
      submittedAt: row.submittedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      stageEnteredAt: row.stageEnteredAt.toISOString(),
      currentRound: row.currentRound,
      proposedSendAt: row.proposedSendAt?.toISOString() ?? null,
      confirmedSendAt: hasConfirmedSendTime(row.status) ? (row.scheduledFor?.toISOString() ?? null) : null,
      delivery: SENT_STATUSES.has(row.status)
        ? (deliveries.get(row.broadcastId as string) ?? NO_DELIVERY_EVENTS)
        : null,
    }),
  );
  return { items, nextCursor: list.nextCursor };
}
