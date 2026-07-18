import { describe, it, expect } from 'vitest';
import { isDirty } from '@/components/invoices/invoice-settings/form-dirty';

describe('isDirty', () => {
  const base = { a: 'x', b: 7, c: false, d: null };
  it('false when identical', () => expect(isDirty(base, { ...base })).toBe(false));
  it('true on a changed string', () => expect(isDirty(base, { ...base, a: 'y' })).toBe(true));
  it('true on null → value', () => expect(isDirty(base, { ...base, d: 'set' })).toBe(true));
  it('true on boolean flip', () => expect(isDirty(base, { ...base, c: true })).toBe(true));
});
