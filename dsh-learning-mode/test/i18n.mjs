/**
 * i18n 完整性与一致性守卫（离线、纯静态 + 字典互查）。
 *
 * 这个文件回答四个"漏了就会静默出错"的问题：
 *   ① 代码里 `t('…')` / `T('…')` 用到的每个 key，字典里都有吗？
 *      （缺了的话英文界面会直接露出中文 —— 而且**不会报错**。）
 *   ② 英文表的值是不是真的英文？（有人复制粘贴忘了翻，值还是中文。）
 *   ③ 占位符对齐吗？（key 有 `{done}` 而英文值漏了 `{done}` → 界面上少一个数字，
 *      比报错更难发现。）
 *   ④ 字典里有重复 key 吗？（对象字面量里重复 key 不报错，后一个静默覆盖前一个。）
 *
 * ⚠️ 为什么用"中文原文当 key"：见 lib/i18n.js 文件头。代价是代码里有中文串，
 * 收益是**漏翻必被本文件抓住**，且中文路径零改动。
 *
 * 浏览器半边的字典不能 import（client.js 不是 ESM），所以这里用大括号配对把
 * `var EN = { … }` 的字面量切出来求值 —— 只求值一个纯字符串字面量，不做任何执行。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { EN as HOST_EN, ZH as HOST_ZH, translate, pickLocale } from '../lib/i18n.js'

const here = dirname(fileURLToPath(import.meta.url))
const lib = join(here, '..', 'lib')

let failures = 0
const check = (label, cond, extra) => {
  if (cond) console.log('  ok  ' + label)
  else { failures += 1; console.log('  FAIL ' + label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 300))) }
}

const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/

/** 收集字符串里 `{name}` 形式的占位符，排序后拼成可比较的字符串。 */
function placeholders(text) {
  const found = []
  const re = /\{(\w+)\}/g
  let m
  while ((m = re.exec(String(text))) !== null) found.push(m[1])
  return found.sort().join(',')
}

/** 从源码里切出 `var <name> = { … }` 的对象字面量文本（跳过字符串内的括号）。 */
function sliceObjectLiteral(source, decl) {
  const start = source.indexOf(decl)
  if (start < 0) return null
  const open = source.indexOf('{', start + decl.length - 1)
  if (open < 0) return null
  let depth = 0
  let i = open
  let quote = ''
  while (i < source.length) {
    const c = source[i]
    if (quote !== '') {
      if (c === '\\') { i += 2; continue }
      if (c === quote) quote = ''
      i += 1
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; i += 1; continue }
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
    i += 1
  }
  return null
}

/**
 * 把源码里的转义还原成**运行时真实字符串**。
 * ⚠️ 这一步不能省：`t('…\n…')` 在运行时那个 `\n` 是**真实换行**，
 * 而字典的 key（JS 字面量）也是真实换行 —— 若这里按源码原文比对，
 * 会把同一个 key 比成两个不同的字符串（曾真的把 `{index}. {path}（{when}）\n   {note}`
 * 这条判成"字典里没有"，而其实运行时取值完全正常）。
 */
function unescapeLiteral(raw) {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (match, esc) => {
    if (esc === 'n') return '\n'
    if (esc === 't') return '\t'
    if (esc === 'r') return '\r'
    if (esc === '0') return '\0'
    if (esc[0] === 'u' || esc[0] === 'x') {
      const hex = esc[0] === 'u' ? esc.replace(/^u\{?|\}?$/g, '') : esc.slice(1)
      try { return String.fromCodePoint(parseInt(hex, 16)) } catch { return match }
    }
    return esc
  })
}

/** 收集源码里所有 `t('…')` / `T('…')` 的第一个参数（只看含中文的那些），已按运行时语义解转义。 */
function collectCallKeys(source) {
  const keys = []
  // 前面不能是标识符字符或 `.`（避免匹配 obj.t(...) / export.t(...)）
  const re = /(?:^|[^\w$.])[tT]\(\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1/g
  let m
  while ((m = re.exec(source)) !== null) {
    const raw = unescapeLiteral(m[2])
    if (CJK.test(raw)) keys.push(raw)
  }
  return keys
}

// ══ 1. 宿主侧字典（lib/i18n.js） ═════════════════════════════════════════════
const hostFiles = ['index.js', 'store.js', 'summary.js']
const hostKeys = []
for (const f of hostFiles) {
  for (const k of collectCallKeys(readFileSync(join(lib, f), 'utf8'))) hostKeys.push({ file: f, key: k })
}
const hostUnique = [...new Set(hostKeys.map((x) => x.key))]
console.log('宿主侧：' + hostFiles.join('/') + ' 用到 ' + hostUnique.length + ' 个 key')

const missingHost = hostUnique.filter((k) => typeof HOST_EN[k] !== 'string')
check('宿主侧每个 t(…) key 都在 EN 字典里（缺了英文界面会露中文）', missingHost.length === 0, missingHost)

const notEnglishHost = Object.entries(HOST_EN).filter(([, v]) => CJK.test(String(v)))
check('宿主侧 EN 字典的值都不是中文（漏翻会原样留着中文）', notEnglishHost.length === 0, notEnglishHost.map(([k]) => k))

const badPhHost = Object.entries(HOST_EN).filter(([k, v]) => placeholders(k) !== placeholders(v))
check('宿主侧占位符对齐（key 与英文值的 {name} 集合一致）', badPhHost.length === 0,
  badPhHost.map(([k, v]) => ({ key: k, want: placeholders(k), got: placeholders(v) })))

// 中文表必须是恒等：dsh-client-locale 的取值链里 zh 的 fallback 就是 en，
// zh 表缺 key 会让**中文界面显示英文**。
const zhBroken = Object.keys(HOST_EN).filter((k) => HOST_ZH[k] !== k)
check('宿主侧 ZH 表是恒等映射（否则中文界面会掉到英文）', zhBroken.length === 0, zhBroken)

// ══ 2. 浏览器侧字典（lib/client.js 内嵌） ════════════════════════════════════
const clientSource = readFileSync(join(lib, 'client.js'), 'utf8')
const literal = sliceObjectLiteral(clientSource, 'var EN =')
check('能从 client.js 里切出 EN 字面量', typeof literal === 'string' && literal.length > 100)
const clientEn = literal === null ? {} : (0, eval)('(' + literal + ')')

const clientKeys = [...new Set(collectCallKeys(clientSource))]
console.log('浏览器侧：client.js 用到 ' + clientKeys.length + ' 个 key')

const missingClient = clientKeys.filter((k) => typeof clientEn[k] !== 'string')
check('浏览器侧每个 T(…) key 都在 EN 字典里', missingClient.length === 0, missingClient)

const notEnglishClient = Object.entries(clientEn).filter(([, v]) => CJK.test(String(v)))
check('浏览器侧 EN 字典的值都不是中文', notEnglishClient.length === 0, notEnglishClient.map(([k]) => k))

const badPhClient = Object.entries(clientEn).filter(([k, v]) => placeholders(k) !== placeholders(v))
check('浏览器侧占位符对齐', badPhClient.length === 0,
  badPhClient.map(([k, v]) => ({ key: k, want: placeholders(k), got: placeholders(v) })))

// 重复 key：对象字面量里不报错，后一个静默覆盖前一个 —— 只能从源码文本里数。
function duplicateKeys(literalText) {
  const seen = new Map()
  const dup = []
  const re = /(?:^|[{,\s])(?:(["'])((?:(?!\1)[^\\]|\\.)*)\1)\s*:/g
  let m
  while ((m = re.exec(literalText)) !== null) {
    const key = m[2]
    if (seen.has(key)) dup.push(key)
    else seen.set(key, true)
  }
  return dup
}
check('宿主侧 EN 字典没有重复 key',
  duplicateKeys(sliceObjectLiteral(readFileSync(join(lib, 'i18n.js'), 'utf8'), 'export const EN =') || '').length === 0,
  duplicateKeys(sliceObjectLiteral(readFileSync(join(lib, 'i18n.js'), 'utf8'), 'export const EN =') || ''))
check('浏览器侧 EN 字典没有重复 key', duplicateKeys(literal || '').length === 0, duplicateKeys(literal || ''))

// ══ 3. 取值行为 ══════════════════════════════════════════════════════════════
check('pickLocale：zh 系列归 zh', pickLocale('zh') === 'zh' && pickLocale('zh-CN') === 'zh' && pickLocale('ZH') === 'zh')
check('pickLocale：其余一律归 en（DSH 内置只有 zh/en，en 是 fallback 终点）',
  pickLocale('en') === 'en' && pickLocale('en-US') === 'en' && pickLocale('ja') === 'en' && pickLocale(undefined) === 'en')
check('translate：中文取 key 本身（恒等）', translate('zh', '随便一个不存在的 key') === '随便一个不存在的 key')
check('translate：缺失的 key 原样返回、缺失的插值参数保留占位符',
  translate('en', '不存在的 key {x}', { y: 1 }) === '不存在的 key {x}')
check('translate：插值正确', translate('zh', '已完成 {a}/{b}', { a: 1, b: 2 }) === '已完成 1/2')

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES')
process.exit(failures === 0 ? 0 : 1)
