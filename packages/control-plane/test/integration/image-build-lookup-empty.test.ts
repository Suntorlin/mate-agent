import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createImageBuildLookup } from "../../src/image-builds/lookup";
import { IMAGE_BUILD_PROVIDER_IDS, repoImageBuildScope } from "../../src/image-builds/model";
import { cleanD1Tables } from "./cleanup";
import { environmentScope, seedEnvironment } from "./image-build-helpers";

/**
 * The engine has no way to build an image any more, so `image_builds` stays
 * empty. A sandbox spawn still asks it for a prebuilt image; the answer has to
 * be "none" (the spawn then boots from the base image), never an error.
 */
describe("prebuilt image lookup with no image build records", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    const { count } = (await env.DB.prepare("SELECT COUNT(*) AS count FROM image_builds").first<{
      count: number;
    }>())!;
    expect(count).toBe(0);
  });

  it.each(IMAGE_BUILD_PROVIDER_IDS)("finds no image for any scope on %s", async (provider) => {
    const lookup = createImageBuildLookup(env.DB, provider);

    await expect(lookup.getLatestReady(repoImageBuildScope("acme", "web"))).resolves.toBeNull();
    await expect(lookup.getLatestReady(environmentScope("env_missing"))).resolves.toBeNull();
  });

  it("finds no image for a scope that still has prebuilds switched on", async () => {
    const environmentId = await seedEnvironment({ prebuildEnabled: true });
    const lookup = createImageBuildLookup(env.DB, IMAGE_BUILD_PROVIDER_IDS[0]);

    await expect(lookup.getLatestReady(environmentScope(environmentId))).resolves.toBeNull();
  });

  it("writes nothing back for an image it never handed out", async () => {
    const lookup = createImageBuildLookup(env.DB, IMAGE_BUILD_PROVIDER_IDS[0]);

    await expect(lookup.markRestoreFailed("image-build-missing", "restore failed")).resolves.toBe(
      false
    );
  });
});
