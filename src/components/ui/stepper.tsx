import * as React from "react"
import { AlertCircle, Check } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Stepper — linear progress indicator for multi-step flows.
 *
 * Design-system audit P0 gap B1. F5 PaySheet (confirm → authorize →
 * succeed) and future F4 refund flow need a canonical step UI so the
 * visual language for "which step are you on" stays consistent.
 *
 * Rendering:
 *   - status "complete"  → filled primary circle + check icon
 *   - status "current"   → outlined primary circle + index number
 *   - status "upcoming"  → muted circle + index number
 *   - status "error"     → destructive circle + AlertCircle icon
 *                          (F2 polish round 2: marks a step the user
 *                          must revisit after a final-submit validation
 *                          failure)
 *
 * Compact mode (`compact={true}`):
 *   - At viewport <sm (640px), step labels are hidden so 3-4 long
 *     non-Latin labels (e.g. Thai "ข้อมูลพื้นฐาน" / "สิทธิประโยชน์")
 *     don't overflow. Consumers should render a compact summary
 *     ("Step 2/4 — {label}") below the stepper in mobile breakpoints.
 *   - Defaults to false so existing consumers (F6 webhook-config-
 *     wizard) keep labels at all breakpoints.
 *
 * Extended per-step overrides (`indicator` / `tone` — Timeline-A follow-up,
 * `.superpowers/sdd/followup-timeline-a-brief.md`):
 *   - Both fields are OPTIONAL. Omitting them (the F2 plan wizard + F6
 *     webhook-config-wizard consumers do) reproduces the exact rendering
 *     documented above — these are additive, backward-compatible escape
 *     hatches for a second use case (F8 reminder timeline), which needs a
 *     read-only "journey" of nodes coloured by MEANING (email/task/due),
 *     not by wizard PROGRESS.
 *   - `indicator`, when set, renders INSTEAD of the index number / Check /
 *     AlertCircle inside the circle — regardless of `status`.
 *   - `tone`, when set to anything other than `'default'`, colours the
 *     circle by that fixed meaning instead of by `status`. Maps to
 *     existing theme tokens only (no hardcoded hex): `brand`→primary,
 *     `info`→`--chart-1`, `warning`→`--chart-5`, `danger`→destructive,
 *     `muted`→border/muted (same look as `status='upcoming'`).
 *     `'default'` (or omitted) keeps the current status-based colouring.
 *
 * Accessibility:
 *   - The container exposes role=list and `aria-label` required.
 *   - The current step carries `aria-current="step"` so SR users can
 *     jump directly to it.
 *   - Connectors are `aria-hidden` decorative elements.
 *   - Error steps add `aria-invalid="true"` so SRs announce the
 *     validation state independently of the visual cue.
 */
export type StepperStatus = "complete" | "current" | "upcoming" | "error"

/**
 * Fixed-meaning colour for a step's indicator circle, overriding the
 * status-based colouring. `'default'` (or omitting `tone` entirely)
 * preserves the original status-driven look.
 */
export type StepperTone = "default" | "brand" | "info" | "warning" | "danger" | "muted"

export interface StepperStep {
  /** Unique per stepper instance; used as React key. */
  id: string
  /** Localized label shown under the circle. */
  label: string
  /** Optional secondary description; appears below label at smaller size. */
  description?: string
  status: StepperStatus
  /**
   * Optional custom content rendered inside the circle INSTEAD of the
   * index number / Check / AlertCircle — regardless of `status`. Always
   * wrapped `aria-hidden` (the visible label carries the meaning).
   */
  indicator?: React.ReactNode
  /**
   * Optional fixed colour for the circle, overriding status-based
   * colouring. Omit (or use `'default'`) to keep the existing look.
   */
  tone?: StepperTone
}

/**
 * Literal Tailwind class strings (never template-interpolated — Tailwind's
 * scanner needs static substrings) for each non-default tone. All are
 * outlined (`bg-background`, matching the `status='current'` shape) rather
 * than filled — a tone step has no wizard-error/complete semantics, so it
 * must never look like the filled `status='complete'`/`status='error'`
 * circles.
 */
const TONE_INDICATOR_CLASSES: Record<Exclude<StepperTone, "default">, string> = {
  brand: "border-primary bg-background text-primary",
  info: "border-chart-1 bg-background text-chart-1",
  warning: "border-chart-5 bg-background text-chart-5",
  danger: "border-destructive bg-background text-destructive",
  muted: "border-border bg-muted text-muted-foreground",
}

export interface StepperProps
  extends Omit<React.ComponentProps<"ol">, "aria-label"> {
  steps: StepperStep[]
  /** Localized `aria-label` describing the flow, e.g. t('payment.steps.label'). */
  "aria-label": string
  orientation?: "horizontal" | "vertical"
  /**
   * Hide step labels at viewport <sm (640px). Defaults to false.
   * Consumers using `compact` typically render their own compact
   * summary text below the stepper for mobile users.
   */
  compact?: boolean
}

function Stepper({
  steps,
  className,
  orientation = "horizontal",
  compact = false,
  ...props
}: StepperProps) {
  return (
    <ol
      data-slot="stepper"
      data-orientation={orientation}
      // I1 follow-up fix (`.superpowers/sdd/followup-reminder-uxwave-brief.md`)
      // — Tailwind v4's `@import 'tailwindcss'` preflight sets
      // `list-style:none` on ol/ul, which drops the implicit `list` role in
      // Safari/VoiceOver (jsdom's accessibility-tree computation ignores
      // CSS entirely, so this was invisible to every RTL `getByRole('list')`
      // assertion in this repo — see stepper.test.tsx / reminder-timeline.
      // test.tsx, unaffected by this addition). Explicit `role="list"`
      // restores it everywhere, matching the 7 other places in this project
      // that add it for the same reason (e.g. month-bar-chart.tsx,
      // portal-invoice-card-list.tsx, timeline-stream.tsx).
      role="list"
      className={cn(
        "flex w-full",
        orientation === "horizontal"
          ? // F6 verify-fix (2026-05-13): gap-0 so connector lines from
            // adjacent steps meet without an 8px visual break. Labels
            // remain visually spaced because each <li> is `flex-1`
            // text-center — labels are centered within their slot, not
            // hard-anchored against the step boundary. Vertical
            // breathing room from the indicator block to the label
            // comes from the inner div's `mt-2` (8px) — sufficient
            // without horizontal gap.
            "flex-row items-start gap-0"
          : "flex-col gap-4",
        className,
      )}
      {...props}
    >
      {steps.map((step, index) => {
        const isLast = index === steps.length - 1
        return (
          <li
            key={step.id}
            data-slot="stepper-step"
            data-status={step.status}
            aria-current={step.status === "current" ? "step" : undefined}
            aria-invalid={step.status === "error" ? "true" : undefined}
            className={cn(
              "flex min-w-0 flex-1",
              orientation === "horizontal"
                ? "flex-col items-center text-center"
                : "flex-row items-start gap-3",
            )}
          >
            <div
              className={cn(
                "flex items-center",
                orientation === "horizontal" && "w-full",
              )}
            >
              {/*
                F6 verify-fix (2026-05-13): ALWAYS render both connectors
                in horizontal mode so every indicator sits flex-center
                within its <li>. Previously the first step had no BEFORE
                connector and the last step had no AFTER connector —
                first indicator anchored start, last indicator anchored
                end, labels (centered) no longer aligned vertically with
                their indicators. First-step BEFORE + last-step AFTER
                render as `bg-transparent` so they reserve flex space
                without drawing the line outside the wizard's first/
                last indicator. Combined with the parent `gap-0`, the
                middle connectors meet at <li> boundaries → visually
                continuous progression from step 1 indicator to last.
              */}
              {orientation === "horizontal" && (
                <span
                  aria-hidden="true"
                  data-slot="stepper-connector"
                  className={cn(
                    "h-px flex-1",
                    index === 0
                      ? "bg-transparent"
                      : step.status === "upcoming"
                        ? "bg-border"
                        : "bg-primary",
                  )}
                />
              )}
              <span
                data-slot="stepper-indicator"
                className={cn(
                  "relative z-[1] flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium transition-colors",
                  step.tone && step.tone !== "default"
                    ? TONE_INDICATOR_CLASSES[step.tone]
                    : cn(
                        step.status === "complete" &&
                          "border-primary bg-primary text-primary-foreground",
                        step.status === "current" &&
                          "border-primary bg-background text-primary",
                        step.status === "upcoming" &&
                          "border-border bg-muted text-muted-foreground",
                        step.status === "error" &&
                          "border-destructive bg-destructive text-destructive-foreground",
                      ),
                )}
              >
                {step.indicator ? (
                  <span aria-hidden="true" className="flex items-center justify-center">
                    {step.indicator}
                  </span>
                ) : step.status === "complete" ? (
                  <Check aria-hidden="true" className="size-4" />
                ) : step.status === "error" ? (
                  <AlertCircle aria-hidden="true" className="size-4" />
                ) : (
                  <span aria-hidden="true">{index + 1}</span>
                )}
              </span>
              {orientation === "horizontal" && (
                <span
                  aria-hidden="true"
                  data-slot="stepper-connector"
                  className={cn(
                    "h-px flex-1",
                    isLast
                      ? "bg-transparent"
                      : step.status === "complete"
                        ? "bg-primary"
                        : "bg-border",
                  )}
                />
              )}
            </div>

            <div
              className={cn(
                "min-w-0",
                orientation === "horizontal" ? "mt-2" : "flex-1",
                // F2 polish round 2 — compact mode hides labels under
                // sm:640px so long non-Latin labels (Thai/Swedish) don't
                // overflow on mobile. Consumers render a compact summary
                // ("Step 2/4 — {label}") below the stepper for mobile.
                compact && orientation === "horizontal" && "hidden sm:block",
              )}
            >
              <div
                data-slot="stepper-label"
                className={cn(
                  "text-sm font-medium",
                  step.status === "upcoming" && "text-muted-foreground",
                  step.status === "error" && "text-destructive",
                )}
              >
                {step.label}
              </div>
              {step.description && (
                <div
                  data-slot="stepper-description"
                  className="text-caption text-muted-foreground"
                >
                  {step.description}
                </div>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

export { Stepper }
