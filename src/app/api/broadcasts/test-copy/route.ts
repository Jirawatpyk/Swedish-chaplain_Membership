/**
 * F119 T105 — `POST /api/broadcasts/test-copy` (portal user; FR-037).
 *
 * Member gate, then the shared handler (`src/lib/broadcasts-test-copy-route.ts`).
 * The recipient is the SESSION address — the body carries no `to`. The
 * audit row's member key is `related_member_id` (the caller's member) even
 * though the caller is a portal user: a test copy to one's own inbox is not
 * member activity on the E-Blast. 10 / hour per user. Node runtime.
 */
import { randomUUID } from 'node:crypto';
import type { NextRequest, NextResponse } from 'next/server';
import { handleTestCopy } from '@/lib/broadcasts-test-copy-route';
import { requireMemberContext } from '@/lib/member-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireMemberContext(request);
  if ('response' in ctx && ctx.response) {
    return ctx.response;
  }
  return handleTestCopy(
    request,
    {
      tenantSlug: ctx.tenant.slug,
      userId: ctx.current.user.id,
      email: ctx.current.user.email,
      role: ctx.current.user.role ?? null,
      relatedMemberId: ctx.member.memberId as unknown as string,
      surface: 'member',
    },
    correlationId,
  );
}
