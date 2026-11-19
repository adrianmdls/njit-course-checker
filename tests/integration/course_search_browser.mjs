// Optional real-browser verification, invoked by test_pipeline.py. Node >=24,
// Chrome/Chromium and Docker are required; no browser framework is installed.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const origin = process.argv[2]
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/)
const { backendContainer, profile } = JSON.parse(readFileSync(0, 'utf8'))
assert.match(backendContainer, /^[a-f0-9]{64}$/)
assert.ok(typeof profile === 'string' && isAbsolute(profile) && basename(profile).startsWith('njit-browser-test-')
  && readdirSync(profile).length === 0, 'The pipeline must supply a new browser profile directory')
const chrome = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless', '--disable-gpu', '--disable-breakpad', '--disable-crash-reporter',
    '--no-first-run', '--no-default-browser-check',
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
  let restorationPaused
  ws.onmessage = event => {
    const message = JSON.parse(event.data)
    if (message.method === 'Fetch.requestPaused') restorationPaused?.resolve(message.params)
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
  // Delay real server responses at Chrome's response boundary. Chrome applies
  // the actual Set-Cookie headers; no response body or header is replaced.
  const sessionCookie = async () => (await send('Network.getCookies', { urls: [origin] })).cookies
    .find(cookie => cookie.name === 'njit.sid')
  await send('Fetch.enable', { patterns: [{ urlPattern: `${origin}/api/auth/me?race=1`, requestStage: 'Response' }] })
  try {
    for (const order of ['login-first', 'restoration-first']) {
      const oldCookie = await sessionCookie()
      restorationPaused = Promise.withResolvers()
      await evaluate(`window.restorationResult=null; void fetch('/api/auth/me?race=1').then(r=>{window.restorationResult=r.status}); true`)
      let timer
      const paused = await Promise.race([restorationPaused.promise,
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Restoration did not pause')), 10000) })])
        .finally(() => clearTimeout(timer))
      assert.equal(paused.responseStatusCode, 200)
      assert.ok(!paused.responseHeaders.some(header => header.name.toLowerCase() === 'set-cookie'), 'restoration must never replace a login cookie')
      if (order === 'restoration-first') {
        await send('Fetch.continueResponse', { requestId: paused.requestId })
        await waitFor('window.restorationResult===200')
      }
      assert.equal(await evaluate(`fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'NJIT-Course-Checker'},body:JSON.stringify({identifier:'course_search_fixture',password:'integration-only-search-password'})}).then(r=>r.status)`), 200)
      const newCookie = await sessionCookie()
      assert.notEqual(newCookie.value, oldCookie.value, 'login regenerates the browser cookie')
      if (order === 'login-first') {
        await send('Fetch.continueResponse', { requestId: paused.requestId })
        await waitFor('window.restorationResult===200')
      }
      assert.equal((await sessionCookie()).value, newCookie.value, 'Chrome retains the authenticated cookie in either response order')
      assert.equal(await evaluate(`fetch('/api/auth/me').then(r=>r.status)`), 200)
    }
  } finally {
    await send('Fetch.disable')
  }
  console.log('PASS Chrome cookie jar with delayed restoration/login responses in both orders')
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
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('thead th')].map(node=>node.textContent.trim())`),
    ['CRN','Course','Section','Capacity','Enrolled','Status','Last Checked','Watchlist'])
  assert.equal(await evaluate(`document.querySelector('tbody tr time').dateTime`), unfiltered.sections[0].last_checked_at)
  assert.ok(await evaluate(`document.body.textContent.includes('About Course Availability') && document.body.textContent.includes('Last Checked shows when each section was last observed in NJIT Banner.')`))
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const infoButton = `document.querySelector('button[aria-label="About Course Availability"]')`
  const infoOpen = `Boolean(document.querySelector('[popover]:popover-open'))`
  assert.equal(await evaluate(infoOpen), false)
  await evaluate(`${infoButton}.focus()`)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await waitFor(infoOpen)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await waitFor(`!${infoOpen}`)
  await evaluate(`${infoButton}.click()`)
  await waitFor(infoOpen)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 20, y: 100, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 20, y: 100, button: 'left', clickCount: 1 })
  await waitFor(`!${infoOpen}`)
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  await evaluate(`${infoButton}.scrollIntoView({block:'center'})`)
  const touch = await evaluate(`(()=>{const r=${infoButton}.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] })
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await waitFor(infoOpen)
  assert.ok(await evaluate(`(()=>{const r=document.querySelector('[popover]:popover-open').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight})()`))
  const outsideTouch = await evaluate(`(()=>{const r=document.querySelector('h2').getBoundingClientRect();return {x:r.left+2,y:r.top+r.height/2}})()`)
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [outsideTouch] })
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await waitFor(`!${infoOpen}`)
  await send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  console.log('PASS availability popover keyboard/Escape, outside click, touch activation/dismissal, and mobile bounds')
  const rowBefore = await evaluate(`(()=>{const r=document.querySelector('tbody tr').getBoundingClientRect();return {height:r.height,width:r.width}})()`)
  await evaluate(`document.querySelector('tbody tr time').focus()`)
  await waitFor(`Boolean(document.querySelector('[role=tooltip]:popover-open'))`)
  assert.ok(await evaluate(`(()=>{const time=document.querySelector('tbody tr time'),tip=document.querySelector('[role=tooltip]:popover-open');return time===document.activeElement && !time.hasAttribute('title') && time.getAttribute('aria-label').includes(tip.textContent.trim())})()`))
  assert.deepEqual(await evaluate(`(()=>{const r=document.querySelector('tbody tr').getBoundingClientRect();return {height:r.height,width:r.width}})()`), rowBefore, 'floating exact time cannot resize table rows or columns')
  await send('Input.dispatchKeyEvent', { type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27 })
  await send('Input.dispatchKeyEvent', { type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27 })
  await waitFor(`!document.querySelector('[role=tooltip]:popover-open')`)
  await evaluate(`document.activeElement.blur(); window.scrollTo(0,0)`)
  await writeFile(join(tmpdir(), 'njit-course-ux-search-desktop.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  assert.ok(await evaluate(`document.documentElement.scrollWidth<=innerWidth`))
  await writeFile(join(tmpdir(), 'njit-course-ux-search-mobile.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
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
  assert.deepEqual(watchRow.slice(0,4), ['12000','CS 100','Spring 2027','000'])
  assert.equal(watchRow[6], 'Open')
  assert.ok(await evaluate(`document.querySelector('button[aria-label="Email notifications coming soon"]').disabled`))
  await evaluate(`document.querySelector('[role=group][aria-label="Email notifications coming soon"]').focus()`)
  assert.ok(await evaluate(`(()=>{const wrapper=document.activeElement;return wrapper.getAttribute('role')==='group' && document.getElementById(wrapper.getAttribute('aria-describedby')).textContent.includes('not yet available')})()`))

  assert.deepEqual(await evaluate(`[...document.querySelectorAll('thead th')].map(node=>node.textContent.trim())`),
    ['CRN','Course','Term','Section','Capacity','Enrolled','Status','Last Checked','Notify','Remove'])
  assert.ok(await evaluate(`document.getElementById('watchlist-heading').textContent==='Watchlist (1)' && document.body.textContent.includes('About Course Availability')`))
  for (const width of [1440,768,390]) {
    await send('Emulation.setDeviceMetricsOverride', {width,height:900,deviceScaleFactor:1,mobile:width<768})
    await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
    const layout=await evaluate(`(()=>{
      const table=document.querySelector('table'),headers=[...table.querySelectorAll('th')],cells=[...table.querySelector('tbody tr').children];
      return {overflow:document.documentElement.scrollWidth>innerWidth,
        widths:headers.map(node=>node.getBoundingClientRect().width/table.getBoundingClientRect().width),
        alignment:cells.map(node=>getComputedStyle(node).textAlign),
        centers:[6,7,8,9].map(i=>{const content=i===6?cells[i].querySelector('span'):i===7?cells[i].querySelector('time'):cells[i].querySelector('button');const a=headers[i].getBoundingClientRect(),b=content.getBoundingClientRect();return Math.abs(a.left+a.width/2-b.left-b.width/2)})}
    })()`)
    assert.equal(layout.overflow,false)
    assert.deepEqual(layout.alignment,['left','left','left','left','right','right','center','center','center','center'])
    assert.ok(layout.centers.every(delta=>delta<1),JSON.stringify(layout))
    const proportions=[8,13,13,9,9,9,10,14,9,6]
    assert.ok(layout.widths.every((value,i)=>Math.abs(value-proportions[i]/100)<0.005))
  }
  await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false})
  // Fixture-only activity changes exercise the real watchlist UI; transactional
  // omission/reactivation is independently covered by the API lifecycle test.
  const sectionId = unfiltered.sections[0].id
  const setActivity = active => execFileSync('docker', ['exec', backendContainer, 'node', '-e',
    "const pool=require('./src/db'); pool.execute('UPDATE Sections SET is_active=? WHERE id=?',JSON.parse(process.argv[1])).finally(()=>pool.end())",
    JSON.stringify([active, sectionId])], { timeout: 15000 })
  try {
    setActivity(false)
    await send('Page.reload')
    await waitFor(`document.querySelectorAll('tbody tr').length===1 && document.body.textContent.includes('Unavailable')`)
    assert.ok(await evaluate(`document.body.textContent.includes('Last Checked')`))
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
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
  await evaluate(`window.scrollTo(0,0)`)
  assert.ok(await evaluate(`document.documentElement.scrollWidth<=innerWidth`))
  const watchRowHeight = await evaluate(`document.querySelector('tbody tr').getBoundingClientRect().height`)
  await evaluate(`document.querySelector('tbody tr time').focus()`)
  await waitFor(`Boolean(document.querySelector('[role=tooltip]:popover-open'))`)
  assert.equal(await evaluate(`document.querySelector('tbody tr').getBoundingClientRect().height`),watchRowHeight)
  assert.ok(await evaluate(`(()=>{const r=document.querySelector('[role=tooltip]:popover-open').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`))
  await evaluate(`document.activeElement.blur()`)
  await waitFor(`!document.querySelector('[role=tooltip]:popover-open')`)
  await evaluate(`document.querySelector('table').parentElement.scrollLeft=0;window.scrollTo(0,0)`)
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
  await evaluate(`${removeButton}.focus()`)
  assert.ok(await evaluate(`${removeButton}===document.activeElement && Boolean(${removeButton}.title)`))
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await waitFor(`document.body.textContent.includes('Your watchlist is empty.')`)
  await send('Page.reload')
  await waitFor(`location.pathname==='/dashboard' && document.body.textContent.includes('Your watchlist is empty.')`)
  // Expire the actual database session; leave its signed browser cookie intact.
  execFileSync('docker', ['exec', backendContainer, 'node', '-e',
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
  if (chrome.pid && chrome.exitCode === null && chrome.signalCode === null) {
    const exited = new Promise(resolve => chrome.once('exit', resolve))
    chrome.kill('SIGTERM')
    await Promise.race([exited, delay(5000, undefined, { ref: false })])
    if (chrome.exitCode === null && chrome.signalCode === null) {
      chrome.kill('SIGKILL')
      await exited
    }
  }
}
