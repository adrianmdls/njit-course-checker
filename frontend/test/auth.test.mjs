import { test } from 'node:test'
import assert from 'node:assert/strict'
import { componentHarness, deferred, reply } from './component-harness.mjs'

const user = { id: 1, username: 'watcher' }
async function provider(me) {
  const harness = await componentHarness(url => url.endsWith('/me') ? me.promise
    : Promise.resolve(url.endsWith('/logout') ? reply(204) : reply(200, { user })))
  return harness.mount('../src/auth.jsx', 'AuthProvider')
}

test('delayed /me 401 cannot undo successful login or change settled loading', async () => {
  const me = deferred(), host = await provider(me)
  await host.tree.props.value.login('watcher', 'password')
  await host.flush()
  const refresh = host.tree.props.value.refresh
  me.resolve(reply(401, { error: 'Expired' }))
  await host.flush()
  assert.equal(host.tree.props.value.user, user)
  assert.equal(host.tree.props.value.loading, false)
  assert.equal(host.tree.props.value.error, '')
  assert.equal(host.tree.props.value.refresh, refresh)
  host.unmount()
})

test('delayed /me success cannot restore the user after logout', async () => {
  const me = deferred(), host = await provider(me)
  await host.tree.props.value.login('watcher', 'password')
  await host.flush()
  assert.equal(host.tree.props.value.user, user)
  await host.tree.props.value.logout()
  me.resolve(reply(200, { user }))
  await host.flush()
  assert.equal(host.tree.props.value.user, null)
  assert.equal(host.tree.props.value.loading, false)
  assert.equal(host.tree.props.value.error, '')
  host.unmount()
})

test('only the latest overlapping session check can update authentication', async () => {
  const first = deferred(), second = deferred()
  let calls = 0
  const harness = await componentHarness(() => (++calls === 1 ? first : second).promise)
  const host = await harness.mount('../src/auth.jsx', 'AuthProvider')
  const latest = host.tree.props.value.refresh()
  second.resolve(reply(200, { user }))
  await latest; await host.flush()
  first.resolve(reply(503, { error: 'Old failure' })); await host.flush()
  assert.equal(host.tree.props.value.user, user)
  assert.equal(host.tree.props.value.error, '')
  assert.equal(host.tree.props.value.loading, false)
  host.unmount()
})

test('/me 503 followed by successful login clears the previous error', async () => {
  const me = deferred(), host = await provider(me)
  me.resolve(reply(503, { error: 'Unavailable' }))
  await host.flush()
  assert.match(host.tree.props.value.error, /Unable to check/)
  await host.tree.props.value.login('watcher', 'password')
  await host.flush()
  assert.equal(host.tree.props.value.user, user)
  assert.equal(host.tree.props.value.error, '')
  assert.equal(host.tree.props.value.loading, false)
  host.unmount()
})

test('initial session restoration sets the user and completes loading', async () => {
  const me = deferred(), host = await provider(me)
  assert.equal(host.tree.props.value.loading, true)
  me.resolve(reply(200, { user }))
  await host.flush()
  assert.equal(host.tree.props.value.user, user)
  assert.equal(host.tree.props.value.loading, false)
  assert.equal(host.tree.props.value.error, '')
  host.unmount()
})
