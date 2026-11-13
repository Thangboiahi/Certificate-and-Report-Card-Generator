'use client';

import { linkedInAddUrl } from '@/lib/linkedin';

export interface AddToLinkedInProps {
  name: string;
  organizationName: string;
  issuedAt: number;
  expiresAt: number | null;
}

/**
 * "1-Click Add to LinkedIn". The link back to this verification page is the address the browser is
 * on right now, so it is correct on any domain; it is built when the button is pressed.
 */
export function AddToLinkedIn(props: AddToLinkedInProps) {
  function open() {
    const url = linkedInAddUrl({ ...props, certUrl: window.location.href.split('#')[0]! });
    window.open(url, '_blank', 'noopener,noreferrer');
  }
  return (
    <button
      type="button"
      onClick={open}
      data-testid="add-to-linkedin"
      className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#0A66C2] px-4 text-sm font-semibold text-white hover:bg-[#004182] focus-visible:ring-2 focus-visible:ring-[#0A66C2] focus-visible:ring-offset-2 focus-visible:outline-none"
    >
      <LinkedInMark /> Add to LinkedIn profile
    </button>
  );
}

/** lucide-react has no brand icons; this is LinkedIn's "in" mark. */
function LinkedInMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 fill-current" aria-hidden>
      <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.03-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zM7.12 20.45H3.56V9h3.56v11.45z" />
    </svg>
  );
}
