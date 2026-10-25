import { describe, expect, it } from "vitest";
import { MemoryMediaStore } from "./direct-transfer.test-support";
import {
  buildWorkspaceCopyKey,
  isWorkspaceCopyKey,
  latestWorkspaceCopyUrl,
  WORKSPACE_COPY_DOWNLOAD_TTL_SECONDS,
} from "./workspace-copies";

describe("workspace copies", () => {
  it("names copies so they sort by time", () => {
    const key = buildWorkspaceCopyKey("s1", "abc", "tar.zst", Date.UTC(2026, 9, 2, 3, 4, 5, 678));
    expect(key).toBe("sessions/s1/workspace/20261002T030405678Z-abc.tar.zst");
    expect(isWorkspaceCopyKey("s1", key)).toBe(true);
    expect(isWorkspaceCopyKey("s2", key)).toBe(false);
    expect(isWorkspaceCopyKey("s1", "sessions/s1/workspace/../files/x.tar.zst")).toBe(false);
  });

  it("signs the newest copy for a fresh sandbox, or nothing when there is none", async () => {
    const store = new MemoryMediaStore();
    expect(await latestWorkspaceCopyUrl(store.direct, "s1")).toBeNull();
    store.putObject(buildWorkspaceCopyKey("s1", "old", "tar.gz", 1_000), new Uint8Array(1), 5);
    store.putObject(buildWorkspaceCopyKey("s1", "new", "tar.zst", 2_000_000), new Uint8Array(1), 1);
    store.putObject("sessions/s1/workspace/stray.txt", new Uint8Array(1), 9);

    const url = await latestWorkspaceCopyUrl(store.direct, "s1");

    expect(url).toBe(
      "https://store.test/sessions/s1/workspace/19700101T003320000Z-new.tar.zst?get"
    );
    expect(store.signed.at(-1)?.options).toEqual({
      expiresInSeconds: WORKSPACE_COPY_DOWNLOAD_TTL_SECONDS,
    });
  });
});
