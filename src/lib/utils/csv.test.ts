import { describe, expect, it } from 'vitest';

import { checkHeaders, parseCsvText } from './csv';

describe('parseCsvText', () => {
  it('reads headers and rows, trimming headers and dropping a BOM and blank lines', () => {
    const parsed = parseCsvText('\uFEFF Name ,Roll\nAsha,1\n\n"Rao, Bala",2\n');
    expect(parsed.headers).toEqual(['Name', 'Roll']);
    expect(parsed.rows).toEqual([
      { Name: 'Asha', Roll: '1' },
      { Name: 'Rao, Bala', Roll: '2' },
    ]);
    expect(parsed.errors).toEqual([]);
  });

  it('reports malformed rows with their line number', () => {
    const parsed = parseCsvText('Name,Roll\nAsha,1,extra\n');
    expect(parsed.errors[0]).toMatch(/^Row 2:/);
  });

  it('keeps Indian-script text intact', () => {
    expect(parseCsvText('नाम,कक्षा\nप्रियंका,10\n').rows).toEqual([
      { नाम: 'प्रियंका', कक्षा: '10' },
    ]);
  });
});

describe('checkHeaders', () => {
  it('lists missing headers and near matches', () => {
    expect(checkHeaders(['name', 'Roll ', 'Photo URL'], ['Name', 'Roll', 'Photo'])).toEqual({
      missing: ['Name', 'Photo'],
      nearMatches: { Name: 'name' },
    });
  });

  it('passes when everything is present', () => {
    expect(checkHeaders(['Name', 'Roll'], ['Roll']).missing).toEqual([]);
  });
});
