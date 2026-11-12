import { WorkspaceToggle } from '@/components/dashboard/WorkspaceToggle';

/**
 * Shared frame of a person's two workspaces — the vault and the Micro-Issuer tools — with the
 * toggle between them in the top bar. Access is checked by each page, not here (ADR-017).
 */
export default function WorkspaceLayout({ children }: LayoutProps<'/dashboard'>) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col px-4 pt-4 pb-12 sm:pt-8">
      <WorkspaceToggle className="sticky top-2 z-20 shadow-sm sm:shadow-none">
        {children}
      </WorkspaceToggle>
    </main>
  );
}
