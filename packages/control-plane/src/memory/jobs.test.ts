import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { USER_MEMORY_LIMITS } from "@open-inspect/shared/types/user-memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../db/session-index";
import type { JobDeps } from "../jobs";
import type { Logger } from "../logger";
import { openNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { fakeSessionRuntimeDispatch } from "../router.test-support";
import { SessionInternalPaths } from "../session/contracts";
import type { Env } from "../types";
import {
  cleanUserMemorySummary,
  USER_MEMORY_CONSOLIDATE_INTERVAL_MS,
  handleUserMemoryConsolidate,
} from "./consolidate";
import {
  USER_MEMORY_CONSOLIDATE_DELAY_MS,
  handleUserMemoryExtract,
  isTrivialUserMessage,
  normalizeExtractedOp,
  queueUserMemoryExtraction,
  saysMuchTheSame,
  type UserMemoryExtractJob,
} from "./extract";
import { USER_MEMORY_MODEL } from "./llm";
import { memoryServiceFor, seedUsers } from "./test-helpers";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../deploy/d1/migrations"
);

const OWNER = "user-1";
const SESSION = "session-1";
const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const FIXED_NOW = Date.UTC(2026, 9, 3, 12);
const DAY_MS = 24 * 60 * 60 * 1000;

const JOB: UserMemoryExtractJob = {
  version: 1,
  sessionId: SESSION,
  ownerUserId: OWNER,
  messageId: "message-1",
};

function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
}

/** A gateway answer in the Messages API shape. */
function modelAnswer(text: string, usage = { input_tokens: 900, output_tokens: 120 }) {
  return Response.json({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage,
  });
}

describe("user memory jobs", () => {
  let dir: string;
  let db: NodeSqlDatabase;
  const fetchMock = vi.fn<typeof fetch>();
  let turn: {
    user: string;
    agent: string;
    authorUserId?: string;
    missing?: boolean;
    startedAt?: number;
  };
  let broadcasts: Array<Record<string, unknown>>;
  let send: ReturnType<typeof vi.fn>;
  let log: Logger & Record<"info" | "warn" | "error", ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW);
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    dir = mkdtempSync(join(tmpdir(), "user-memory-jobs-"));
    db = openNodeSqlDatabase(join(dir, "global.db"), { migrationsDir: MIGRATIONS_DIR });
    await seedUsers(db, [OWNER]);
    turn = {
      user: "以后配音都用男声，字幕要黄色描边",
      agent: "好的，我用男声重新配了音，字幕改成黄色描边。咖啡新品视频已经导出。",
      authorUserId: OWNER,
    };
    broadcasts = [];
    send = vi.fn(async () => {});
    log = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    } as unknown as typeof log;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function env(overrides: Partial<Record<string, unknown>> = {}): Env {
    return {
      GATEWAY_URL: "https://gateway.example",
      GATEWAY_SECRET: SECRET,
      JOBS: { send },
      SESSION: fakeSessionRuntimeDispatch(async (request, sessionId) => {
        const url = new URL(request.url);
        if (url.pathname === SessionInternalPaths.userMemoryEvent) {
          broadcasts.push({ sessionId, ...((await request.json()) as object) });
          return Response.json({ ok: true });
        }
        if (url.pathname !== SessionInternalPaths.events)
          return new Response("no", { status: 500 });
        expect(url.searchParams.get("message_id")).toBe(JOB.messageId);
        if (url.searchParams.get("type") === "user_message") {
          return Response.json({
            hasMore: false,
            events: turn.missing
              ? []
              : [
                  {
                    id: `user_message:${JOB.messageId}`,
                    type: "user_message",
                    data: {
                      type: "user_message",
                      content: turn.user,
                      messageId: JOB.messageId,
                      timestamp: 1,
                      author: { participantId: "p1", userId: turn.authorUserId, name: "User" },
                    },
                    messageId: JOB.messageId,
                    createdAt: turn.startedAt ?? 1,
                  },
                ],
          });
        }
        return Response.json({
          hasMore: false,
          events: [
            {
              id: `token:${JOB.messageId}`,
              type: "token",
              data: { type: "token", content: turn.agent, messageId: JOB.messageId },
              messageId: JOB.messageId,
              createdAt: 2,
            },
          ],
        });
      }),
      ...overrides,
    } as unknown as Env;
  }

  function deps(overrides: Partial<Record<string, unknown>> = {}): JobDeps {
    return { env: env(overrides), db, log, correlation: { trace_id: "t", request_id: "r" } };
  }

  const delivery = { attempts: 1, maxAttempts: 3 };

  async function current() {
    const { service } = memoryServiceFor(db, { now: Date.now() });
    return (await service.list(OWNER)).entries;
  }

  describe("user_memory.extract", () => {
    it("applies what the user said and project records at once and the rest as pending, then tells the session", async () => {
      fetchMock.mockResolvedValue(
        modelAnswer(
          "```json\n" +
            JSON.stringify({
              ops: [
                { op: "set", key: "pref.voice", content: "配音用男声", said: true },
                { op: "set", key: "pref.captions", content: "字幕黄色描边", said: true },
                {
                  op: "set",
                  key: "project.2026-10-03.coffee",
                  content: "咖啡新品视频已导出",
                  said: false,
                },
              ],
            }) +
            "\n```"
        )
      );

      expect(await handleUserMemoryExtract(JOB, delivery, deps())).toBe("ack");

      expect(
        (await current()).map((entry) => `${entry.key}|${entry.status}|${entry.source}`).sort()
      ).toEqual([
        "pref.captions|active|extractor",
        "pref.voice|active|extractor",
        "project.2026-10-03.coffee|active|extractor",
      ]);
      expect(broadcasts).toEqual([
        expect.objectContaining({
          sessionId: SESSION,
          type: "memory_updated",
          batchId: "extract:message-1",
          source: "extractor",
        }),
      ]);
      expect(send).toHaveBeenCalledWith(
        {
          kind: "user_memory.consolidate",
          payload: { version: 1, ownerUserId: OWNER, sessionId: SESSION },
        },
        { delayMs: USER_MEMORY_CONSOLIDATE_DELAY_MS }
      );
      expect(log.info).toHaveBeenCalledWith(
        "user_memory.extracted",
        expect.objectContaining({
          model: "claude-haiku-4-5",
          input_tokens: 900,
          output_tokens: 120,
          latency_ms: expect.any(Number),
          applied: 3,
        })
      );
    });

    it("calls Haiku through the gateway as the user, with the turn and the memory", async () => {
      const { service } = memoryServiceFor(db, { now: Date.now() });
      await service.create(OWNER, { key: "pref.music", content: "Lo-fi music" });
      await service.update(OWNER, (await current())[0]!.id, { locked: true });
      await service.create(OWNER, { key: "profile.name", content: "Ada" });
      fetchMock.mockResolvedValue(modelAnswer('{"ops": []}'));

      await handleUserMemoryExtract(JOB, delivery, deps());

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://gateway.example/llm/v1/messages");
      const headers = new Headers(init?.headers);
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
      expect(headers.get("user-agent")).toMatch(/^agent-engine-control-plane\//);
      const claims = decodePayload(headers.get("x-api-key")!);
      expect(claims).toMatchObject({ sub: OWNER, sid: SESSION });
      expect(claims).not.toHaveProperty("scope");
      expect(Number(claims.exp) - Number(claims.iat)).toBe(600);
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        max_tokens: number;
        system: string;
        messages: Array<{ role: string; content: string }>;
      };
      expect(body).toMatchObject({ model: USER_MEMORY_MODEL, max_tokens: 1200 });
      expect(USER_MEMORY_MODEL).toBe("claude-haiku-4-5");
      expect(body.system).toContain("Today is Sat 2026-10-03.");
      expect(body.system).toContain("Next week: Mon 2026-10-05,");
      expect(body.system).toContain("Fri 2026-10-09");
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]!.content).toContain("pref.music (locked): Lo-fi music");
      expect(body.messages[0]!.content).toContain("profile.name (set by the user): Ada");
      expect(body.system).toContain("- profile.<field>: who the user is");
      expect(body.messages[0]!.content).toContain(`<user>${turn.user}</user>`);
      expect(body.messages[0]!.content).toContain(`<agent>${turn.agent}</agent>`);
      // Nothing durable: nothing written, nobody told.
      expect(broadcasts).toEqual([]);
      expect(send).not.toHaveBeenCalled();
    });

    it("does nothing the second time a turn is delivered", async () => {
      fetchMock.mockResolvedValue(
        modelAnswer(
          JSON.stringify({
            ops: [
              { op: "append", key: "project.2026-10-03.coffee", content: "导出完成", said: true },
            ],
          })
        )
      );
      expect(await handleUserMemoryExtract(JOB, delivery, deps())).toBe("ack");
      expect(await handleUserMemoryExtract(JOB, { ...delivery, attempts: 2 }, deps())).toBe("ack");

      expect(fetchMock).toHaveBeenCalledOnce();
      expect((await current()).map((entry) => entry.content)).toEqual(["导出完成"]);
      expect(log.info).toHaveBeenCalledWith(
        "user_memory.extract_skipped",
        expect.objectContaining({ reason: "done" })
      );
    });

    it("repairs an op with no op or a key that is not ASCII", () => {
      expect(
        normalizeExtractedOp({ key: "pref.voice", content: "Male voice", said: true })
      ).toEqual({ op: "set", key: "pref.voice", content: "Male voice", said: true });
      const first = normalizeExtractedOp({
        op: "set",
        key: "project.2026-10-03.新品预热",
        content: "新品预热片已交付",
      });
      expect(first?.key).toMatch(/^project\.2026-10-03\.item-[a-z0-9]{1,5}$/);
      expect(
        normalizeExtractedOp({ op: "append", key: "project.2026-10-03.新品预热", content: "定稿" })
          ?.key
      ).toBe(first?.key);
      expect(
        normalizeExtractedOp({ op: "set", key: "pref.配音-v2", content: "女声" })?.key
      ).toMatch(/^pref\.v2-[a-z0-9]{1,5}$/);
      expect(normalizeExtractedOp({ key: "pref.voice" })).toBeNull();
    });

    it("leaves alone what the user changed, undid or forgot since the turn began", async () => {
      const clock = { now: FIXED_NOW - 3_600_000 };
      const { service } = memoryServiceFor(db, clock);
      // An hour before the turn the user forgot their captions; the turn may bring them back.
      await service.applyOps(
        OWNER,
        [{ op: "set", key: "pref.captions", content: "Old captions" }],
        {
          kind: "user",
        }
      );
      await service.applyOps(OWNER, [{ op: "forget", key: "pref.captions" }], { kind: "user" });
      // During the turn the agent wrote the voice, and the user undid it at once.
      turn.startedAt = FIXED_NOW - 60_000;
      clock.now = FIXED_NOW - 30_000;
      const written = await service.applyOps(
        OWNER,
        [{ op: "set", key: "pref.voice", content: "Male voice", said: true }],
        { kind: "agent", sessionId: SESSION }
      );
      await service.undo(OWNER, written.batchId);
      fetchMock.mockResolvedValue(
        modelAnswer(
          JSON.stringify({
            ops: [
              { op: "set", key: "pref.voice", content: "Male voice", said: true },
              // The undone fact again, under another key.
              { op: "set", key: "pref.narration", content: "A male voice", said: true },
              { op: "set", key: "pref.captions", content: "Yellow captions", said: true },
            ],
          })
        )
      );

      expect(await handleUserMemoryExtract(JOB, delivery, deps())).toBe("ack");

      expect((await current()).map((entry) => `${entry.key}=${entry.content}`)).toEqual([
        "pref.captions=Yellow captions",
      ]);
      expect(log.info).toHaveBeenCalledWith(
        "user_memory.extracted",
        expect.objectContaining({ valid: 1, applied: 1, left_to_user: 2 })
      );
    });

    it("does not write again what the agent saved itself during the turn", async () => {
      const clock = { now: FIXED_NOW - 3_600_000 };
      const { service } = memoryServiceFor(db, clock);
      // Before the turn the agent saved a lesson; the turn may still restate it.
      await service.applyOps(
        OWNER,
        [{ op: "set", key: "lesson.hook", content: "开场三秒内出产品" }],
        { kind: "agent", sessionId: SESSION }
      );
      turn.startedAt = FIXED_NOW - 60_000;
      clock.now = FIXED_NOW - 30_000;
      const project =
        "小林口播（咖啡店主，竖版12.5s）文稿剪辑：删「我的建议就一句话」，「上个月」→「今年夏天」原声重配+veed 对口型，关字幕导出 11.6s 成片 v1。素材480积分。待反馈。";
      await service.applyOps(
        OWNER,
        [
          { op: "set", key: "project.2026-10-03.xiaolin-talk-edit", content: project },
          { op: "set", key: "pref.voice", content: "配音用男声", said: true },
        ],
        { kind: "agent", sessionId: SESSION }
      );
      // Another session's agent wrote during the turn too; that is not this turn's.
      await service.applyOps(
        OWNER,
        [{ op: "set", key: "pref.music", content: "背景音乐用轻快纯音乐", said: true }],
        { kind: "agent", sessionId: "session-2" }
      );
      clock.now = FIXED_NOW;
      const paraphrase =
        "小林口播（咖啡店主，竖版）文稿剪辑：删「我的建议就一句话」，「上个月」→「今年夏天」原声重配+对口型。成片 v1 11.6s。素材480积分。已交付，待反馈。";
      fetchMock.mockResolvedValue(
        modelAnswer(
          JSON.stringify({
            ops: [
              // The agent's project again in other words, under its key and under another.
              { op: "set", key: "project.2026-10-03.xiaolin-talk-edit", content: paraphrase },
              { op: "set", key: "project.2026-10-03.xiaolin-cafe-talk", content: paraphrase },
              { op: "forget", key: "pref.voice" },
              // Something the agent's entry leaves out still lands on its key.
              {
                op: "append",
                key: "project.2026-10-03.xiaolin-talk-edit",
                content: "创作者：节奏很好",
                said: true,
              },
              { op: "set", key: "pref.captions", content: "字幕黄色描边", said: true },
              { op: "set", key: "lesson.hook", content: "开场三秒内要出产品", said: true },
              { op: "set", key: "pref.bgm", content: "背景音乐用轻快的纯音乐", said: true },
            ],
          })
        )
      );

      expect(await handleUserMemoryExtract(JOB, delivery, deps())).toBe("ack");

      const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as {
        system: string;
        messages: Array<{ content: string }>;
      };
      expect(body.system).toContain('marked "saved this turn"');
      const prompt = body.messages[0]!.content;
      expect(prompt).toContain(
        `project.2026-10-03.xiaolin-talk-edit (saved this turn): ${project}`
      );
      expect(prompt).toContain("pref.voice (saved this turn): 配音用男声");
      expect(prompt).toContain("lesson.hook: 开场三秒内出产品");
      expect(prompt).toContain("pref.music: 背景音乐用轻快纯音乐");

      expect(
        (await current()).map((entry) => `${entry.key}|${entry.source}=${entry.content}`).sort()
      ).toEqual([
        "lesson.hook|extractor=开场三秒内要出产品",
        "pref.bgm|extractor=背景音乐用轻快的纯音乐",
        "pref.captions|extractor=字幕黄色描边",
        "pref.music|user_said=背景音乐用轻快纯音乐",
        "pref.voice|user_said=配音用男声",
        `project.2026-10-03.xiaolin-talk-edit|extractor=${project} → 创作者：节奏很好`,
      ]);
      expect(broadcasts).toHaveLength(1);
      expect(
        (broadcasts[0]!.changes as Array<{ key: string }>).map((change) => change.key)
      ).toEqual([
        "project.2026-10-03.xiaolin-talk-edit",
        "pref.captions",
        "lesson.hook",
        "pref.bgm",
      ]);
      expect(log.info).toHaveBeenCalledWith(
        "user_memory.extracted",
        expect.objectContaining({ valid: 4, applied: 4, left_to_user: 0, left_to_agent: 3 })
      );
    });

    it("tells a paraphrase of a fact from a different fact", () => {
      expect(
        saysMuchTheSame("每条视频结尾都放品牌 logo，停留 2 秒", "视频结尾放品牌 logo，停留 2 秒")
      ).toBe(true);
      expect(saysMuchTheSame("Always a male voice-over", "male voice-over, always")).toBe(true);
      expect(saysMuchTheSame("视频配音一律用女声", "字幕用黄色描边")).toBe(false);
      expect(saysMuchTheSame("Male voice", "Plain captions, no animated text")).toBe(false);
      expect(
        saysMuchTheSame(
          "结尾放品牌 logo",
          "新品预热，15 秒竖屏，男声配音，轻快纯音乐，结尾放品牌 logo，2026-10-09 上线"
        )
      ).toBe(false);
      expect(saysMuchTheSame("", "anything")).toBe(false);
    });

    it("drops what is not a valid op, and memory ops past ten", async () => {
      fetchMock.mockResolvedValue(
        modelAnswer(
          JSON.stringify({
            ops: [
              { op: "set", key: "Pref.Voice", content: "Male voice", said: true },
              { op: "set", key: "notes.x", content: "not a layer" },
              { op: "set", key: "recent.summary", content: "2026-10-03 not the extraction's" },
              { op: "set", key: "profile.brandName", content: "Bean There" },
              { op: "forget", key: "pref.old", said: true },
              { op: "set", key: "pref.a", content: "A" },
              { op: "set", key: "pref.b", content: "B" },
              { op: "set", key: "pref.c", content: "C" },
              { op: "set", key: "pref.d", content: "D" },
              { op: "set", key: "pref.e", content: "E" },
              { op: "set", key: "pref.f", content: "F" },
              { op: "set", key: "pref.g", content: "G" },
              { op: "set", key: "pref.h", content: "H" },
              { op: "set", key: "pref.i", content: "I" },
            ],
          })
        )
      );

      await handleUserMemoryExtract(JOB, delivery, deps());

      // Valid: pref.voice (lowercased), recent.summary (refused as invalid), a suggested
      // profile.brandname (pending), forget pref.old (missing), pref.a to pref.f; pref.g to
      // pref.i are past the ten.
      expect((await current()).map((entry) => `${entry.key}:${entry.status}`).sort()).toEqual([
        "pref.a:pending",
        "pref.b:pending",
        "pref.c:pending",
        "pref.d:pending",
        "pref.e:pending",
        "pref.f:pending",
        "pref.voice:active",
        "profile.brandname:pending",
      ]);
      expect(log.info).toHaveBeenCalledWith(
        "user_memory.extracted",
        expect.objectContaining({
          proposed: 14,
          valid: 10,
          applied: 8,
          outcomes:
            "applied,invalid,applied,missing,applied,applied,applied,applied,applied,applied",
        })
      );
    });

    it("acknowledges an answer that is not JSON without writing anything", async () => {
      fetchMock.mockResolvedValue(modelAnswer("I think the user likes male voices."));

      expect(await handleUserMemoryExtract(JOB, delivery, deps())).toBe("ack");

      expect(await current()).toEqual([]);
      expect(log.warn).toHaveBeenCalledWith(
        "user_memory.extract_unparsed",
        expect.objectContaining({ answer: "I think the user likes male voices." })
      );
      expect(broadcasts).toEqual([]);
    });

    it("skips go-aheads, paused memory, other people's messages and deployments without a gateway", async () => {
      turn.user = "继续";
      expect(await handleUserMemoryExtract(JOB, delivery, deps())).toBe("ack");

      turn.user = "Please make the intro shorter next time";
      turn.authorUserId = "someone-else";
      expect(await handleUserMemoryExtract(JOB, delivery, deps())).toBe("ack");

      turn.authorUserId = OWNER;
      const { service } = memoryServiceFor(db, { now: Date.now() });
      await service.setPaused(OWNER, true);
      expect(await handleUserMemoryExtract(JOB, delivery, deps())).toBe("ack");
      await service.setPaused(OWNER, false);

      expect(
        await handleUserMemoryExtract(
          JOB,
          delivery,
          deps({ GATEWAY_URL: undefined, GATEWAY_SECRET: undefined })
        )
      ).toBe("ack");

      turn.missing = true;
      expect(await handleUserMemoryExtract(JOB, delivery, deps())).toBe("ack");

      expect(fetchMock).not.toHaveBeenCalled();
      expect(
        log.info.mock.calls
          .filter(([message]) => message === "user_memory.extract_skipped")
          .map(([, data]) => (data as { reason: string }).reason)
      ).toEqual(["trivial", "not_the_owner", "paused", "no_model", "no_message"]);
    });

    it("gives up on a spent budget and retries what may pass later", async () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({ type: "error", error: { type: "rate_limit_error" } }, { status: 429 })
      );
      expect(await handleUserMemoryExtract(JOB, delivery, deps())).toBe("ack");

      fetchMock.mockResolvedValueOnce(new Response("overloaded", { status: 529 }));
      expect(await handleUserMemoryExtract(JOB, delivery, deps())).toEqual({
        retry: true,
        delayMs: 60_000,
      });

      fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
      expect(await handleUserMemoryExtract(JOB, delivery, deps())).toEqual({
        retry: true,
        delayMs: 60_000,
      });

      fetchMock.mockResolvedValueOnce(new Response("bad token", { status: 401 }));
      expect(await handleUserMemoryExtract(JOB, delivery, deps())).toBe("ack");
      expect(await current()).toEqual([]);
    });

    it("retries when the session cannot hand over the turn", async () => {
      const failing = env({
        SESSION: fakeSessionRuntimeDispatch(async () => new Response("gone", { status: 503 })),
      });
      expect(
        await handleUserMemoryExtract(JOB, delivery, {
          env: failing,
          db,
          log,
          correlation: { trace_id: "t", request_id: "r" },
        })
      ).toEqual({ retry: true, delayMs: 60_000 });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("recognizes a go-ahead", () => {
      for (const text of ["继续", "好", "ok", "Thanks!", "continue", "go ahead.", "好的。"]) {
        expect(isTrivialUserMessage(text), text).toBe(true);
      }
      for (const text of [
        "以后都用男声配音",
        "Use a male voice from now on",
        "继续，但字幕要黄色",
      ]) {
        expect(isTrivialUserMessage(text), text).toBe(false);
      }
    });
  });

  describe("queueing an extraction", () => {
    const session = (overrides: Partial<SessionEntry> = {}): SessionEntry =>
      ({
        id: SESSION,
        userId: OWNER,
        spawnSource: "user",
        parentSessionId: null,
        ...overrides,
      }) as SessionEntry;

    it("queues a user's own session's turns where there is a gateway", async () => {
      await queueUserMemoryExtraction(env(), async () => session(), "message-9");
      expect(send).toHaveBeenCalledExactlyOnceWith({
        kind: "user_memory.extract",
        payload: { version: 1, sessionId: SESSION, ownerUserId: OWNER, messageId: "message-9" },
      });
    });

    it("leaves out sessions without an owner, spawned ones, and deployments without a gateway", async () => {
      const read = vi.fn(async () => session());
      await queueUserMemoryExtraction(
        env({ GATEWAY_URL: undefined, GATEWAY_SECRET: undefined }),
        read,
        "m"
      );
      expect(read).not.toHaveBeenCalled();
      for (const entry of [
        null,
        session({ userId: null }),
        session({ spawnSource: "agent" }),
        session({ spawnSource: "automation" }),
        session({ parentSessionId: "parent-1" }),
      ]) {
        await queueUserMemoryExtraction(env(), async () => entry, "m");
      }
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe("user_memory.consolidate", () => {
    const job = { version: 1 as const, ownerUserId: OWNER, sessionId: SESSION };

    it("writes the recent-focus summary from current memory and recent changes", async () => {
      const { service } = memoryServiceFor(db, { now: Date.now() });
      await service.create(OWNER, { key: "pref.voice", content: "配音用男声" });
      await service.create(OWNER, {
        key: "project.2026-10-02.coffee",
        content: "咖啡新品 15 秒竖屏",
      });
      fetchMock.mockResolvedValue(
        modelAnswer('"2026-10-02 在做咖啡新品系列\n2026-10-03 测试开头钩子"')
      );

      expect(await handleUserMemoryConsolidate(job, delivery, deps())).toBe("ack");

      const prompt = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as {
        system: string;
        messages: Array<{ content: string }>;
      };
      expect(prompt.system).toContain("at most 3 short lines");
      expect(prompt.messages[0]!.content).toContain("Today is 2026-10-03.");
      expect(prompt.messages[0]!.content).toContain("- pref.voice: 配音用男声");
      expect(prompt.messages[0]!.content).toContain("set project.2026-10-02.coffee");
      const summary = (await current()).find((entry) => entry.key === "recent.summary");
      expect(summary).toMatchObject({
        content: "2026-10-02 在做咖啡新品系列\n2026-10-03 测试开头钩子",
        status: "active",
        source: "extractor",
        forgetAfter: Date.now() + USER_MEMORY_LIMITS.recentSummaryDays * DAY_MS,
      });

      // Within half an hour a second run leaves it alone.
      vi.setSystemTime(FIXED_NOW + USER_MEMORY_CONSOLIDATE_INTERVAL_MS - 1);
      expect(await handleUserMemoryConsolidate(job, delivery, deps())).toBe("ack");
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("forgets the summary when nothing is current, without asking when there are no facts", async () => {
      const { service } = memoryServiceFor(db, { now: Date.now() });
      await service.applyOps(
        OWNER,
        [{ op: "set", key: "recent.summary", content: "2026-09-01 old focus", ttlDays: 14 }],
        { kind: "consolidator", sessionId: SESSION }
      );
      await service.create(OWNER, { key: "lesson.hooks", content: "Questions open best" });
      vi.setSystemTime(FIXED_NOW + USER_MEMORY_CONSOLIDATE_INTERVAL_MS + 1);
      fetchMock.mockResolvedValue(modelAnswer(""));

      await handleUserMemoryConsolidate(job, delivery, deps());
      expect((await current()).map((entry) => entry.key)).toEqual(["lesson.hooks"]);

      await service.clear(OWNER);
      vi.setSystemTime(FIXED_NOW + 20 * DAY_MS);
      fetchMock.mockClear();
      expect(await handleUserMemoryConsolidate(job, delivery, deps())).toBe("ack");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("trims an answer to three lines within the summary limit", () => {
      expect(
        cleanUserMemorySummary("```\n2026-10-01 a\n\n2026-10-02 b\n2026-10-03 c\n2026-10-04 d\n```")
      ).toBe("2026-10-01 a\n2026-10-02 b\n2026-10-03 c");
      const long = `2026-10-01 ${"x".repeat(700)}`;
      expect(cleanUserMemorySummary(long)).toHaveLength(USER_MEMORY_LIMITS.recentSummaryChars);
      expect(cleanUserMemorySummary('""')).toBe("");
    });
  });
});
