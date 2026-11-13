import { describe, expect, it } from 'vitest';

import { indexErrorOf } from './firestore-errors';

const LINK =
  'https://console.firebase.google.com/v1/r/project/demo-v6/firestore/indexes?create_composite=Cg9wcm9qZWN0cy9kZW1v';

describe('indexErrorOf', () => {
  it('finds the console link in a FAILED_PRECONDITION index error', () => {
    const cause = Object.assign(
      new Error(
        `9 FAILED_PRECONDITION: The query requires an index. You can create it here: ${LINK}`,
      ),
      { code: 9 },
    );
    expect(indexErrorOf(cause)).toEqual({ link: LINK });
  });

  it('drops punctuation after the link', () => {
    const cause = new Error(`9 FAILED_PRECONDITION: The query requires an index: ${LINK}.`);
    expect(indexErrorOf(cause)?.link).toBe(LINK);
  });

  it('still recognises an index error that carries no link', () => {
    const cause = Object.assign(new Error('The query requires an index.'), { code: 9 });
    expect(indexErrorOf(cause)).toEqual({ link: null });
  });

  it('ignores other failures', () => {
    expect(indexErrorOf(new Error('PERMISSION_DENIED: missing permissions'))).toBeNull();
    expect(indexErrorOf(Object.assign(new Error('deadline exceeded'), { code: 4 }))).toBeNull();
    expect(
      indexErrorOf(new Error('9 FAILED_PRECONDITION: transaction aborted by a conflict')),
    ).toBeNull();
    expect(indexErrorOf(undefined)).toBeNull();
  });
});
