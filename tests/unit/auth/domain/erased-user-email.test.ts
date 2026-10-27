/**
 * 134-s2 — the one auth-side builder / matcher of eraseUser's login sentinel
 * `erased+{userId}@erased.invalid` (user-repo scrub, token scrub, enableUser).
 */
import { describe, expect, it } from 'vitest';
import {
  erasedUserEmail,
  isErasedUserEmail,
} from '@/modules/auth/domain/erased-user-email';

const ID = '11111111-2222-4333-8444-555555555555';

describe('erased user email sentinel (134-s2)', () => {
  it('builds the sentinel from the user id', () => {
    expect(erasedUserEmail(ID)).toBe(`erased+${ID}@erased.invalid`);
  });

  it('matches only the exact sentinel of that id', () => {
    expect(isErasedUserEmail(`erased+${ID}@erased.invalid`, ID)).toBe(true);
    expect(isErasedUserEmail(`erased+other@erased.invalid`, ID)).toBe(false);
    expect(isErasedUserEmail('someone@erased.invalid', ID)).toBe(false);
  });
});
