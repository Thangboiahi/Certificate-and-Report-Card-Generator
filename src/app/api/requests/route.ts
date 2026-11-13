/**
 * /api/requests — the Kanban board's credential requests (Phase 12, ADR-033).
 *
 *   GET   → the caller's board           POST  → add a request           PATCH → move a card
 *
 * Logic and responses: `src/lib/crm/handler.ts`.
 */
import { connection } from 'next/server';

import { handleCreateRequest, handleListRequests, handleMoveRequest } from '@/lib/crm/handler';

export async function GET(): Promise<Response> {
  await connection();
  return handleListRequests();
}

export async function POST(request: Request): Promise<Response> {
  await connection();
  return handleCreateRequest(request);
}

export async function PATCH(request: Request): Promise<Response> {
  await connection();
  return handleMoveRequest(request);
}
