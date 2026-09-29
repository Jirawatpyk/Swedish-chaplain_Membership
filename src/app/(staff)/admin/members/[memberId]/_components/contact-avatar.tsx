'use client';

/**
 * 122 US5b-1 — the contact's avatar on the member page (board
 * `Admin-member-detail`). AURA's `Avatar` ships from the client entry only,
 * so the server-rendered contact row mounts it through this file. Decorative
 * here: the name is the h3 beside it, so it is hidden from assistive tech.
 */
import { Avatar } from '@jirawatpyk/aura-react';

export function ContactAvatar({ name }: { readonly name: string }) {
  return (
    <span aria-hidden="true" className="inline-flex">
      <Avatar name={name} />
    </span>
  );
}
