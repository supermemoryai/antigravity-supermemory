import { copyFileSync } from 'node:fs';
import { build } from 'esbuild';

// Antigravity installs a plugin by copying this directory; there is no
// npm install step, so the SDK ships pre-bundled.
await build({
  stdin: {
    contents: "export { Supermemory } from 'supermemory';",
    resolveDir: process.cwd(),
    sourcefile: 'supermemory-runtime.js',
  },
  outfile: 'scripts/vendor/supermemory.cjs',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  minify: true,
  legalComments: 'none',
});

copyFileSync(
  'node_modules/supermemory/LICENSE',
  'scripts/vendor/LICENSE-supermemory',
);
