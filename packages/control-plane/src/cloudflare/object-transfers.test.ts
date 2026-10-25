import { describe, expect, it } from "vitest";
import { createCloudflareEnv, createObjectTransfers, type WorkerBindings } from "./platform";

const R2_ENDPOINT = "https://0123456789abcdef.r2.cloudflarestorage.com";

const VARIABLES = {
  OBJECT_STORE_BUCKET: "agent-engine-staging",
  OBJECT_STORE_REGION: "auto",
  OBJECT_STORE_ENDPOINT: R2_ENDPOINT,
  OBJECT_STORE_PUBLIC_ENDPOINT: R2_ENDPOINT,
  OBJECT_STORE_FORCE_PATH_STYLE: "true",
  AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
  AWS_SECRET_ACCESS_KEY: "secret-example",
};

describe("createObjectTransfers", () => {
  it("provides no ports when the deployment sets no object store endpoint", () => {
    expect(createObjectTransfers({})).toEqual({});
    expect(createObjectTransfers({ OBJECT_STORE_BUCKET: "agent-engine-staging" })).toEqual({});
  });

  it("treats an empty endpoint as unset, which is how an environment waits for its key pair", () => {
    // A key-less environment sets the address to "" in its config; the Worker then starts, and
    // direct uploads answer 501 until the address and the key pair are both there.
    const waiting = { ...VARIABLES, OBJECT_STORE_ENDPOINT: "", OBJECT_STORE_PUBLIC_ENDPOINT: "" };
    expect(
      createObjectTransfers({
        ...waiting,
        AWS_ACCESS_KEY_ID: undefined,
        AWS_SECRET_ACCESS_KEY: undefined,
      })
    ).toEqual({});
  });

  it("refuses an endpoint that comes without a complete key pair", () => {
    const withoutKeys = {
      ...VARIABLES,
      AWS_ACCESS_KEY_ID: undefined,
      AWS_SECRET_ACCESS_KEY: undefined,
    };
    expect(() => createObjectTransfers(withoutKeys)).toThrow(/AWS_ACCESS_KEY_ID/);
    // The error says what to do about it.
    expect(() => createObjectTransfers(withoutKeys)).toThrow(/leave OBJECT_STORE_ENDPOINT empty/);
    expect(() => createObjectTransfers({ ...VARIABLES, AWS_SECRET_ACCESS_KEY: undefined })).toThrow(
      /AWS_SECRET_ACCESS_KEY/
    );
  });

  it("signs direct uploads for the bucket's S3 domain with the given key pair", async () => {
    const { MEDIA_DIRECT, MEDIA_TRANSFERS } = createObjectTransfers(VARIABLES);
    expect(MEDIA_DIRECT).toBeDefined();
    expect(MEDIA_TRANSFERS).toBeDefined();

    const put = new URL(
      await MEDIA_DIRECT!.signPut("sessions/s1/clip.mp4", {
        contentType: "video/mp4",
        expiresInSeconds: 900,
      })
    );
    expect(put.origin).toBe(R2_ENDPOINT);
    expect(put.pathname).toBe("/agent-engine-staging/sessions/s1/clip.mp4");
    expect(put.searchParams.get("X-Amz-Credential")).toMatch(
      /^AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request$/
    );
    expect(put.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(put.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);

    const part = new URL(
      await MEDIA_DIRECT!.signUploadPart("sessions/s1/big.zip", "upload-1", 2, 3600)
    );
    expect(part.origin).toBe(R2_ENDPOINT);
    expect(part.searchParams.get("partNumber")).toBe("2");
    expect(part.searchParams.get("uploadId")).toBe("upload-1");
    // A checksum baked into a presigned part URL would make the store refuse the real bytes.
    expect(
      [...part.searchParams.keys()].some((key) => key.toLowerCase().includes("checksum"))
    ).toBe(false);
  });
});

describe("createCloudflareEnv", () => {
  const bindings = {
    DB: {} as D1Database,
    SESSION: {} as DurableObjectNamespace,
    REPOS_CACHE: {} as KVNamespace,
    MEDIA_BUCKET: {} as R2Bucket,
    DEPLOYMENT_NAME: "staging",
    ...VARIABLES,
  } as unknown as WorkerBindings;

  it("puts the transfer ports on the platform and keeps the key pair out of the configuration", () => {
    const env = createCloudflareEnv(bindings);
    expect(env.MEDIA_DIRECT).toBeDefined();
    expect(env.MEDIA_TRANSFERS).toBeDefined();
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(env).not.toHaveProperty("AWS_ACCESS_KEY_ID");
    expect(env).not.toHaveProperty("OBJECT_STORE_ENDPOINT");
  });

  it("builds the S3 clients once per bindings object", () => {
    expect(createCloudflareEnv(bindings).MEDIA_DIRECT).toBe(
      createCloudflareEnv(bindings).MEDIA_DIRECT
    );
  });

  it("leaves the ports out when the deployment has no object store endpoint", () => {
    const plain = { ...bindings, OBJECT_STORE_ENDPOINT: undefined } as unknown as WorkerBindings;
    const env = createCloudflareEnv(plain);
    expect(env.MEDIA_DIRECT).toBeUndefined();
    expect(env.MEDIA_TRANSFERS).toBeUndefined();
  });

  it("hands the gateway service binding to the platform", () => {
    const GATEWAY = { fetch: async () => new Response("ok") } as unknown as Fetcher;
    const env = createCloudflareEnv({ ...bindings, GATEWAY });
    expect(env.GATEWAY).toBe(GATEWAY);
  });
});
