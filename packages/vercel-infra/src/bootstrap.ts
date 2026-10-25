/** Provider overlay only; the packed recipe owns all dependencies. */
export const VERCEL_RUNTIME_WORKDIR = "/tmp/open-inspect-runtime";
export const VERCEL_LOCAL_RUNTIME_EXTRACT_DIR = `${VERCEL_RUNTIME_WORKDIR}/packages`;

export function buildVercelBootstrapScript(params: { runtimeExtractDir?: string } = {}): string {
  const directory = params.runtimeExtractDir || VERCEL_LOCAL_RUNTIME_EXTRACT_DIR;
  const script = `${directory}/packages/sandbox-images/install/install.sh`;
  const install = `sudo -E env PATH='/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' bash '${script.replace(/'/g, `'\\''`)}'`;
  // The second run adds the media toolchain, as the E2B template build does.
  return `set -euo pipefail
# Prefer the packaged OS tools that remain visible in the final runtime environment.
${install}
${install} media`;
}
