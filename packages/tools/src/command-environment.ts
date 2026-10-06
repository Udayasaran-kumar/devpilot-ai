import path from 'node:path';
import { isWithin } from './paths.js';

export type HostEnvironment = Readonly<Record<string, string | undefined>>;

/** Host variables copied into command environments. Everything else is dropped. */
export const DEFAULT_ENV_PASSTHROUGH: readonly string[] = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
];

/** Names that are never passed through, even if a caller adds them to the passthrough list. */
export const SECRET_ENV_NAME_PATTERN =
  /^(AWS_|BEDROCK_|AZURE_|GOOGLE_|GCP_)|SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|SESSION|AUTH/i;

/** Always set, for deterministic output and to keep npm off the network. */
export const FIXED_COMMAND_ENV: Readonly<Record<string, string>> = {
  NO_COLOR: '1',
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
};

export interface CommandEnvironmentOptions {
  readonly passthrough?: readonly string[];
  /** PATH entries inside these directories are removed so a repository cannot shadow allowlisted executables. */
  readonly excludedPathRoots?: readonly string[];
}

export function buildCommandEnvironment(
  host: HostEnvironment,
  options: CommandEnvironmentOptions = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of options.passthrough ?? DEFAULT_ENV_PASSTHROUGH) {
    const value = host[name];
    if (value !== undefined && !SECRET_ENV_NAME_PATTERN.test(name)) {
      env[name] = value;
    }
  }
  if (env.PATH !== undefined) {
    env.PATH = sanitizePath(env.PATH, options.excludedPathRoots ?? []);
  }
  return { ...env, ...FIXED_COMMAND_ENV };
}

/** Keeps only absolute PATH entries outside the excluded roots; relative entries would resolve against the repository cwd. */
function sanitizePath(value: string, excludedRoots: readonly string[]): string {
  return value
    .split(path.delimiter)
    .filter(
      (entry) =>
        entry !== '' && path.isAbsolute(entry) && !excludedRoots.some((root) => isWithin(root, path.resolve(entry))),
    )
    .join(path.delimiter);
}
