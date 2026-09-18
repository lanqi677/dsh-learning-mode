import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'lmprobe-'))
const mod = await import('../lib/index.js')
const registered = []
const ctx = {
  effect: (fn) => fn(),
  on: () => () => {},
  tools: { register: (t) => registered.push(t) },
  systemPrompt: { section: () => () => {}, context: () => () => {} },
  inject: (names, cb) => cb({ effect: (f) => f(), webServer: { register: () => () => {} }, sessions: { get: () => ({}) } }),
  agents: { currentInitiator: () => undefined },
}
mod.apply(ctx)
console.log('name=', mod.name, 'inject=', JSON.stringify(mod.inject))
console.log('tools=', registered.length)
console.log('tool0 keys=', JSON.stringify(Object.keys(registered[0])))
console.log('names=', JSON.stringify(registered.map((t) => t.name)))
