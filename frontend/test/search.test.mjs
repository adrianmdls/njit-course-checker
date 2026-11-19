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
      { code: '202710', departments: ['CS', 'IT', 'MATH', 'ZZZ'] }, { code: '202690', departments: ['IT'] },
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
  if (id === 'search-department') {
    const option = (() => { try { return host.find(node => node.props.id === `department-option-${value}`) } catch { return null } })()
    if (option) { option.props.onClick(); await host.flush() }
  }
}

test('search requires an explicitly selected department from the current catalog', async () => {
  const { host, requests } = await setup()
  assert.equal(field(host, 'search-department').props.placeholder, 'Select department')
  assert.equal(field(host, 'search-department').props['aria-required'], 'true')
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
  assert.equal(field(host, 'search-department').props.value, 'IT — Information Technology')
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

const typeDepartment = async (host, text) => {
  field(host, 'search-department').props.onChange({ target: { value: text } })
  await host.flush()
}
const keyDepartment = async (host, key) => {
  let prevented = false
  field(host, 'search-department').props.onKeyDown({ key, preventDefault() { prevented = true } })
  await host.flush()
  return prevented
}

test('combobox filters API departments by code or full name without accepting free text', async () => {
  const { host, requests } = await setup()
  field(host, 'search-department').props.onFocus(); await host.flush()
  assert.equal(field(host, 'search-department').props['aria-expanded'], true)
  assert.ok(field(host, 'department-option-ZZZ'), 'unknown API codes remain selectable')
  await typeDepartment(host, 'cS')
  assert.ok(field(host, 'department-option-CS'))
  assert.throws(() => field(host, 'department-option-IT'), /Element not found/)
  submit(host)
  assert.equal(requests.length, 0, 'even an exact code must be explicitly selected')
  await typeDepartment(host, 'COMPUTER sci')
  assert.ok(field(host, 'department-option-CS'))
  await typeDepartment(host, 'Math')
  assert.ok(field(host, 'department-option-MATH'))
  await typeDepartment(host, 'unavailable department')
  assert.equal(button(host, 'Search Courses').props.disabled, true)
  assert.ok(host.find(node => node.props.role === 'status' && node.props.children.includes('No matching departments')))
  assert.equal(await keyDepartment(host, 'Enter'), true)
  submit(host); assert.equal(requests.length, 0)
  host.unmount()
})

test('combobox selection and clearing preserve focus and invalidate delayed results', async () => {
  const { host, requests } = await setup()
  await select(host, 'search-department', 'CS')
  assert.equal(field(host, 'search-department').props.value, 'CS — Computer Science')
  assert.equal(field(host, 'search-department').props['aria-expanded'], false)
  submit(host); await host.flush()
  let focused = false
  field(host, 'search-department').props.ref.current = { focus() { focused = true } }
  host.find(node => node.props['aria-label'] === 'Clear department').props.onClick()
  await host.flush()
  assert.equal(focused, true)
  assert.equal(field(host, 'search-department').props.value, '')
  assert.equal(button(host, 'Search Courses').props.disabled, true)
  assert.equal(requests[0].options.signal.aborted, true)
  requests[0].resolve(reply(200, result)); await host.flush()
  assert.throws(() => button(host, 'Add'), /Element not found/)
  await select(host, 'search-department', 'IT')
  await typeDepartment(host, 'CS')
  submit(host); assert.equal(requests.length, 1, 'editing a selection invalidates it immediately')
  host.unmount()
})

test('combobox supports arrows, Enter, Escape, and blur without implicit selection', async () => {
  const { host, requests } = await setup()
  assert.equal(await keyDepartment(host, 'ArrowDown'), true)
  assert.equal(field(host, 'search-department').props['aria-activedescendant'], 'department-option-CS')
  await keyDepartment(host, 'ArrowDown')
  assert.equal(field(host, 'search-department').props['aria-activedescendant'], 'department-option-IT')
  await keyDepartment(host, 'Enter')
  assert.equal(field(host, 'search-department').props.value, 'IT — Information Technology')
  assert.equal(field(host, 'search-department').props['aria-expanded'], false)
  await keyDepartment(host, 'ArrowUp')
  assert.equal(field(host, 'search-department').props['aria-activedescendant'], 'department-option-ZZZ')
  await keyDepartment(host, 'Escape')
  assert.equal(field(host, 'search-department').props['aria-activedescendant'], undefined)
  assert.equal(field(host, 'search-department').props.value, 'IT — Information Technology')
  await typeDepartment(host, 'Math')
  assert.equal(await keyDepartment(host, 'Tab'), false)
  host.find(node => Boolean(node.props.onBlur)).props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null })
  await host.flush()
  assert.equal(field(host, 'search-department').props['aria-expanded'], false)
  submit(host); assert.equal(requests.length, 0)
  host.unmount()
})

for (const number of ['', '490']) {
  test(`optional course number ${number || '(empty)'} preserves department, status, and sorting`, async () => {
    const { host, requests } = await setup()
    await select(host, 'search-department', 'IT')
    await select(host, 'search-number', number)
    await select(host, 'search-status', 'OPEN')
    await select(host, 'search-sort', 'availability')
    await select(host, 'search-order', 'desc')
    assert.equal(field(host, 'search-number').props.placeholder, 'e.g., 280, 340, 490')
    assert.ok(host.find(node => node.type === 'label' && node.props.children.includes('Course Number (Optional)')))
    submit(host)
    const params = new URL(requests[0].url, 'http://test.invalid').searchParams
    assert.equal(params.get('subject'), 'IT')
    assert.equal(params.get('query'), number || null)
    assert.equal(params.get('status'), 'OPEN')
    assert.equal(params.get('sort'), 'availability')
    assert.equal(params.get('order'), 'desc')
    host.unmount()
  })
}

for (const edit of [false, true]) {
  test(`${edit ? 'editing' : 'pasting'} a displayed department label matches without selecting free text`, async () => {
    const { host, requests } = await setup()
    await select(host, 'search-department', 'CS')
    const label = field(host, 'search-department').props.value
    await typeDepartment(host, edit ? label.slice(0, -1) : label.toUpperCase().replace(' — ', '  —  '))
    assert.ok(field(host, 'department-option-CS'))
    assert.throws(() => field(host, 'department-option-IT'), /Element not found/)
    assert.equal(button(host, 'Search Courses').props.disabled, true)
    submit(host); assert.equal(requests.length, 0)
    field(host, 'department-option-CS').props.onClick(); await host.flush()
    assert.equal(field(host, 'search-department').props.value, label)
    assert.equal(button(host, 'Search Courses').props.disabled, false)
    host.unmount()
  })
}

test('reselecting the current department closes the list and preserves results and pagination', async () => {
  const { host, requests } = await setup()
  await select(host, 'search-department', 'CS')
  submit(host); requests[0].resolve(reply(200, result)); await host.flush()
  button(host, 'Next').props.onClick()
  requests[1].resolve(reply(200, { ...result, pagination: { ...result.pagination, offset: 50 } })); await host.flush()
  field(host, 'search-department').props.onFocus(); await host.flush()
  field(host, 'department-option-CS').props.onClick(); await host.flush()
  assert.equal(field(host, 'search-department').props['aria-expanded'], false)
  assert.ok(button(host, 'Add'))
  assert.equal(button(host, 'Previous').props.disabled, false)
  assert.equal(button(host, 'Next').props.disabled, true)
  assert.equal(requests.length, 2, 'reselection never submits another search')
  button(host, 'Previous').props.onClick()
  const params = new URL(requests[2].url, 'http://test.invalid').searchParams
  assert.equal(params.get('subject'), 'CS')
  assert.equal(params.get('offset'), '0')
  host.unmount()
})

test('reselecting the current department does not abort an in-flight page', async () => {
  const { host, requests } = await setup()
  await select(host, 'search-department', 'CS')
  submit(host); await host.flush()
  field(host, 'search-department').props.onFocus(); await host.flush()
  field(host, 'department-option-CS').props.onClick(); await host.flush()
  assert.equal(requests[0].options.signal.aborted, false)
  requests[0].resolve(reply(200, result)); await host.flush()
  assert.ok(button(host, 'Add'))
  host.unmount()
})

for (const code of ['IT', '']) {
  test(`${code ? 'selecting a different department' : 'clearing a department'} still invalidates displayed results`, async () => {
    const { host, requests } = await setup()
    await select(host, 'search-department', 'CS')
    submit(host); requests[0].resolve(reply(200, result)); await host.flush()
    assert.ok(button(host, 'Add'))
    if (code) {
      field(host, 'search-department').props.onFocus(); await host.flush()
      field(host, 'department-option-IT').props.onClick()
    } else host.find(node => node.props['aria-label'] === 'Clear department').props.onClick()
    await host.flush()
    assert.throws(() => button(host, 'Add'), /Element not found/)
    assert.throws(() => button(host, 'Next'), /Element not found/)
    assert.equal(button(host, 'Search Courses').props.disabled, !code)
    if (code) {
      submit(host)
      const params = new URL(requests[1].url, 'http://test.invalid').searchParams
      assert.equal(params.get('subject'), 'IT')
      assert.equal(params.get('offset'), '0')
    }
    host.unmount()
  })
}

test('search tables expose section observations, consistent headers and availability guidance', async () => {
  const { host, requests, added } = await setup()
  await select(host, 'search-department', 'CS')
  submit(host)
  const seen = '2000-01-01T00:00:00.000Z'
  requests[0].resolve(reply(200, { ...result, sections: [
    { ...section, last_checked_at: seen }, { ...section, id: 8, last_checked_at: null },
  ] }))
  await host.flush()
  for (const label of ['Capacity','Enrolled','Last Seen','Watchlist']) {
    assert.ok(host.find(node=>node.type==='th' && node.props.children.includes(label)))
  }
  const observed=host.find(node=>node.type==='tr' && node.props.key===7)
  const missing=host.find(node=>node.type==='tr' && node.props.key===8)
  assert.equal(observed.props.children[6].props.children[0].props.timestamp,seen)
  assert.equal(missing.props.children[6].props.children[0].props.timestamp,null)
  assert.ok(host.find(node=>node.type?.name==='CourseAvailabilityInfo'))
  button(host,'Add').props.onClick()
  assert.equal(added[0].last_checked_at,seen)
  host.unmount()
})
