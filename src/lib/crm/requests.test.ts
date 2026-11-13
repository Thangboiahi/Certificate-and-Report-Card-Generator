import { describe, expect, it } from 'vitest';

import { ownerKeyOf, parseMove, parseNewRequest, RequestError } from './requests';

const invalid = (run: () => unknown) => {
  try {
    run();
  } catch (cause) {
    expect(cause).toBeInstanceOf(RequestError);
    return (cause as RequestError).message;
  }
  throw new Error('expected the input to be rejected');
};

describe('parseNewRequest', () => {
  it('keeps trimmed fields and drops empty optional ones', () => {
    expect(
      parseNewRequest({
        recipientName: '  Asha Rao ',
        credential: 'Bonafide letter',
        email: '',
        phone: ' +91 98765 43210 ',
        note: '   ',
      }),
    ).toEqual({
      recipientName: 'Asha Rao',
      credential: 'Bonafide letter',
      phone: '+91 98765 43210',
    });
  });

  it('asks for the two required fields', () => {
    expect(invalid(() => parseNewRequest({ credential: 'x' }))).toMatch(/Recipient name/);
    expect(invalid(() => parseNewRequest({ recipientName: 'x', credential: '  ' }))).toMatch(
      /Credential/,
    );
    expect(invalid(() => parseNewRequest(null))).toMatch(/details/);
  });

  it('rejects malformed contacts, wrong types and over-long text', () => {
    const base = { recipientName: 'A', credential: 'B' };
    expect(invalid(() => parseNewRequest({ ...base, email: 'nope' }))).toMatch(/email/);
    expect(invalid(() => parseNewRequest({ ...base, phone: 'call me' }))).toMatch(/phone/);
    expect(invalid(() => parseNewRequest({ ...base, note: 5 }))).toMatch(/text/);
    expect(invalid(() => parseNewRequest({ ...base, recipientName: 'x'.repeat(121) }))).toMatch(
      /too long/,
    );
  });
});

describe('parseMove', () => {
  it('accepts a known column and a whole position', () => {
    expect(parseMove({ id: 'abc', to: 'ready', toIndex: 2 })).toEqual({
      id: 'abc',
      to: 'ready',
      toIndex: 2,
    });
  });

  it('rejects anything else, including ids that could address another path', () => {
    expect(() => parseMove({ id: 'a/b', to: 'ready', toIndex: 0 })).toThrow(RequestError);
    expect(() => parseMove({ id: '', to: 'ready', toIndex: 0 })).toThrow(RequestError);
    expect(() => parseMove({ id: 'a', to: 'archive', toIndex: 0 })).toThrow(RequestError);
    expect(() => parseMove({ id: 'a', to: 'new', toIndex: -1 })).toThrow(RequestError);
    expect(() => parseMove({ id: 'a', to: 'new', toIndex: 1.5 })).toThrow(RequestError);
    expect(() => parseMove(undefined)).toThrow(RequestError);
  });
});

describe('ownerKeyOf', () => {
  it('uses the institution for its staff and the person for everyone else', () => {
    expect(ownerKeyOf({ uid: 'u', role: 'inst_staff', institutionId: 'school' })).toBe(
      'inst:school',
    );
    expect(ownerKeyOf({ uid: 'u', role: 'individual', institutionId: null })).toBe('uid:u');
    // A super admin is not tied to an institution: their board is their own.
    expect(ownerKeyOf({ uid: 'root', role: 'super_admin', institutionId: null })).toBe('uid:root');
  });
});
