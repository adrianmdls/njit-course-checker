// Optional real-browser verification, invoked by test_pipeline.py. Node >=24,
// Chrome/Chromium and Docker are required; no browser framework is installed.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  const watchlistRequests = []
  const errors = []
  ws.onmessage = event => {
    const message = JSON.parse(event.data)
    if (message.method === 'Network.requestWillBeSent' && message.params.request.url.includes('/api/courses?')) {
      requests.push(new URL(message.params.request.url))
    }
    if (message.method === 'Network.requestWillBeSent' && new URL(message.params.request.url).pathname.startsWith('/api/watchlist')) {
      watchlistRequests.push(message.params.request)
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
    window.selectDepartment = async code => {
      document.getElementById('search-department').focus()
      window.setField('search-department',code)
      await new Promise(resolve=>setTimeout(resolve,0))
      document.getElementById('department-option-'+code).click()
    }

  ` })
  if (process.argv[3] !== 'empty') {
    const username = `browser_${Date.now()}`
    await send('Page.navigate', { url: `${origin}/register` })
    await waitFor(`Boolean(document.getElementById('register-confirm'))`)
    await evaluate(`setField('register-username',${JSON.stringify(username)}); setField('register-email',${JSON.stringify(`${username}@example.invalid`)}); setField('register-password','browser-only-test-password'); setField('register-confirm','browser-only-test-password')`)
    await evaluate(`document.querySelector('button[type=submit]').click()`)
    await waitFor(`location.pathname==='/login' && Boolean(document.getElementById('password'))`)
    await evaluate(`setField('username',${JSON.stringify(username)}); setField('password','browser-only-test-password')`)
    await evaluate(`document.querySelector('button[type=submit]').click()`)
    await waitFor(`location.pathname==='/dashboard' && Boolean(button('Logout'))`)
    await evaluate(`button('Logout').click()`)
    await waitFor(`location.pathname==='/login' && Boolean(document.getElementById('password'))`)
    await send('Page.navigate', { url: `${origin}/dashboard` })
    await waitFor(`location.pathname==='/login' && Boolean(document.getElementById('password'))`)
    console.log('PASS browser registration, login, logout, and protected-route session invalidation')
  } else {
    await send('Page.navigate', { url: `${origin}/login` })
  }
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
  assert.ok(await evaluate(`document.querySelector('button[type=submit]').disabled`))
  assert.equal(await evaluate(`document.querySelector('#search-department').getAttribute('role')`), 'combobox')
  assert.equal(await evaluate(`document.querySelector('#search-department').getAttribute('aria-required')`), 'true')
  assert.equal(requests.length, 0, 'loading options never submits an implicit search')
  // Exercise real input, keyboard selection, clearing, and narrow-screen layout.
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await evaluate(`setField('search-term','202710')`)
  await evaluate(`document.querySelector('#search-department').focus(); setField('search-department','COMPUTER sci')`)
  await waitFor(`Boolean(document.getElementById('department-option-CS'))`)
  assert.ok(await evaluate(`document.querySelector('button[type=submit]').disabled`))
  assert.ok(await evaluate(`(()=>{const r=document.querySelector('[role=listbox]').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth})()`))
  await evaluate(`document.querySelector('#search-department').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))`)
  await waitFor(`document.querySelector('#search-department').getAttribute('aria-activedescendant')==='department-option-CS'`)
  await evaluate(`document.querySelector('#search-department').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`)
  await waitFor(`document.querySelector('#search-department').value==='CS — Computer Science' && !document.querySelector('[role=listbox]')`)
  await evaluate(`setField('search-department',document.querySelector('#search-department').value.slice(0,-1))`)
  await waitFor(`Boolean(document.getElementById('department-option-CS')) && document.querySelector('button[type=submit]').disabled`)
  await evaluate(`setField('search-department','cs — computer science')`)
  await waitFor(`document.querySelector('#search-department').value==='cs — computer science' && Boolean(document.getElementById('department-option-CS'))`)
  assert.ok(await evaluate(`document.querySelector('button[type=submit]').disabled`))
  await evaluate(`document.getElementById('department-option-CS').click()`)
  await waitFor(`document.querySelector('#search-department').value==='CS — Computer Science' && !document.querySelector('[role=listbox]')`)
  await evaluate(`document.querySelector('button[aria-label="Clear department"]').click()`)
  await waitFor(`document.querySelector('#search-department').value==='' && document.querySelector('button[type=submit]').disabled`)
  assert.equal(await evaluate(`document.activeElement.id`), 'search-department')
  assert.equal(requests.length, 0, 'combobox interactions never implicitly search')
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  // Spring 2027 requires an explicit department, including without a course query.
  await evaluate(`setField('search-term','202710'); setField('search-number',''); setField('search-status','')`)
  await evaluate(`selectDepartment('CS')`)
  await evaluate(`document.querySelector('button[type=submit]').click()`)
  await waitFor(`document.querySelectorAll('tbody tr').length===50`)
  assert.deepEqual(Object.fromEntries(requests.at(-1).searchParams), {
    term:'202710', subject:'CS', sort:'course', order:'asc', limit:'50', offset:'0',
  })
  assert.equal(responses.at(-1).response.status, 200)
  const raw = await send('Network.getResponseBody', { requestId: responses.at(-1).requestId })
  const unfiltered = JSON.parse(raw.base64Encoded ? Buffer.from(raw.body, 'base64').toString() : raw.body)
  assert.deepEqual(unfiltered.pagination, { limit:50, offset:0, total:53 })
  console.log('Spring department request:', requests.at(-1).search, 'HTTP', responses.at(-1).response.status, JSON.stringify(unfiltered.pagination))
  await evaluate(`document.querySelector('#search-department').focus(); document.querySelector('#search-department').click()`)
  await waitFor(`Boolean(document.querySelector('[role=listbox]'))`)
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('[role=option]')].map(option=>option.id)`), ['department-option-CS'])
  await evaluate(`setField('search-term','202795')`)
  await waitFor(`document.querySelectorAll('tbody tr').length===0 && !button('Next')`)
  assert.equal(await evaluate(`document.querySelector('#search-department').value`), '')
  assert.ok(await evaluate(`document.querySelector('button[type=submit]').disabled`))
  await evaluate(`document.querySelector('#search-department').focus(); document.querySelector('#search-department').click()`)
  await waitFor(`Boolean(document.querySelector('[role=listbox]'))`)
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('[role=option]')].map(option=>option.id)`), ['department-option-IT'])
  assert.equal(await evaluate(`document.querySelector('#search-number').value`), '')
  const searchesBeforeDepartment = requests.length
  await evaluate(`selectDepartment('IT')`)
  await evaluate(`document.querySelector('button[type=submit]').click()`)
  await waitFor(`document.querySelectorAll('tbody tr').length===2`)
  assert.equal(requests.length, searchesBeforeDepartment + 1)
  assert.equal(requests.at(-1).searchParams.get('subject'), 'IT')
  await evaluate(`setField('search-term','202710')`)
  await waitFor(`Boolean(document.getElementById('search-term'))`)
  await evaluate(`setField('search-number',' cs  100 '); setField('search-sort','crn'); setField('search-order','asc')`)
  await evaluate(`selectDepartment('CS')`)
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
  await waitFor(`Boolean(button('Add')) && !button('Add').disabled`)
  await send('Network.setBlockedURLs', { urls: [`${origin}/api/watchlist`] })
  await evaluate(`button('Add').click()`)
  await waitFor(`document.body.textContent.includes('Unable to update your watchlist')`)
  assert.ok(await evaluate(`!button('Added') && !button('Add').disabled`))
  await send('Network.setBlockedURLs', { urls: [] })
  const addsBefore = watchlistRequests.filter(request => request.method === 'POST').length
  await evaluate(`button('Add').click(); button('Add').click()`)
  await waitFor(`Boolean(button('Added')?.disabled)`)
  assert.equal(watchlistRequests.filter(request => request.method === 'POST').length, addsBefore + 1)

  await evaluate(`button('Next').click()`)
  await waitFor(`document.querySelectorAll('tbody tr').length===3 && document.body.textContent.includes('Page 2')`)
  assert.equal(requests.at(-1).searchParams.get('offset'), '50')
  assert.ok(await evaluate(`button('Next').disabled && !button('Previous').disabled && document.body.textContent.includes('53 matching results')`))
  const searchesBeforeReselect = requests.length
  await evaluate(`document.querySelector('#search-department').focus(); document.querySelector('#search-department').click()`)
  await waitFor(`Boolean(document.getElementById('department-option-CS'))`)
  await evaluate(`document.getElementById('department-option-CS').click()`)
  await waitFor(`!document.querySelector('[role=listbox]')`)
  assert.equal(await evaluate(`document.querySelectorAll('tbody tr').length`), 3)
  assert.ok(await evaluate(`document.body.textContent.includes('Page 2') && button('Next').disabled && !button('Previous').disabled`))
  assert.equal(requests.length, searchesBeforeReselect, 'same-department selection preserves the existing page without a request')
  await evaluate(`button('Previous').click()`)
  await waitFor(`document.querySelectorAll('tbody tr').length===50`)
  await evaluate(`setField('search-status','CANCELLED')`)
  await evaluate(`document.querySelector('button[type=submit]').click()`)
  await waitFor(`document.querySelectorAll('tbody tr').length===17`)
  assert.equal(requests.at(-1).searchParams.get('status'), 'CANCELLED')
  assert.ok(await evaluate(`[...document.querySelectorAll('tbody tr')].every(row=>row.children[5].textContent.trim()==='Cancelled')`))
  await evaluate(`setField('search-number','99999'); setField('search-status','')`)
  await evaluate(`document.querySelector('button[type=submit]').click()`)
  await waitFor(`document.body.textContent.includes('No matching course sections found')`)
  assert.ok(await evaluate(`button('Previous').disabled && button('Next').disabled`))
  // Real watchlist persistence, stored status, retryable loading/removal errors.
  await evaluate(`button('Watchlist').click()`)
  await waitFor(`document.querySelectorAll('tbody tr').length===1 && !document.body.textContent.includes('Loading your watchlist')`)
  const watchRow = await evaluate(`[...document.querySelector('tbody tr').children].map(cell=>cell.textContent.trim())`)
  assert.deepEqual(watchRow.slice(0,4), ['12000','CS 100','202710','000'])
  assert.equal(watchRow[6], 'Open')
  // Fixture-only activity changes exercise the real watchlist UI; transactional
  // omission/reactivation is independently covered by the API lifecycle test.
  const sectionId = unfiltered.sections[0].id
  const setActivity = active => execFileSync('docker', ['exec', process.env.INTEGRATION_BACKEND_CONTAINER, 'node', '-e',
    "const pool=require('./src/db'); pool.execute('UPDATE Sections SET is_active=? WHERE id=?',JSON.parse(process.argv[1])).finally(()=>pool.end())",
    JSON.stringify([active, sectionId])], { timeout: 15000 })
  try {
    setActivity(false)
    await send('Page.reload')
    await waitFor(`document.querySelectorAll('tbody tr').length===1 && document.body.textContent.includes('Unavailable')`)
    assert.ok(await evaluate(`document.body.textContent.includes('Last Seen')`))
    assert.ok(await evaluate(`!document.querySelector('button[aria-label^="Remove CS 100"]').disabled`))
    await evaluate(`button('Search Courses').click()`)
    await waitFor(`Boolean(document.querySelector('#search-term option[value="202710"]'))`)
    await evaluate(`setField('search-term','202710')`)
    await evaluate(`selectDepartment('CS')`)
    await evaluate(`document.querySelector('button[type=submit]').click()`)
    await waitFor(`document.body.textContent.includes('52 matching results')`)
    assert.ok(await evaluate(`[...document.querySelectorAll('tbody tr')].every(row=>row.children[0].textContent.trim()!=='12000')`))
  } finally {
    setActivity(true)
  }
  await evaluate(`button('Watchlist').click()`)
  await waitFor(`document.querySelectorAll('tbody tr').length===1 && document.querySelector('tbody tr').children[6].textContent.trim()==='Open'`)
  await send('Page.reload')
  await waitFor(`location.pathname==='/dashboard' && document.querySelectorAll('tbody tr').length===1 && !document.body.textContent.includes('Loading your watchlist')`)
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await writeFile(join(tmpdir(), 'njit-phase3-watchlist-desktop.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await writeFile(join(tmpdir(), 'njit-phase3-watchlist-mobile.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await evaluate(`button('Search Courses').click()`)
  await waitFor(`Boolean(document.querySelector('#search-term option[value="202710"]')) && !document.body.textContent.includes('Loading your watchlist')`)
  await evaluate(`setField('search-term','202710')`)
  await evaluate(`selectDepartment('CS')`)
  await evaluate(`document.querySelector('button[type=submit]').click()`)
  await waitFor(`Boolean(button('Added')?.disabled)`)
  await evaluate(`button('Watchlist').click()`)
  await waitFor(`document.querySelectorAll('tbody tr').length===1 && !document.body.textContent.includes('Loading your watchlist')`)
  await send('Network.setBlockedURLs', { urls: [`${origin}/api/watchlist`] })
  await send('Page.reload')
  await waitFor(`Boolean(button('Retry watchlist'))`)
  assert.ok(await evaluate(`document.body.textContent.includes('Unable to load your watchlist')`))
  await send('Network.setBlockedURLs', { urls: [] })
  await evaluate(`button('Retry watchlist').click()`)
  await waitFor(`document.querySelectorAll('tbody tr').length===1 && !document.body.textContent.includes('Loading your watchlist')`)
  const removeButton = `document.querySelector('button[aria-label^="Remove CS 100"]')`
  await send('Network.setBlockedURLs', { urls: [`${origin}/api/watchlist/${sectionId}`] })
  await evaluate(`${removeButton}.click()`)
  await waitFor(`document.body.textContent.includes('Unable to update your watchlist')`)
  assert.equal(await evaluate(`document.querySelectorAll('tbody tr').length`), 1)
  await send('Network.setBlockedURLs', { urls: [] })
  await evaluate(`${removeButton}.click()`)
  await waitFor(`document.body.textContent.includes('Your watchlist is empty.')`)
  await send('Page.reload')
  await waitFor(`location.pathname==='/dashboard' && document.body.textContent.includes('Your watchlist is empty.')`)
  // Expire the actual database session; leave its signed browser cookie intact.
  execFileSync('docker', ['exec', process.env.INTEGRATION_BACKEND_CONTAINER, 'node', '-e',
    "const pool=require('./src/db'); pool.query('UPDATE sessions SET expires=1').finally(()=>pool.end())"], { timeout: 15000 })
  // Search and watchlist loading both retain session-expiry handling.
  await evaluate(`button('Search Courses').click()`)
  await waitFor(`location.pathname==='/login' && Boolean(document.getElementById('password'))`)
  assert.deepEqual(errors, [])
  assert.ok(requests.every(url => url.searchParams.get('subject')), 'every search specifies a department')
  console.log('PASS real React → Nginx → Express → MariaDB: catalog options/retry, mandatory departments, term switching, Spring search, parameters, rows, statuses/nulls, persistent Add/reload/Remove, inactive watch/search, watchlist retries, duplicate-click protection, pagination, empty results, session expiry')
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
