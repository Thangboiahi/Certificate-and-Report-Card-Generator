/**
 * Ordering inside a Kanban column. Every card stores a number (`order`); a column reads top to
 * bottom by ascending order. Dropping a card between two others gives it the midpoint, so a move
 * rewrites one document, not the whole column.
 */

export const ORDER_STEP = 1024;

/**
 * The `order` for a card dropped at `index` of a column whose other cards (the moved card
 * excluded) have the ascending `orders`.
 */
export function orderForIndex(orders: readonly number[], index: number): number {
  const at = Math.min(Math.max(Math.trunc(index), 0), orders.length);
  const before = orders[at - 1];
  const after = orders[at];
  if (before === undefined && after === undefined) return 0;
  if (before === undefined) return after! - ORDER_STEP;
  if (after === undefined) return before + ORDER_STEP;
  return (before + after) / 2;
}

/** True when neighbours have drifted so close that the midpoint would collide with one of them. */
export function needsRebalance(orders: readonly number[]): boolean {
  for (let i = 1; i < orders.length; i++) {
    if (orders[i]! - orders[i - 1]! < 1e-6) return true;
  }
  return false;
}

/** Fresh, evenly spaced orders for a column of `count` cards. */
export function evenOrders(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i * ORDER_STEP);
}
