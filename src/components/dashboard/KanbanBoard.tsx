'use client';

/**
 * Four-column drag-and-drop board for credential requests (`@hello-pangea/dnd`):
 * New Requests → Pending User Data → Ready to Issue → Issued.
 *
 * - Mouse: drag a card. Touch: press and hold a card briefly, then drag. Keyboard: focus a card,
 *   Space to lift, arrow keys to move, Space to drop, Escape to cancel (announced to screen
 *   readers by the library).
 * - On phones the columns sit side by side in a horizontally scrolling, snapping strip; from `lg`
 *   up all four are visible.
 * - The board updates at once (optimistic). `onMove` persists the move; if it rejects, the card
 *   returns to where it was and an error is shown.
 */
import { DragDropContext, Draggable, Droppable, type DropResult } from '@hello-pangea/dnd';
import { Mail, MessageCircle, StickyNote } from 'lucide-react';
import { useState } from 'react';

import { applyMove, toColumns, type Columns } from '@/lib/crm/board';
import { cn } from '@/lib/utils/cn';
import {
  REQUEST_STAGES,
  STAGE_LABELS,
  type CredentialRequest,
  type RequestMove,
  type RequestStage,
} from '@/types/crm';

const STAGE_ACCENT: Record<RequestStage, string> = {
  new: 'bg-sky-500',
  pending_data: 'bg-amber-500',
  ready: 'bg-violet-500',
  issued: 'bg-emerald-500',
};

const relative = new Intl.RelativeTimeFormat('en-IN', { numeric: 'auto' });
function age(updatedAt: number, now: number): string {
  const minutes = Math.round((updatedAt - now) / 60_000);
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour');
  return relative.format(Math.round(hours / 24), 'day');
}

export interface KanbanBoardProps {
  /** Initial cards; the board keeps its own order afterwards. */
  initialRequests: readonly CredentialRequest[];
  /** Persists a move. A rejected promise rolls the move back. */
  onMove?: (move: RequestMove) => void | Promise<void>;
  /** Reference time for "2 hours ago"; pass the server's render time to avoid hydration drift. */
  renderedAt?: number;
  className?: string;
}

export function KanbanBoard({ initialRequests, onMove, renderedAt, className }: KanbanBoardProps) {
  const [columns, setColumns] = useState<Columns>(() => toColumns(initialRequests));
  const [error, setError] = useState<string | null>(null);
  // Fixed at mount so server and client render the same relative times.
  const [now] = useState(() => renderedAt ?? Date.now());

  function handleDragEnd(result: DropResult) {
    const { source, destination, draggableId } = result;
    if (!destination) return;
    const from = source.droppableId as RequestStage;
    const to = destination.droppableId as RequestStage;
    const previous = columns;
    const next = applyMove(columns, {
      from,
      fromIndex: source.index,
      to,
      toIndex: destination.index,
    });
    if (!next) return;
    setColumns(next);
    setError(null);
    if (!onMove) return;
    Promise.resolve(onMove({ id: draggableId, from, to, toIndex: destination.index })).catch(
      (cause: unknown) => {
        console.error('Could not save the move', cause);
        setColumns(previous);
        setError('That move could not be saved, so it was undone. Try again.');
      },
    );
  }

  return (
    <div className={cn('flex flex-col gap-3', className)} data-testid="kanban-board">
      {error && (
        <p
          role="alert"
          className="rounded-xl bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
        >
          {error}
        </p>
      )}
      <DragDropContext onDragEnd={handleDragEnd}>
        <div className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-2 lg:mx-0 lg:grid lg:grid-cols-4 lg:overflow-visible lg:px-0">
          {REQUEST_STAGES.map((stage) => (
            <section
              key={stage}
              aria-labelledby={`stage-${stage}`}
              className="flex w-[82vw] max-w-80 shrink-0 snap-start flex-col rounded-2xl bg-neutral-100 p-2 sm:w-72 lg:w-auto lg:max-w-none dark:bg-neutral-900"
            >
              <header className="flex items-center gap-2 px-2 pt-1 pb-2">
                <span className={cn('size-2 rounded-full', STAGE_ACCENT[stage])} aria-hidden />
                <h3 id={`stage-${stage}`} className="flex-1 text-sm font-semibold">
                  {STAGE_LABELS[stage]}
                </h3>
                <span
                  className="rounded-full bg-white px-2 text-xs tabular-nums text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                  data-testid={`count-${stage}`}
                >
                  {columns[stage].length}
                </span>
              </header>
              <Droppable droppableId={stage}>
                {(provided, snapshot) => (
                  <ol
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    data-testid={`column-${stage}`}
                    className={cn(
                      'flex min-h-28 flex-1 flex-col gap-2 rounded-xl p-1 transition-colors',
                      snapshot.isDraggingOver && 'bg-blue-500/10',
                    )}
                  >
                    {columns[stage].map((request, index) => (
                      <Draggable key={request.id} draggableId={request.id} index={index}>
                        {(drag, dragSnapshot) => (
                          <li
                            ref={drag.innerRef}
                            {...drag.draggableProps}
                            {...drag.dragHandleProps}
                            data-testid="kanban-card"
                            data-request-id={request.id}
                            aria-label={`${request.recipientName}, ${request.credential}, ${STAGE_LABELS[stage]}`}
                            className={cn(
                              'rounded-xl border border-neutral-200 bg-white p-3 text-sm shadow-sm outline-none select-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:border-neutral-800 dark:bg-neutral-950',
                              dragSnapshot.isDragging &&
                                'rotate-1 shadow-lg ring-2 ring-blue-600/40',
                            )}
                          >
                            <p className="font-medium">{request.recipientName}</p>
                            <p className="text-xs text-neutral-500">{request.credential}</p>
                            {request.note && (
                              <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-300">
                                <StickyNote className="mt-0.5 size-3 shrink-0" aria-hidden />
                                {request.note}
                              </p>
                            )}
                            <div className="mt-2 flex items-center gap-2 text-neutral-400">
                              {request.phone && (
                                <MessageCircle
                                  className="size-3.5"
                                  aria-label="Has a WhatsApp number"
                                />
                              )}
                              {request.email && (
                                <Mail className="size-3.5" aria-label="Has an email address" />
                              )}
                              <span className="ml-auto text-[11px]">
                                {age(request.updatedAt, now)}
                              </span>
                            </div>
                          </li>
                        )}
                      </Draggable>
                    ))}
                    {provided.placeholder}
                    {columns[stage].length === 0 && !snapshot.isDraggingOver && (
                      <li className="rounded-xl border border-dashed border-neutral-300 p-4 text-center text-xs text-neutral-400 dark:border-neutral-700">
                        Drop requests here
                      </li>
                    )}
                  </ol>
                )}
              </Droppable>
            </section>
          ))}
        </div>
      </DragDropContext>
    </div>
  );
}
