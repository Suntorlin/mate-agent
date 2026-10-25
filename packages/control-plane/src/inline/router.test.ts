import { describe, expect, it, vi } from "vitest";
import { createJevRuntimeRouter, JEV_URL } from "./router";

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
const input = {
  messageId: "m1",
  content: "明天下午三点提醒我吃药",
  previousContent: null,
  hasAttachments: false,
};

function jevAnswer(p: number) {
  return vi.fn(async () =>
    Response.json({ answers: { computer: { noul: { yes: p } } }, usage: { cost: 0.00002 } })
  );
}

describe("createJevRuntimeRouter", () => {
  it("routes to a sandbox when Jev is sure a computer is needed", async () => {
    const fetchFn = jevAnswer(0.97);
    const route = createJevRuntimeRouter({ apiKey: "k", log: log as never, fetchFn });
    await expect(route(input)).resolves.toBe("sandbox");
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(JEV_URL);
    expect(JSON.parse(init.body as string).state.latest_user_message).toBe(input.content);
  });

  it("runs conversational messages inline", async () => {
    const route = createJevRuntimeRouter({
      apiKey: "k",
      log: log as never,
      fetchFn: jevAnswer(0.11),
    });
    await expect(route(input)).resolves.toBe("inline");
  });

  it("sends attachments to a sandbox without asking Jev", async () => {
    const fetchFn = jevAnswer(0);
    const route = createJevRuntimeRouter({ apiKey: "k", log: log as never, fetchFn });
    await expect(route({ ...input, hasAttachments: true })).resolves.toBe("sandbox");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    ["unconfigured", undefined, jevAnswer(0.99)],
    ["an error status", "k", vi.fn(async () => new Response("no", { status: 500 }))],
    ["an unparsed answer", "k", vi.fn(async () => Response.json({ answers: {} }))],
    [
      "a failed call",
      "k",
      vi.fn(async () => {
        throw new Error("network");
      }),
    ],
  ])("runs inline on %s", async (_case, apiKey, fetchFn) => {
    const route = createJevRuntimeRouter({ apiKey, log: log as never, fetchFn: fetchFn as never });
    await expect(route(input)).resolves.toBe("inline");
  });
});
