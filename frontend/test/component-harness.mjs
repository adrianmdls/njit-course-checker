// Socket-free component tests using the installed JSX compiler. This models hook
// state/effects and inspects JSX elements; it does not replace browser testing.
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { transformSync } from 'rolldown/experimental'

export function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export const reply = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data })
const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))

export async function componentHarness(fetch, auth = { refresh() {} }) {
  let active
  const element = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
  const hooks = {
    createContext: () => ({ Provider: 'Provider' }), useContext: () => auth,
    useState(initial) {
      const host = active, index = host.index++
      if (!(index in host.slots)) host.slots[index] = typeof initial === 'function' ? initial() : initial
      return [host.slots[index], value => {
        const next = typeof value === 'function' ? value(host.slots[index]) : value
        if (!Object.is(next, host.slots[index])) { host.slots[index] = next; host.dirty = true }
      }]
    },
    useRef(initial) {
      const host = active, index = host.index++
      return host.slots[index] ??= { current: initial }
    },
    useCallback(callback, deps) {
      const host = active, index = host.index++
      if (!same(host.slots[index]?.deps, deps)) host.slots[index] = { callback, deps }
      return host.slots[index].callback
    },
    useEffect(effect, deps) {
      const host = active, index = host.index++
      if (!same(host.slots[index]?.deps, deps)) {
        const previous = host.slots[index]
        host.slots[index] = { deps }
        host.effects.push(() => { previous?.cleanup?.(); host.slots[index].cleanup = effect() })
      }
    },
  }
  const context = vm.createContext({ fetch, AbortController, URLSearchParams, element })
  const modules = new Map()
  function synthetic(name, values) {
    const module = new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value)
    }, { context })
    modules.set(name, module)
  }
  synthetic('react', hooks)
  synthetic('react-router', { Navigate: 'Navigate', Outlet: 'Outlet' })
  synthetic('lucide-react', { Search: 'Search', BookmarkPlus: 'BookmarkPlus', Check: 'Check', Bookmark: 'Bookmark', Trash2: 'Trash2' })
  async function load(name) {
    if (modules.has(name)) return modules.get(name)
    const file = new URL(name === '../auth' ? '../src/auth.jsx'
      : name === '../components/SearchCourses' ? '../src/components/SearchCourses.jsx' : name, import.meta.url)
    const { code } = transformSync(file.pathname, await readFile(file, 'utf8'), { jsx: { runtime: 'classic', pragma: 'element' } })
    const module = new vm.SourceTextModule(code, { context, identifier: file.href })
    modules.set(name, module)
    await module.link(load)
    return module
  }
  return {
    async mount(name, exported, props = {}) {
      const module = await load(name)
      if (module.status !== 'evaluated') await module.evaluate()
      const host = { slots: [], effects: [], dirty: false, tree: null,
        render() {
          active = host; host.index = 0; host.dirty = false
          host.tree = module.namespace[exported](props)
          for (const effect of host.effects.splice(0)) effect()
        },
        async flush() {
          for (let i = 0; i < 20; i++) {
            await new Promise(resolve => setImmediate(resolve))
            if (!host.dirty) return
            host.render()
          }
          throw new Error('Component did not settle')
        },
        unmount() { for (const slot of host.slots) slot?.cleanup?.() },
        find(predicate) {
          function walk(node) {
            if (!node || typeof node !== 'object') return
            if (predicate(node)) return node
            for (const child of node.props?.children ?? []) { const found = walk(child); if (found) return found }
          }
          const found = walk(host.tree)
          if (!found) throw new Error('Element not found')
          return found
        },
      }
      host.render()
      return host
    },
  }
}
