import { isTestPath, type PatchViolation, type PatchViolationCode } from '@devpilot/core';
import { checkPatchPath, PROTECTED_PATH_SEGMENTS } from '@devpilot/tools';

/**
 * File names a patch must never introduce: env files (except `.env.example`),
 * private keys, and credential stores. This matches names only; file contents
 * are not scanned.
 */
export const SECRET_FILE_PATTERN =
  /(^|\/)(\.env(\.(?!example$)[^/]+)?|\.npmrc|\.netrc|\.pgpass|id_(rsa|dsa|ecdsa|ed25519)|[^/]*\.(pem|key|p12|pfx)|credentials[^/]*)$/i;

export interface PatchPathRule {
  readonly code: PatchViolationCode;
  readonly reason: string;
  readonly matches: (path: string) => boolean;
}

const basename = (filePath: string): string => filePath.slice(filePath.lastIndexOf('/') + 1);
/** Case-insensitive, because `Package.JSON` names `package.json` on case-insensitive file systems. */
const nameIn = (names: readonly string[]) => {
  const lower = new Set(names.map((name) => name.toLowerCase()));
  return (filePath: string) => lower.has(basename(filePath).toLowerCase());
};

const PACKAGE_MANIFESTS = [
  'package.json',
  'deno.json',
  'deno.jsonc',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'Pipfile',
  'Cargo.toml',
  'go.mod',
  'Gemfile',
  'composer.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  '.yarnrc',
  '.yarnrc.yml',
  '.pnpmfile.cjs',
  'pnpm-workspace.yaml',
  'bunfig.toml',
];
const REQUIREMENTS_FILE = /(^|\/)requirements[^/]*\.txt$/i;
const LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
];
const CI_PATH =
  /(^|\/)(\.github|\.gitlab|\.circleci|\.buildkite)\/|(^|\/)(\.gitlab-ci\.ya?ml|\.travis\.ya?ml|azure-pipelines\.ya?ml|bitbucket-pipelines\.ya?ml|buildspec\.ya?ml|\.drone\.ya?ml|Jenkinsfile)$/i;
/**
 * Test runner, compiler, and task runner configuration: it decides which tests
 * run and how, so changing it can turn the verification command GREEN without
 * changing the behaviour under test.
 */
const TEST_CONFIG_FILE =
  /(^|\/)((jest|vitest|vite|playwright|cypress|ava|nyc|babel|wdio)\.(config|setup|workspace)(\.[^/]+)?\.(js|cjs|mjs|ts|cts|mts|json)|karma\.conf\.[^/]+|\.mocharc(\.[^/]+)?|\.c8rc(\.[^/]+)?|\.nycrc(\.[^/]+)?|\.babelrc(\.[^/]+)?|tsconfig(\.[^/]+)?\.json|jsconfig\.json|pytest\.ini|tox\.ini|noxfile\.py|conftest\.py|\.coveragerc|phpunit\.xml(\.dist)?|\.rspec|(GNU)?makefile|justfile|taskfile\.ya?ml|rakefile|gulpfile\.[^/]+|gruntfile\.[^/]+|\.nvmrc|\.node-version|\.tool-versions)$/i;
/** Installed or vendored third-party code: a patch there changes what the tests import, not the project. */
const DEPENDENCY_DIRECTORY = /(^|\/)(node_modules|bower_components|jspm_packages|vendor|\.venv|venv|site-packages)\//i;
const CREDENTIAL_DIRECTORY = /(^|\/)\.(aws|ssh|docker|kube|gnupg)\//i;
const SECRETS_FILE = /(^|\/)secrets?(\.[^/]+)?$/i;

/**
 * The patch safety policy. Fixed rather than configurable, so a proposal is
 * judged the same way when it is reviewed and when its review is replayed.
 * Repairs change source code; everything below is refused.
 */
export const PATCH_PATH_RULES: readonly PatchPathRule[] = [
  {
    code: 'test_file',
    reason: 'tests define the expected behaviour; a repair must not change them',
    matches: isTestPath,
  },
  {
    code: 'test_config',
    reason: 'test, build, and task runner configuration decides what the verification command runs',
    matches: (filePath) => TEST_CONFIG_FILE.test(filePath),
  },
  {
    code: 'package_manifest',
    reason: 'package manifests control dependencies and scripts, including the verification command',
    matches: (filePath) => nameIn(PACKAGE_MANIFESTS)(filePath) || REQUIREMENTS_FILE.test(filePath),
  },
  {
    code: 'lockfile',
    reason: 'lockfiles pin dependencies',
    matches: nameIn(LOCKFILES),
  },
  {
    code: 'dependency_directory',
    reason: 'installed and vendored dependencies are not the project source',
    matches: (filePath) => DEPENDENCY_DIRECTORY.test(filePath),
  },
  {
    code: 'ci_config',
    reason: 'CI and workflow files run with repository credentials',
    matches: (filePath) => CI_PATH.test(filePath),
  },
  {
    code: 'credential_file',
    reason: 'the file name looks like an environment or credential file',
    matches: (filePath) =>
      SECRET_FILE_PATTERN.test(filePath) || CREDENTIAL_DIRECTORY.test(filePath) || SECRETS_FILE.test(filePath),
  },
];

/** Every policy violation for one patch path, in rule order. */
export function checkPatchPathPolicy(filePath: string): PatchViolation[] {
  const segments = filePath.split('/');
  const protectedSegment = segments.find((segment) => PROTECTED_PATH_SEGMENTS.includes(segment.toLowerCase()));
  if (protectedSegment !== undefined) {
    return [{ code: 'protected_path', path: filePath, message: `${filePath} is inside the protected ${protectedSegment} directory` }];
  }
  const unsafe = checkPatchPath(filePath);
  if (unsafe !== undefined) {
    const escapes = filePath.startsWith('/') || /^[A-Za-z]:/.test(filePath) || segments.includes('..');
    return [{ code: escapes ? 'outside_repository' : 'unsafe_path', path: filePath, message: `${filePath} ${unsafe}` }];
  }
  return PATCH_PATH_RULES.filter((rule) => rule.matches(filePath)).map((rule) => ({
    code: rule.code,
    path: filePath,
    message: `${filePath} is refused: ${rule.reason}`,
  }));
}
