// Spec 131 — RED stub; the behaviour lands in the GREEN commit.
import { ok, type Result } from '@/lib/result';

export async function releaseUnusedImage(
  _deps: unknown,
  _input: unknown,
): Promise<Result<{ readonly released: boolean }, { readonly kind: 'not_found' }>> {
  return ok({ released: false });
}
