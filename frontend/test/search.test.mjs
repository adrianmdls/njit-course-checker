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
      { code: '202710', departments: ['CS'] }, { code: '202690', departments: ['IT'] },
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

test('term change clears results/pagination and preserves all other filters', async () => {
  const { host, requests } = await setup()
  for (const [id, value] of [['search-department', 'CS'], ['search-number', '100'],
    ['search-status', 'OPEN'], ['search-sort', 'availability'], ['search-order', 'desc']]) await select(host, id, value)
  submit(host); requests[0].resolve(reply(200, result)); await host.flush()
  assert.ok(button(host, 'Next'))
  await select(host, 'search-term', '202690')
  assert.equal(field(host, 'search-department').props.value, 'CS')
  assert.equal(field(host, 'search-number').props.value, '100')
  assert.equal(field(host, 'search-status').props.value, 'OPEN')
  assert.equal(field(host, 'search-sort').props.value, 'availability')
  assert.equal(field(host, 'search-order').props.value, 'desc')
  assert.throws(() => button(host, 'Next'), /Element not found/)
  submit(host)
  const params = new URL(requests[1].url, 'http://test.invalid').searchParams
  assert.equal(params.get('term'), '202690')
  assert.equal(params.get('offset'), '0')
  assert.equal(params.get('subject'), 'CS')
  requests[1].resolve(reply(200, { ...result, sections: [] })); await host.flush()
  host.unmount()
})

test('old fetch response cannot restore previous-term results even when abort is ignored', async () => {
  const { host, requests } = await setup()
  submit(host); await host.flush()
  await select(host, 'search-term', '202690')
  assert.equal(requests[0].options.signal.aborted, true)
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
  submit(host)
  requests[0].resolve({ status: 200, ok: true, json: () => body.promise })
  await host.flush()
  await select(host, 'search-term', '202690')
  body.resolve(result); await host.flush()
  assert.throws(() => button(host, 'Add'), /Element not found/)
  assert.equal(button(host, 'Search Courses').props.disabled, false)
  host.unmount()
})

test('same-term pagination and watchlist Add retain the section identity', async () => {
  const { host, requests, added } = await setup()
  submit(host); requests[0].resolve(reply(200, result)); await host.flush()
  button(host, 'Add').props.onClick()
  assert.equal(added[0].id, section.id)
  button(host, 'Next').props.onClick()
  assert.equal(new URL(requests[1].url, 'http://test.invalid').searchParams.get('offset'), '50')
  requests[1].resolve(reply(200, result)); await host.flush()
  host.unmount()
})
