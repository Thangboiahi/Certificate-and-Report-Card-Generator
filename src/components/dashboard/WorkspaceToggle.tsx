'use client';

/**
 * Top-nav segmented control between a person's two workspaces:
 *
 *   - "My Digital Vault"     → /dashboard/vault  (credentials issued to them)
 *   - "Issue Credentials"    → /dashboard/issue  (their Micro-Issuer tools)
 *
 * Built on shadcn/ui Tabs. Each workspace is its own route with its own server-side access check,
 * so the address bar is the source of truth: the active tab follows the path, choosing a tab
 * navigates, and the current page is rendered as the active tab's panel. The highlight moves
 * immediately (optimistic) while the next page loads.
 */
import { Award, Send } from 'lucide-react';
import { motion, MotionConfig } from 'framer-motion';
import { usePathname, useRouter } from 'next/navigation';
import { useOptimistic, useTransition, type ReactNode } from 'react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils/cn';

export const WORKSPACES = [
  {
    value: 'vault',
    href: '/dashboard/vault',
    label: 'My Digital Vault',
    short: 'Vault',
    icon: Award,
  },
  {
    value: 'issue',
    href: '/dashboard/issue',
    label: 'Issue Credentials',
    short: 'Issue',
    icon: Send,
  },
] as const;

export type Workspace = (typeof WORKSPACES)[number]['value'];

/** The workspace a path belongs to, or `null` outside both. */
export function workspaceForPath(pathname: string): Workspace | null {
  const match = WORKSPACES.find(({ href }) => pathname === href || pathname.startsWith(`${href}/`));
  return match?.value ?? null;
}

export function WorkspaceToggle({
  children,
  className,
}: {
  /** The current workspace's page, shown as the active tab's panel. */
  children?: ReactNode;
  className?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const current = workspaceForPath(pathname) ?? 'vault';
  const [isPending, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic<Workspace>(current);

  function choose(value: string) {
    const target = WORKSPACES.find((workspace) => workspace.value === value);
    if (!target || target.value === current) return;
    startTransition(() => {
      setShown(target.value);
      router.push(target.href);
    });
  }

  return (
    <Tabs value={shown} onValueChange={choose} activationMode="manual" className="flex flex-col">
      <MotionConfig reducedMotion="user">
        <TabsList
          aria-label="Workspace"
          data-testid="workspace-toggle"
          data-pending={isPending ? 'true' : 'false'}
          className={cn('grid w-full grid-cols-2 sm:inline-grid sm:w-auto', className)}
        >
          {WORKSPACES.map(({ value, label, short, icon: Icon }) => (
            <TabsTrigger
              key={value}
              value={value}
              data-testid={`workspace-${value}`}
              onMouseEnter={() => router.prefetch(WORKSPACES.find((w) => w.value === value)!.href)}
              className="px-3 sm:px-4"
            >
              {shown === value && (
                <motion.span
                  layoutId="workspace-toggle-pill"
                  className="absolute inset-0 rounded-lg bg-white shadow-sm ring-1 ring-black/5 dark:bg-neutral-800 dark:ring-white/10"
                  transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                  aria-hidden
                />
              )}
              <span className="relative flex items-center gap-2">
                <Icon className="size-4" aria-hidden />
                <span className="hidden min-[375px]:inline">{label}</span>
                <span className="min-[375px]:hidden">{short}</span>
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
      </MotionConfig>
      {children !== undefined && (
        <TabsContent value={current} className="mt-6" data-testid="workspace-panel">
          {children}
        </TabsContent>
      )}
    </Tabs>
  );
}
