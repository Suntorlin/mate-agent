/** A source of configuration values, `process.env` in production and a Worker's bindings on Cloudflare. */
export type ConfigSource = Record<string, string | undefined>;

/**
 * The variables in `source` named by `names`, and no other: a reader that
 * takes its input through here cannot read a variable its table omits, so
 * the table stays the one list of what the reader depends on.
 */
export function pickVariables<Name extends string>(
  source: ConfigSource,
  names: readonly Name[]
): Record<Name, string | undefined> {
  const picked = {} as Record<Name, string | undefined>;
  for (const name of names) picked[name] = source[name];
  return picked;
}
