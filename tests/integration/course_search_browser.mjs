// Optional real-browser verification, invoked by test_pipeline.py. Node >=24,
// Chrome/Chromium and Docker are required; no browser framework is installed.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const origin = process.argv[2]
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/)
assert.ok(process.env.INTEGRATION_BACKEND_CONTAINER)
const profile = await mkdtemp(join(tmpdir(), 'njit-course-search-'))
const chrome = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'])
let ws
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome startup timed out')), 15000)
    chrome.once('error', error => { clearTimeout(timer); reject(error) })
    chrome.once('exit', code => { clearTimeout(timer); reject(new Error(`Chrome exited: ${code}`)) })
    chrome.stderr.on('data', data => {
      const match = String(data).match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) { clearTimeout(timer); resolve(new URL(match[1])) }
    })
  })
  const targets = await (await fetch(`http://${endpoint.host}/json/list`)).json()
  ws = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let id = 0
  const pending = new Map()
  const requests = []
  const errors = []
  ws.onmessage = event => {
    const message = JSON.parse(event.data)
    if (message.method === 'Network.requestWillBeSent' && message.params.request.url.includes('/api/courses?')) {
      requests.push(new URL(message.params.request.url))
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (!message.id) return
    const callback = pending.get(message.id)
    pending.delete(message.id)
    message.error ? callback.reject(new Error(JSON.stringify(message.error))) : callback.resolve(message.result)
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const waitFor = async expression => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const page = await evaluate('({url:location.href, text:document.body?.innerText.slice(0,1200)})')
    throw new Error(`Timed out: ${expression}; page=${JSON.stringify(page)}; runtime=${JSON.stringify(errors)}`)
  }
  await send('Runtime.enable')
  await send('Network.enable')
  await send('Page.enable')
  // Helpers dispatch real UI events. No requests or responses are mocked.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.setField = (id,value) => {
      const node = document.getElementById(id)
      Object.getOwnPropertyDescriptor(node.tagName==='SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype,'value').set.call(node,value)
      node.dispatchEvent(new Event(node.tagName==='SELECT' ? 'change' : 'input',{bubbles:true}))
    }
    window.button = text => [...document.querySelectorAll('button')].find(node=>node.textContent.trim()===text)
  ` })
  await send('Page.navigate', { url: `${origin}/login` })
  await waitFor(`Boolean(document.getElementById('password'))`)
  await evaluate(`setField('username','course_search_fixture'); setField('password','integration-only-search-password')`)
  await evaluate(`document.querySelector('button[type=submit]').click()`)
  await waitFor(`location.pathname==='/dashboard' && Boolean(button('Search Courses'))`)
  await evaluate(`button('Search Courses').click()`)
  await waitFor(`Boolean(document.getElementById('search-term'))`)
  await evaluate(`setField('search-department','CS'); setField('search-number',' cs  100 '); setField('search-sort','crn'); setField('search-order','asc')`)
  await evaluate(`document.querySelector('button[type=submit]').click()`)
  await waitFor(`document.querySelectorAll('tbody tr').length===50`)
  assert.deepEqual(Object.fromEntries(requests.at(-1).searchParams), {
    term:'202710', subject:'CS', query:'CS 100', sort:'crn', order:'asc', limit:'50', offset:'0',
  })
  const rows = await evaluate(`[...document.querySelectorAll('tbody tr')].map(row=>[...row.children].map(cell=>cell.textContent.trim()))`)
  assert.equal(rows[0][0], '12000')
  assert.equal(rows[0][1], 'CS 100')
  assert.deepEqual(rows[0].slice(3,6), ['—','—','Open'])
  assert.equal(rows[1][5], 'Closed')
  assert.equal(rows[2][5], 'Cancelled')
  assert.ok(await evaluate(`button('Previous').disabled && !button('Next').disabled`))
  await evaluate(`button('Add').click()`)
  await waitFor(`Boolean(button('Added')?.disabled)`)
  await evaluate(`button('Next').click()`)
  await waitFor(`document.querySelectorAll('tbody tr').length===3 && document.body.textContent.includes('Page 2')`)
  assert.equal(requests.at(-1).searchParams.get('offset'), '50')
  assert.ok(await evaluate(`button('Next').disabled && !button('Previous').disabled && document.body.textContent.includes('53 matching results')`))
  await evaluate(`button('Previous').click()`)
  await waitFor(`document.querySelectorAll('tbody tr').length===50`)
  await evaluate(`setField('search-status','CANCELLED')`)
  await evaluate(`document.querySelector('button[type=submit]').click()`)
  await waitFor(`document.querySelectorAll('tbody tr').length===17`)
  assert.equal(requests.at(-1).searchParams.get('status'), 'CANCELLED')
  assert.ok(await evaluate(`[...document.querySelectorAll('tbody tr')].every(row=>row.children[5].textContent.trim()==='Cancelled')`))
  await evaluate(`setField('search-department','PHIL'); setField('search-number',''); setField('search-status','')`)
  await evaluate(`document.querySelector('button[type=submit]').click()`)
  await waitFor(`document.body.textContent.includes('No matching course sections found')`)
  assert.ok(await evaluate(`button('Previous').disabled && button('Next').disabled`))
  // Expire the actual database session; leave its signed browser cookie intact.
  execFileSync('docker', ['exec', process.env.INTEGRATION_BACKEND_CONTAINER, 'node', '-e',
    "const pool=require('./src/db'); pool.query('UPDATE sessions SET expires=1').finally(()=>pool.end())"], { timeout: 15000 })
  await evaluate(`document.querySelector('button[type=submit]').click()`)
  await waitFor(`location.pathname==='/login' && Boolean(document.getElementById('password'))`)
  assert.deepEqual(errors, [])
  console.log('PASS real React → Nginx → Express → MariaDB: login, parameters, synchronized rows, statuses/nulls, watchlist Add, pagination, empty results, expired session')
} finally {
  ws?.close()
  if (chrome.pid && chrome.exitCode === null) {
    const exited = new Promise(resolve => chrome.once('exit', resolve))
    chrome.kill('SIGTERM')
    await exited
  }
  await rm(profile, { recursive: true, force: true })
}
