/**
 * DV-17 — composeBroadcastFromName: single source for the member-originated
 * Resend "From" display name. Pinned so submitBroadcast + saveDraft can never
 * drift on the separator / ordering (the reuse-cleanup the code-review flagged).
 */
import { describe, it, expect } from 'vitest';
import { composeBroadcastFromName } from '@/modules/broadcasts/domain/from-name';

describe('composeBroadcastFromName (DV-17)', () => {
  it('composes "<member> via <tenant>"', () => {
    expect(composeBroadcastFromName('Fogmaker International AB', 'SweCham')).toBe(
      'Fogmaker International AB via SweCham',
    );
  });

  it('preserves the member-then-tenant order and the " via " separator', () => {
    expect(composeBroadcastFromName('Acme', 'Chamber')).toBe('Acme via Chamber');
  });
});
