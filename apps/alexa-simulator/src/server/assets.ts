import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const WEB_ROOT = fileURLToPath(new URL('../web', import.meta.url));

/** Everything the browser can load: one page, one script, one stylesheet. */
export interface StaticAssets {
  readonly html: string;
  readonly script: string;
  readonly styles: string;
}

/**
 * Bundles the browser code in memory. Nothing from the server's environment
 * is defined into the bundle except React's production mode.
 */
export async function buildAssets(): Promise<StaticAssets> {
  const result = await build({
    entryPoints: [path.join(WEB_ROOT, 'main.tsx')],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    write: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const [script] = result.outputFiles;
  if (!script) throw new Error('The browser bundle is empty');
  const [html, styles] = await Promise.all([
    readFile(path.join(WEB_ROOT, 'index.html'), 'utf8'),
    readFile(path.join(WEB_ROOT, 'styles.css'), 'utf8'),
  ]);
  return { html, script: script.text, styles };
}
