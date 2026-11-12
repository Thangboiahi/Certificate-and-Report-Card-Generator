import { describe, expect, it } from 'vitest';

import type { CredentialRequest } from '@/types/crm';

import { applyMove, toColumns } from './board';

const card = (id: string, stage: CredentialRequest['stage']): CredentialRequest => ({
  id,
  stage,
  recipientName: id,
  credential: 'Certificate',
  updatedAt: 0,
});

const board = () => toColumns([card('a', 'new'), card('b', 'new'), card('c', 'ready')]);

describe('Kanban board state', () => {
  it('groups requests by stage, keeping their order, with every column present', () => {
    const columns = board();
    expect(columns.new.map((c) => c.id)).toEqual(['a', 'b']);
    expect(columns.ready.map((c) => c.id)).toEqual(['c']);
    expect(columns.pending_data).toEqual([]);
    expect(columns.issued).toEqual([]);
  });

  it('moves a card to another column, updating its stage and time', () => {
    const before = board();
    const next = applyMove(before, { from: 'new', fromIndex: 1, to: 'issued', toIndex: 0 }, 42)!;
    expect(next.new.map((c) => c.id)).toEqual(['a']);
    expect(next.issued).toEqual([{ ...card('b', 'issued'), updatedAt: 42 }]);
    expect(before.new).toHaveLength(2); // not mutated
  });

  it('reorders within a column without touching the card', () => {
    const next = applyMove(board(), { from: 'new', fromIndex: 0, to: 'new', toIndex: 1 }, 42)!;
    expect(next.new.map((c) => c.id)).toEqual(['b', 'a']);
    expect(next.new[1]!.updatedAt).toBe(0);
  });

  it('ignores drops in place and unknown positions', () => {
    expect(applyMove(board(), { from: 'new', fromIndex: 0, to: 'new', toIndex: 0 })).toBeNull();
    expect(applyMove(board(), { from: 'issued', fromIndex: 3, to: 'new', toIndex: 0 })).toBeNull();
  });
});
