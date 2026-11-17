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
  const responses = []
  const errors = []
  ws.onmessage = event => {
    const message = JSON.parse(event.data)
    if (message.method === 'Network.requestWillBeSent' && message.params.request.url.includes('/api/courses?')) {
      requests.push(new URL(message.params.request.url))
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method === 'Network.responseReceived' && message.params.response.url.includes('/api/courses?')) responses.push(message.params)
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
  // A failed metadata request must leave a safe, retryable UI. All successful
  // responses below still come from the real backend, without interception.
  await send('Network.setBlockedURLs', { urls: [`${origin}/api/courses/options`] })
  await evaluate(`button('Search Courses').click()`)
  await waitFor(`Boolean(button('Retry catalog options'))`)
  assert.ok(await evaluate(`document.querySelector('button[type=submit]').disabled`))
  await send('Network.setBlockedURLs', { urls: [] })
  await evaluate(`button('Retry catalog options').click()`)
  if (process.argv[3] === 'empty') {
    await waitFor(`document.body.textContent.includes('No searchable local catalog data')`)
    assert.ok(await evaluate(`document.querySelector('button[type=submit]').disabled`))
    assert.ok(await evaluate(`document.querySelector('#search-term').disabled`))
    assert.equal(requests.length, 0)
    assert.deepEqual(errors, [])
    console.log('PASS empty local catalog: explanatory message, disabled search, no course search requests')
  } else {
  await waitFor(`Boolean(document.querySelector('#search-term option[value="202710"]'))`)
  // Reproduce Spring 2027 / All Departments / no query / All Statuses explicitly.
  await evaluate(`setField('search-term','202710'); setField('search-department',''); setField('search-number',''); setField('search-status','')`)
  await evaluate(`document.querySelector('button[type=submit]').click()`)
  await waitFor(`document.querySelectorAll('tbody tr').length===50`)
  assert.deepEqual(Object.fromEntries(requests.at(-1).searchParams), {
    term:'202710', sort:'course', order:'asc', limit:'50', offset:'0',
  })
  assert.equal(responses.at(-1).response.status, 200)
  const raw = await send('Network.getResponseBody', { requestId: responses.at(-1).requestId })
  const unfiltered = JSON.parse(raw.base64Encoded ? Buffer.from(raw.body, 'base64').toString() : raw.body)
  assert.deepEqual(unfiltered.pagination, { limit:50, offset:0, total:53 })
  console.log('Spring unfiltered request:', requests.at(-1).search, 'HTTP', responses.at(-1).response.status, JSON.stringify(unfiltered.pagination))
  assert.deepEqual(await evaluate(`[...document.querySelector('#search-department').options].map(option=>option.value)`), ['', 'CS'])
  await evaluate(`setField('search-department','CS'); setField('search-term','202795')`)
  assert.equal(await evaluate(`document.querySelector('#search-department').value`), '')
  assert.deepEqual(await evaluate(`[...document.querySelector('#search-department').options].map(option=>option.value)`), ['', 'IT'])
  // Paging the still-visible results must keep the submitted Spring filters.
  await evaluate(`button('Next').click()`)
  await waitFor(`document.querySelectorAll('tbody tr').length===3`)
  assert.equal(requests.at(-1).searchParams.get('term'), '202710')
  await evaluate(`setField('search-term','202710')`)
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
  await evaluate(`setField('search-department',''); setField('search-number','99999'); setField('search-status','')`)
  await evaluate(`document.querySelector('button[type=submit]').click()`)
  await waitFor(`document.body.textContent.includes('No matching course sections found')`)
  assert.ok(await evaluate(`button('Previous').disabled && button('Next').disabled`))
  // Expire the actual database session; leave its signed browser cookie intact.
  execFileSync('docker', ['exec', process.env.INTEGRATION_BACKEND_CONTAINER, 'node', '-e',
    "const pool=require('./src/db'); pool.query('UPDATE sessions SET expires=1').finally(()=>pool.end())"], { timeout: 15000 })
  // Reopening Search exercises expiry handling on the metadata endpoint itself.
  await evaluate(`button('Watchlist').click()`)
  await evaluate(`button('Search Courses').click()`)
  await waitFor(`location.pathname==='/login' && Boolean(document.getElementById('password'))`)
  assert.deepEqual(errors, [])
  console.log('PASS real React → Nginx → Express → MariaDB: catalog options/retry, term-dependent departments, unfiltered Spring, parameters, rows, statuses/nulls, Add, pagination snapshots, empty results, metadata session expiry')
  }
} finally {
  ws?.close()
  if (chrome.pid && chrome.exitCode === null) {
    const exited = new Promise(resolve => chrome.once('exit', resolve))
    chrome.kill('SIGTERM')
    await exited
  }
  await rm(profile, { recursive: true, force: true })
}
