/**
 * shadcn/ui Table primitives, adapted to the project's neutral palette. The wrapper scrolls
 * sideways on narrow screens instead of squeezing columns.
 */
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils/cn';

export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div className="relative w-full overflow-x-auto rounded-2xl border border-neutral-200 dark:border-neutral-800">
      <table className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return (
    <thead
      className={cn('bg-neutral-50 dark:bg-neutral-900 [&_tr]:border-b', className)}
      {...props}
    />
  );
}

export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return (
    <tr
      className={cn(
        'border-b border-neutral-200 transition-colors hover:bg-neutral-50/60 dark:border-neutral-800 dark:hover:bg-neutral-900/60',
        className,
      )}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      className={cn(
        'h-10 px-3 text-left align-middle text-xs font-medium whitespace-nowrap text-neutral-500',
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('px-3 py-3 align-middle whitespace-nowrap', className)} {...props} />;
}

export function TableCaption({ className, ...props }: ComponentProps<'caption'>) {
  return <caption className={cn('mt-3 text-xs text-neutral-500', className)} {...props} />;
}
