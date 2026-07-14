/**
 * Thai postal-code lookup for the member-form address section (058 / PR-B).
 *
 * Reference data, not tenant data — no `runInTenant`, no RLS. Staff-guarded
 * anyway: there is no reason to expose an endpoint to the unauthenticated web.
 * Gated the same as `GET /api/members` (`resource: 'members', action:
 * 'read'`) since the only consumer is the admin member create/edit form.
 *
 * The dataset is 97 KB gzipped and lives server-side only; this route is what
 * keeps it out of the client bundle.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdminContext } from '@/lib/admin-context';
import { lookupPostalCode, POSTAL_CODE_RE } from '@/lib/thai-postal/lookup';

const paramsSchema = z.object({
  code: z.string().regex(POSTAL_CODE_RE),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'members',
    action: 'read',
  });
  if ('response' in ctx) return ctx.response;

  const resolved = await params;
  const parsed = paramsSchema.safeParse(resolved);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_postal_code',
          message: 'code must be exactly 5 digits.',
        },
      },
      { status: 400 },
    );
  }

  const candidates = lookupPostalCode(parsed.data.code);

  if (candidates.length === 0) {
    return NextResponse.json(
      { error: { code: 'postal_code_not_found' } },
      { status: 404 },
    );
  }

  return NextResponse.json(
    { candidates },
    // Immutable reference data — cache hard, but `private`: this route is
    // staff-guarded, and `public` would let Vercel's Edge Network cache the
    // response and replay it to an unauthenticated caller for up to 24h
    // without ever re-running the auth guard above. `private` keeps the
    // long max-age (the data really doesn't change between deploys) while
    // confining the cache to the requesting browser — every other
    // authenticated route in src/app/api/** uses no-store/private, no
    // exceptions.
    { headers: { 'Cache-Control': 'private, max-age=86400, immutable' } },
  );
}
