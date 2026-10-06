import path from 'node:path';

/** True when `target` is `root` or below it. Compares path segments, not string prefixes. */
export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}
