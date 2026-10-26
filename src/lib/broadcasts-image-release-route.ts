// Spec 131 — RED stub; the behaviour lands in the GREEN commit.
import { NextResponse } from 'next/server';

export async function handleImageRelease(..._args: unknown[]): Promise<NextResponse> {
  return NextResponse.json({ error: 'not_implemented' }, { status: 501 });
}
