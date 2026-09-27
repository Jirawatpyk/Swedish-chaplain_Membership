/**
 * Audit event types a MEMBER may see on their own timeline (`/portal/timeline`
 * and the portal dashboard's "Recent activity").
 *
 * `member_timeline_v` carries every audit row whose payload has a `member_id`
 * or `related_member_id` key (migration 0196) — 124 event types at the time of
 * writing, of which a large share are staff-internal: the churn-risk score and
 * its outreach, escalation tasks, reminder / scheduling plumbing, auto-drafted
 * renewal invoices, a security fail-open notice. A member must not read those.
 *
 * An ALLOWLIST, not a denylist: a newly added audit type that happens to carry
 * `member_id` stays hidden from members until someone decides it belongs here.
 * The hidden set is pinned in `tests/unit/members/timeline-member-audit-allowlist.test.ts`.
 *
 * Applied twice, like the money gate: in the SQL (`TimelineFilter.
 * auditEventTypeAllowlist`, so `total` and the keyset cursor reveal nothing
 * about the hidden rows) and again in `timelineList` over whatever the repo
 * returned.
 */
export const MEMBER_VISIBLE_AUDIT_EVENT_TYPES = [
  // --- member record + contacts --------------------------------------------
  'member_created',
  'member_updated',
  'member_plan_changed',
  'member_primary_contact_changed',
  'member_status_changed',
  'member_archived',
  'member_undeleted',
  'member_self_updated',
  'member_number_assigned',
  'member_erasure_requested',
  'member_erased',
  'member_auto_invoice_enrolled',
  'member_auto_invoice_unenrolled',
  'member_contact_email_changed',
  'member_portal_invite_queued',
  'member_email_unverified_threshold_crossed',
  'member_acknowledged_broadcasts_terms',
  'contact_created',
  'contact_updated',
  'contact_removed',
  'contact_linked_to_user',
  'contact_marketing_opted_out',
  'contact_marketing_opted_in',
  'plan_bundle_changed',
  'user_sessions_revoked',
  'email_verification_sent',
  'email_verification_resent',
  'email_change_notification_sent_to_old_address',
  // --- change requests (FR-029 projection still applies on top) ------------
  'member_change_request_submitted',
  'member_change_request_decided',
  'member_change_request_withdrawn',
  'member_change_request_rate_limited',
  // --- scheduled plan changes ------------------------------------------------
  'plan_change_scheduled',
  'plan_change_superseded',
  'plan_change_cancelled',
  'plan_change_applied',
  // --- invoicing (still subject to the money gate) --------------------------
  'invoice_issued',
  'invoice_paid',
  'invoice_voided',
  'invoice_overdue_detected',
  'invoice_pdf_resent',
  'credit_note_issued',
  'tax_receipt_issued',
  'auto_email_skipped_no_recipient',
  'payment_on_terminated_member',
  // --- renewals + membership access ------------------------------------------
  'renewal_cycle_created',
  'renewal_cycle_cancelled',
  'renewal_cycle_completed_offline',
  'renewal_cycle_reanchored',
  'renewal_entered_awaiting_payment',
  'renewal_invoice_created',
  'renewal_reminder_sent',
  'renewal_self_service_initiated',
  'renewal_skipped_no_joined_at',
  'renewal_token_clicked_on_completed_cycle',
  'renewal_with_plan_change',
  'renewal_completed',
  'renewal_completed_post_lapse',
  'renewal_lapsed',
  'membership_suspended_action_blocked',
  'lapsed_member_action_blocked',
  'lapsed_member_admin_reactivated',
  // --- tier upgrades -----------------------------------------------------------
  'tier_upgrade_accepted',
  'tier_upgrade_pending_member_notified',
  'tier_upgrade_applied_at_renewal',
  // --- broadcasts ----------------------------------------------------------------
  'broadcast_submitted',
  'broadcast_test_copy_sent',
  'broadcast_image_uploaded',
  'broadcast_version_started',
  'broadcast_version_sent_to_member',
  'broadcast_member_approved',
  'broadcast_member_changes_requested',
  'broadcast_member_approval_withdrawn',
  'broadcast_member_approval_voided',
  'broadcast_member_halted_pending_review',
  'broadcast_membership_suspended_blocked',
  'broadcast_schedule_confirmed',
  'broadcast_approval_reminder_sent',
  'broadcast_approval_expiry_warned',
  'broadcast_approval_expired',
] as const;

const MEMBER_VISIBLE: ReadonlySet<string> = new Set(MEMBER_VISIBLE_AUDIT_EVENT_TYPES);

export function isMemberVisibleAuditType(eventType: string): boolean {
  return MEMBER_VISIBLE.has(eventType);
}
