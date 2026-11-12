'use client';

/** shadcn/ui Toaster (Sonner): the one place toast notifications are rendered. */
import { Toaster as Sonner, type ToasterProps } from 'sonner';

export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="system"
      position="top-center"
      closeButton
      richColors
      // Keep toasts clear of the editor's bottom property sheet.
      offset={{ top: 16 }}
      mobileOffset={{ top: 12 }}
      toastOptions={{ classNames: { toast: 'font-sans' } }}
      {...props}
    />
  );
}
