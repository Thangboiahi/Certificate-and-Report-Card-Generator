import type { Metadata, Viewport } from 'next';

import { GlobalErrorToasts } from '@/components/GlobalErrorToasts';
import { Toaster } from '@/components/ui/sonner';

import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Bulk document generator', template: '%s · Bulk document generator' },
  description:
    'Certificates, report cards and ID cards for everyone on your list, generated in your browser.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en">
      <body className="bg-white text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">
        {children}
        <Toaster />
        <GlobalErrorToasts />
      </body>
    </html>
  );
}
