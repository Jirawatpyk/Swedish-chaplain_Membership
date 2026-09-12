/**
 * F114 — the stand-in for a submitting contact whose row is GONE (hard-deleted
 * or never readable). `decideChangeRequest` and `getChangeRequestReview` still
 * need the Group B contact columns to build the record (its contact-target rows
 * render "(empty)" and can only be rejected — FR-020). The stand-in is exactly
 * those four columns (`GroupBContactRecord`) — no forged `Email` brand, no
 * epoch dates, nothing a future caller could mail or render as a fact
 * (rounds 6 and 7, silent-failure #21 / types #4).
 */
import type { GroupBContactRecord } from './submit-change-request';

export function removedContactStandIn(): GroupBContactRecord {
  return { firstName: '', lastName: '', phone: null, roleTitle: null };
}
