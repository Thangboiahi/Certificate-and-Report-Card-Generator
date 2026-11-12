import { describe, expect, it } from 'vitest';

import type { SessionUser } from '@/types/roles';

import {
  canonicalPath,
  evaluateAccess,
  parseRoleClaims,
  requiresRevocationCheck,
  ruleForPath,
  postLoginPath,
  roleHomePath,
  safeReturnPath,
  sameRoleClaims,
  toSessionUser,
} from './access';

const user = (role: SessionUser['role'], institutionId: string | null = null): SessionUser => ({
  uid: 'u1',
  email: 'u1@example.in',
  role,
  institutionId,
});

describe('parseRoleClaims', () => {
  it('reads the three elevated roles', () => {
    expect(parseRoleClaims({ role: 'super_admin' })).toEqual({ role: 'super_admin' });
    expect(parseRoleClaims({ role: 'inst_admin', institutionId: 'inst-1' })).toEqual({
      role: 'inst_admin',
      institutionId: 'inst-1',
    });
    expect(parseRoleClaims({ role: 'inst_staff', institutionId: 'A_b-9' })).toEqual({
      role: 'inst_staff',
      institutionId: 'A_b-9',
    });
  });

  it('ignores a stray institution on a super admin', () => {
    expect(parseRoleClaims({ role: 'super_admin', institutionId: 'x' })).toEqual({
      role: 'super_admin',
    });
  });

  it.each([
    [undefined],
    [null],
    [{}],
    [{ role: 'admin' }],
    [{ role: 'SUPER_ADMIN' }],
    [{ role: 'individual' }],
    [{ role: 'guest' }],
    [{ role: 'inst_admin' }],
    [{ role: 'inst_staff', institutionId: '' }],
    [{ role: 'inst_staff', institutionId: 42 }],
    [{ role: 'inst_staff', institutionId: 'a/b' }],
    [{ role: 'inst_staff', institutionId: 'x'.repeat(129) }],
    [{ role: ['super_admin'] }],
  ])('treats %j as no elevated role', (claims) => {
    expect(parseRoleClaims(claims as Record<string, unknown>)).toBeNull();
  });
});

describe('sameRoleClaims', () => {
  it('compares role and institution', () => {
    expect(sameRoleClaims(null, null)).toBe(true);
    expect(sameRoleClaims({ role: 'super_admin' }, { role: 'super_admin' })).toBe(true);
    expect(
      sameRoleClaims(
        { role: 'inst_staff', institutionId: 'a' },
        { role: 'inst_staff', institutionId: 'a' },
      ),
    ).toBe(true);
    expect(
      sameRoleClaims(
        { role: 'inst_staff', institutionId: 'a' },
        { role: 'inst_staff', institutionId: 'b' },
      ),
    ).toBe(false);
    expect(
      sameRoleClaims(
        { role: 'inst_staff', institutionId: 'a' },
        { role: 'inst_admin', institutionId: 'a' },
      ),
    ).toBe(false);
    expect(sameRoleClaims({ role: 'super_admin' }, null)).toBe(false);
  });
});

describe('toSessionUser', () => {
  it('makes anonymous Firebase users guests, whatever claims they carry', () => {
    expect(
      toSessionUser({ uid: 'a', firebase: { sign_in_provider: 'anonymous' }, role: 'super_admin' }),
    ).toEqual({
      uid: 'a',
      email: null,
      role: 'guest',
      institutionId: null,
      phoneNumber: null,
      emailVerified: false,
    });
  });

  it('makes signed-in users without elevated claims individuals', () => {
    expect(
      toSessionUser({
        uid: 'b',
        email: 'b@example.in',
        firebase: { sign_in_provider: 'google.com' },
      }),
    ).toEqual({
      uid: 'b',
      email: 'b@example.in',
      role: 'individual',
      institutionId: null,
      phoneNumber: null,
      emailVerified: false,
    });
  });

  it('carries the verified phone number and email status (used to match claim links)', () => {
    expect(
      toSessionUser({
        uid: 'p',
        phone_number: '+919876543210',
        email: 'p@example.in',
        email_verified: true,
        firebase: { sign_in_provider: 'phone' },
      }),
    ).toMatchObject({ phoneNumber: '+919876543210', emailVerified: true, role: 'individual' });
  });

  it('applies elevated claims', () => {
    expect(
      toSessionUser({ uid: 'c', role: 'inst_staff', institutionId: 'school-1' }),
    ).toMatchObject({
      role: 'inst_staff',
      institutionId: 'school-1',
    });
    expect(
      toSessionUser({ uid: 'd', role: 'super_admin', institutionId: 'school-1' }),
    ).toMatchObject({
      role: 'super_admin',
      institutionId: null,
    });
  });

  it('falls back to individual for malformed claims', () => {
    expect(toSessionUser({ uid: 'e', role: 'inst_admin' }).role).toBe('individual');
  });
});

describe('ruleForPath', () => {
  it.each([
    ['/admin', 'roles:super_admin'],
    ['/admin/users/42', 'roles:super_admin'],
    ['/dashboard/institution', 'roles:inst_admin,inst_staff'],
    ['/dashboard/institution/staff', 'roles:inst_admin,inst_staff'],
    ['/dashboard/vault', 'signed-in'],
    ['/dashboard/vault/item-1', 'signed-in'],
    ['/dashboard/issue', 'signed-in'],
    ['/dashboard/issue/templates', 'signed-in'],
    ['/dashboard', 'signed-in'],
    ['/dashboard/settings', 'signed-in'],
    ['/editor', 'public'],
    ['/editor/new', 'public'],
  ])('%s → %s', (path, expected) => {
    const access = ruleForPath(path)!.access;
    const label = access.kind === 'roles' ? `roles:${access.roles.join(',')}` : access.kind;
    expect(label).toBe(expected);
  });

  it.each([
    '/',
    '/playground',
    '/administer',
    '/admins',
    '/dashboards',
    '/editorial',
    '/api/proxy-image',
    '/login',
  ])('applies no rule to %s', (path) => {
    expect(ruleForPath(path)).toBeNull();
  });

  it.each([
    '/%61dmin',
    '/ADMIN',
    '/Admin/users',
    '//admin',
    '/admin/',
    '/admin//users',
    '/dashboard%2Finstitution',
    '/%64ashboard/institution/',
  ])('sees through the disguised path %s', (path) => {
    expect(ruleForPath(path)?.access.kind).toBe('roles');
  });

  it('denies everything for paths that cannot be decoded', () => {
    const rule = ruleForPath('/admin%E0%A4%A');
    expect(rule).not.toBeNull();
    for (const role of ['individual', 'inst_staff', 'inst_admin', 'super_admin'] as const) {
      expect(
        evaluateAccess(rule!.access, user(role, role.startsWith('inst') ? 'i' : null)),
      ).not.toBe('allow');
    }
  });
});

describe('canonicalPath', () => {
  it('normalises', () => {
    expect(canonicalPath('/')).toBe('/');
    expect(canonicalPath('/A//b/')).toBe('/a/b');
    expect(canonicalPath('/%E0%A4%95')).toBe('/क');
    expect(canonicalPath('/%')).toBeNull();
  });
});

describe('evaluateAccess', () => {
  const admin = ruleForPath('/admin')!.access;
  const institution = ruleForPath('/dashboard/institution')!.access;
  const vault = ruleForPath('/dashboard/vault')!.access;
  const editor = ruleForPath('/editor')!.access;

  const table: Array<[SessionUser | null, string, [string, string, string, string]]> = [
    // who                                   admin              institution        vault              editor
    [null, 'nobody', ['unauthenticated', 'unauthenticated', 'unauthenticated', 'allow']],
    [user('guest'), 'guest', ['unauthenticated', 'unauthenticated', 'unauthenticated', 'allow']],
    [user('individual'), 'individual', ['forbidden', 'forbidden', 'allow', 'allow']],
    [user('inst_staff', 'i1'), 'inst_staff', ['forbidden', 'allow', 'allow', 'allow']],
    [user('inst_admin', 'i1'), 'inst_admin', ['forbidden', 'allow', 'allow', 'allow']],
    [user('super_admin'), 'super_admin', ['allow', 'forbidden', 'allow', 'allow']],
  ];

  it.each(table)('%#: %s', (who, _label, [onAdmin, onInstitution, onVault, onEditor]) => {
    expect(evaluateAccess(admin, who)).toBe(onAdmin);
    expect(evaluateAccess(institution, who)).toBe(onInstitution);
    expect(evaluateAccess(vault, who)).toBe(onVault);
    expect(evaluateAccess(editor, who)).toBe(onEditor);
  });

  it('checks revocation only in privileged areas', () => {
    expect(requiresRevocationCheck(admin)).toBe(true);
    expect(requiresRevocationCheck(institution)).toBe(true);
    expect(requiresRevocationCheck(vault)).toBe(false);
    expect(requiresRevocationCheck(editor)).toBe(false);
  });
});

describe('safeReturnPath', () => {
  it('keeps same-origin paths', () => {
    expect(safeReturnPath('/dashboard/institution?tab=staff')).toBe(
      '/dashboard/institution?tab=staff',
    );
  });

  it.each([
    null,
    '',
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    '/\tx',
    'dashboard',
  ])('rejects %j', (value) => {
    expect(safeReturnPath(value)).toBe('/dashboard/vault');
  });
});

describe('roleHomePath', () => {
  it.each([
    ['super_admin', null, '/admin'],
    ['inst_admin', 'inst-1', '/dashboard/institution'],
    ['inst_staff', 'inst-1', '/dashboard/institution'],
    ['individual', null, '/dashboard/vault'],
  ] as const)('%s lands on %s', (role, institutionId, expected) => {
    expect(roleHomePath(user(role, institutionId))).toBe(expected);
  });
});

describe('postLoginPath', () => {
  const staff = user('inst_staff', 'inst-1');
  const solo = user('individual');

  it('sends institution staff to the institution dashboard', () => {
    expect(postLoginPath(staff, null)).toBe('/dashboard/institution');
    expect(postLoginPath(user('inst_admin', 'inst-1'), undefined)).toBe('/dashboard/institution');
  });

  it('sends a Micro-Issuer to their vault', () => {
    expect(postLoginPath(solo, null)).toBe('/dashboard/vault');
  });

  it('returns to the requested page when this user may open it', () => {
    expect(postLoginPath(solo, '/dashboard/issue?x=1')).toBe('/dashboard/issue?x=1');
    expect(postLoginPath(staff, '/dashboard/vault')).toBe('/dashboard/vault');
    expect(postLoginPath(solo, '/editor')).toBe('/editor');
  });

  it('falls back to the role home when the request is off limits', () => {
    expect(postLoginPath(solo, '/dashboard/institution')).toBe('/dashboard/vault');
    expect(postLoginPath(solo, '/admin')).toBe('/dashboard/vault');
    expect(postLoginPath(solo, '/%41dmin')).toBe('/dashboard/vault');
    expect(postLoginPath(staff, '/admin/users')).toBe('/dashboard/institution');
  });

  it.each(['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:1', '/%zz'])(
    'never follows %j',
    (next) => {
      expect(postLoginPath(solo, next)).toBe('/dashboard/vault');
    },
  );

  it('never loops back to the login page', () => {
    expect(postLoginPath(solo, '/login?next=/dashboard/issue')).toBe('/dashboard/vault');
    expect(postLoginPath(staff, '/LOGIN')).toBe('/dashboard/institution');
  });
});
