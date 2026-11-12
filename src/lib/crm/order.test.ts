import { describe, expect, it } from 'vitest';

import { evenOrders, needsRebalance, ORDER_STEP, orderForIndex } from './order';

describe('orderForIndex', () => {
  it('starts an empty column at zero', () => {
    expect(orderForIndex([], 0)).toBe(0);
    expect(orderForIndex([], 5)).toBe(0);
  });

  it('puts a card first, last or between neighbours', () => {
    const orders = [0, 1024, 2048];
    expect(orderForIndex(orders, 0)).toBe(-ORDER_STEP);
    expect(orderForIndex(orders, 1)).toBe(512);
    expect(orderForIndex(orders, 2)).toBe(1536);
    expect(orderForIndex(orders, 3)).toBe(2048 + ORDER_STEP);
  });

  it('clamps an index outside the column', () => {
    const orders = [10, 20];
    expect(orderForIndex(orders, -4)).toBe(10 - ORDER_STEP);
    expect(orderForIndex(orders, 99)).toBe(20 + ORDER_STEP);
  });

  it('keeps the card at the requested position among the others', () => {
    let column = evenOrders(4);
    const dropAtOne = () => {
      // Always drop at index 1: the gap halves each time.
      column = [column[0]!, orderForIndex(column, 1), ...column.slice(1)];
    };
    for (let i = 0; i < 8; i++) dropAtOne();
    expect(column.slice().sort((a, b) => a - b)).toEqual(column);
    expect(needsRebalance(column)).toBe(false);
    // Keep halving the same gap and the numbers run out of room: that is the cue to respace.
    for (let i = 0; i < 30; i++) dropAtOne();
    expect(needsRebalance(column)).toBe(true);
  });
});

describe('needsRebalance', () => {
  it('flags neighbours that are practically equal', () => {
    expect(needsRebalance([0, 1, 2])).toBe(false);
    expect(needsRebalance([0, 1e-9, 2])).toBe(true);
    expect(needsRebalance([])).toBe(false);
  });
});
