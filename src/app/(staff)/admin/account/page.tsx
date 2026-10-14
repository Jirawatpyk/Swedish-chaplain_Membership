import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ShieldCheckIcon } from 'lucide-react';
import { Badge, Card } from '@jirawatpyk/aura-react/server';
import { ChangePasswordForm } from '@/components/auth/change-password-form';
import { ROLE_BADGE_STYLE } from '@/components/auth/role-badge-style';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { requirePagePermission } from '@/lib/rbac';
import type { Role } from '@/modules/auth/domain/role';
/**
 * Staff account settings page (T154) at URL `/admin/account`.
 *
 * For F1 the only setting is password change. Future phases will
 * add profile, notification preferences, language selection, etc.
 *
 * Spec 122 US10c (T1025; boards `Admin-account`, `-mobile`): the role is an
 * AURA badge styled as on the users list, and the form sits in one AURA card
 * under its explanation. The board draws no second "Change password" heading
 * in the card: the page h1 already says it.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.changePassword');
  return { title: t('title') };
}

export default async function StaffAccountPage() {
  const { user } = await requirePagePermission('dashboard.view');
  return renderStaffAccountView({ email: user.email, role: user.role });
}

/** The page body, shared with the /test-fixtures/aura-admin preview (spec 122 US10c). */
export async function renderStaffAccountView({
  email,
  role,
}: {
  readonly email: string;
  readonly role: Role;
}): Promise<React.ReactElement> {
  const t = await getTranslations('auth.changePassword');
  const tShell = await getTranslations('shell.roleBadge');
  const { tone, variant } = ROLE_BADGE_STYLE[role];

  return (
    <FormContainer align="start">
      <PageHeader
        title={t('title')}
        subtitle={email}
        badge={
          <Badge
            tone={tone}
            variant={variant}
            // rbac-presentation-only-ok: picks a badge icon
            icon={role === 'super_admin' ? <ShieldCheckIcon aria-hidden /> : undefined}
          >
            {tShell(role)}
          </Badge>
        }
      />

      <Card>
        <div className="flex flex-col gap-[var(--aura-space-4)]">
          <p className="aura-text-sm text-[var(--aura-fg-secondary)]">{t('description')}</p>
          <ChangePasswordForm />
        </div>
      </Card>
    </FormContainer>
  );
}
