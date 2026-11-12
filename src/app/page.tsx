import {
  Award,
  BadgeCheck,
  FileSpreadsheet,
  FileText,
  Languages,
  MessageCircle,
  QrCode,
  Send,
  ShieldCheck,
  Sparkles,
  Wand2,
  type LucideIcon,
} from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: { absolute: 'Issue verifiable credentials in seconds · Bulk document generator' },
  description:
    'Turn one template and one spreadsheet into hundreds of certificates, report cards and ID cards, then send each person a link that proves it is genuine.',
};

const PRIMARY =
  'inline-flex min-h-12 items-center justify-center rounded-xl bg-blue-600 px-6 text-base font-semibold text-white transition-colors hover:bg-blue-700 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 focus-visible:outline-none dark:focus-visible:ring-offset-neutral-950';
const SECONDARY =
  'inline-flex min-h-12 items-center justify-center rounded-xl border border-neutral-300 px-6 text-base font-semibold transition-colors hover:border-neutral-500 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 focus-visible:outline-none dark:border-neutral-700 dark:hover:border-neutral-500 dark:focus-visible:ring-offset-neutral-950';

const STEPS: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: FileText,
    title: 'Upload your design',
    text: 'A PDF, PNG or JPG of your blank certificate, card or report. Add a spreadsheet of names if you have one.',
  },
  {
    icon: Wand2,
    title: 'Tap to place fields',
    text: 'Drag each field where it belongs. Test one real PDF before you make hundreds.',
  },
  {
    icon: Send,
    title: 'Generate and send',
    text: 'PDFs are made in your browser. Each person gets a link to claim theirs into a personal vault.',
  },
];

const FEATURES: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: FileSpreadsheet,
    title: 'Hundreds of PDFs from one spreadsheet',
    text: 'Generation runs on your own device, so a batch does not wait in a queue and your data stays with you.',
  },
  {
    icon: Languages,
    title: 'Made for Indian scripts',
    text: 'Names in Hindi, Tamil, Bengali and more print correctly, not as empty boxes.',
  },
  {
    icon: MessageCircle,
    title: 'WhatsApp and email delivery',
    text: 'Send each recipient a private claim link. Re-send to anyone who has not claimed with one click.',
  },
  {
    icon: QrCode,
    title: 'Proof anyone can check',
    text: 'A public verification page shows who issued a credential and whether it is still valid. No sign-in needed.',
  },
  {
    icon: ShieldCheck,
    title: 'Revoke when it is wrong',
    text: 'Revoked credentials stop verifying straight away and say so in red.',
  },
  {
    icon: Sparkles,
    title: 'AI clean-up for messy data',
    text: 'Fix capitalisation, spot missing values and translate names before you print.',
  },
];

const PLANS: {
  name: string;
  audience: string;
  points: string[];
  href: string;
  cta: string;
  primary?: boolean;
}[] = [
  {
    name: 'Try it',
    audience: 'Anyone, no account',
    points: [
      'Design a template and test real PDFs',
      'Works on a phone',
      'Nothing is uploaded or saved',
    ],
    href: '/editor',
    cta: 'Open the editor',
  },
  {
    name: 'Independent issuer',
    audience: 'Coaches, trainers, small organisers',
    points: [
      'Sign in with email or phone, no password',
      'Recipients keep credentials in a vault',
      'Public verification links and LinkedIn sharing',
    ],
    href: '/login',
    cta: 'Sign in',
  },
  {
    name: 'Institution',
    audience: 'Schools, colleges, companies',
    points: [
      'Staff and admin roles for your team',
      'Prepaid credits for WhatsApp and email sends',
      'Audit ledger and one-click re-issue',
    ],
    href: '/login',
    cta: 'Sign in as an institution',
    primary: true,
  },
];

export default function Home() {
  return (
    <div className="min-h-dvh bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-4">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <Award className="size-5 text-blue-600" aria-hidden />
          Bulk document generator
        </Link>
        <nav aria-label="Sections" className="ml-auto hidden items-center gap-5 text-sm sm:flex">
          <a href="#how" className="text-neutral-600 hover:underline dark:text-neutral-400">
            How it works
          </a>
          <a href="#features" className="text-neutral-600 hover:underline dark:text-neutral-400">
            Features
          </a>
          <a href="#plans" className="text-neutral-600 hover:underline dark:text-neutral-400">
            Plans
          </a>
        </nav>
        <Link
          href="/login"
          className="ml-auto inline-flex min-h-10 items-center rounded-lg border border-neutral-300 px-4 text-sm font-medium hover:border-neutral-500 sm:ml-0 dark:border-neutral-700"
        >
          Sign in
        </Link>
      </header>

      <main>
        <section className="mx-auto flex w-full max-w-4xl flex-col items-center gap-6 px-4 pt-12 pb-16 text-center sm:pt-20 sm:pb-24">
          <p className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300">
            <BadgeCheck className="size-3.5" aria-hidden /> Certificates people can check
          </p>
          <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-6xl">
            Issue Verifiable Credentials in Seconds
          </h1>
          <p className="max-w-2xl text-lg leading-relaxed text-pretty text-neutral-600 dark:text-neutral-400">
            One template and one spreadsheet in, hundreds of certificates, report cards or ID cards
            out. Every one comes with a link that proves it is genuine.
          </p>
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
            <Link href="/login" className={PRIMARY} data-testid="cta-institution">
              I’m an institution: sign in
            </Link>
            <Link href="/editor" className={SECONDARY} data-testid="cta-editor">
              Try the editor, no sign-in
            </Link>
          </div>
          <p className="text-sm text-neutral-500">
            Works on any phone. Your files stay in your browser.
          </p>
        </section>

        <section
          id="how"
          aria-labelledby="how-heading"
          className="border-y border-neutral-200 bg-neutral-50 py-16 dark:border-neutral-800 dark:bg-neutral-900"
        >
          <div className="mx-auto w-full max-w-6xl px-4">
            <h2 id="how-heading" className="text-center text-3xl font-bold tracking-tight">
              From blank design to delivered in three steps
            </h2>
            <ol className="mt-10 grid gap-6 sm:grid-cols-3">
              {STEPS.map(({ icon: Icon, title, text }, index) => (
                <li
                  key={title}
                  className="rounded-2xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-950"
                >
                  <span className="flex size-10 items-center justify-center rounded-xl bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                    <Icon className="size-5" aria-hidden />
                  </span>
                  <h3 className="mt-4 font-semibold">
                    <span className="text-neutral-400">{index + 1}. </span>
                    {title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
                    {text}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="features" aria-labelledby="features-heading" className="py-16">
          <div className="mx-auto w-full max-w-6xl px-4">
            <h2 id="features-heading" className="text-center text-3xl font-bold tracking-tight">
              Everything between the spreadsheet and the proof
            </h2>
            <ul className="mt-10 grid gap-x-8 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map(({ icon: Icon, title, text }) => (
                <li key={title} className="flex gap-4">
                  <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <div>
                    <h3 className="font-semibold">{title}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
                      {text}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section
          id="plans"
          aria-labelledby="plans-heading"
          className="border-t border-neutral-200 bg-neutral-50 py-16 dark:border-neutral-800 dark:bg-neutral-900"
        >
          <div className="mx-auto w-full max-w-6xl px-4">
            <h2 id="plans-heading" className="text-center text-3xl font-bold tracking-tight">
              Pick the way you work
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-center text-sm text-neutral-600 dark:text-neutral-400">
              Pricing is being finalised, so no prices are shown yet. You can try the editor now
              without an account.
            </p>
            <ul className="mt-10 grid gap-6 lg:grid-cols-3">
              {PLANS.map((plan) => (
                <li
                  key={plan.name}
                  className={
                    plan.primary
                      ? 'flex flex-col rounded-2xl border-2 border-blue-600 bg-white p-6 dark:bg-neutral-950'
                      : 'flex flex-col rounded-2xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-950'
                  }
                >
                  <h3 className="text-xl font-semibold">{plan.name}</h3>
                  <p className="text-sm text-neutral-500">{plan.audience}</p>
                  <ul className="mt-5 flex flex-1 flex-col gap-2 text-sm">
                    {plan.points.map((point) => (
                      <li key={point} className="flex gap-2">
                        <BadgeCheck className="mt-0.5 size-4 shrink-0 text-green-600" aria-hidden />
                        {point}
                      </li>
                    ))}
                  </ul>
                  <Link
                    href={plan.href}
                    className={`${plan.primary ? PRIMARY : SECONDARY} mt-6 w-full`}
                  >
                    {plan.cta}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="mx-auto flex w-full max-w-3xl flex-col items-center gap-5 px-4 py-16 text-center">
          <h2 className="text-3xl font-bold tracking-tight text-balance">
            Ready to issue your first batch?
          </h2>
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
            <Link href="/login" className={PRIMARY}>
              Sign in
            </Link>
            <Link href="/editor" className={SECONDARY}>
              Try the editor
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-neutral-200 py-8 text-center text-sm text-neutral-500 dark:border-neutral-800">
        <p>
          Holding a credential link or QR code? Open it to see whether it is genuine. No sign-in
          needed.
        </p>
      </footer>
    </div>
  );
}
