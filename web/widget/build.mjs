// Bundles the widget into a single IIFE-format file any site can load
// with a plain <script src="..."> tag - no module support, no bundler,
// no framework required on the embedding page. esbuild is used directly
// (no framework/CLI wrapper) since this is one entry point with no
// special asset pipeline needs.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');
const isProd = process.argv.includes('--prod');

const options = {
  entryPoints: [path.join(__dirname, 'src/widget.ts')],
  outfile: path.join(__dirname, 'dist/widget.js'),
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  minify: isProd,
  sourcemap: !isProd,
  logLevel: 'info',
};

if (isWatch) {
  const ctx = await import('esbuild').then((m) => m.context(options));
  await ctx.watch();
  console.log('watching for changes...');
} else {
  await build(options);
}
