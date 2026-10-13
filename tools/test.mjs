// The checks of the engine itself (tools/selfTest.ts), without a project and without a browser.
//   npm run test
// `npm run check -- <project>` runs the same checks before it looks at the project.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Vite loads the engine the same way the editor does (TypeScript)
const server = await createServer({ root, server: { middlewareMode: true, ws: false, hmr: false }, appType: 'custom', logLevel: 'error' })
let failures
try {
  failures = (await server.ssrLoadModule('/tools/selfTest.ts')).selfTest()
} finally {
  await server.close()
}

if (failures.length === 0) {
  console.log('engine: OK')
} else {
  for (const failure of failures) console.error(failure)
  console.error(`\nengine: ${failures.length} check(s) failed`)
  process.exit(1)
}
