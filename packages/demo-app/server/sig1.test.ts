import { createHash } from "node:crypto";
import { verifyServiceSignature } from "@open-inspect/shared/service-auth";
import { describe, expect, it } from "vitest";
import { sig1Headers } from "./sig1.ts";

describe("sig1", () => {
  it("produces signatures the engine's verifier accepts", async () => {
    const url = "http://engine.test/sessions/abc/messages?limit=100&b=2&a=1";
    const body = JSON.stringify({ content: "hello" });
    const headers = sig1Headers({
      service: "app",
      secret: "s3cret",
      method: "post",
      url,
      body,
      actor: "app:0123456789abcdef",
    });

    const result = await verifyServiceSignature({
      signatureHeader: headers["X-OpenInspect-Service-Signature"],
      service: "app",
      secret: "s3cret",
      method: "POST",
      url,
      bodySha256Hex: createHash("sha256").update(body).digest("hex"),
      actor: headers["X-OpenInspect-Actor"],
    });
    expect(result.ok).toBe(true);
  });

  it("is refused for another actor or another secret", async () => {
    const url = "http://engine.test/sessions";
    const headers = sig1Headers({
      service: "app",
      secret: "s3cret",
      method: "GET",
      url,
      actor: "app:a",
    });
    const verify = (secret: string, actor: string) =>
      verifyServiceSignature({
        signatureHeader: headers["X-OpenInspect-Service-Signature"],
        service: "app",
        secret,
        method: "GET",
        url,
        bodySha256Hex: createHash("sha256").update("").digest("hex"),
        actor,
      });
    expect((await verify("s3cret", "app:b")).ok).toBe(false);
    expect((await verify("other", "app:a")).ok).toBe(false);
  });
});
