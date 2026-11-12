/** Pure Kanban board state: grouping requests into columns and applying a drop. */
import { REQUEST_STAGES, type CredentialRequest, type RequestStage } from '@/types/crm';

export type Columns = Record<RequestStage, CredentialRequest[]>;

/** Groups requests into columns, keeping the given order inside each column. */
export function toColumns(requests: readonly CredentialRequest[]): Columns {
  const columns = Object.fromEntries(
    REQUEST_STAGES.map((stage) => [stage, []]),
  ) as unknown as Columns;
  for (const request of requests) columns[request.stage].push(request);
  return columns;
}

/** Applies a drop to the columns. Pure; returns `null` when nothing changed. */
export function applyMove(
  columns: Columns,
  move: { from: RequestStage; fromIndex: number; to: RequestStage; toIndex: number },
  now = Date.now(),
): Columns | null {
  if (move.from === move.to && move.fromIndex === move.toIndex) return null;
  const source = [...columns[move.from]];
  const [card] = source.splice(move.fromIndex, 1);
  if (!card) return null;
  const moved = move.from === move.to ? card : { ...card, stage: move.to, updatedAt: now };
  const target = move.from === move.to ? source : [...columns[move.to]];
  target.splice(move.toIndex, 0, moved);
  return { ...columns, [move.from]: source, [move.to]: target };
}
