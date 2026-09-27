// Bundles the extension with esbuild. ESM port of the esbuild.js that generator-code 1.12.0
// emits; the only behavioural change is the `location` guard in the problem-matcher plugin.
//
//   node esbuild.mjs               development build (sourcemap, not minified)
//   node esbuild.mjs --watch       rebuild on change; output is read by the
//                                  connor4312.esbuild-problem-matchers task matcher
//   node esbuild.mjs --production  minified release build
import esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',

  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      });
      console.log('[watch] build finished');
    });
  },
};

async function main() {
  const ctx = await esbuild.context({
    // One entry point for now. The second entry of docs/ARCHITECTURE.md §2
    // (src/webview/goalPanel.ts → dist/goalPanel.js, iife, platform browser) is scoped by
    // docs/ROADMAP.md M0 as a stub entry; M7 replaces the stub with the real goal panel.
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'silent',
    plugins: [
      /* add to the end of plugins array */
      esbuildProblemMatcherPlugin,
    ],
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
