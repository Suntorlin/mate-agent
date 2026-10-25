import { describe, expect, it, vi } from "vitest";
import { SessionInternalPaths, buildSessionInternalRequest } from "../session/contracts";
import {
  createDurableObjectSessionRuntimeDispatch,
  parseLocationHint,
} from "./session-runtime-dispatch";

describe("createDurableObjectSessionRuntimeDispatch", () => {
  it("sends the request to the Durable Object named by the session id", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      return Response.json({ ok: true });
    });
    const idFromName = vi.fn((name: string) => `do-${name}`);
    const get = vi.fn(() => ({ fetch }));
    const dispatch = createDurableObjectSessionRuntimeDispatch({
      idFromName,
      get,
    } as unknown as DurableObjectNamespace);

    const response = await dispatch(
      "session-1",
      buildSessionInternalRequest(
        SessionInternalPaths.events,
        { method: "POST", headers: { "x-trace-id": "trace-1" }, body: "{}" },
        "?limit=10"
      )
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(idFromName).toHaveBeenCalledWith("session-1");
    expect(get).toHaveBeenCalledWith("do-session-1");
    expect(fetch).toHaveBeenCalledOnce();
    const request = requests[0]!;
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe(SessionInternalPaths.events);
    expect(new URL(request.url).search).toBe("?limit=10");
    expect(request.headers.get("x-trace-id")).toBe("trace-1");
  });

  it("asks Cloudflare to create the object in the configured region", async () => {
    const get = vi.fn(() => ({ fetch: async () => Response.json({ ok: true }) }));
    const dispatch = createDurableObjectSessionRuntimeDispatch(
      { idFromName: (name: string) => `do-${name}`, get } as unknown as DurableObjectNamespace,
      "enam"
    );
    await dispatch(
      "session-2",
      buildSessionInternalRequest(SessionInternalPaths.events, { method: "GET" })
    );
    expect(get).toHaveBeenCalledWith("do-session-2", { locationHint: "enam" });
  });
});

describe("parseLocationHint", () => {
  it("accepts a region, treats an unset value as no hint and refuses anything else", () => {
    expect(parseLocationHint("enam")).toBe("enam");
    expect(parseLocationHint(undefined)).toBeUndefined();
    expect(parseLocationHint("")).toBeUndefined();
    expect(() => parseLocationHint("us-east")).toThrow(/SESSION_DO_LOCATION_HINT/);
  });
});
