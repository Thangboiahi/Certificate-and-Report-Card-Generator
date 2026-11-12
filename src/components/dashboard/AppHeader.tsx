'use client';

/**
 * Top bar of the signed-in area: the product name, and a profile menu (Avatar) with the person's
 * identity, a link to the editor, and Sign out.
 *
 * Sign out ends the browser-side Firebase session, clears the server's session cookie and loads
 * `/login`. The navigation is a full page load, not a client transition, so no signed-in page or
 * cached server data stays on screen after the cookie is gone.
 */
import { Award, LogOut, PenTool } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { signOutEverywhere, type FirebaseClientConfig } from '@/lib/firebase';
import { notifyError } from '@/lib/ui/notify';
import type { UserRole } from '@/types/roles';

const ROLE_LABELS: Partial<Record<UserRole, string>> = {
  super_admin: 'Platform admin',
  inst_admin: 'Institution admin',
  inst_staff: 'Institution staff',
  individual: 'Issuer',
};

export interface AppHeaderProps {
  /** `null` when the session could not be read; the menu then offers only Sign out. */
  user: { identity: string; role: UserRole } | null;
  /** Where the product name links: the person's own home page. */
  homeHref?: string;
  /** Firebase config for the browser-side sign-out; `null` when sign-in is not configured. */
  config: FirebaseClientConfig | null;
}

/** Initials for the avatar: the first two letters of the identity (an email or phone number). */
export function initialsOf(identity: string): string {
  const letters = identity.replace(/[^\p{L}\p{N}]/gu, '');
  return (letters.slice(0, 2) || '?').toUpperCase();
}

export function AppHeader({ user, config, homeHref = '/dashboard/vault' }: AppHeaderProps) {
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOutEverywhere(config);
      window.location.replace('/login');
    } catch (cause) {
      notifyError(cause, 'You could not be signed out. Check your connection and try again.');
      setSigningOut(false);
    }
  }

  return (
    <header
      data-testid="app-header"
      className="sticky top-0 z-40 border-b border-neutral-200 bg-white/90 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/90"
    >
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4">
        <Link
          href={homeHref}
          className="flex items-center gap-2 text-sm font-semibold tracking-tight"
        >
          <Award className="size-5 text-blue-600" aria-hidden />
          Bulk document generator
        </Link>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Account menu"
            data-testid="profile-menu-trigger"
            className="flex size-11 items-center justify-center rounded-full focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-none"
          >
            <Avatar>
              <AvatarFallback>{user ? initialsOf(user.identity) : '?'}</AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {user && (
              <>
                <DropdownMenuLabel data-testid="profile-identity">
                  <span className="block truncate font-medium">{user.identity}</span>
                  <span className="block text-xs text-neutral-500">
                    {ROLE_LABELS[user.role] ?? user.role}
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/editor">
                    <PenTool className="size-4" aria-hidden />
                    Template editor
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem
              data-testid="sign-out"
              disabled={signingOut}
              onSelect={(event) => {
                // Keep the menu mounted until the request settles, so a failure is not lost.
                event.preventDefault();
                void signOut();
              }}
            >
              <LogOut className="size-4" aria-hidden />
              {signingOut ? 'Signing out…' : 'Sign out'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
