/**
 * The page-level guard, on its own: it must hold even if the proxy never ran (a matcher change,
 * a refactor, a framework bug). Verification is stubbed; it is exercised for real in
 * auth.emulator.test.ts and scripts/e2e-auth.mjs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionUser } from '@/types/roles';

const state = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  user: null as SessionUser | null,
  checkRevoked: [] as boolean[],
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => (state.cookie ? { value: state.cookie } : undefined) }),
}));

vi.mock('./customClaims', () => ({
  verifySessionCookie: async (_cookie: string, options: { checkRevoked: boolean }) => {
    state.checkRevoked.push(options.checkRevoked);
    return state.user;
  },
  verifyIdToken: async () => null,
}));

const { requireRouteAccess } = await import('./session');

const as = (role: SessionUser['role'], institutionId: string | null = null): SessionUser => ({
  uid: 'u',
  email: 'u@example.in',
  role,
  institutionId,
});

/** What the guard did: returned the user, redirected, or answered "not found". */
async function outcome(path: string): Promise<string> {
  try {
    const user = await requireRouteAccess(path);
    return `allow ${user.role}`;
  } catch (error) {
    const digest = String((error as { digest?: unknown }).digest ?? error);
    if (digest.startsWith('NEXT_REDIRECT')) return `redirect ${digest.split(';')[2]}`;
    if (digest.includes(';404')) return 'not found';
    throw error;
  }
}

beforeEach(() => {
  state.cookie = 'session-cookie';
  state.user = null;
  state.checkRevoked = [];
});

describe('requireRouteAccess', () => {
  it('sends signed-out visitors to sign-in, keeping where they were going', async () => {
    state.cookie = undefined;
    expect(await outcome('/admin')).toBe('redirect /login?next=%2Fadmin');
    expect(await outcome('/dashboard/vault')).toBe('redirect /login?next=%2Fdashboard%2Fvault');
  });

  it('treats an invalid cookie and an anonymous session as signed out', async () => {
    expect(await outcome('/dashboard/vault')).toBe('redirect /login?next=%2Fdashboard%2Fvault');
    state.user = as('guest');
    expect(await outcome('/dashboard/vault')).toBe('redirect /login?next=%2Fdashboard%2Fvault');
  });

  it('hides privileged pages from users without the role', async () => {
    state.user = as('individual');
    expect(await outcome('/admin')).toBe('not found');
    expect(await outcome('/dashboard/institution')).toBe('not found');
    state.user = as('inst_staff', 'school-a');
    expect(await outcome('/admin')).toBe('not found');
    state.user = as('super_admin');
    expect(await outcome('/dashboard/institution')).toBe('not found');
  });

  it('lets the right roles in', async () => {
    state.user = as('super_admin');
    expect(await outcome('/admin')).toBe('allow super_admin');
    state.user = as('inst_admin', 'school-a');
    expect(await outcome('/dashboard/institution')).toBe('allow inst_admin');
    state.user = as('individual');
    expect(await outcome('/dashboard/vault')).toBe('allow individual');
  });

  it('checks revocation for privileged pages only', async () => {
    state.user = as('super_admin');
    await outcome('/admin');
    await outcome('/dashboard/vault');
    expect(state.checkRevoked).toEqual([true, false]);
  });

  it('refuses to guard a path that has no protected rule', async () => {
    await expect(requireRouteAccess('/editor')).rejects.toThrow('no protected route rule');
    await expect(requireRouteAccess('/playground')).rejects.toThrow('no protected route rule');
  });
});
