/** Runtime launch contract; image construction lives in packages/vercel-infra. */
import { SANDBOX_RUNTIME_VERSION } from "../../runtime-manifest";

export const VERCEL_SANDBOX_VERSION = SANDBOX_RUNTIME_VERSION;
export const VERCEL_PYTHON_BIN = "/opt/openinspect/python/bin/python";
/**
 * Vercel's Ubuntu-based managed image. It replaces the deprecated `runtime: node24` substrate
 * (Amazon Linux 2023, glibc 2.34), which cannot run Remotion's compositor (needs glibc 2.35).
 */
export const DEFAULT_VERCEL_IMAGE = "vercel/sandbox/node:24";
