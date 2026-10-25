/**
 * Canonical control-plane HTTP route catalog.
 *
 * Registration order is part of the routing contract for overlapping static
 * and parameterized paths.
 */

import type { RouteModule } from "../routing/hono-env";
import { browserAuthRoutes } from "./browser-auth";
import { commitSigningRoutes } from "./commit-signing";
import { spendRoutes } from "./spend";
import { sessionCredentialRoutes } from "./session-credentials";
import { userFileRoutes } from "./files";
import { userMemoryRoutes } from "./memory";
import { llmAdminRoutes } from "./llm-admin";
import { llmUsageRoutes } from "./llm-usage";
import { healthRoutes } from "./health";
import { personalSkillRoutes } from "./personal-skills";
import { workflowRoutes } from "./workflows";
import { modelProviderAccountRoutes } from "./model-provider-accounts";
import { providerRuntimeCredentialRoutes } from "./provider-runtime-credentials";
import { rbacRoutes } from "./rbac";
import { sessionRoutes } from "./sessions";
import { slackNotifyRoutes } from "./slack-notify";
import { signInProviderRoutes } from "./sign-in-providers";
import { skillRoutes } from "./skills";

/** Registration order is the precedence order: each module is mounted where it appears. */
export const catalog: readonly RouteModule[] = [
  healthRoutes,

  browserAuthRoutes,
  signInProviderRoutes,

  // Session management, then the agent-initiated Slack notification
  sessionRoutes,
  slackNotifyRoutes,

  // Subscription provider account management and sandbox access broker
  modelProviderAccountRoutes,
  // Delivery of stored provider secrets to sandboxes (Anthropic)
  providerRuntimeCredentialRoutes,
  // Fresh gateway and product credentials for a session's sandbox
  sessionCredentialRoutes,
  // What a session's sandbox may spend (permission mode and budget)
  spendRoutes,
  // User files: uploads, the library and session inputs
  userFileRoutes,
  // User memory: the owner's memory routes and the sandbox's `mem`
  userMemoryRoutes,
  // The signed-in user's LLM spend against their gateway budget
  llmUsageRoutes,
  // Workspace admins' view of every user's LLM spend, budgets and blocks
  llmAdminRoutes,

  // Deployment-wide commit signing identity, brokered to sandboxes
  commitSigningRoutes,

  // Installation-wide managed skills and personal profiles
  skillRoutes,
  // Each user's own skills and on/off switches
  personalSkillRoutes,
  // Each user's saved script workflows and their runs
  workflowRoutes,

  // Workspace roles, members, and current-user authorization
  rbacRoutes,
];
