// src/modules/broadcasts/application/format/resend-dashboard-name.ts
//
// Verify-fix (2026-06-21) — Resend caps the broadcast `name` at 70 code points
// ("Field `name` has a maximum of 70 items"). The dashboard label is
// `${fromName} — ${subject}`; fromName is `{member} via {tenant full name}`
// (~53 cp for TSCC), so prefix + ` — ` + a 60-cp subject overflowed and EVERY
// dispatch failed. Preserve the existing 60-cp subject slice, then cap the whole
// label to 70 code points (Unicode-safe via spread; trailing subject truncated).
const MAX_RESEND_BROADCAST_NAME_CP = 70;
const MAX_SUBJECT_CP = 60;

export function resendDashboardName(fromName: string, subject: string): string {
  const subjectSlice = [...subject].slice(0, MAX_SUBJECT_CP).join('');
  const full = `${fromName} — ${subjectSlice}`;
  return [...full].slice(0, MAX_RESEND_BROADCAST_NAME_CP).join('');
}
