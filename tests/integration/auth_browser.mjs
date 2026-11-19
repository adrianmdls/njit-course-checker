// Invoked serially by test_pipeline.py with the identity of its disposable stack.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const { project, origin, containers, profile } = JSON.parse(readFileSync(0, 'utf8'))
const services = ['backend', 'db', 'frontend', 'db-storage']
assert.match(project, /^njit-banner-test-[a-f0-9]{10}$/)
assert.match(origin, /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/)
const port = new URL(origin).port
assert.ok(port, 'The disposable frontend must use an explicit loopback port')
assert.ok(services.every(service => /^[a-f0-9]{64}$/.test(containers?.[service])),
  'The pipeline must supply full container IDs')
assert.ok(typeof profile === 'string' && isAbsolute(profile) && basename(profile).startsWith('njit-browser-test-')
  && readdirSync(profile).length === 0, 'The pipeline must supply a new browser profile directory')
const directory = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '')
const files = ['compose.yaml', 'auth-compose.yaml'].map(name => join(directory, name))
const compose = ['compose', '--env-file', '/dev/null', '-p', project, ...files.flatMap(file => ['-f', file])]
const environment = { ...process.env, INTEGRATION_HTTP_PORT: port }
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', env: environment, timeout: 60000 })
const volume = `${project}_auth-db`

function inspectStack() {
  const ids = services.map(service => containers[service])
  const actual = docker(...compose, 'ps', '-a', '-q', ...services).trim().split(/\s+/)
  assert.deepEqual(actual.sort(), [...ids].sort(), 'Compose must resolve only the supplied containers')
  const inspected = JSON.parse(docker('inspect', '--type', 'container', ...ids))
  const stack = Object.fromEntries(services.map((service, index) => {
    const container = inspected[index]
    const labels = container.Config.Labels
    assert.equal(container.Id, containers[service])
    assert.equal(labels['com.docker.compose.project'], project)
    assert.equal(labels['com.docker.compose.service'], service)
    assert.equal(labels['com.docker.compose.project.working_dir'], directory)
    assert.equal(labels['com.docker.compose.project.config_files'], files.join(','))
    return [service, container]
  }))
  const publish = stack.frontend.NetworkSettings.Ports['80/tcp']
  assert.deepEqual(publish, [{ HostIp: '127.0.0.1', HostPort: port }])
  assert.ok(stack.frontend.State.Running && stack['db-storage'].State.Running)
  assert.equal(stack['db-storage'].HostConfig.NetworkMode, 'none')
  for (const [service, path] of [['db', '/var/lib/mysql'], ['db-storage', '/storage']]) {
    const mount = stack[service].Mounts.find(entry => entry.Destination === path)
    assert.ok(mount?.Type === 'volume' && mount.Name === volume, 'MariaDB must use the owned volume')
    if (service === 'db-storage') assert.equal(mount.RW, false)
  }
  const [storage] = JSON.parse(docker('volume', 'inspect', volume))
  assert.equal(storage.Labels['com.docker.compose.project'], project)
  assert.equal(storage.Options?.type, 'tmpfs')
  for (const setting of ['DB_HOST=db', 'DB_USER=root', 'DB_NAME=njit_course_checker',
    'DB_PASSWORD=integration-only-password', 'APP_ENV=development', `APP_ORIGIN=${origin}`]) {
    assert.ok(stack.backend.Config.Env.includes(setting), 'Backend must use integration settings')
  }
  return stack
}

function ownedCommand(...args) {
  inspectStack()
  return docker(...compose, ...args)
}

function sql(statement, params) {
  const code = `const pool = require('./src/db');
    pool.execute(process.argv[1], JSON.parse(process.argv[2]))
      .then(([rows]) => process.stdout.write(JSON.stringify(rows)))
      .catch(error => { console.error(error.code || 'SQL failed'); process.exitCode = 1; })
      .finally(() => pool.end());`
  return JSON.parse(ownedCommand('exec', '-T', 'backend', 'node', '-e', code, statement, JSON.stringify(params)))
}

async function waitFor(predicate, description, timeout = 10000) {
  const deadline = Date.now() + timeout
  do {
    if (await predicate()) return
    await delay(100)
  } while (Date.now() < deadline)
  throw new Error(`Timed out waiting for ${description}`)
}

async function waitForHealth() {
  await waitFor(async () => {
    try { return (await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) })).ok }
    catch { return false }
  }, 'the disposable frontend health endpoint', 25000)
}

async function restartBackend() {
  const previous = inspectStack().backend.State.StartedAt
  ownedCommand('restart', 'backend')
  await waitForHealth()
  const restarted = inspectStack().backend.State
  assert.ok(restarted.Running && restarted.StartedAt !== previous, 'Backend process actually restarted')
  return restarted.StartedAt
}

// Chrome's DevTools pipe keeps the debugging channel local to this process.
function devTools(chrome, errors) {
  let id = 0
  let buffered = ''
  const pending = new Map()
  const close = error => {
    for (const callback of pending.values()) callback.reject(error)
    pending.clear()
  }
  chrome.on('error', close)
  chrome.stdio[3].on('error', close)
  chrome.stdio[4].on('error', close)
  chrome.on('exit', () => close(new Error('Chrome exited')))
  chrome.stdio[4].setEncoding('utf8').on('data', chunk => {
    buffered += chunk
    let end
    while ((end = buffered.indexOf('\0')) !== -1) {
      const message = JSON.parse(buffered.slice(0, end))
      buffered = buffered.slice(end + 1)
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text)
      const callback = pending.get(message.id)
      if (callback) {
        pending.delete(message.id)
        if (message.error) callback.reject(new Error(message.error.message))
        else callback.resolve(message.result)
      }
    }
  })
  return (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const commandId = ++id
    const timer = setTimeout(() => {
      pending.delete(commandId)
      reject(new Error(`Chrome command timed out: ${method}`))
    }, 15000)
    pending.set(commandId, {
      resolve: result => { clearTimeout(timer); resolve(result) },
      reject: error => { clearTimeout(timer); reject(error) },
    })
    chrome.stdio[3].write(JSON.stringify({ id: commandId, method, params, sessionId }) + '\0')
  })
}

inspectStack()
await restartBackend()
let chrome
try {
  chrome = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ['--headless', '--disable-gpu', '--disable-breakpad', '--disable-crash-reporter',
      '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-pipe', `--user-data-dir=${profile}`, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
  const errors = []
  const cdp = devTools(chrome, errors)
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true })
  const send = (method, params) => cdp(method, params, sessionId)
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.fill = (id, text) => {
      const input = document.getElementById(id)
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    window.button = text => [...document.querySelectorAll('button')].find(node => node.textContent.trim() === text)
  ` })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(`Chrome evaluation failed: ${result.exceptionDetails.text}`)
    return result.result.value
  }
  const waitForPage = (expression, description) => waitFor(async () => {
    try {
      return await evaluate(expression)
    } catch (error) {
      if (/execution context|context with specified id/i.test(error.message)) return false
      throw error
    }
  }, description)
  const onPage = (path, selector) => waitForPage(
    `location.pathname === ${JSON.stringify(path)} && Boolean(document.querySelector(${JSON.stringify(selector)}))`, path)
  const reloadDashboard = async () => {
    const previousDocument = await evaluate('performance.timeOrigin')
    await send('Page.reload')
    await waitForPage(`performance.timeOrigin !== ${previousDocument}
      && location.pathname === '/dashboard' && Boolean(window.button?.('Logout'))`, 'the reloaded dashboard')
  }
  const navigate = path => send('Page.navigate', { url: origin + path })
  const cookie = async () => (await send('Network.getCookies', { urls: [origin] })).cookies.find(row => row.name === 'njit.sid')
  const request = (path, payload) => evaluate(`(async () => {
    const payload = ${JSON.stringify(payload)}
    const response = await fetch(${JSON.stringify(path)}, {
      signal: AbortSignal.timeout(8000),
      ...(payload === undefined ? {} : { method: 'POST',
        headers: { 'X-Requested-With': 'NJIT-Course-Checker', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload) }),
    })
    return { status: response.status, body: await response.json() }
  })()`)
  const auth = (path, payload) => request(`/api/auth/${path}`, payload)
  const username = `auth_fixture_${project.slice(-10)}`
  const email = `${username}@example.invalid`
  const password = 'Disposable browser password 938!'
  const credentials = { username, email, password }

  await navigate('/dashboard')
  await onPage('/login', '#username')
  assert.equal((await auth('me')).status, 401)
  for (const [route, headers] of [
    ['register', { Origin: 'https://unrelated.invalid', 'X-Requested-With': 'NJIT-Course-Checker' }],
    ['login', { Origin: origin }],
  ]) {
    const response = await fetch(`${origin}/api/auth/${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}',
      signal: AbortSignal.timeout(8000),
    })
    assert.equal(response.status, 403)
  }
  assert.equal((await auth('register', { ...credentials, password: 'short' })).status, 400)
  await navigate('/register')
  await onPage('/register', '#register-confirm')
  await evaluate(`fill('register-username', ${JSON.stringify(username)});
    fill('register-email', ${JSON.stringify(email)});
    fill('register-password', ${JSON.stringify(password)});
    fill('register-confirm', ${JSON.stringify(password)});
    document.querySelector('button[type="submit"]').click()`)
  await onPage('/login', '[role="status"]')
  assert.match(await evaluate(`document.querySelector('[role="status"]').textContent`), /Account created/)
  const [user] = sql('SELECT id, LEFT(password_hash, 10) AS hash_prefix, email_verified FROM Users WHERE username=? AND email=?',
    [username, email])
  assert.equal(user.hash_prefix, '$argon2id$')
  assert.equal(user.email_verified, 0)
  const sessions = () => sql('SELECT session_id FROM sessions WHERE JSON_EXTRACT(data, "$.userId")=?', [user.id])
  assert.equal((await auth('register', credentials)).status, 409)
  assert.equal((await auth('login', { identifier: username, password: 'wrong password' })).status, 401)
  await evaluate(`fill('username', ${JSON.stringify(email)}); fill('password', ${JSON.stringify(password)});
    document.querySelector('button[type="submit"]').click()`)
  await onPage('/dashboard', 'button')
  const initial = await cookie()
  assert.ok(initial?.httpOnly)
  assert.equal(initial.sameSite, 'Lax')
  assert.equal(initial.secure, false)
  const assertUser = async () => {
    const restored = await auth('me')
    assert.equal(restored.status, 200)
    assert.equal(restored.body.user.id, user.id)
    assert.equal(restored.body.user.email_verified, false)
  }
  await assertUser()
  const [firstSession] = sessions()
  assert.equal((await auth('login', { identifier: username, password })).status, 200)
  const saved = await cookie()
  assert.ok(saved && saved.value !== initial.value, 'Username login regenerated the browser cookie')
  const currentSessions = sessions()
  assert.equal(currentSessions.length, 1)
  assert.ok(currentSessions[0].session_id !== firstSession.session_id, 'The previous session row was destroyed')
  const assertSession = async () => {
    await assertUser()
    assert.ok((await cookie())?.value === saved.value, 'The browser kept the regenerated cookie')
    const rows = sessions()
    assert.equal(rows.length, 1)
    assert.ok(rows[0].session_id === currentSessions[0].session_id, 'The original session row survived')
  }

  const backendStarted = await restartBackend()
  await assertSession()
  await reloadDashboard()
  console.log('PASS: actual backend restart preserved the browser cookie, account and session row')

  const dbStarted = inspectStack().db.State.StartedAt
  try {
    ownedCommand('stop', 'db')
    assert.equal(inspectStack().db.State.Running, false)
    assert.deepEqual(await auth('me'), { status: 503, body: { error: 'Service temporarily unavailable' } })
    assert.deepEqual(await request('/api/health'), { status: 503, body: { status: 'error', database: 'unavailable' } })
  } finally {
    ownedCommand('start', '--wait', '--wait-timeout', '60', 'db')
    await waitForHealth()
  }
  const recovered = inspectStack()
  assert.ok(recovered.db.State.Running && recovered.db.State.StartedAt !== dbStarted)
  assert.equal(recovered.backend.State.StartedAt, backendStarted)
  await assertSession()
  console.log('PASS: actual MariaDB stop/start returned safe 503 responses and recovered the same session')

  await reloadDashboard()
  await evaluate(`button('Logout').click()`)
  await onPage('/login', '#username')
  assert.equal((await auth('me')).status, 401)
  assert.ok(!(await cookie()), 'Logout removed the browser cookie')
  assert.deepEqual(sessions(), [])
  console.log('PASS: browser route guard, registration, Argon2id, unverified email, mutation guards, validation, both login identifiers, cookie flags, regeneration and logout')

  // The catalog browser scenario already checks the redirect after idle expiry.
  assert.equal((await auth('login', { identifier: username, password })).status, 200)
  await assertUser()
  const [expiringSession] = sessions()
  sql('UPDATE sessions SET data=JSON_SET(data, "$.authenticatedAt", ?) WHERE session_id=?',
    [Date.now() - 9 * 3600000, expiringSession.session_id])
  const beforeExpiryNavigation = await evaluate('performance.timeOrigin')
  await navigate('/dashboard')
  await waitForPage(`performance.timeOrigin !== ${beforeExpiryNavigation}
    && location.pathname === '/login' && Boolean(document.getElementById('username'))`, 'the absolute-expiry redirect')
  assert.equal((await auth('me')).status, 401)
  assert.deepEqual(sessions(), [])
  console.log('PASS: absolute expiry redirected the browser and destroyed the expired session')

  // Restart around the limiter assertions so every request counts from zero
  // and the other browser scenarios receive fresh rate-limit counters.
  await restartBackend()
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await auth('login', { identifier: username, password: 'bad' })).status, 401)
  }
  const limited = { status: 429, body: { error: 'Too many attempts; try again later' } }
  assert.deepEqual(await auth('login', { identifier: username, password: 'bad' }), limited)
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await auth('register', credentials)).status, 409)
  }
  assert.deepEqual(await auth('register', credentials), limited)
  console.log('PASS: fresh backend limits login on attempt 11 and registration on attempt 6')
  assert.deepEqual(errors, [])
} finally {
  try {
    if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) {
      const exited = new Promise(resolve => chrome.once('exit', resolve))
      chrome.kill('SIGTERM')
      await Promise.race([exited, delay(5000, undefined, { ref: false })])
      if (chrome.exitCode === null && chrome.signalCode === null) {
        chrome.kill('SIGKILL')
        await exited
      }
    }
  } finally {
    // Keep rate-limit counters isolated from the subsequent scenarios even
    // when an earlier assertion fails.
    await restartBackend()
  }
}
