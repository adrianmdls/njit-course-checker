import { test } from 'node:test'
import assert from 'node:assert/strict'
import { componentHarness, reply } from './component-harness.mjs'

test('inactive watched sections show Unavailable, last seen, and remain removable', async () => {
  const seen = '2026-11-17T12:00:00.000Z'
  const requests = []
  const harness = await componentHarness((url, options) => {
    requests.push({ url, options })
    return Promise.resolve(options.method === 'DELETE' ? reply(204) : reply(200, { sections: [{
      section_id: 42, course: 'CS 100', term: '202710', crn: '01234', section: '001',
      status: 'OPEN', is_active: false, max: 30, now: 20, last_checked_at: seen,
    }] }))
  })
  const host = await harness.mount('../src/pages/Dashboard.jsx', 'default')
  await host.flush()
  const row = host.find(node => node.type === 'tr' && node.props.key === 42)
  const cells = row.props.children
  assert.equal(cells[4].props.children[0], '—')
  assert.equal(cells[5].props.children[0], '—')
  const badge = host.find(node => node.type === 'span' && node.props.children.includes('Unavailable'))
  assert.ok(!badge.props.className.includes('bg-green'))
  assert.equal(cells[2].props.children[0], 'Spring 2027')
  assert.equal(cells[7].props.children[0].props.timestamp, seen)
  assert.ok(host.find(node => node.type === 'th' && node.props.children.includes('Last Seen')))
  const remove = host.find(node => node.type === 'button' && node.props['aria-label']?.startsWith('Remove CS 100'))
  assert.equal(remove.props.disabled, false)
  assert.match(remove.props.title, /Remove CS 100/)
  assert.match(remove.props.className, /focus-visible:outline/)
  assert.ok(host.find(node => node.type === 'h2' && node.props.id === 'watchlist-heading'))
  assert.ok(host.find(node => node.type?.name === 'CourseAvailabilityInfo'))
  await remove.props.onClick(); await host.flush()
  assert.equal(requests.at(-1).url, '/api/watchlist/42')
  assert.equal(requests.at(-1).options.method, 'DELETE')
  assert.ok(host.find(node => node.type === 'p' && node.props.children.includes('Your watchlist is empty.')))
  host.unmount()
})
