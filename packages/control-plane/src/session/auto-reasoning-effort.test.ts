import { describe, expect, it, vi } from "vitest";
import { AUTO_LOW_THRESHOLD, createJevEffortChooser, JEV_URL } from "./auto-reasoning-effort";

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
}

function jevAnswering(p: number | null, init: { status?: number } = {}) {
  return vi.fn<typeof fetch>(async () =>
    Response.json(
      p === null
        ? { answers: {} }
        : { answers: { small: { noul: { yes: p, no: 1 - p } } }, usage: { cost: 0.00002 } },
      { status: init.status ?? 200 }
    )
  );
}

const INPUT = {
  messageId: "m1",
  content: "把字幕改大一点",
  previousContent: "做一条 15 秒的竖屏短片",
  baseEffort: "medium",
};

describe("createJevEffortChooser", () => {
  it("runs a message Jev is sure needs no new work at low", async () => {
    const fetchFn = jevAnswering(0.95);
    const log = logger();
    const choose = createJevEffortChooser({ apiKey: "k", log, fetchFn });
    expect(await choose(INPUT)).toBe("low");

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(JEV_URL);
    expect(init?.headers).toMatchObject({ Authorization: "Bearer k" });
    const body = JSON.parse(String(init?.body));
    expect(body.state).toEqual({
      latest_user_message: "把字幕改大一点",
      previous_user_message: "做一条 15 秒的竖屏短片",
    });
    expect(body.questions.small.type).toBe("noul");
    expect(log.info).toHaveBeenCalledWith(
      "prompt.auto_effort",
      expect.objectContaining({ reasoning_effort: "low", reason: "small", p_small: 0.95 })
    );
  });

  it("keeps the base effort below the threshold", async () => {
    const choose = createJevEffortChooser({
      apiKey: "k",
      log: logger(),
      fetchFn: jevAnswering(AUTO_LOW_THRESHOLD - 0.01),
    });
    expect(await choose(INPUT)).toBe("medium");
  });

  it("does not ask about an answer to a question card, which starts the work asked for", async () => {
    const fetchFn = jevAnswering(0.99);
    const choose = createJevEffortChooser({ apiKey: "k", log: logger(), fetchFn });
    expect(await choose({ ...INPUT, content: "[回答 q_1「图片比例？」] 9:16" })).toBe("medium");
    expect(await choose({ ...INPUT, content: "[用户点了「开始生成」]" })).toBe("medium");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("keeps the base effort whenever Jev cannot answer", async () => {
    const log = logger();
    const failing = vi.fn<typeof fetch>(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    expect(await createJevEffortChooser({ apiKey: "k", log, fetchFn: failing })(INPUT)).toBe(
      "medium"
    );
    expect(log.info).toHaveBeenLastCalledWith(
      "prompt.auto_effort",
      expect.objectContaining({ reason: "jev_failed", error: "TimeoutError" })
    );
    const erroring = jevAnswering(0.99, { status: 502 });
    expect(await createJevEffortChooser({ apiKey: "k", log, fetchFn: erroring })(INPUT)).toBe(
      "medium"
    );
    const unparsed = jevAnswering(null);
    expect(await createJevEffortChooser({ apiKey: "k", log, fetchFn: unparsed })(INPUT)).toBe(
      "medium"
    );
  });

  it("keeps the base effort without a key", async () => {
    const fetchFn = jevAnswering(0.99);
    const choose = createJevEffortChooser({ apiKey: undefined, log: logger(), fetchFn });
    expect(await choose(INPUT)).toBe("medium");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
