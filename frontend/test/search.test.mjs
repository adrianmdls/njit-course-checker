import { test } from 'node:test'
import assert from 'node:assert/strict'
import { componentHarness, deferred, reply } from './component-harness.mjs'

const section = { id: 7, course: 'CS 100', crn: '01234', status: 'OPEN' }
const result = { sections: [section], pagination: { limit: 50, offset: 0, total: 75 } }
const field = (host, id) => host.find(node => node.props.id === id)
const button = (host, text) => host.find(node => node.type === 'button' && node.props.children.includes(text))
const submit = host => host.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
async function setup() {
  const requests = [], added = []
  const harness = await componentHarness((url, options) => {
    if (url.endsWith('/options')) return Promise.resolve(reply(200, { terms: [
      { code: '202710', departments: ['CS', 'IT'] }, { code: '202690', departments: ['IT'] },
    ] }))
    const request = { url, options, ...deferred() }
    requests.push(request)
    return request.promise
  })
  const host = await harness.mount('../src/components/SearchCourses.jsx', 'default', {
    courses: [], watchlistReady: true, pendingId: null, onAdd: row => added.push(row),
  })
  await host.flush()
  return { host, requests, added }
}
async function select(host, id, value) {
  field(host, id).props.onChange({ target: { value } })
  await host.flush()
}

test('search requires an explicitly selected department from the current catalog', async () => {
  const { host, requests } = await setup()
  const placeholder = host.find(node => node.type === 'option' && node.props.value === '' && node.props.children.includes('Select department'))
  assert.equal(placeholder.props.disabled, true)
  assert.equal(button(host, 'Search Courses').props.disabled, true)
  submit(host)
  assert.equal(requests.length, 0)
  await select(host, 'search-department', 'ECE')
  submit(host)
  assert.equal(requests.length, 0, 'an unavailable department cannot submit even programmatically')
  await select(host, 'search-department', 'CS')
  assert.equal(button(host, 'Search Courses').props.disabled, false)
  submit(host)
  assert.equal(new URL(requests[0].url, 'http://test.invalid').searchParams.get('subject'), 'CS')
  host.unmount()
})

test('term change resets an unavailable department, clears pagination, and preserves other filters', async () => {
  const { host, requests } = await setup()
  for (const [id, value] of [['search-department', 'CS'], ['search-number', '100'],
    ['search-status', 'OPEN'], ['search-sort', 'availability'], ['search-order', 'desc']]) await select(host, id, value)
  submit(host); requests[0].resolve(reply(200, result)); await host.flush()
  assert.ok(button(host, 'Next'))
  await select(host, 'search-term', '202690')
  assert.equal(field(host, 'search-department').props.value, '')
  assert.equal(field(host, 'search-number').props.value, '100')
  assert.equal(field(host, 'search-status').props.value, 'OPEN')
  assert.equal(field(host, 'search-sort').props.value, 'availability')
  assert.equal(field(host, 'search-order').props.value, 'desc')
  assert.throws(() => button(host, 'Next'), /Element not found/)
  submit(host)
  assert.equal(requests.length, 1)
  assert.equal(button(host, 'Search Courses').props.disabled, true)
  await select(host, 'search-department', 'IT')
  submit(host)
  const params = new URL(requests[1].url, 'http://test.invalid').searchParams
  assert.equal(params.get('term'), '202690')
  assert.equal(params.get('offset'), '0')
  assert.equal(params.get('subject'), 'IT')
  requests[1].resolve(reply(200, { ...result, sections: [] })); await host.flush()
  host.unmount()
})

test('term change preserves a department that is available in both terms', async () => {
  const { host, requests } = await setup()
  await select(host, 'search-department', 'IT')
  await select(host, 'search-term', '202690')
  assert.equal(field(host, 'search-department').props.value, 'IT')
  assert.equal(button(host, 'Search Courses').props.disabled, false)
  submit(host)
  const params = new URL(requests[0].url, 'http://test.invalid').searchParams
  assert.equal(params.get('subject'), 'IT')
  assert.equal(params.get('term'), '202690')
  await select(host, 'search-term', '209910')
  submit(host)
  assert.equal(button(host, 'Search Courses').props.disabled, true)
  assert.equal(requests.length, 1, 'an unknown term cannot submit')
  host.unmount()
})

test('department change clears displayed results without changing the other filters', async () => {
  const { host, requests } = await setup()
  for (const [id, value] of [['search-department', 'CS'], ['search-number', '100'],
    ['search-status', 'OPEN'], ['search-sort', 'crn'], ['search-order', 'desc']]) await select(host, id, value)
  submit(host)
  requests[0].resolve(reply(200, result)); await host.flush()
  assert.ok(button(host, 'Add'))
  await select(host, 'search-department', 'IT')
  assert.throws(() => button(host, 'Add'), /Element not found/)
  assert.throws(() => button(host, 'Next'), /Element not found/)
  for (const [id, value] of [['search-term', '202710'], ['search-number', '100'],
    ['search-status', 'OPEN'], ['search-sort', 'crn'], ['search-order', 'desc']]) {
    assert.equal(field(host, id).props.value, value)
  }
  assert.equal(requests.length, 1, 'selection changes never automatically search')
  host.unmount()
})

test('old fetch response cannot restore previous-term results even when abort is ignored', async () => {
  const { host, requests } = await setup()
  await select(host, 'search-department', 'CS')
  submit(host); await host.flush()
  await select(host, 'search-term', '202690')
  assert.equal(requests[0].options.signal.aborted, true)
  await select(host, 'search-department', 'IT')
  submit(host)
  requests[1].resolve(reply(200, { sections: [], pagination: { limit: 50, offset: 0, total: 0 } }))
  await host.flush()
  requests[0].resolve(reply(200, result)); await host.flush()
  assert.throws(() => button(host, 'Add'), /Element not found/)
  assert.equal(button(host, 'Next').props.disabled, true)
  host.unmount()
})

test('term change also invalidates a response waiting on JSON parsing', async () => {
  const { host, requests } = await setup(), body = deferred()
  await select(host, 'search-department', 'IT')
  submit(host)
  requests[0].resolve({ status: 200, ok: true, json: () => body.promise })
  await host.flush()
  await select(host, 'search-term', '202690')
  body.resolve(result); await host.flush()
  assert.throws(() => button(host, 'Add'), /Element not found/)
  assert.equal(button(host, 'Search Courses').props.disabled, false)
  host.unmount()
})

for (const delayedBody of [false, true]) {
  test(`department change clears results and ignores delayed ${delayedBody ? 'JSON parsing' : 'fetch'} from the old department`, async () => {
    const { host, requests } = await setup(), body = deferred()
    await select(host, 'search-department', 'CS')
    submit(host)
    requests[0].resolve(reply(200, result)); await host.flush()
    button(host, 'Next').props.onClick(); await host.flush()
    if (delayedBody) {
      requests[1].resolve({ status: 200, ok: true, json: () => body.promise })
      await host.flush()
    }
    await select(host, 'search-department', 'IT')
    assert.equal(requests[1].options.signal.aborted, true)
    assert.throws(() => button(host, 'Next'), /Element not found/)
    submit(host)
    const params = new URL(requests[2].url, 'http://test.invalid').searchParams
    assert.equal(params.get('subject'), 'IT')
    assert.equal(params.get('offset'), '0')
    requests[2].resolve(reply(200, { sections: [], pagination: { limit: 50, offset: 0, total: 0 } }))
    await host.flush()
    if (delayedBody) body.resolve(result)
    else requests[1].resolve(reply(200, result))
    await host.flush()
    assert.throws(() => button(host, 'Add'), /Element not found/)
    assert.equal(button(host, 'Next').props.disabled, true)
    host.unmount()
  })
}

test('same-term pagination and watchlist Add retain the section identity', async () => {
  const { host, requests, added } = await setup()
  await select(host, 'search-department', 'CS')
  submit(host); requests[0].resolve(reply(200, result)); await host.flush()
  button(host, 'Add').props.onClick()
  assert.equal(added[0].id, section.id)
  button(host, 'Next').props.onClick()
  assert.equal(new URL(requests[1].url, 'http://test.invalid').searchParams.get('offset'), '50')
  requests[1].resolve(reply(200, result)); await host.flush()
  host.unmount()
})
