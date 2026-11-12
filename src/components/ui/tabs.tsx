'use client';

/**
 * shadcn/ui Tabs (Radix UI), adapted to the project's neutral palette and 44 px touch targets.
 * Keyboard support (arrow keys, Home/End) and ARIA roles come from Radix.
 */
import * as TabsPrimitive from '@radix-ui/react-tabs';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils/cn';

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        'inline-flex items-center rounded-xl bg-neutral-100 p-1 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400',
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'relative inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium whitespace-nowrap transition-colors',
        'hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 dark:hover:text-neutral-100',
        'data-[state=active]:text-neutral-900 dark:data-[state=active]:text-neutral-50',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn('outline-none focus-visible:ring-2 focus-visible:ring-blue-600', className)}
      {...props}
    />
  );
}
