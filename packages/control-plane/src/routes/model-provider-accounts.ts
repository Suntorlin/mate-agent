import {
  subscriptionProviderIdSchema,
  type SubscriptionProviderId,
} from "@open-inspect/shared/types/provider-accounts";
import { Hono } from "hono";
import { z } from "zod";
import { createLogger } from "../logger";
import { generateId } from "../auth/crypto";
import { modelProviderAccountAdapterRegistry } from "../auth/model-provider-account-default-adapters";
import {
  ModelProviderAccountBroker,
  ModelProviderAccountBrokerError,
} from "../auth/model-provider-account-broker";
import { ModelProviderAccountStore } from "../db/model-provider-accounts";
import { D1ModelProviderAccountAtomicWriter } from "../db/model-provider-account-atomic-writer";
import { ProviderCredentialStore } from "../db/provider-account-credentials";
import { SessionIndexStore } from "../db/session-index";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { SessionInternalPaths, type SessionInternalPath } from "../session/contracts";
import { createSessionRuntimeClient } from "../session/runtime-client";
import {
  error,
  json,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  type SandboxRouteContext,
  NO_AUTHORIZATION,
} from "./shared";

const NO_STORE = "no-store" as const;
const logger = createLogger("router:model-provider-accounts");
const legacyAccessSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional(),
  account_id: z.string().optional(),
});
/** Providers that ever had a session-scoped legacy OAuth refresh path. */
const LEGACY_REFRESH_PATH: Partial<Record<SubscriptionProviderId, SessionInternalPath>> = {
  openai: SessionInternalPaths.openaiTokenRefresh,
  xai: SessionInternalPaths.xaiTokenRefresh,
};

function provider(value: string): SubscriptionProviderId | Response {
  const parsed = subscriptionProviderIdSchema.safeParse(value);
  return parsed.success ? parsed.data : error("Unsupported model provider", 400);
}

/** The sandbox's access-token broker for a session's pinned provider account. */
export const modelProviderAccountRoutes = new Hono<ControlPlaneHonoEnv>();

async function handleLegacyProviderAccess(
  env: Env,
  ctx: SandboxRouteContext,
  sessionId: string,
  providerId: SubscriptionProviderId
): Promise<Response> {
  const legacyPath = LEGACY_REFRESH_PATH[providerId];
  if (!legacyPath) return error("Provider has no legacy scoped OAuth path", 409);
  const response = await createSessionRuntimeClient(env, ctx).fetch(sessionId, legacyPath, {
    method: "POST",
  });
  if (!response.ok) return response;
  const parsed = legacyAccessSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return error("Provider access unavailable", 503);
  return json({
    accessToken: parsed.data.access_token,
    ...(parsed.data.expires_in === undefined ? {} : { expiresIn: parsed.data.expires_in }),
    providerMetadata:
      providerId === "openai" && parsed.data.account_id
        ? { accountId: parsed.data.account_id }
        : {},
  });
}

async function handleProviderAccess(
  _request: Request,
  env: Env,
  params: { id: string; provider: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  const sessionId = params.id;
  const parsedProvider = provider(params.provider);
  if (parsedProvider instanceof Response) return parsedProvider;
  let binding;
  try {
    binding = await new SessionIndexStore(ctx.db).getProviderAuthForProvider(
      sessionId,
      parsedProvider
    );
  } catch (cause) {
    logger.error("provider_account.session_binding_lookup_failed", {
      event: "provider_account.session_binding_lookup_failed",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      session_id: sessionId,
      provider: parsedProvider,
      error: cause instanceof Error ? cause : String(cause),
    });
    return error("Session provider auth unavailable", 503);
  }
  if (!binding) return error("Session provider account is not configured", 404);
  if (binding.authMode === "legacy_scoped_oauth") {
    return handleLegacyProviderAccess(env, ctx, sessionId, parsedProvider);
  }
  if (binding.authMode === "api_key") {
    return error("Session uses API-key mode for this provider", 409);
  }
  if (
    modelProviderAccountAdapterRegistry.runtimeCredentialKind(parsedProvider) !==
    "brokered_access_token"
  ) {
    // The stored secret only leaves through the runtime-credential route,
    // which applies the account and expiry checks for it.
    return error(
      "Provider delivers a stored provider secret; use the runtime-credential route",
      409
    );
  }
  const broker = new ModelProviderAccountBroker(
    {
      accounts: new ModelProviderAccountStore(ctx.db),
      credentials: new ProviderCredentialStore(ctx.db, env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY),
      atomicWriter: new D1ModelProviderAccountAtomicWriter(
        ctx.db,
        env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY
      ),
    },
    modelProviderAccountAdapterRegistry,
    { now: () => Date.now(), createOwner: () => generateId() }
  );
  try {
    return json(await broker.getAccess(binding.providerAccountId, parsedProvider));
  } catch (cause) {
    if (cause instanceof ModelProviderAccountBrokerError) {
      const status =
        cause.code === "account_not_found" ? 404 : cause.code === "upstream_retry_safe" ? 502 : 409;
      return error(cause.message, status);
    }
    return error("Provider access unavailable", 503);
  }
}

modelProviderAccountRoutes.post(
  "/sessions/:id/provider-auth/:provider/access-token",
  admit({ ...SCM_AGNOSTIC_SANDBOX_ROUTE, cacheControl: NO_STORE, authorization: NO_AUTHORIZATION }),
  (c) => dispatch(c, handleProviderAccess)
);
