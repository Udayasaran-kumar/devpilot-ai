/** Repository-relative paths that hold tests: test directories and `*.test.*` / `*.spec.*` / `test_*.py` files. */
export const TEST_PATH_PATTERN =
  /(^|\/)(test|tests|__tests__|spec|specs|__mocks__|__snapshots__)\/|(\.|_)(test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$/i;

export function isTestPath(filePath: string): boolean {
  return TEST_PATH_PATTERN.test(filePath);
}
