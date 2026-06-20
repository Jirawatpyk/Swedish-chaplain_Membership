/**
 * DV-4 — unit coverage for `buildSegmentPayload`, the pure mapper that
 * turns the compose form's `SegmentPickerValue` + parsed custom lines
 * into the wire-shape `segment` payload posted to the submit route.
 *
 * `SegmentPickerValue` requires BOTH `kind` and `tierCodes` (the latter
 * is `[]` for non-tier kinds — see segment-picker.tsx:26-29), so every
 * input here carries `tierCodes`. The expected output shapes are matched
 * against the ACTUAL switch arms in compose-form.tsx:
 *   - tier                     → { kind: 'tier', tierCodes }
 *   - custom                   → { kind: 'custom', emails: customLines }
 *   - all_members / events…    → { kind } (default arm)
 */
import { describe, it, expect } from 'vitest';
import { buildSegmentPayload } from '@/components/broadcast/compose-form';

describe('buildSegmentPayload', () => {
  it('maps all_members (default arm — kind only)', () => {
    expect(buildSegmentPayload({ kind: 'all_members', tierCodes: [] }, [])).toEqual({
      kind: 'all_members',
    });
  });

  it('maps tier with tier codes', () => {
    expect(
      buildSegmentPayload({ kind: 'tier', tierCodes: ['GOLD'] }, []),
    ).toEqual({
      kind: 'tier',
      tierCodes: ['GOLD'],
    });
  });

  it('maps event_attendees_last_90d (default arm — kind only)', () => {
    expect(
      buildSegmentPayload({ kind: 'event_attendees_last_90d', tierCodes: [] }, []),
    ).toEqual({
      kind: 'event_attendees_last_90d',
    });
  });

  it('maps custom from the supplied custom lines', () => {
    expect(
      buildSegmentPayload({ kind: 'custom', tierCodes: [] }, ['a@x.com', 'b@x.com']),
    ).toEqual({
      kind: 'custom',
      emails: ['a@x.com', 'b@x.com'],
    });
  });

  it('maps custom with no lines to an empty email list', () => {
    expect(buildSegmentPayload({ kind: 'custom', tierCodes: [] }, [])).toEqual({
      kind: 'custom',
      emails: [],
    });
  });
});
