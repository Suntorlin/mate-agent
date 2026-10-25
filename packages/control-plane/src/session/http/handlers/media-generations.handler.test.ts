import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mediaGenerationEventId,
  type MediaGenerationEvent,
} from "@open-inspect/shared/types/media-generation";
import { sandboxEventSchema } from "@open-inspect/shared/types/sandbox-events";
import type { ServerMessage } from "@open-inspect/shared/types/server-messages";
import { createNodeSqlStorage } from "../../../node/sqlite-storage";
import { EventRepository } from "../../event-repository";
import { initSchema } from "../../schema";
import { MediaGenerationsHandler } from "./media-generations.handler";

const NOW = 1_760_000_000_000;

const SUBMITTED = {
  generationId: "gen-1",
  status: "running",
  source: "mcp",
  mediaKind: "video",
  messageId: "msg-1",
  label: "coffee-shot03",
  prompt: "A barista pours latte art, slow motion",
  model: "seedance-1-0-pro",
  aspectRatio: "9:16",
  durationMs: 5000,
  credits: 120,
  costUsd: 0.5,
};

const MODERATED = {
  generationId: "gen-1",
  status: "failed",
  source: "mcp",
  mediaKind: "video",
  credits: 0,
  costUsd: 0,
  outputs: [
    {
      status: "failed",
      failure: { code: "moderation", message: "Prompt rejected by moderation" },
    },
  ],
  failure: {
    code: "moderation",
    message: "Prompt rejected by moderation",
    providerCode: "moderation",
    refunded: true,
    retryable: false,
  },
};

const SUCCEEDED = {
  generationId: "gen-1",
  status: "succeeded",
  source: "mcp",
  mediaKind: "video",
  credits: 120,
  costUsd: 0.5,
  outputs: [
    {
      status: "succeeded",
      url: "https://cdn.example.com/media/gen-1.mp4",
      mimeType: "video/mp4",
      width: 720,
      height: 1280,
    },
  ],
};

function post(body: unknown): Request {
  return new Request("http://internal/x", { method: "POST", body: JSON.stringify(body) });
}

describe("MediaGenerationsHandler", () => {
  let db: DatabaseSync;
  let events: EventRepository;
  let turn: { id: string } | null;
  let knownMessages: Set<string>;
  let knownArtifacts: Set<string>;
  let broadcasts: ServerMessage[];
  let now: number;
  let spendChanges: Array<{ messageId: string; costUsd: number }>;
  let handler: MediaGenerationsHandler;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    const storage = createNodeSqlStorage(db);
    initSchema(storage.sql);
    events = new EventRepository(storage.sql, storage.transactionSync);
    turn = { id: "msg-2" };
    knownMessages = new Set(["msg-1", "msg-2"]);
    knownArtifacts = new Set(["art-1"]);
    broadcasts = [];
    spendChanges = [];
    now = NOW;
    handler = new MediaGenerationsHandler(
      events,
      {
        getProcessingMessage: () => turn,
        // Only presence matters to the handler.
        getMessageById: (id: string) => (knownMessages.has(id) ? ({ id } as never) : null),
      },
      {
        getArtifactById: (id: string) => (knownArtifacts.has(id) ? ({ id } as never) : null),
      },
      { broadcast: (message) => broadcasts.push(message) },
      () => now,
      async (messageId) => {
        spendChanges.push({ messageId, costUsd: events.sumMediaGenerationCostUsd() });
      }
    );
  });

  afterEach(() => db.close());

  async function report(body: unknown) {
    const response = await handler.report(post(body));
    return {
      status: response.status,
      body: (await response.json()) as {
        event?: MediaGenerationEvent;
        recorded?: boolean;
        error?: string;
        issues?: string[];
      },
    };
  }

  function rows() {
    return db
      .prepare(
        `SELECT id, type, message_id, created_at, data FROM events ORDER BY timeline_sequence`
      )
      .all() as Array<{
      id: string;
      type: string;
      message_id: string;
      created_at: number;
      data: string;
    }>;
  }

  it("records a running generation on the turn the reporter named and shows it", async () => {
    const { status, body } = await report(SUBMITTED);

    expect(status).toBe(201);
    expect(body.recorded).toBe(true);
    const event = body.event!;
    expect(event).toEqual({
      type: "media_generation",
      generationId: "gen-1",
      messageId: "msg-1",
      status: "running",
      mediaKind: "video",
      source: "mcp",
      label: "coffee-shot03",
      prompt: "A barista pours latte art, slow motion",
      model: "seedance-1-0-pro",
      aspectRatio: "9:16",
      durationMs: 5000,
      credits: 120,
      costUsd: 0.5,
      startedAt: NOW,
      timestamp: NOW / 1000,
    });
    expect(sandboxEventSchema.parse(event)).toEqual(event);
    expect(rows()).toEqual([
      {
        id: mediaGenerationEventId("gen-1"),
        type: "media_generation",
        message_id: "msg-1",
        created_at: NOW,
        data: JSON.stringify(event),
      },
    ]);
    expect(broadcasts).toEqual([{ type: "sandbox_event", event }]);
  });

  it("puts a generation whose reporter does not know the turn on the running turn", async () => {
    const { messageId: _messageId, ...fromScript } = SUBMITTED;
    const { body } = await report({ ...fromScript, source: "api" });
    expect(body.event).toMatchObject({ messageId: "msg-2", source: "api" });

    const unknownTurn = await report({ ...SUBMITTED, generationId: "gen-2", messageId: "msg-x" });
    expect(unknownTurn.body.event?.messageId).toBe("msg-2");
  });

  it("merges a failure into the same row and keeps where the generation started", async () => {
    await report(SUBMITTED);
    now = NOW + 30_000;
    const { status, body } = await report(MODERATED);

    expect(status).toBe(200);
    expect(body.event).toMatchObject({
      generationId: "gen-1",
      messageId: "msg-1",
      status: "failed",
      model: "seedance-1-0-pro",
      label: "coffee-shot03",
      credits: 0,
      failure: MODERATED.failure,
      startedAt: NOW,
      finishedAt: NOW + 30_000,
      timestamp: (NOW + 30_000) / 1000,
    });
    const stored = rows();
    expect(stored).toHaveLength(1);
    expect(stored[0].created_at).toBe(NOW);
    expect(JSON.parse(stored[0].data)).toEqual(body.event);
    expect(
      broadcasts.map((message) => (message as { event: { status: string } }).event.status)
    ).toEqual(["running", "failed"]);
  });

  it("ignores a running report that arrives after the generation finished", async () => {
    await report(SUCCEEDED);
    const { status, body } = await report(SUBMITTED);

    expect(status).toBe(200);
    expect(body.recorded).toBe(false);
    expect(body.event?.status).toBe("succeeded");
    expect(broadcasts).toHaveLength(1);
    expect(JSON.parse(rows()[0].data).status).toBe("succeeded");
  });

  it("counts each generation's cost as session spend, held then net of refunds", async () => {
    await report(SUBMITTED);
    await report({ ...SUBMITTED, generationId: "gen-2", credits: 600, costUsd: 2.5 });
    expect(events.sumMediaGenerationCostUsd()).toBe(3);

    // A re-poll with the same cost changes nothing the budget has to hear.
    await report(SUCCEEDED);
    // The first one failed and was refunded; the second settled lower than it held.
    await report(MODERATED);
    await report({ ...SUCCEEDED, generationId: "gen-2", credits: 580, costUsd: 2.25 });

    expect(events.sumMediaGenerationCostUsd()).toBe(2.25);
    expect(spendChanges).toEqual([
      { messageId: "msg-1", costUsd: 0.5 },
      { messageId: "msg-1", costUsd: 3 },
      { messageId: "msg-1", costUsd: 2.5 },
      { messageId: "msg-1", costUsd: 2.25 },
    ]);
  });

  it("tells the budget about the cost only once it is in the generation's row", async () => {
    // A report with no cost (a voiceover's first one) has none to count yet; credits alone,
    // which the product only shows, count nothing.
    await report({ generationId: "tts-1", status: "running", source: "api", mediaKind: "audio" });
    await report({
      generationId: "tts-2",
      status: "running",
      source: "mcp",
      mediaKind: "audio",
      credits: 9,
    });
    expect(spendChanges).toEqual([]);

    await report({
      generationId: "tts-1",
      status: "succeeded",
      source: "api",
      credits: 9,
      costUsd: 0.125,
      outputs: [{ status: "succeeded", url: "https://cdn.example.com/tts-1.mp3" }],
    });
    expect(spendChanges).toEqual([{ messageId: "msg-2", costUsd: 0.125 }]);
  });

  it("tells the budget nothing about a report that was refused", async () => {
    expect((await report({ ...SUBMITTED, status: "failed" })).status).toBe(400);
    expect((await report({ ...SUBMITTED, mediaKind: undefined, generationId: "g-x" })).status).toBe(
      400
    );
    expect(spendChanges).toEqual([]);
  });

  it("keeps a generation running on a success that names no output", async () => {
    await report(SUBMITTED);
    // A status poll that knows only the outcome: nothing to show yet.
    const poll = await report({
      generationId: "gen-1",
      status: "succeeded",
      source: "mcp",
      credits: 110,
    });
    expect(poll.body.recorded).toBe(true);
    expect(poll.body.event).toMatchObject({ status: "running", credits: 110 });
    expect(poll.body.event?.finishedAt).toBeUndefined();
    expect(poll.body.event?.outputs).toBeUndefined();

    // The result brings the outputs and finishes it.
    now = NOW + 30_000;
    const result = await report(SUCCEEDED);
    expect(result.body.event).toMatchObject({
      status: "succeeded",
      finishedAt: NOW + 30_000,
      outputs: [{ url: SUCCEEDED.outputs[0].url }],
    });
    // The same poll afterwards keeps what the card shows.
    const again = await report({ generationId: "gen-1", status: "succeeded", source: "mcp" });
    expect(again.body.event).toMatchObject({
      status: "succeeded",
      outputs: [{ url: SUCCEEDED.outputs[0].url }],
    });
    for (const row of rows()) {
      const stored = JSON.parse(row.data) as MediaGenerationEvent;
      expect(stored.status !== "succeeded" || (stored.outputs?.length ?? 0) > 0).toBe(true);
    }
  });

  it("does not turn a failed generation into an empty success", async () => {
    await report(MODERATED);
    const { body } = await report({ generationId: "gen-1", status: "succeeded", source: "mcp" });
    expect(body.recorded).toBe(false);
    expect(body.event).toMatchObject({ status: "failed", failure: { code: "moderation" } });
  });

  it("does not let a reasonless failure replace one that had a reason", async () => {
    await report(MODERATED);
    const { body } = await report({
      generationId: "gen-1",
      status: "failed",
      source: "mcp",
      failure: { code: "unknown", message: "The generation failed; its result has the reason." },
    });
    expect(body.event?.failure?.code).toBe("moderation");
  });

  it("links an uploaded artifact to the output it is", async () => {
    await report(SUBMITTED);
    await report(SUCCEEDED);
    const { body } = await report({
      generationId: "gen-1",
      status: "succeeded",
      source: "mcp",
      artifactId: "art-1",
      outputIndex: 0,
    });
    expect(body.event).toMatchObject({
      status: "succeeded",
      artifactId: "art-1",
      outputs: [{ url: SUCCEEDED.outputs[0].url, artifactId: "art-1" }],
    });

    // A later re-poll of the same result keeps the link.
    const repoll = await report(SUCCEEDED);
    expect(repoll.body.event?.outputs?.[0].artifactId).toBe("art-1");
    expect(repoll.body.event?.artifactId).toBe("art-1");
  });

  it("refuses an artifact that is not the session's", async () => {
    await report(SUCCEEDED);
    const { status, body } = await report({
      generationId: "gen-1",
      status: "succeeded",
      source: "mcp",
      artifactId: "art-elsewhere",
    });
    expect(status).toBe(400);
    expect(body.error).toContain("art-elsewhere");
  });

  it("needs the media kind of a generation it has not seen", async () => {
    const { mediaKind: _kind, ...withoutKind } = SUCCEEDED;
    const { status, body } = await report(withoutKind);
    expect(status).toBe(400);
    expect(body.issues).toEqual(["mediaKind: required for a generation this session has not seen"]);
    expect(rows()).toEqual([]);

    await report(SUBMITTED);
    expect((await report(withoutKind)).status).toBe(200);
  });

  it("refuses a new generation outside a turn but still finishes a known one", async () => {
    await report(SUBMITTED);
    turn = null;
    knownMessages.clear();
    expect((await report(SUCCEEDED)).status).toBe(200);
    const late = await report({ ...SUBMITTED, generationId: "gen-9" });
    expect(late.status).toBe(409);
  });

  it("refuses a malformed report with issues the reporter can read", async () => {
    const { status, body } = await report({
      generationId: "gen 1",
      status: "failed",
      source: "mcp",
      mediaKind: "video",
      type: "question",
    });
    expect(status).toBe(400);
    expect(body.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("generationId"),
        // The sandbox reports; it never names the event type.
        expect.stringContaining('"type"'),
      ])
    );
    expect(rows()).toEqual([]);
    expect(
      (await handler.report(new Request("http://internal/x", { method: "POST", body: "{" }))).status
    ).toBe(400);
  });
});
