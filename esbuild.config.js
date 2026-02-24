import esbuild from 'esbuild'
import { chmodSync } from 'fs'

const shouldWatch = process.argv.includes('--watch') || process.argv.includes('-w') ||
  process.env.WATCH === "1"

const chmodPlugin = {
  name: 'chmod',
  setup(build) {
    build.onEnd(result => {
      if (result.errors.length > 0) return
      const outfile = build.initialOptions.outfile
      try {
        chmodSync(outfile, 0o755)
      } catch (err) {
        console.error(`chmod failed for ${outfile}:`, err.message)
      }
    })
  }
}

const ctx = await esbuild.context({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "dist/bundle/protoc-gen-solidity.mjs",
  sourcemap: true,
  minify: false,
  banner: {
    js: [
      "#!/usr/bin/env node",
      // "import { createRequire } from 'module';",
      // "import { fileURLToPath } from 'url';",
      // "import { dirname } from 'path';",
      // "const require = createRequire(import.meta.url);",
      // "const __filename = fileURLToPath(import.meta.url);",
      // "const __dirname = dirname(__filename);",
    ].join("\n")
  },
  external: [],
  logLevel: "info",
  plugins: [chmodPlugin]
})

if (shouldWatch) {
  await ctx.watch()
} else {
  await ctx.rebuild()
  await ctx.dispose()
}
