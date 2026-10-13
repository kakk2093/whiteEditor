// A headless Chrome or Edge for the commands that need a real browser (WebGL, the editor page):
// `npm run render` and `npm run test`. Set WHITE_BROWSER to the path of another Chromium-based one.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function findBrowser() {
  const candidates = [
    process.env.WHITE_BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ]
  return candidates.find((file) => file && fs.existsSync(file))
}

// Opens the page without a window. `exited` resolves with the exit code if the browser closes by itself;
// close() ends it and removes its profile.
export function openPage(browser, url, { width = 960, height = 540 } = {}) {
  // A profile of its own, so that it is a separate browser and not a tab of the one the user has open
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'white-browser-'))
  const child = spawn(browser, [
    '--headless=new',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
    `--window-size=${width},${height}`,
    url,
  ], { stdio: 'ignore' })
  return {
    exited: new Promise((resolve) => child.once('exit', resolve)),
    close() {
      child.kill()
      // The browser lets go of its files a moment after it is killed
      setTimeout(() => fs.rm(profile, { recursive: true, force: true }, () => {}), 500)
    },
  }
}
