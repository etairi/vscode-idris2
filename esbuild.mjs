// Bundles the extension with esbuild. ESM port of the esbuild.js that generator-code 1.12.0
// emits, with two changes: the `location` guard in the problem-matcher plugin, and the second
// entry point of docs/ARCHITECTURE.md §2 (src/webview/goalPanel.ts → dist/goalPanel.js).
//
//   node esbuild.mjs               development build (sourcemap, not minified)
//   node esbuild.mjs --watch       rebuild on change; output is read by the
//                                  connor4312.esbuild-problem-matchers task matcher
//   node esbuild.mjs --production  minified release build
import esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Number of builds currently running, over both contexts. */
let running = 0;

/**
 * Prints the begin/end markers the esbuild problem matcher watches for. Both build contexts
 * share this plugin, and the markers bracket the whole group: "started" when the first of them
 * starts, "finished" when the last one still running ends, so a watch task is not reported done
 * while the other bundle is still building.
 *
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',

  setup(build) {
    build.onStart(() => {
      if (running++ === 0) {
        console.log('[watch] build started');
      }
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      });
      if (--running === 0) {
        console.log('[watch] build finished');
      }
    });
  },
};

/** Options shared by both bundles (docs/ARCHITECTURE.md §2, §13). */
const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: 'silent',
  plugins: [
    /* add to the end of plugins array */
    esbuildProblemMatcherPlugin,
  ],
};

async function main() {
  const contexts = await Promise.all([
    // The extension host bundle.
    esbuild.context({
      ...common,
      entryPoints: ['src/extension.ts'],
      format: 'cjs',
      platform: 'node',
      outfile: 'dist/extension.js',
      external: ['vscode'],
    }),
    // The goal panel webview script: runs in the webview, so a self-contained browser bundle
    // with no externals. M0 ships a stub entry (docs/ROADMAP.md M0 "Out"); M7 replaces it.
    esbuild.context({
      ...common,
      entryPoints: ['src/webview/goalPanel.ts'],
      format: 'iife',
      platform: 'browser',
      outfile: 'dist/goalPanel.js',
    }),
  ]);
  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
  } else {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
