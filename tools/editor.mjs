// npm run editor [-- --json] [--scene] [--port 5173]
//
// What the editor shows now, for whoever works on the project from the command line: the open project and
// scene, what is selected, whether there are unsaved changes, whether Play runs, and the last messages of
// the Console. The open editor page tells the dev server (src/editor/core/report.ts), this asks the server.
//
//   --scene   also print the unsaved scene (or prefab) as JSON: what the editor has and the file has not
//   --json    everything as JSON, every open editor page

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const value = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined)
const port = value('port') ?? process.env.WHITE_PORT ?? '5173'

let pages
try {
  const res = await fetch(`http://localhost:${port}/__api/editor`)
  if (!res.ok) throw new Error(`the server answered ${res.status}`)
  pages = await res.json()
} catch (e) {
  console.error(`No dev server on port ${port} (${e.message}). Start the editor: npm run dev`)
  process.exit(1)
}

if (flag('json')) {
  console.log(JSON.stringify(pages, null, 2))
  process.exit(0)
}
if (pages.length === 0) {
  console.log(`The dev server runs on port ${port}, but no editor page is open (or it has not reported yet): http://localhost:${port}`)
  process.exit(0)
}

// The page that changed last is the one somebody works in
const [page, ...others] = pages
const ago = Math.round((Date.now() - page.at) / 1000)
console.log(`project: ${page.project || '(none open)'}`)
if (page.project) {
  console.log(`${page.editingPrefab ? `prefab:  ${page.editingPrefab} (being edited; the scene behind it is ${page.scene})` : `scene:   ${page.scene}`}${page.dirty ? '  — UNSAVED changes: the file on disk is older than what the editor shows' : ''}`)
  console.log(`look:    ${page.look || '(none)'}`)
  console.log(`play:    ${page.playing ? `${page.paused ? 'paused' : 'running'}${page.playScene ? `, in scene ${page.playScene}` : ''}` : 'stopped'}`)
  console.log(`selected: ${page.selected.length > 0 ? page.selected.map((s) => `${s.name} (${s.id})`).join(', ') : page.asset ? `${page.asset.kind} ${page.asset.name}` : 'nothing'}`)
}
console.log(`status:  ${page.status}`)
console.log(`console: ${page.errors} error(s), ${page.warnings} warning(s)${page.console.length > 0 ? `, the last ${page.console.length} messages:` : ''}`)
for (const entry of page.console) {
  const [first, ...rest] = entry.text.split('\n')
  console.log(`  ${entry.level}: ${first}${entry.count > 1 ? `  (x${entry.count})` : ''}`)
  for (const line of rest.slice(0, 6)) console.log(`      ${line}`)
}
console.log(`(as of ${ago} s ago${others.length > 0 ? `; ${others.length} more editor page(s) open: --json shows all` : ''})`)

if (flag('scene')) {
  if (page.unsaved) console.log(`\nunsaved ${page.editingPrefab ? 'prefab' : 'scene'}:\n${JSON.stringify(page.unsaved, null, 2)}`)
  else console.log('\nNothing unsaved: the file on disk is what the editor shows.')
}
