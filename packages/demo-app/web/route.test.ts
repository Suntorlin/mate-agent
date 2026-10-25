import { describe, expect, it } from "vitest";
import { formatRoute, parseRoute } from "./route.ts";

describe("routes", () => {
  it("reads the page and the conversation from the hash", () => {
    expect(parseRoute("#/chats/abc")).toEqual({ page: "chats", conversationId: "abc" });
    expect(parseRoute("#/chats")).toEqual({ page: "chats", conversationId: null });
    expect(parseRoute("#/me")).toEqual({ page: "me" });
  });

  it("opens the chat list for an empty or unknown hash", () => {
    expect(parseRoute("")).toEqual({ page: "chats", conversationId: null });
    expect(parseRoute("#/nowhere")).toEqual({ page: "chats", conversationId: null });
  });

  it("round-trips", () => {
    for (const hash of ["#/chats", "#/chats/abc", "#/me"]) {
      expect(formatRoute(parseRoute(hash))).toBe(hash);
    }
  });
});
