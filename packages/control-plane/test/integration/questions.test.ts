import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";
import {
  queryDO,
  routeRequest,
  seedMessage,
  seedSandboxAuthHash,
  serviceRequestHeaders,
} from "./helpers";

const BASE = "https://test.local";
// Two users signed in to the product; its backend (the app service) relays each as the actor.
const ALICE = "app:uid-alice";
const BOB = "app:uid-bob";
const SANDBOX_TOKEN = "questions-sandbox-token";
const TURN = "msg-turn-1";

const CARD = {
  title: "节奏想要哪种？",
  kind: "single",
  options: [
    { value: "keep", title: "照原片节奏" },
    { value: "fast", title: "更快" },
  ],
  allowOther: true,
  secondary: [{ value: "more", label: "换一批" }],
};

async function call(
  as: string | { sandboxToken: string },
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<Response> {
  const url = `${BASE}${path}`;
  const method = options.method ?? "GET";
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers =
    typeof as === "string"
      ? await serviceRequestHeaders(url, { method, body, service: "app", actor: as })
      : {
          Authorization: `Bearer ${as.sandboxToken}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        };
  return routeRequest(
    new Request(url, { method, headers, body }),
    { ...env, TEAMS_ENFORCEMENT: "on", DEFAULT_SESSION_VISIBILITY: "private" } as typeof env,
    createExecutionContext()
  );
}

/** Alice's session, with its sandbox connected and a turn running. */
async function aliceSessionMidTurn() {
  const created = await call(ALICE, "/sessions", {
    method: "POST",
    body: { title: "Cut", model: "anthropic/claude-haiku-4-5" },
  });
  expect(created.status).toBe(201);
  const { sessionId } = await created.json<{ sessionId: string }>();
  const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
  await seedSandboxAuthHash(stub, { authToken: SANDBOX_TOKEN, sandboxId: "sandbox-alice" });
  const [owner] = await queryDO<{ id: string }>(stub, "SELECT id FROM participants LIMIT 1");
  await seedMessage(stub, {
    id: TURN,
    authorId: owner.id,
    content: "帮我剪个预告",
    source: "web",
    status: "processing",
    createdAt: Date.now(),
    startedAt: Date.now(),
  });
  return { sessionId, stub };
}

async function events(sessionId: string, type: string) {
  const response = await call(ALICE, `/sessions/${sessionId}/events?type=${type}`);
  expect(response.status).toBe(200);
  return (await response.json<{ events: { data: Record<string, unknown> }[] }>()).events;
}

describe("questions", () => {
  beforeEach(cleanD1Tables);

  it("shows the agent's card, takes the owner's answer once, and queues it as her prompt", async () => {
    const { sessionId, stub } = await aliceSessionMidTurn();
    const sandbox = { sandboxToken: SANDBOX_TOKEN };

    // The agent asks; a card it cannot show comes back with what to fix.
    const invalid = await call(sandbox, `/sessions/${sessionId}/questions`, {
      method: "POST",
      body: { title: "二选一", kind: "binary", options: [CARD.options[0]] },
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      issues: ["options: a binary question has exactly 2 options"],
    });
    const asked = await call(sandbox, `/sessions/${sessionId}/questions`, {
      method: "POST",
      body: CARD,
    });
    expect(asked.status).toBe(201);
    const { questionId, messageId } = await asked.json<{
      questionId: string;
      messageId: string;
    }>();
    expect(messageId).toBe(TURN);
    expect((await events(sessionId, "question")).map((event) => event.data)).toEqual([
      expect.objectContaining({ type: "question", questionId, messageId: TURN, ...CARD }),
    ]);

    // Only Alice answers: Bob cannot even see the session, and the app
    // service needs someone to act for.
    const answer = (body: unknown, id = questionId) => ({ method: "POST", body, id });
    const post = (as: string, request: ReturnType<typeof answer>) =>
      call(as, `/sessions/${sessionId}/questions/${request.id}/answer`, request);
    expect((await post(BOB, answer({ action: "submit", value: "keep" }))).status).toBe(404);
    expect((await post(ALICE, answer({ action: "submit", value: "slow" }))).status).toBe(400);
    expect((await post(ALICE, answer({ action: "dismiss" }, "q_missing"))).status).toBe(404);

    const answered = await post(ALICE, answer({ action: "submit", value: "keep" }));
    expect(answered.status).toBe(200);
    const queued = await answered.json<{ messageId: string; status: string }>();
    expect(queued).toMatchObject({ questionId, status: "queued" });

    const [prompt] = await queryDO<{ content: string; status: string }>(
      stub,
      "SELECT content, status FROM messages WHERE id = ?",
      queued.messageId
    );
    expect(prompt).toEqual({
      content: `[回答 ${questionId}「节奏想要哪种？」] 选了：照原片节奏（keep）`,
      // The asking turn is still running, so the answer waits its turn.
      status: "pending",
    });
    expect((await events(sessionId, "question_answered")).map((event) => event.data)).toEqual([
      expect.objectContaining({
        type: "question_answered",
        questionId,
        messageId: TURN,
        answerMessageId: queued.messageId,
        action: "submit",
        value: "keep",
      }),
    ]);

    const again = await post(ALICE, answer({ action: "dismiss" }));
    expect(again.status).toBe(409);
    await expect(again.json()).resolves.toMatchObject({ code: "QUESTION_ALREADY_ANSWERED" });
  });
});
