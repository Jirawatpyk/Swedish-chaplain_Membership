/**
 * Spec 122 PR J (UX review) — the lines that explain a dimmed "Submit for
 * review" sit beside that button on the phone bar, so in Thai they name the
 * step the way the button does: ส่งเพื่อตรวจสอบ, never ส่งขออนุมัติ.
 */
import { describe, expect, it } from 'vitest';
import th from '@/i18n/messages/th.json';

const compose = th.portal.broadcasts.compose;
const LINES = {
  subjectRequired: compose.submitBlocked.subjectRequired,
  tierRequired: compose.submitBlocked.tierRequired,
  memberRequiredHint: th.admin.broadcasts.proxySubmitDialog.memberRequiredHint,
};

describe('Thai Submit hints match the button', () => {
  it('the button is ส่งเพื่อตรวจสอบ', () => {
    expect(compose.button.submit).toBe('ส่งเพื่อตรวจสอบ');
  });

  it.each(Object.entries(LINES))('%s says ส่งเพื่อตรวจสอบ', (_key, line) => {
    expect(line).toContain('ส่งเพื่อตรวจสอบ');
    expect(line).not.toContain('ส่งขออนุมัติ');
  });
});
