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
  assert.ok(host.find(node => node.type === 'th' && node.props.children.includes('Last Checked')))
  const remove = host.find(node => node.type === 'button' && node.props['aria-label']?.startsWith('Remove CS 100'))
  assert.equal(remove.props.disabled, false)
  assert.match(cells[4].props.className,/text-right/)
  assert.match(cells[5].props.className,/text-right/)
  for (const index of [0,1,2,3]) assert.match(cells[index].props.className,/text-left/)
  for (const index of [6,7,8,9]) assert.match(cells[index].props.className,/text-center/)
  for (const label of ['Status','Last Checked','Notify','Remove']) assert.match(host.find(node=>node.type==='th' && node.props.children.includes(label)).props.className,/text-center/)
  assert.match(remove.props.className,/mx-auto/)
  const notify=host.find(node=>node.type==='button' && node.props['aria-label']==='Email notifications coming soon')
  assert.equal(notify.props.disabled,true)
  assert.equal(notify.props.onClick,undefined)
  const help=host.find(node=>node.props.id===notify.props['aria-describedby'])
  assert.ok(help.props.children.join('').includes('not yet available'))
  const wrapper=host.find(node=>node.props.role==='group' && node.props['aria-label']==='Email notifications coming soon')
  assert.equal(wrapper.props.tabIndex,0)
  assert.ok(wrapper.props.title)
  assert.equal(requests.length,1, 'placeholder adds no API calls')
  assert.ok(host.find(node=>node.type==='colgroup'))
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

test('watchlist preserves varied course codes, terms, statuses and historical observations', async () => {
  const fixtures=[
    {section_id:1,course:'CS 100',term:'202710',status:'OPEN',last_checked_at:'2000-01-01T00:00:00Z'},
    {section_id:2,course:'MATH 333A',term:'202695',status:'CLOSED',last_checked_at:'2026-11-17T01:00:00Z'},
    {section_id:3,course:'LONGCODE 1234567890',term:'202611',status:'CANCELLED',last_checked_at:null},
  ].map(row=>({...row,is_active:true,crn:'01234',section:'H01',max:40,now:30}))
  const host=await (await componentHarness(()=>Promise.resolve(reply(200,{sections:fixtures})))).mount('../src/pages/Dashboard.jsx','default')
  await host.flush()
  for (const [index,term] of ['Spring 2027','Winter 2026–2027','202611'].entries()) {
    const row=host.find(node=>node.type==='tr' && node.props.key===index+1)
    assert.equal(row.props.children[1].props.children[0].props.children[0],fixtures[index].course)
    assert.equal(row.props.children[2].props.children[0],term)
    assert.equal(row.props.children[7].props.children[0].props.timestamp,fixtures[index].last_checked_at)
    assert.equal(row.props.children.length,10)
  }
  host.unmount()
})
