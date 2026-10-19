/**
 * The E-Blast review queue's column minimums, shared by `QueueTableClient` and
 * the route's loading skeleton so the skeleton grid lands where the real one
 * does (CLS 0, ux-standards § 2.1). Plain data: the server `loading.tsx`
 * imports it. Every column is flexible (AURA `minWidth`); at a 1280px window
 * they sit at these minimums.
 */
export const QUEUE_COLUMN_LAYOUT = {
  member: { minWidth: 112 },
  subject: { minWidth: 112 },
  status: { minWidth: 200 },
  timeInStage: { minWidth: 132 },
  sendTime: { minWidth: 84 },
  audience: { minWidth: 100 },
  actions: { minWidth: 128 },
} as const;

/**
 * Actions takes two and a half shares of the spare width, so Approve and
 * Reject sit side by side from 1,440px (stand-in until AURA #162).
 */
export const QUEUE_ACTIONS_SHARE = 2.5;
