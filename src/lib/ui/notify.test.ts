import { describe, expect, it } from 'vitest';

import { AiError } from '@/lib/ai/schema';

import { ApiError, errorMessage, readApiError } from './notify';

describe('errorMessage', () => {
  it('shows the server-written message of an ApiError', () => {
    expect(errorMessage(new ApiError('Not enough credits.', 402))).toBe('Not enough credits.');
  });

  it('shows messages written for people by our own error classes', () => {
    expect(errorMessage(new AiError('AI_UNAVAILABLE', 'The AI is busy. Try again.'))).toBe(
      'The AI is busy. Try again.',
    );
  });

  it('translates Firebase permission and index errors into plain words', () => {
    expect(errorMessage({ code: 'permission-denied' })).toMatch(/permission/i);
    expect(errorMessage({ code: 'failed-precondition' })).toMatch(/prepared/i);
  });

  it('never leaks raw runtime error text', () => {
    expect(errorMessage(new TypeError('Failed to fetch'))).toBe('Something went wrong. Try again.');
    expect(errorMessage(new Error('x at /srv/app.js:1'), 'Custom fallback')).toBe(
      'Custom fallback',
    );
    expect(errorMessage(undefined)).toBe('Something went wrong. Try again.');
  });
});

describe('readApiError', () => {
  it('reads { error: { code, message } } bodies', async () => {
    const response = new Response(JSON.stringify({ error: { code: 'X', message: 'Nope.' } }), {
      status: 400,
    });
    const error = await readApiError(response);
    expect(error).toMatchObject({ message: 'Nope.', status: 400, code: 'X' });
  });

  it('falls back to a status-based message when the body is not JSON', async () => {
    expect((await readApiError(new Response('<html>', { status: 403 }))).message).toMatch(
      /permission/i,
    );
    expect((await readApiError(new Response('', { status: 401 }))).message).toMatch(/sign in/i);
    expect((await readApiError(new Response('', { status: 502 }))).message).toMatch(/try again/i);
  });
});
