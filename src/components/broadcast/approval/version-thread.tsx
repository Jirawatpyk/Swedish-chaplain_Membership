/**
 * F119 T085 (FR-032, FR-007, FR-011, FR-015a) — the history of an E-Blast's
 * approval round, read by BOTH sides: the member on `/portal/broadcasts/[id]`
 * and staff on `/admin/broadcasts/[id]`.
 *
 * Shape (contracts/portal-eblast-approval-api.md § versions): ONE ordered
 * list, a heading per round, oldest → newest. The member's original opens it;
 * each round is the version sent to the member FIRST and the decisions on
 * that version AFTER it — attached by `versionId`, the version the decision
 * concerns (FR-011, FR-015a), so an approval later withdrawn sits with the
 * version it approved. An E-Blast approved as submitted has no version row at
 * all (R2) and shows the single "approved as submitted" entry instead, so the
 * history is never blank (FR-007). Marketing's unsent working copy is never
 * part of it on either side.
 *
 * Authors: the portal names only "your company" / "you" / "a colleague" and
 * "the chamber", never a staff user (the F114 `organisation` precedent), and
 * never the name of the member user who decided. That rule is enforced HERE,
 * on render: in `audience="member"` no name is ever read, even if one reaches
 * the model — the member projection already drops it (`_member-view.ts`);
 * this is the second layer. Staff see the author's name, and (UX review M7,
 * FR-032 "who") the deciding member user's name, where it is known.
 *
 * A sync Server Component (`useTranslations`, no async boundary — the
 * `overdue-banner.tsx` pattern), so both server pages compose it directly.
 * Times arrive formatted by the page, in the tenant's time zone.
 */
import { useTranslations } from 'next-intl';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import type {
  BroadcastVersionThread,
  MemberDecisionKind,
  MemberVersionThread,
} from '@/modules/broadcasts';

export type ThreadAuthor =
  | { readonly side: 'member' }
  | { readonly side: 'organisation'; readonly name: string | null };

export interface ThreadTime {
  readonly iso: string;
  readonly label: string;
}

export interface ThreadVersion {
  readonly id: string;
  readonly versionNo: number;
  readonly subject: string;
  readonly note: string | null;
  readonly author: ThreadAuthor;
  /** When it was sent to the member (the original: when it was written). */
  readonly at: ThreadTime | null;
}

export interface ThreadDecision {
  readonly id: string;
  readonly decision: MemberDecisionKind;
  /** The reason (changes / withdrawal) or the approval's optional note. */
  readonly reason: string | null;
  /** Portal only: the caller's own login recorded it (else a colleague at the same company). */
  readonly byMe: boolean;
  /** Staff only: the deciding member user's display name; null when unknown (never read in the portal). */
  readonly byName: string | null;
  readonly at: ThreadTime;
}

export interface ThreadRound {
  readonly round: number;
  readonly version: ThreadVersion;
  readonly decisions: readonly ThreadDecision[];
}

export interface VersionThreadModel {
  readonly original: ThreadVersion | null;
  readonly rounds: readonly ThreadRound[];
  readonly approvedAsSubmitted: { readonly at: ThreadTime; readonly author: ThreadAuthor } | null;
}

export type FormatThreadTime = (d: Date) => string;

const time = (d: Date, format: FormatThreadTime): ThreadTime => ({ iso: d.toISOString(), label: format(d) });

interface RawVersion {
  readonly id: string;
  readonly versionNo: number;
  readonly subject: string;
  readonly note: string | null;
  readonly author: ThreadAuthor;
  readonly at: Date | null;
}

interface RawDecision {
  readonly id: string;
  readonly versionId: string;
  readonly decision: MemberDecisionKind;
  readonly reason: string | null;
  readonly byMe: boolean;
  readonly byName: string | null;
  readonly at: Date;
}

/** Group sent versions into rounds (a round IS a version sent — `current_round = version_no`) with their decisions. */
function buildModel(
  original: RawVersion | null,
  sent: readonly RawVersion[],
  decisions: readonly RawDecision[],
  approvedAsSubmitted: VersionThreadModel['approvedAsSubmitted'],
  format: FormatThreadTime,
): VersionThreadModel {
  const toVersion = (v: RawVersion): ThreadVersion => ({
    id: v.id,
    versionNo: v.versionNo,
    subject: v.subject,
    note: v.note,
    author: v.author,
    at: v.at === null ? null : time(v.at, format),
  });
  return {
    original: original === null ? null : toVersion(original),
    rounds: [...sent]
      .sort((a, b) => a.versionNo - b.versionNo)
      .map((v) => ({
        round: v.versionNo,
        version: toVersion(v),
        decisions: decisions
          .filter((d) => d.versionId === v.id)
          .map((d) => ({
            id: d.id,
            decision: d.decision,
            reason: d.reason,
            byMe: d.byMe,
            byName: d.byName,
            at: time(d.at, format),
          })),
      })),
    approvedAsSubmitted,
  };
}

/** The member's thread (`getMemberVersionThread`) — already stripped of staff identities and unsent copies. */
export function memberThreadModel(thread: MemberVersionThread, format: FormatThreadTime): VersionThreadModel {
  const raw = (v: MemberVersionThread['versions'][number]): RawVersion => ({
    id: v.id,
    versionNo: v.versionNo,
    subject: v.subject,
    note: v.noteToMember,
    author: v.authoredBy === 'member' ? { side: 'member' } : { side: 'organisation', name: null },
    at: v.versionNo === 0 ? v.createdAt : v.sentToMemberAt,
  });
  const original = thread.versions.find((v) => v.versionNo === 0);
  return buildModel(
    original === undefined ? null : raw(original),
    thread.versions.filter((v) => v.versionNo >= 1 && v.sentToMemberAt !== null).map(raw),
    thread.decisions.map((d) => ({
      id: d.id,
      versionId: d.versionId,
      decision: d.decision,
      reason: d.reason,
      byMe: d.decidedByMe,
      byName: null,
      at: d.decidedAt,
    })),
    thread.approvedAsSubmitted === null
      ? null
      : { at: time(thread.approvedAsSubmitted.at, format), author: { side: 'organisation', name: null } },
    format,
  );
}

/** The staff thread (`listBroadcastVersions`) — names where known; the working copy is left out. */
export function staffThreadModel(thread: BroadcastVersionThread, format: FormatThreadTime): VersionThreadModel {
  const raw = (entry: BroadcastVersionThread['sentVersions'][number]): RawVersion => ({
    id: entry.version.id,
    versionNo: entry.version.versionNo,
    subject: entry.version.subject,
    note: entry.version.noteToMember,
    author:
      entry.version.authoredByRole === 'member_self_service'
        ? { side: 'member' }
        : { side: 'organisation', name: entry.authoredByName },
    at: entry.version.versionNo === 0 ? entry.version.createdAt : entry.version.sentToMemberAt,
  });
  return buildModel(
    thread.memberOriginal === null ? null : raw(thread.memberOriginal),
    thread.sentVersions.map(raw),
    thread.decisions.map((d) => ({
      id: d.id,
      versionId: d.versionId,
      decision: d.decision,
      reason: d.reason,
      byMe: false,
      byName: d.decidedByName ?? null,
      at: d.decidedAt,
    })),
    thread.approvedAsSubmitted === null
      ? null
      : {
          at: time(thread.approvedAsSubmitted.at, format),
          author: { side: 'organisation', name: thread.approvedAsSubmitted.byUserName },
        },
    format,
  );
}

/**
 * Whether there is a history to show: a round (a version sent to the member)
 * or the approve-as-submitted entry. The member's original on its own is not
 * one — before the first send it is simply the content the page already shows.
 */
export function hasThreadHistory(model: VersionThreadModel): boolean {
  return model.rounds.length > 0 || model.approvedAsSubmitted !== null;
}

export interface VersionThreadProps {
  readonly audience: 'member' | 'staff';
  readonly model: VersionThreadModel;
}

const HEADING = 'font-heading text-sm font-medium leading-snug';

export function VersionThread({ audience, model }: VersionThreadProps): React.ReactElement {
  const tPortal = useTranslations('portal.broadcasts.approval.thread');
  const tStaff = useTranslations('admin.broadcasts.approval.thread');
  const tFeedback = useTranslations('admin.broadcasts.approval.feedback');
  const member = audience === 'member';
  const t = member ? tPortal : tStaff;
  const headingId = `eblast-thread-title-${audience}`;

  // The author line of a version. In the portal a name is NEVER read.
  const versionLine = (v: ThreadVersion): string => {
    if (v.versionNo === 0) {
      // "your company", not "you": the original may be a colleague's.
      if (member) return v.author.side === 'member' ? tPortal('submittedByYourCompany') : tPortal('submittedByChamber');
      if (v.author.side === 'member') return tStaff('submittedByMember');
      return v.author.name !== null
        ? tStaff('submittedOnBehalfBy', { name: v.author.name })
        : tStaff('submittedOnBehalf');
    }
    if (member) return tPortal('versionSent', { version: v.versionNo });
    return v.author.side === 'organisation' && v.author.name !== null
      ? tStaff('versionSentBy', { version: v.versionNo, name: v.author.name })
      : tStaff('versionSent', { version: v.versionNo });
  };

  const decisionLine = (d: ThreadDecision, versionNo: number): string => {
    if (!member) {
      // FR-032 — who decided, where the name is known; "the member" otherwise.
      if (d.byName !== null) {
        const values = { name: d.byName, version: versionNo };
        if (d.decision === 'approved') return tStaff('approvedBy', values);
        if (d.decision === 'changes_requested') return tStaff('changesRequestedBy', values);
        return tStaff('withdrawnBy', values);
      }
      if (d.decision === 'approved') return tFeedback('approvedTitle', { version: versionNo });
      if (d.decision === 'changes_requested') return tFeedback('changesRequestedTitle', { version: versionNo });
      return tFeedback('withdrawnTitle', { version: versionNo });
    }
    if (d.decision === 'approved') return d.byMe ? tPortal('approvedByYou') : tPortal('approvedByColleague');
    if (d.decision === 'changes_requested') {
      return d.byMe ? tPortal('changesRequestedByYou') : tPortal('changesRequestedByColleague');
    }
    return d.byMe ? tPortal('withdrawnByYou') : tPortal('withdrawnByColleague');
  };

  const approvedAsSubmittedLine = (author: ThreadAuthor): string => {
    if (member) return tPortal('approvedAsSubmitted');
    return author.side === 'organisation' && author.name !== null
      ? tStaff('approvedAsSubmittedBy', { name: author.name })
      : tStaff('approvedAsSubmitted');
  };

  return (
    <section aria-labelledby={headingId} data-testid="eblast-version-thread">
      <Card>
        <CardHeader>
          <h2 id={headingId} className="font-heading text-base font-medium leading-snug">
            {t('title')}
          </h2>
          {member ? <CardDescription>{tPortal('description')}</CardDescription> : null}
        </CardHeader>
        <CardContent>
          <ol className="space-y-4 text-sm">
            {model.approvedAsSubmitted !== null && model.original === null && model.rounds.length === 0 ? (
              <li className="border-l-2 border-border pl-3">
                <p>{approvedAsSubmittedLine(model.approvedAsSubmitted.author)}</p>
                <When at={model.approvedAsSubmitted.at} />
              </li>
            ) : null}
            {model.original !== null ? (
              <li className="border-l-2 border-border pl-3">
                <h3 className={HEADING}>{t('original')}</h3>
                <VersionEntry line={versionLine(model.original)} version={model.original} noteLabel={t('noteLabel')} />
              </li>
            ) : null}
            {model.rounds.map((r) => (
              <li key={r.version.id} className="border-l-2 border-border pl-3">
                <h3 className={HEADING}>{t('round', { round: r.round })}</h3>
                <VersionEntry line={versionLine(r.version)} version={r.version} noteLabel={t('noteLabel')} />
                {r.decisions.map((d) => (
                  <div key={d.id} className="mt-3">
                    <p className="font-medium">{decisionLine(d, r.version.versionNo)}</p>
                    <When at={d.at} />
                    {d.reason !== null ? (
                      <p className="mt-1 whitespace-pre-line break-words">
                        <span className="block text-xs text-muted-foreground">
                          {d.decision === 'approved' ? t('approvalNoteLabel') : t('reasonLabel')}
                        </span>
                        {d.reason}
                      </p>
                    ) : null}
                  </div>
                ))}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </section>
  );
}

function VersionEntry({
  line,
  version,
  noteLabel,
}: {
  readonly line: string;
  readonly version: ThreadVersion;
  readonly noteLabel: string;
}): React.ReactElement {
  return (
    <div className="mt-1">
      <p>{line}</p>
      {version.at !== null ? <When at={version.at} /> : null}
      <p className="mt-1 break-words">{version.subject}</p>
      {version.versionNo >= 1 && version.note !== null ? (
        <p className="mt-1 whitespace-pre-line break-words">
          <span className="block text-xs text-muted-foreground">{noteLabel}</span>
          {version.note}
        </p>
      ) : null}
    </div>
  );
}

function When({ at }: { readonly at: ThreadTime }): React.ReactElement {
  return (
    <time dateTime={at.iso} className="block text-xs text-muted-foreground tabular-nums">
      {at.label}
    </time>
  );
}
