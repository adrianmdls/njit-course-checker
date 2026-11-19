import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observationTime, termLabel } from '../src/utils/courseFormatting.js'
import { positionFloating } from '../src/utils/positionFloating.js'
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

test('Last Checked exposes the section instant on hover, keyboard focus and to screen readers', async () => {
  const harness=await componentHarness(()=>{})
  const host=await harness.mount('../src/components/LastSeen.jsx','default',{timestamp:'2026-11-17T12:00:00Z'})
  const time=host.find(node=>node.type==='time')
  assert.equal(time.props.dateTime,'2026-11-17T12:00:00.000Z')
  assert.equal(time.props.tabIndex,0)
  assert.throws(()=>host.find(node=>node.type==='Clock'), /Element not found/)
  assert.equal(time.props.title, undefined, 'no duplicate native tooltip')
  const tooltip=host.find(node=>node.props.role==='tooltip')
  assert.equal(time.props['aria-controls'],tooltip.props.id)
  assert.ok(time.props['aria-label'].includes(tooltip.props.children.join('')))
  assert.equal(tooltip.props.popover,'auto')
  assert.match(tooltip.props.className,/fixed/)
  host.unmount()
})

test('availability explanation preserves the exact requested copy', async () => {
  const host=await (await componentHarness(()=>{})).mount('../src/components/CourseAvailabilityInfo.jsx','default')
  const text=node=>typeof node==='string'?node:(node?.props?.children??[]).map(text).join('')
  const copy=text(host.tree)
  assert.ok(copy.includes('About Course Availability'))
  assert.ok(!copy.includes('Sections omitted'))
  assert.ok(!copy.includes('Last Seen'))
  assert.ok(copy.includes('Departments with watchlisted courses are checked about every 10 minutes. Other departments are checked less frequently to reduce requests to NJIT Banner.'))
  assert.ok(copy.includes('Last Checked shows when each section was last observed in NJIT Banner.'))
  host.unmount()
})

test('availability popover supports hover, touch activation, pinning and collapsed ARIA state', async () => {
  const window={innerWidth:390,innerHeight:844,addEventListener(){},removeEventListener(){}}
  const host=await (await componentHarness(()=>{},undefined,{window})).mount('../src/components/CourseAvailabilityInfo.jsx','default')
  const trigger=host.find(node=>node.type==='button')
  const panel=host.find(node=>node.props.popover==='auto')
  assert.equal(trigger.props['aria-expanded'],false)
  assert.equal(trigger.props['aria-controls'],panel.props.id)
  assert.equal(trigger.props.popoverTarget,panel.props.id)
  assert.equal(panel.props.role,'region')
  let shows=0,hides=0
  trigger.props.ref.current={getBoundingClientRect:()=>({left:350,bottom:40,top:8})}
  let visible=false
  const popup={style:{},matches:()=>visible,showPopover(){shows++;visible=true},hidePopover(){hides++;visible=false},
    getBoundingClientRect:()=>({width:320,height:180})}
  panel.props.ref.current=popup
  trigger.props.onPointerEnter({pointerType:'touch'})
  assert.equal(shows,0)
  trigger.props.onPointerEnter({pointerType:'mouse'})
  assert.equal(shows,1)
  assert.equal(popup.style.left,'58px', 'popover remains within mobile viewport')
  trigger.props.onClick({preventDefault(){}})
  assert.equal(shows,2, 'first click pins an already hovered popover')
  trigger.props.onClick({preventDefault(){}})
  assert.equal(hides,1)
  panel.props.onToggle({newState:'open'}); await host.flush()
  assert.equal(host.find(node=>node.type==='button').props['aria-expanded'],true)
  panel.props.onToggle({newState:'closed'}); await host.flush()
  assert.equal(host.find(node=>node.type==='button').props['aria-expanded'],false)
  host.unmount()
})


test('floating panels fit viewport edges without affecting their anchor', () => {
  const panel={style:{},getBoundingClientRect:()=>({width:320,height:180})}
  const viewport={innerWidth:390,innerHeight:844}
  for (const top of [20,800,1200,-200]) {
    const anchor={getBoundingClientRect:()=>({left:370,top,bottom:top+24})}
    positionFloating(anchor,panel,viewport)
    assert.equal(panel.style.left,'58px')
    const placed=parseFloat(panel.style.top)
    assert.ok(placed>=12 && placed+180<=832)
  }
})
