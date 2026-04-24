"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * LiveRegion — visually-hidden ARIA live region for inline async feedback
 * that should NOT pop a toast.
 *
 * Design-system audit P0 gap D1. sonner already handles toast live
 * regions internally (role=status / role=alert + aria-live), but the
 * F5 PaySheet needs to announce "Verifying with your bank…",
 * "Authorizing…", "Payment succeeded" *inside* the drawer without
 * stealing user focus or firing a toast on every polling tick.
 *
 * Usage:
 *   <LiveRegion politeness="polite">
 *     {status === "polling" ? t('payment.polling') : null}
 *   </LiveRegion>
 *
 * Rules:
 *   - "polite" — announce when SR is idle. Default. Good for progress.
 *   - "assertive" — interrupt SR speech. Reserve for errors / state
 *     changes that demand immediate attention (payment failure, session
 *     expiring).
 *   - Content changes trigger the announcement; mount with empty content
 *     and update later rather than conditionally mounting the region
 *     (mount-time content is NOT announced by most SRs).
 */
export interface LiveRegionProps extends React.ComponentProps<"div"> {
  politeness?: "polite" | "assertive"
  /** Screen-reader-only by default; set false for visible debug surfaces. */
  visuallyHidden?: boolean
}

function LiveRegion({
  politeness = "polite",
  visuallyHidden = true,
  className,
  children,
  ...props
}: LiveRegionProps) {
  return (
    <div
      data-slot="live-region"
      role={politeness === "assertive" ? "alert" : "status"}
      aria-live={politeness}
      aria-atomic="true"
      className={cn(visuallyHidden && "sr-only", className)}
      {...props}
    >
      {children}
    </div>
  )
}

export { LiveRegion }
