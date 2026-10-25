import { describe, expect, it } from "vitest";
import { fetchSkillFilesFromUrl, parseSkillUrl } from "./url-import";

const markdown = "---\nname: cafe-ad\ndescription: d\n---\n";

function fakeGitHub(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (!(url in routes)) return new Response("missing", { status: 404 });
    const value = routes[url];
    return typeof value === "string"
      ? new Response(value)
      : new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("skill links", () => {
  it("reads GitHub folder, file and raw links", () => {
    expect(parseSkillUrl("https://github.com/acme/skills/tree/main/video/cafe-ad")).toEqual({
      kind: "folder",
      owner: "acme",
      repo: "skills",
      ref: "main",
      path: "video/cafe-ad",
    });
    expect(parseSkillUrl("https://github.com/acme/skills/blob/v1/cafe-ad/SKILL.md")).toMatchObject({
      kind: "folder",
      ref: "v1",
      path: "cafe-ad",
    });
    expect(parseSkillUrl("https://github.com/acme/cafe-ad")).toMatchObject({ ref: null, path: "" });
    expect(
      parseSkillUrl("https://raw.githubusercontent.com/acme/skills/main/cafe-ad/SKILL.md")
    ).toMatchObject({ kind: "file", path: "main/cafe-ad/SKILL.md".slice(5) });
  });

  it("refuses other hosts, plain http and non-skill files", () => {
    for (const bad of [
      "http://github.com/acme/skills",
      "https://example.com/SKILL.md",
      "https://169.254.169.254/latest",
      "https://github.com/acme/skills/blob/main/README.md",
      "https://raw.githubusercontent.com/acme/skills/main/README.md",
      "not a link",
    ]) {
      expect(() => parseSkillUrl(bad), bad).toThrow();
    }
  });

  it("downloads a folder recursively and marks shebang scripts executable", async () => {
    const api = "https://api.github.com/repos/acme/skills/contents";
    const raw = "https://raw.githubusercontent.com/acme/skills/main";
    const { fetchImpl } = fakeGitHub({
      [`${api}/cafe-ad?ref=main`]: [
        {
          type: "file",
          path: "cafe-ad/SKILL.md",
          size: 10,
          download_url: `${raw}/cafe-ad/SKILL.md`,
        },
        { type: "dir", path: "cafe-ad/scripts", size: 0, download_url: null },
      ],
      [`${api}/cafe-ad/scripts?ref=main`]: [
        {
          type: "file",
          path: "cafe-ad/scripts/cut.sh",
          size: 10,
          download_url: `${raw}/cafe-ad/scripts/cut.sh`,
        },
      ],
      [`${raw}/cafe-ad/SKILL.md`]: markdown,
      [`${raw}/cafe-ad/scripts/cut.sh`]: "#!/bin/sh\n",
    });
    await expect(
      fetchSkillFilesFromUrl("https://github.com/acme/skills/tree/main/cafe-ad", fetchImpl)
    ).resolves.toEqual([
      { path: "SKILL.md", content: markdown, executable: false },
      { path: "scripts/cut.sh", content: "#!/bin/sh\n", executable: true },
    ]);
  });

  it("only downloads from GitHub's raw host and needs a SKILL.md", async () => {
    const api = "https://api.github.com/repos/acme/skills/contents";
    const evil = fakeGitHub({
      [`${api}/x?ref=main`]: [
        { type: "file", path: "x/SKILL.md", size: 1, download_url: "https://evil.test/SKILL.md" },
      ],
    });
    await expect(
      fetchSkillFilesFromUrl("https://github.com/acme/skills/tree/main/x", evil.fetchImpl)
    ).rejects.toThrow(/cannot be downloaded/);
    expect(evil.calls.some((url) => url.includes("evil.test"))).toBe(false);

    const empty = fakeGitHub({ [`${api}/y?ref=main`]: [] });
    await expect(
      fetchSkillFilesFromUrl("https://github.com/acme/skills/tree/main/y", empty.fetchImpl)
    ).rejects.toThrow(/no SKILL\.md/);
    await expect(
      fetchSkillFilesFromUrl("https://github.com/acme/skills/tree/main/z", empty.fetchImpl)
    ).rejects.toMatchObject({ status: 404 });
  });
});
