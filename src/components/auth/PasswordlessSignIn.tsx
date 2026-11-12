'use client';

/**
 * Passwordless sign-in: a one-time email link or an SMS code. There is no password to create or
 * remember, and nothing to install.
 *
 * - Email: enter the address → "check your inbox" → tapping the link reopens this page, which
 *   finishes sign-in by itself (same device). On another device it asks for the address once.
 * - Phone: enter the mobile number (+91 assumed) → a 6-digit code arrives by SMS; the keyboard
 *   offers it (`autocomplete="one-time-code"`) and sign-in completes as soon as 6 digits are in.
 *
 * Afterwards the session cookie is set (`establishSession`) and `onSignedIn` runs.
 */
import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import { ArrowLeft, LoaderCircle, Mail, MessageSquareText, Smartphone } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { toE164 } from '@/lib/claim/contact';
import {
  authErrorMessage,
  completeEmailSignIn,
  confirmPhoneCode,
  establishSession,
  isEmailSignInLink,
  rememberedEmail,
  sendEmailSignInLink,
  startPhoneSignIn,
  type ConfirmationResult,
  type FirebaseClientConfig,
} from '@/lib/firebase';
import { cn } from '@/lib/utils/cn';

export type SignInMethod = 'phone' | 'email';

type Step =
  | { kind: 'enter' }
  | { kind: 'busy'; label: string }
  | { kind: 'email-sent'; email: string }
  | { kind: 'code'; phone: string; confirmation: ConfirmationResult; sentAt: number }
  | { kind: 'confirm-email' };

const RESEND_SECONDS = 30;
const LINK_PARAMS = ['apiKey', 'oobCode', 'mode', 'lang', 'continueUrl', 'tenantId'];

export interface PasswordlessSignInProps {
  config: FirebaseClientConfig;
  /** Offered methods, first is the default. */
  methods: readonly SignInMethod[];
  /** Same-origin path the email link returns to (this page, normally). */
  returnPath: string;
  /** Shown under the heading, e.g. which number to use. */
  hint?: string;
  onSignedIn: () => void;
}

const field =
  'h-12 w-full rounded-xl border border-neutral-300 bg-white px-4 text-base outline-none focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-600/30 dark:border-neutral-700 dark:bg-neutral-900';
const primary =
  'inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-base font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60';

export function PasswordlessSignIn({
  config,
  methods,
  returnPath,
  hint,
  onSignedIn,
}: PasswordlessSignInProps) {
  const [method, setMethod] = useState<SignInMethod>(methods[0] ?? 'phone');
  const [step, setStep] = useState<Step>({ kind: 'enter' });
  const [value, setValue] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const recaptcha = useRef<HTMLDivElement>(null);
  const finished = useRef(false);

  async function finish(idToken: string) {
    await establishSession(config, idToken);
    // Remove the one-time link parameters from the address bar.
    const url = new URL(window.location.href);
    for (const name of LINK_PARAMS) url.searchParams.delete(name);
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    finished.current = true;
    onSignedIn();
  }

  async function completeLink(email: string) {
    setStep({ kind: 'busy', label: 'Signing you in…' });
    setError(null);
    try {
      await finish(await completeEmailSignIn(config, window.location.href, email));
    } catch (cause) {
      setError(authErrorMessage(cause));
      setStep({ kind: 'confirm-email' });
    }
  }

  // Returning from an email link: finish without any typing when the address is remembered.
  useEffect(() => {
    if (finished.current || !isEmailSignInLink(config, window.location.href)) return;
    const email = rememberedEmail();
    // Deferred: the page first renders, then sign-in finishes.
    queueMicrotask(() => {
      if (email) void completeLink(email);
      else setStep({ kind: 'confirm-email' });
    });
    // Runs once on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resend countdown.
  useEffect(() => {
    if (step.kind !== 'code') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [step.kind]);

  async function sendEmail(email: string) {
    setStep({ kind: 'busy', label: 'Sending your link…' });
    setError(null);
    try {
      await sendEmailSignInLink(
        config,
        email,
        new URL(returnPath, window.location.origin).toString(),
      );
      setStep({ kind: 'email-sent', email });
    } catch (cause) {
      setError(authErrorMessage(cause));
      setStep({ kind: 'enter' });
    }
  }

  async function sendCode(phone: string) {
    setStep({ kind: 'busy', label: 'Sending your code…' });
    setError(null);
    try {
      // A fresh element each time: reCAPTCHA cannot render twice into the same one.
      const host = document.createElement('div');
      recaptcha.current!.replaceChildren(host);
      const confirmation = await startPhoneSignIn(config, phone, host);
      setCode('');
      setNow(Date.now());
      setStep({ kind: 'code', phone, confirmation, sentAt: Date.now() });
    } catch (cause) {
      setError(authErrorMessage(cause));
      setStep({ kind: 'enter' });
    }
  }

  async function verifyCode(entered: string, current: Extract<Step, { kind: 'code' }>) {
    setStep({ kind: 'busy', label: 'Checking the code…' });
    setError(null);
    try {
      await finish(await confirmPhoneCode(current.confirmation, entered));
    } catch (cause) {
      setError(authErrorMessage(cause));
      setCode('');
      setStep(current);
    }
  }

  function submitContact(event: FormEvent) {
    event.preventDefault();
    if (method === 'email') {
      const email = value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        setError('Enter a valid email address.');
        return;
      }
      void sendEmail(email);
    } else {
      const phone = toE164(value);
      if (!phone) {
        setError('Enter a valid 10-digit mobile number.');
        return;
      }
      void sendCode(phone);
    }
  }

  function onCodeChange(raw: string) {
    const digits = raw.replace(/\D/g, '').slice(0, 6);
    setCode(digits);
    if (digits.length === 6 && step.kind === 'code') void verifyCode(digits, step);
  }

  const resendIn =
    step.kind === 'code' ? Math.max(0, RESEND_SECONDS - Math.floor((now - step.sentAt) / 1000)) : 0;

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex flex-col gap-4" data-testid="passwordless-sign-in">
        {hint && <p className="text-sm text-neutral-600 dark:text-neutral-400">{hint}</p>}
        {error && (
          <p
            role="alert"
            className="rounded-xl bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
          >
            {error}
          </p>
        )}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step.kind + method}
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -16 }}
            transition={{ duration: 0.18 }}
          >
            {step.kind === 'enter' && (
              <form onSubmit={submitContact} className="flex flex-col gap-3" noValidate>
                {methods.length > 1 && (
                  <div
                    role="tablist"
                    aria-label="Sign in with"
                    className="grid grid-cols-2 rounded-xl bg-neutral-100 p-1 dark:bg-neutral-900"
                  >
                    {methods.map((option) => (
                      <button
                        key={option}
                        type="button"
                        role="tab"
                        aria-selected={method === option}
                        onClick={() => {
                          setMethod(option);
                          setValue('');
                          setError(null);
                        }}
                        className={cn(
                          'flex min-h-10 items-center justify-center gap-2 rounded-lg text-sm font-medium',
                          method === option
                            ? 'bg-white shadow-sm dark:bg-neutral-800'
                            : 'text-neutral-500',
                        )}
                      >
                        {option === 'phone' ? (
                          <Smartphone className="size-4" aria-hidden />
                        ) : (
                          <Mail className="size-4" aria-hidden />
                        )}
                        {option === 'phone' ? 'Mobile' : 'Email'}
                      </button>
                    ))}
                  </div>
                )}
                {method === 'phone' ? (
                  <label className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium">Mobile number</span>
                    <div className="flex items-center gap-2">
                      <span className="flex h-12 items-center rounded-xl bg-neutral-100 px-3 text-base text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">
                        +91
                      </span>
                      <input
                        className={field}
                        type="tel"
                        inputMode="tel"
                        autoComplete="tel-national"
                        placeholder="98765 43210"
                        value={value}
                        onChange={(event) => setValue(event.target.value)}
                        data-testid="phone-input"
                        autoFocus
                      />
                    </div>
                  </label>
                ) : (
                  <label className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium">Email address</span>
                    <input
                      className={field}
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      placeholder="you@example.in"
                      value={value}
                      onChange={(event) => setValue(event.target.value)}
                      data-testid="email-input"
                      autoFocus
                    />
                  </label>
                )}
                <button type="submit" className={primary} data-testid="send-sign-in">
                  {method === 'phone' ? (
                    <MessageSquareText className="size-5" aria-hidden />
                  ) : (
                    <Mail className="size-5" aria-hidden />
                  )}
                  {method === 'phone' ? 'Send me a code' : 'Email me a sign-in link'}
                </button>
                <p className="text-center text-xs text-neutral-500">
                  No password needed.{' '}
                  {method === 'phone' ? 'Standard SMS rates may apply.' : 'The link works once.'}
                </p>
              </form>
            )}

            {step.kind === 'busy' && (
              <p
                className="flex items-center justify-center gap-2 py-8 text-sm text-neutral-600 dark:text-neutral-300"
                role="status"
              >
                <LoaderCircle className="size-5 animate-spin" aria-hidden />
                {step.label}
              </p>
            )}

            {step.kind === 'email-sent' && (
              <div
                className="flex flex-col items-center gap-3 py-4 text-center"
                data-testid="email-sent"
              >
                <span className="rounded-full bg-blue-50 p-4 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                  <Mail className="size-7" aria-hidden />
                </span>
                <h3 className="text-lg font-semibold">Check your inbox</h3>
                <p className="text-sm text-neutral-600 dark:text-neutral-400">
                  We sent a sign-in link to <strong>{step.email}</strong>. Open it on this phone to
                  continue.
                </p>
                <button
                  type="button"
                  className="text-sm text-blue-700 underline-offset-2 hover:underline dark:text-blue-300"
                  onClick={() => setStep({ kind: 'enter' })}
                >
                  Use a different address
                </button>
              </div>
            )}

            {step.kind === 'code' && (
              <div className="flex flex-col gap-3">
                <button
                  type="button"
                  onClick={() => setStep({ kind: 'enter' })}
                  className="flex w-fit items-center gap-1 text-sm text-neutral-500"
                >
                  <ArrowLeft className="size-4" aria-hidden /> Change number
                </button>
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium">
                    Enter the 6-digit code sent to {step.phone}
                  </span>
                  <input
                    className={cn(field, 'text-center text-2xl tracking-[0.5em] tabular-nums')}
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]*"
                    maxLength={6}
                    value={code}
                    onChange={(event) => onCodeChange(event.target.value)}
                    data-testid="otp-input"
                    aria-describedby="otp-help"
                    autoFocus
                  />
                </label>
                <p id="otp-help" className="text-center text-xs text-neutral-500">
                  {resendIn > 0 ? (
                    `You can ask for a new code in ${resendIn} s`
                  ) : (
                    <button
                      type="button"
                      className="text-blue-700 hover:underline dark:text-blue-300"
                      onClick={() => void sendCode(step.phone)}
                    >
                      Send a new code
                    </button>
                  )}
                </p>
              </div>
            )}

            {step.kind === 'confirm-email' && (
              <form
                className="flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void completeLink(value.trim().toLowerCase());
                }}
              >
                <p className="text-sm text-neutral-600 dark:text-neutral-400">
                  You opened the sign-in link on a different device or browser. Confirm your email
                  address to continue.
                </p>
                <input
                  className={field}
                  type="email"
                  autoComplete="email"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  data-testid="confirm-email-input"
                  autoFocus
                />
                <button type="submit" className={primary}>
                  Continue
                </button>
              </form>
            )}
          </motion.div>
        </AnimatePresence>
        {/* Hosts the invisible reCAPTCHA for SMS sign-in. */}
        <div ref={recaptcha} />
      </div>
    </MotionConfig>
  );
}
