import Link from 'next/link';

/**
 * Placeholder home page. The product's real screens (sign-in, templates, data, generation) arrive
 * with milestones M1–M4 — see docs/PLAN.md. Until then this points at the one thing that runs.
 */
export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col justify-center gap-6 px-4 py-12">
      <p className="text-xs font-medium tracking-widest text-neutral-500 uppercase">
        Milestone 0 · Engine foundation
      </p>
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Bulk document generator</h1>
      <p className="max-w-prose leading-relaxed text-neutral-600 dark:text-neutral-400">
        Certificates, report cards, ID cards and letters — one template and one spreadsheet in,
        hundreds of filled PDFs out, generated in the browser. The generation engine is built; the
        product around it is next.
      </p>
      <div>
        <Link
          href="/playground"
          className="inline-flex rounded-xl bg-blue-600 px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-700"
        >
          Open the engine playground
        </Link>
      </div>
    </main>
  );
}
