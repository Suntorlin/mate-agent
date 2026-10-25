import { describe, expect, it } from "vitest";
import {
  USER_FILE_MAX_BYTES,
  USER_FILE_NAME_MAX_CHARS,
  USER_FILE_PART_BYTES,
  createUserFileUploadRequestSchema,
  userFilePartCount,
  inferUserFileKind,
  sanitizeUserFileName,
  updateUserFileRequestSchema,
} from "./user-files";

describe("sanitizeUserFileName", () => {
  it("keeps an ordinary name", () => {
    expect(sanitizeUserFileName("Brand Intro v2.mov")).toBe("Brand Intro v2.mov");
    expect(sanitizeUserFileName("北汉山 4点.mp4")).toBe("北汉山 4点.mp4");
  });

  it("removes separators, control characters and leading dots", () => {
    expect(sanitizeUserFileName("../../etc/passwd")).toBe("-..-etc-passwd");
    expect(sanitizeUserFileName("a\\b/c.png")).toBe("a-b-c.png");
    expect(sanitizeUserFileName("bad\u0000\u001fname.wav")).toBe("badname.wav");
    expect(sanitizeUserFileName("...hidden")).toBe("hidden");
    expect(sanitizeUserFileName("  spaced \t out  ")).toBe("spaced out");
    expect(sanitizeUserFileName("..")).toBe("");
  });

  it("shortens long names but keeps the extension", () => {
    const name = sanitizeUserFileName(`${"x".repeat(400)}.cube`);
    expect(name.length).toBe(USER_FILE_NAME_MAX_CHARS);
    expect(name.endsWith(".cube")).toBe(true);
  });
});

describe("inferUserFileKind", () => {
  it.each([
    ["clip.MOV", undefined, "video"],
    ["voice.wav", undefined, "audio"],
    ["still.webp", undefined, "image"],
    ["Inter-Display.otf", undefined, "font"],
    ["warm.cube", undefined, "lut"],
    ["company-logo.svg", undefined, "logo"],
    ["Logo.png", "image/png", "logo"],
    ["notes.pdf", "application/pdf", "other"],
    ["raw", "video/quicktime", "video"],
    ["no-extension", undefined, "other"],
  ])("%s (%s) is %s", (name, mime, kind) => {
    expect(inferUserFileKind(name, mime)).toBe(kind);
  });
});

describe("userFilePartCount", () => {
  it("uses at least one part", () => {
    expect(userFilePartCount(1)).toBe(1);
    expect(userFilePartCount(USER_FILE_PART_BYTES)).toBe(1);
    expect(userFilePartCount(USER_FILE_PART_BYTES + 1)).toBe(2);
    expect(userFilePartCount(USER_FILE_MAX_BYTES)).toBe(320);
  });
});

describe("request schemas", () => {
  it("sanitizes the name of a new upload and bounds its size", () => {
    const parsed = createUserFileUploadRequestSchema.parse({
      name: "folder/clip.mp4",
      sizeBytes: 10,
      scope: "input",
    });
    expect(parsed.name).toBe("folder-clip.mp4");
    expect(
      createUserFileUploadRequestSchema.safeParse({
        name: "big.mov",
        sizeBytes: USER_FILE_MAX_BYTES + 1,
        scope: "library",
      }).success
    ).toBe(false);
    expect(
      createUserFileUploadRequestSchema.safeParse({ name: "..", sizeBytes: 1, scope: "library" })
        .success
    ).toBe(false);
  });

  it("refuses an empty update", () => {
    expect(updateUserFileRequestSchema.safeParse({}).success).toBe(false);
    expect(updateUserFileRequestSchema.parse({ kind: "font" })).toEqual({ kind: "font" });
  });
});
