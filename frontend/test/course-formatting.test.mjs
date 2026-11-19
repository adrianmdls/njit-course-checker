import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observationTime, termLabel } from '../src/utils/courseFormatting.js'
import { componentHarness } from './component-harness.mjs'

test('academic terms reuse supported seasons and preserve unknown codes', () => {
  for (const [code, label] of [['202710','Spring 2027'],['202690','Fall 2026'],
    ['202650','Summer 2026'],['202695','Winter 2026–2027'],['202611','202611'],['unknown','unknown']]) {
    assert.equal(termLabel(code), label)
  }
})

test('observation ages use elapsed time across midnight and explicit time zones', () => {
  const now = Date.parse('2026-11-18T00:01:00Z')
  for (const [seconds, label] of [[0,'Just now'],[59,'Just now'],[120,'2 min ago'],
    [2700,'45 min ago'],[3600,'1 hour ago'],[10800,'3 hours ago'],[86400,'1 day ago'],[172800,'2 days ago']]) {
    const value = new Date(now-seconds*1000).toISOString()
    const observation = observationTime(value,now)
    assert.equal(observation.label,label)
    assert.equal(observation.dateTime,value)
    assert.ok(observation.exact)
    assert.equal(observation.note,'', 'old observations do not imply a missed monitoring deadline')
  }
  assert.deepEqual(observationTime('2026-11-17T19:00:00-05:00',now),
    observationTime('2026-11-18T00:00:00Z',now))
})

test('missing, invalid, ambiguous and future observations are explicit', () => {
  const now = Date.parse('2026-11-18T00:00:00Z')
  for (const value of [null,undefined,'',0]) {
    assert.equal(observationTime(value,now).label,'Not recorded')
    assert.equal(observationTime(value,now).dateTime,undefined)
  }
  for (const value of ['invalid','2026-11-17 12:00:00','2026-13-01T00:00:00Z','2026-02-30T00:00:00Z']) {
    assert.equal(observationTime(value,now).label,'Unknown')
    assert.equal(observationTime(value,now).dateTime,undefined)
  }
  const future=observationTime('2026-11-18T00:01:00Z',now)
  assert.equal(future.label,'Future timestamp')
  assert.ok(future.note.includes('clock'))
  assert.equal(future.dateTime,'2026-11-18T00:01:00.000Z')
})

test('Last Seen exposes the section instant on hover, keyboard focus and to screen readers', async () => {
  const harness=await componentHarness(()=>{})
  const host=await harness.mount('../src/components/LastSeen.jsx','default',{timestamp:'2026-11-17T12:00:00Z'})
  const time=host.find(node=>node.type==='time')
  assert.equal(time.props.dateTime,'2026-11-17T12:00:00.000Z')
  assert.equal(time.props.tabIndex,0)
  assert.ok(time.props.title)
  assert.ok(host.find(node=>node.props.className?.includes('sr-only')).props.children.join('').includes(time.props.title))
  assert.ok(host.find(node=>node.props.className?.includes('group-focus:block')))
  host.unmount()
})

test('availability explanation preserves the exact requested copy', async () => {
  const host=await (await componentHarness(()=>{})).mount('../src/components/CourseAvailabilityInfo.jsx','default')
  const text=node=>typeof node==='string'?node:(node?.props?.children??[]).map(text).join('')
  const copy=text(host.tree)
  assert.ok(copy.includes('About Course Availability'))
  assert.ok(copy.includes('To reduce requests to NJIT Banner, departments with watchlisted courses are checked approximately every 10 minutes. Other departments are checked less frequently.'))
  assert.ok(copy.includes('Last Seen shows when each section was last observed in NJIT Banner.'))
  host.unmount()
})
