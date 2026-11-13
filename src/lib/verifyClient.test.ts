import { describe, expect, it, vi } from 'vitest';

import type { DataRow } from '@/lib/template';
import { MAX_MINT_PER_REQUEST } from '@/lib/verify/limits';

import { guessNameColumn, premintVerification } from './verifyClient';

const ID = (n: number) => String(n).padStart(43, 'a');

/** A fake server: mints sequential ids and records what it was asked. */
function fakeServer() {
  let counter = 0;
  const calls: { credentialName: string; recipientNames: (string | null)[] }[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    const items = (body.recipientNames as unknown[]).map(() => {
      const id = ID(++counter);
      return { id, url: `https://app.example.in/verify/${id}` };
    });
    return Response.json({ items });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe('premintVerification', () => {
  it('adds an id and an address to every row, in order, without changing the input', async () => {
    const server = fakeServer();
    const rows: DataRow[] = [{ Name: 'Asha' }, { Name: 'Ravi' }, { Name: '' }];
    const out = await premintVerification({
      rows,
      credentialName: 'Class 10 certificate',
      nameColumn: 'Name',
      fetchImpl: server.fetchImpl,
    });
    expect(out.map((row) => row.verification_id)).toEqual([ID(1), ID(2), ID(3)]);
    expect(out[1]!.verification_url).toBe(`https://app.example.in/verify/${ID(2)}`);
    expect(out[0]!.Name).toBe('Asha');
    expect(rows[0]).toEqual({ Name: 'Asha' });
    expect(server.calls).toEqual([
      { credentialName: 'Class 10 certificate', recipientNames: ['Asha', 'Ravi', null] },
    ]);
  });

  it('records no names when there is no name column', async () => {
    const server = fakeServer();
    await premintVerification({
      rows: [{ Roll: '1' }],
      credentialName: 'C',
      nameColumn: null,
      fetchImpl: server.fetchImpl,
    });
    expect(server.calls[0]!.recipientNames).toEqual([null]);
  });

  it('does not mint again for rows that already have an id (a second run reuses them)', async () => {
    const server = fakeServer();
    const first = await premintVerification({
      rows: [{ Name: 'A' }, { Name: 'B' }],
      credentialName: 'C',
      nameColumn: 'Name',
      fetchImpl: server.fetchImpl,
    });
    const second = await premintVerification({
      rows: [...first, { Name: 'C' }],
      credentialName: 'C',
      nameColumn: 'Name',
      fetchImpl: server.fetchImpl,
    });
    expect(second.slice(0, 2)).toEqual(first);
    expect(second[2]!.verification_id).toBe(ID(3));
    expect(server.calls.map((call) => call.recipientNames.length)).toEqual([2, 1]);
  });

  it('asks in chunks the server accepts', async () => {
    const server = fakeServer();
    const rows = Array.from({ length: MAX_MINT_PER_REQUEST + 5 }, (_, i) => ({ Name: `n${i}` }));
    const out = await premintVerification({
      rows,
      credentialName: 'C',
      nameColumn: 'Name',
      fetchImpl: server.fetchImpl,
    });
    expect(server.calls.map((call) => call.recipientNames.length)).toEqual([
      MAX_MINT_PER_REQUEST,
      5,
    ]);
    expect(new Set(out.map((row) => row.verification_id)).size).toBe(rows.length);
  });

  it('surfaces the server’s refusal instead of producing rows without ids', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { error: { code: 'UNAUTHENTICATED', message: 'Sign in first.' } },
        { status: 401 },
      ),
    ) as unknown as typeof fetch;
    await expect(
      premintVerification({
        rows: [{ Name: 'A' }],
        credentialName: 'C',
        nameColumn: 'Name',
        fetchImpl,
      }),
    ).rejects.toMatchObject({ message: 'Sign in first.', status: 401 });
  });

  it('rejects a reply with the wrong number of ids', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ items: [] })) as unknown as typeof fetch;
    await expect(
      premintVerification({
        rows: [{ Name: 'A' }],
        credentialName: 'C',
        nameColumn: 'Name',
        fetchImpl,
      }),
    ).rejects.toThrow(/wrong number/);
  });
});

describe('guessNameColumn', () => {
  it('prefers a plain name column, then any column containing "name"', () => {
    expect(guessNameColumn([{ Roll: 1, Name: 'A', 'Father Name': 'B' }])).toBe('Name');
    expect(guessNameColumn([{ Roll: 1, 'Student Name': 'A' }])).toBe('Student Name');
    expect(guessNameColumn([{ Roll: 1 }])).toBeNull();
    expect(guessNameColumn([])).toBeNull();
  });
});
