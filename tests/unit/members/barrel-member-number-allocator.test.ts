import { describe, it, expect } from 'vitest';
import * as membersBarrel from '@/modules/members';

describe('members barrel — member-number allocator + settings exports', () => {
  it('re-exports the concrete allocator + settings adapters', () => {
    expect(typeof membersBarrel.drizzleMemberNumberAllocator.allocate).toBe(
      'function',
    );
    expect(typeof membersBarrel.drizzleMemberSettingsRepo.getPrefix).toBe(
      'function',
    );
  });

  it('type-exports the two port interfaces (compile-time contract)', () => {
    // Type-only conformance: these lines fail to compile if the barrel
    // drops the type re-exports.
    const _a: membersBarrel.MemberNumberAllocatorPort | null = null;
    const _s: membersBarrel.MemberSettingsReaderPort | null = null;
    expect(_a).toBeNull();
    expect(_s).toBeNull();
  });
});
