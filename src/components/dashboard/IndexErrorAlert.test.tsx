import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { indexErrorOf } from '@/lib/firestore-errors';

import { IndexErrorAlert } from './IndexErrorAlert';

// What Firestore really sends when a composite index is missing (project id shortened).
const LINK =
  'https://console.firebase.google.com/v1/r/project/my-project/firestore/indexes?create_composite=ClBwcm9qZWN0cy9teS1wcm9qZWN0L2RhdGFiYXNlcy8oZGVmYXVsdCkvY29sbGVjdGlvbkdyb3Vwcy92YXVsdF9pdGVtcy9pbmRleGVzL18QARoMCghvd25lclVpZBABGgwKCGlzc3VlZEF0EAIaDAoIX19uYW1lX18QAg';
const REAL_MESSAGE = `9 FAILED_PRECONDITION: The query requires an index. You can create it here: ${LINK}`;

describe('IndexErrorAlert', () => {
  it('shows the exact console link from the error, as a clickable link', () => {
    const error = indexErrorOf(Object.assign(new Error(REAL_MESSAGE), { code: 9 }))!;
    const html = renderToStaticMarkup(<IndexErrorAlert error={error} what="The vault" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain(`href="${LINK}"`);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('The vault needs a one-time database setup');
  });

  it('explains how to deploy the indexes when the error carried no link', () => {
    const html = renderToStaticMarkup(<IndexErrorAlert error={{ link: null }} what="The vault" />);
    expect(html).not.toContain('href=');
    expect(html).toContain('firestore:indexes');
  });
});
