import { toolCallIdentityKey } from "@open-inspect/shared/types/sandbox-events";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import {
  cardDismissedEventSchema,
  type CardDismissedEvent,
} from "@open-inspect/shared/types/session-cards";
import type { MediaGenerationEvent } from "@open-inspect/shared/types/media-generation";
import {
  eventTimelineCursorFromRow,
  type EventListCursor,
  type EventTimelineCursor,
} from "./event-cursor";
import type { SqlStorage, TransactionSync } from "./sql-storage";
import { eventRowSchema, SessionStorageIntegrityError, type EventRow } from "./types";

type TokenEvent = Extract<SandboxEvent, { type: "token" }>;
type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;
type ExecutionCompleteEvent = Extract<SandboxEvent, { type: "execution_complete" }>;
type UpsertableEventType = TokenEvent["type"] | ExecutionCompleteEvent["type"];

const NEXT_TIMELINE_SEQUENCE_SQL = "(SELECT COALESCE(MAX(timeline_sequence), 0) + 1 FROM events)";

/**
 * Data for creating an event. Type is open because sandboxes emit additional
 * event types beyond the shared EventType union.
 */
export interface CreateEventData {
  id: string;
  type: string;
  data: string;
  messageId: string | null;
  createdAt: number;
}

export interface ListEventPageOptions {
  cursor?: EventListCursor | null;
  limit: number;
  type?: string | null;
  messageId?: string | null;
}

export interface ListEventTimelinePageOptions {
  cursor?: EventTimelineCursor | null;
  excludeTypes?: string[];
  limit: number;
}

export interface EventPage {
  events: EventRow[];
  hasMore: boolean;
  nextCursor: EventTimelineCursor | null;
}

interface QueryEventPageOptions extends ListEventPageOptions {
  excludeTypes?: string[];
}

/** Persistence for events scoped to one session. */
export class EventRepository {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transactionSync: TransactionSync
  ) {}

  createEvent(data: CreateEventData): void {
    this.sql.exec(
      `INSERT INTO events (id, type, data, message_id, created_at, timeline_sequence)
       VALUES (?, ?, ?, ?, ?, ${NEXT_TIMELINE_SEQUENCE_SQL})`,
      data.id,
      data.type,
      data.data,
      data.messageId,
      data.createdAt
    );
  }

  /** Idempotent event recording for a lifecycle decision retried after reconstruction. */
  createEventIfAbsent(data: CreateEventData): boolean {
    const result = this.sql.exec(
      `INSERT INTO events (id, type, data, message_id, created_at, timeline_sequence)
       VALUES (?, ?, ?, ?, ?, ${NEXT_TIMELINE_SEQUENCE_SQL}) ON CONFLICT(id) DO NOTHING`,
      data.id,
      data.type,
      data.data,
      data.messageId,
      data.createdAt
    );
    result.toArray();
    return (result.rowsWritten ?? 0) > 0;
  }

  /** One event by id, or null when there is none. */
  getEventById(id: string): EventRow | null {
    const rows = this.sql.exec(`SELECT * FROM events WHERE id = ? LIMIT 1`, id).toArray();
    return rows.length > 0 ? parseEventRow(rows[0]) : null;
  }

  /**
   * Cards closed since the agent was last given a prompt, oldest first: the
   * `card_dismissed` events after the newest `user_message`. Dispatching a
   * prompt records its `user_message`, which marks everything before it as
   * told; a prompt whose send fails loses that row again, so its dismissals
   * stay pending for the retry.
   */
  listCardDismissalsSinceLastPrompt(): CardDismissedEvent[] {
    return this.sql
      .exec(
        `SELECT * FROM events
         WHERE type = 'card_dismissed'
           AND timeline_sequence > COALESCE(
             (SELECT MAX(timeline_sequence) FROM events WHERE type = 'user_message'), 0)
         ORDER BY timeline_sequence ASC`
      )
      .toArray()
      .flatMap((row) => {
        let data: unknown;
        try {
          data = JSON.parse(parseEventRow(row).data);
        } catch {
          return [];
        }
        const event = cardDismissedEventSchema.safeParse(data);
        return event.success ? [event.data] : [];
      });
  }

  createContextCompactionEvent(data: CreateEventData & { messageId: string }): void {
    this.transactionSync(() => {
      this.sql.exec(
        `UPDATE events SET id = ? WHERE id = ?`,
        `token:${data.messageId}:${data.id}`,
        `token:${data.messageId}`
      );
      this.createEvent(data);
    });
  }

  private upsertEventByMessageId<TType extends UpsertableEventType>(
    type: TType,
    messageId: string,
    event: Extract<SandboxEvent, { type: TType }>,
    createdAt: number,
    id = `${type}:${messageId}`,
    preserveCreatedAt = false
  ): void {
    this.sql.exec(
      `INSERT INTO events (id, type, data, message_id, created_at, timeline_sequence)
       VALUES (?, ?, ?, ?, ?, ${NEXT_TIMELINE_SEQUENCE_SQL})
       ON CONFLICT(id) DO UPDATE SET
         data = excluded.data,
         message_id = excluded.message_id,
         created_at = ${preserveCreatedAt ? "events.created_at" : "excluded.created_at"}`,
      id,
      type,
      JSON.stringify(event),
      messageId,
      createdAt
    );
  }

  upsertTokenEvent(messageId: string, event: TokenEvent, createdAt: number): void {
    const id = event.partId
      ? `token-part:${JSON.stringify([messageId, event.partId])}`
      : `token:${messageId}`;
    this.upsertEventByMessageId("token", messageId, event, createdAt, id, Boolean(event.partId));
  }

  /**
   * A message's stored text as SandboxStreamingEventHandler cut it: its
   * ordinary token row, its parts, and how many compactions it went through.
   */
  listTurnText(messageId: string): {
    text: string | null;
    parts: Array<{ partId: string; content: string }>;
    compactions: number;
  } {
    const rows = this.sql
      .exec(
        `SELECT * FROM events
         WHERE message_id = ? AND type IN ('token', 'context_compacted')
         ORDER BY timeline_sequence ASC`,
        messageId
      )
      .toArray()
      .map(parseEventRow);
    let text: string | null = null;
    let compactions = 0;
    const parts: Array<{ partId: string; content: string }> = [];
    for (const row of rows) {
      if (row.type === "context_compacted") {
        compactions += 1;
        continue;
      }
      let data: { content?: unknown; partId?: unknown };
      try {
        data = JSON.parse(row.data) as typeof data;
      } catch {
        continue;
      }
      if (typeof data.content !== "string") continue;
      if (row.id === `token:${messageId}`) text = data.content;
      else if (typeof data.partId === "string")
        parts.push({ partId: data.partId, content: data.content });
    }
    return { text, parts, compactions };
  }

  upsertToolCallEvent(messageId: string, event: ToolCallEvent, createdAt: number): void {
    const id = `tool_call:${toolCallIdentityKey(event)}`;
    this.sql.exec(
      `INSERT INTO events (id, type, data, message_id, created_at, timeline_sequence)
       VALUES (?, ?, ?, ?, ?, ${NEXT_TIMELINE_SEQUENCE_SQL})
       ON CONFLICT(id) DO UPDATE SET
         data = excluded.data,
         message_id = excluded.message_id`,
      id,
      event.type,
      JSON.stringify(event),
      messageId,
      createdAt
    );
  }

  upsertExecutionCompleteEvent(
    messageId: string,
    event: ExecutionCompleteEvent,
    createdAt: number
  ): void {
    this.upsertEventByMessageId("execution_complete", messageId, event, createdAt);
  }

  /**
   * A media generation's one row, created by its first report and rewritten by later ones. The
   * row keeps its turn, time and timeline position, so the generation stays where it started.
   */
  upsertMediaGenerationEvent(id: string, event: MediaGenerationEvent, createdAt: number): void {
    this.sql.exec(
      `INSERT INTO events (id, type, data, message_id, created_at, timeline_sequence)
       VALUES (?, ?, ?, ?, ?, ${NEXT_TIMELINE_SEQUENCE_SQL})
       ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      id,
      event.type,
      JSON.stringify(event),
      event.messageId,
      createdAt
    );
  }

  /**
   * USD the session's media generations hold or were charged: each generation's latest `costUsd`
   * (held while it runs, net of refunds once it finished). A generation is one row, rewritten by
   * every report of it, so a re-poll, a retry or a second reporter never counts it twice. A
   * session has tens of them, so they are summed here.
   */
  sumMediaGenerationCostUsd(): number {
    const rows = this.sql
      .exec(`SELECT data FROM events WHERE type = 'media_generation'`)
      .toArray() as Array<{ data: string }>;
    let total = 0;
    for (const row of rows) {
      try {
        const cost = (JSON.parse(row.data) as { costUsd?: unknown }).costUsd;
        if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) total += cost;
      } catch {
        // A row that does not parse has no cost to count.
      }
    }
    return total;
  }

  listEventPage(options: ListEventPageOptions): EventPage {
    return this.queryEventPage(options);
  }

  getEventTimelinePage(options: ListEventTimelinePageOptions): EventPage {
    const page = this.queryEventPage(options);
    return { ...page, events: [...page.events].reverse() };
  }

  private queryEventPage(options: QueryEventPageOptions): EventPage {
    let query = `SELECT * FROM events`;
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.type) {
      conditions.push(`type = ?`);
      params.push(options.type);
    }
    if (options.messageId) {
      conditions.push(`message_id = ?`);
      params.push(options.messageId);
    }
    if (options.excludeTypes?.length) {
      conditions.push(`type NOT IN (${options.excludeTypes.map(() => "?").join(", ")})`);
      params.push(...options.excludeTypes);
    }

    const cursor = options.cursor;
    if (cursor?.kind === "timeline") {
      if (cursor.sequence !== undefined) {
        conditions.push(`((created_at < ?) OR (created_at = ? AND timeline_sequence < ?))`);
        params.push(cursor.createdAt, cursor.createdAt, cursor.sequence);
      } else {
        conditions.push(`((created_at < ?) OR (created_at = ? AND id < ?))`);
        params.push(cursor.createdAt, cursor.createdAt, cursor.id);
      }
    } else if (cursor?.kind === "legacy") {
      conditions.push(`created_at < ?`);
      params.push(cursor.createdAt);
    }

    if (conditions.length > 0) query += ` WHERE ${conditions.join(" AND ")}`;

    const tieBreaker =
      cursor?.kind === "timeline" && cursor.sequence === undefined ? "id" : "timeline_sequence";
    query += ` ORDER BY created_at DESC, ${tieBreaker} DESC LIMIT ?`;
    params.push(options.limit + 1);

    const rows = this.sql
      .exec(query, ...params)
      .toArray()
      .map(parseEventRow);
    const hasMore = rows.length > options.limit;
    const events = hasMore ? rows.slice(0, options.limit) : rows;
    const nextCursor = events.length ? eventTimelineCursorFromRow(events[events.length - 1]) : null;
    return { events, hasMore, nextCursor };
  }
}

function parseEventRow(row: unknown): EventRow {
  const parsed = eventRowSchema.safeParse(row);
  if (parsed.success) return parsed.data;
  throw new SessionStorageIntegrityError("Malformed persisted event row");
}
