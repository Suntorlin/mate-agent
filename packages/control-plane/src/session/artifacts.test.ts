import { describe, expect, it } from "vitest";
import { summarizeSessionMedia } from "./artifacts";

describe("summarizeSessionMedia", () => {
  it("has no cover and counts nothing before the session produces an image or a video", () => {
    expect(summarizeSessionMedia([])).toEqual({ cover: null, count: 0 });
    expect(
      summarizeSessionMedia([
        { id: "pr-1", type: "pr", created_at: 1 },
        { id: "file-1", type: "file", created_at: 2 },
        { id: "page-1", type: "page", created_at: 3 },
      ])
    ).toEqual({ cover: null, count: 0 });
  });

  it("keeps the first image or video as the cover however the rows are ordered", () => {
    const artifacts = [
      { id: "video-2", type: "video", created_at: 30 },
      { id: "file-1", type: "file", created_at: 5 },
      { id: "video-1", type: "video", created_at: 10 },
      { id: "shot-1", type: "screenshot", created_at: 20 },
    ];
    const expected = { cover: { artifactId: "video-1", type: "video" }, count: 3 };

    expect(summarizeSessionMedia(artifacts)).toEqual(expected);
    expect(summarizeSessionMedia([...artifacts].reverse())).toEqual(expected);
  });

  it("picks the same cover among artifacts made in the same millisecond", () => {
    const artifacts = [
      { id: "b", type: "screenshot", created_at: 10 },
      { id: "a", type: "video", created_at: 10 },
    ];

    expect(summarizeSessionMedia(artifacts).cover).toEqual({ artifactId: "a", type: "video" });
    expect(summarizeSessionMedia([...artifacts].reverse()).cover).toEqual({
      artifactId: "a",
      type: "video",
    });
  });
});
