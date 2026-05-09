/**
 * F8 Phase 8 T222 — `<ReassignTaskDropdown>` AlertDialog + combobox.
 *
 * Admin reassigns task ownership. Lazy-loads active staff users from
 * `/api/admin/users/staff-active` on dialog open. Combobox via `cmdk`
 * (already in deps for F2 command palette). Submit button disabled
 * until a user is selected.
 */
'use client';

import { useEffect, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { z } from 'zod';
import { Check, ChevronsUpDown, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/**
 * Round 5 I-6 close — runtime-shape validation prevents a silently
 * empty combobox when the API response shape drifts (partial deploy,
 * proxy injection of an HTML error page, future RBAC tightening that
 * returns `{error:{}}` with status 200, etc.). zod is already in the
 * client bundle (form validation) — incremental cost is zero.
 */
const staffUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  display_name: z.string().nullable(),
  role: z.enum(['admin', 'manager']),
});

const staffActiveResponseSchema = z.object({
  users: z.array(staffUserSchema),
});

type StaffUser = z.infer<typeof staffUserSchema>;

export interface ReassignTaskDropdownProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly currentAssigneeUserId: string | null;
  readonly onSubmit: (toUserId: string) => Promise<void>;
}

export function ReassignTaskDropdown({
  open,
  onOpenChange,
  currentAssigneeUserId,
  onSubmit,
}: ReassignTaskDropdownProps) {
  const t = useTranslations('admin.renewals.tasks.reassign_dialog');
  const [users, setUsers] = useState<ReadonlyArray<StaffUser> | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Lazy-load active staff users on open. Reset of `selectedUserId` /
  // `popoverOpen` lives in the AlertDialog `onOpenChange` callback below
  // so we don't violate the `react-hooks/set-state-in-effect` rule
  // (effects are for syncing state to external systems, not for
  // managing UI state in response to prop changes — React docs:
  // https://react.dev/learn/you-might-not-need-an-effect).
  useEffect(() => {
    if (!open) return;
    if (users !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/admin/users/staff-active', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) {
          if (!cancelled) setLoadError(true);
          return;
        }
        // Round 5 I-6 close — zod validate the parsed shape so a drift
        // (e.g. proxy-injected HTML, partial deploy, future RBAC change
        // that returns `{error:{}}` with 200) does not produce a
        // silently empty combobox.
        const parsed = staffActiveResponseSchema.safeParse(await res.json());
        if (!parsed.success) {
          if (!cancelled) setLoadError(true);
          return;
        }
        if (!cancelled) setUsers(parsed.data.users);
      } catch {
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, users]);

  function handleSubmit(): void {
    if (selectedUserId === null) return;
    startTransition(async () => {
      await onSubmit(selectedUserId);
    });
  }

  const selectedUser = users?.find((u) => u.id === selectedUserId) ?? null;
  const triggerLabel =
    selectedUser !== null
      ? selectedUser.display_name ?? selectedUser.email
      : t('placeholder');

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setSelectedUserId(null);
          setPopoverOpen(false);
        }
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('description')}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="grid gap-2">
          <span id="assignee-label" className="text-sm font-medium">
            {t('assignee_label')}
          </span>
          {loadError ? (
            <p className="text-sm text-destructive">{t('load_error')}</p>
          ) : (
            <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
              <PopoverTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    role="combobox"
                    aria-expanded={popoverOpen}
                    aria-labelledby="assignee-label"
                    className="w-full justify-between"
                    disabled={isPending || users === null}
                  >
                    <span className="truncate">{triggerLabel}</span>
                    <ChevronsUpDown
                      className="ml-2 size-4 shrink-0 opacity-50"
                      aria-hidden
                    />
                  </Button>
                }
              />
              {/* Round 5 C-2 close — base-ui Positioner exposes
                  `--anchor-width` (NOT `--radix-popover-trigger-width`
                  which is Radix-only). Pattern matches member-picker
                  + searchable-combobox elsewhere in the codebase. */}
              <PopoverContent
                align="start"
                className="w-[var(--anchor-width)] max-w-[calc(100vw-2rem)] p-0"
              >
                <Command>
                  <CommandInput placeholder={t('search_placeholder')} />
                  <CommandList>
                    <CommandEmpty>{t('no_results')}</CommandEmpty>
                    <CommandGroup>
                      {(users ?? []).map((u) => (
                        <CommandItem
                          key={u.id}
                          value={`${u.display_name ?? ''} ${u.email}`}
                          onSelect={() => {
                            setSelectedUserId(u.id);
                            setPopoverOpen(false);
                          }}
                        >
                          <Check
                            className={`mr-2 size-4 ${
                              u.id === selectedUserId ? 'opacity-100' : 'opacity-0'
                            }`}
                            aria-hidden
                          />
                          <span className="truncate">
                            <span className="font-medium">
                              {u.display_name ?? u.email}
                            </span>
                            {u.display_name !== null && (
                              <span className="ml-2 text-xs text-muted-foreground">
                                {u.email}
                              </span>
                            )}
                            <span className="ml-2 text-xs uppercase tracking-wide text-muted-foreground">
                              · {u.role}
                            </span>
                            {u.id === currentAssigneeUserId && (
                              <span className="ml-2 rounded-full bg-secondary px-1.5 py-0.5 text-xs font-medium text-secondary-foreground">
                                {t('current_assignee_badge')}
                              </span>
                            )}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>
            {t('cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={
              isPending ||
              selectedUserId === null ||
              selectedUserId === currentAssigneeUserId
            }
            aria-busy={isPending}
            onClick={handleSubmit}
          >
            {isPending && (
              <Loader2 className="mr-2 size-3.5 animate-spin" aria-hidden />
            )}
            {isPending ? t('submitting') : t('confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
