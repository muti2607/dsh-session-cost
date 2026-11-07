/**
 * Offline check: drive the plugin's Host half with a fake Cordis ctx and a synthetic
 * session log, then assert the money math (Flash valley / peak, pro rate, cache split).
 * Run: node verify.mjs
 */
import { apply } from './index.js'

const T_VALLEY = Date.parse('2026-11-02T20:00:00+08:00') // Monday, 20:00 -> valley
const T_PEAK = Date.parse('2026-11-02T15:00:00+08:00')   // Monday, 15:00 -> peak

function ev(seq, time, model, usage, provider = 'deepseek') {
  return {
    seq, time, type: 'assistant/message',
    data: { turn: seq, step: 1, usage, message: { source: { provider, model } } },
  }
}

const events = [
  ev(1, T_VALLEY, 'deepseek-v4-flash', { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }),
  ev(2, T_PEAK, 'deepseek-v4-flash', { inputTokens: 0, cacheReadTokens: 1_000_000, outputTokens: 0 }),
  ev(3, T_VALLEY, 'deepseek-v4-pro', { inputTokens: 0, cacheReadTokens: 0, outputTokens: 1_000_000 }),
  // 别家免费渠道：token 再大也不该算钱
  ev(4, T_VALLEY, 'deepseek-v4-pro', { inputTokens: 5_000_000, cacheReadTokens: 0, outputTokens: 5_000_000 }, 'trae'),
  ev(5, T_VALLEY, 'deepseek-v4.1-flash', { inputTokens: 5_000_000, cacheReadTokens: 0, outputTokens: 5_000_000 }, 'cline'),
]

// Expected, Flash valley: 1e6 * 1 / 1e6 = 1.0 ; Flash peak cache hit: 1e6 * 0.04 / 1e6 = 0.04 ;
// Pro valley output: 1e6 * 13.5 / 1e6 = 13.5  => 14.54
// trae / cline 两条必须贡献 0
const EXPECTED = 1 + 0.04 + 13.5

let captured = null
let capturedTool = null
const listeners = []
const services = {
  webServer: { register(route) { captured = route; return () => { captured = null } } },
  tools: { register(definition) { capturedTool = definition; return () => { capturedTool = null } } },
  sessionQuery: {
    async listSessions() {
      return [{ header: { id: 'session-a', createdAt: T_VALLEY - 60_000, cwd: 'D:\\work\\demo' }, live: true, persisted: true }]
    },
    async readSession(id) {
      if (id !== 'session-a') throw new Error('unexpected id ' + id)
      return { session: { id }, events }
    },
    async readTitleSnapshots(ids) {
      return [{ sessionId: 'session-a', status: 'fulfilled', value: { session: { id: 'session-a' }, title: { title: '娴嬭瘯浼氳瘽' } } }]
    },
  },
}
const ctx = {
  effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
  on(name, listener) { listeners.push([name, listener]); return () => {} },
  // 鐪熷疄 Cordis 鐨?ctx.inject(deps, cb)锛氫緷璧栭綈浜嗘墠璺?callback锛岃繑鍥炲€煎綋娓呯悊鍑芥暟
  inject(deps, callback) {
    for (const name of deps) if (!services[name]) return () => {}
    return callback(services) || (() => {})
  },
  get(name) { return services[name] },
}

apply(ctx, { dshHome: 'D:/dfyqq/dfyduihua娑堣垂璁板綍/__no_ledger__' })

if (!captured) throw new Error('route was not registered')
if (captured.path !== '/dsh-session-cost/data.json') throw new Error('unexpected path ' + captured.path)

const chunks = []
await captured.handler(
  { method: 'GET', url: '/dsh-session-cost/data.json?wait=1', headers: {} },
  { statusCode: 0, setHeader() {}, end(body) { chunks.push(body) } },
)
const report = JSON.parse(chunks.join(''))

const fail = (message) => { console.error('FAIL: ' + message); process.exitCode = 1 }

if (!report.ok) fail('report not ok: ' + JSON.stringify(report))
if (report.sessions.length !== 1) fail('expected 1 session, got ' + report.sessions.length)
const row = report.sessions[0]
if (Math.abs(row.cost - EXPECTED) > 1e-9) fail('session cost ' + row.cost + ' != ' + EXPECTED)
if (Math.abs(report.totals.cost - EXPECTED) > 1e-9) fail('total cost ' + report.totals.cost + ' != ' + EXPECTED)
if (row.title !== '娴嬭瘯浼氳瘽') fail('title not folded: ' + JSON.stringify(row.title))
// 2 涓璐规《锛坒lash 涓ゆ潯鍚堝苟 + pro锛? 2 涓厤璐规《锛坱rae / cline锛?if (row.models.length !== 4) fail('expected 4 model buckets, got ' + JSON.stringify(row.models.map((m) => m.provider + '/' + m.model)))
if (row.calls !== 5) fail('expected 5 calls, got ' + row.calls)
if (row.billedCalls !== 3) fail('expected 3 billed calls, got ' + row.billedCalls)
if (row.freeCalls !== 2) fail('expected 2 free calls, got ' + row.freeCalls)
if (report.totals.freeCalls !== 2) fail('totals.freeCalls ' + report.totals.freeCalls)
// 鍏嶈垂娓犻亾鐨勯噾棰濆繀椤讳负 0锛屽摢鎬?token 寰堝ぇ
for (const m of row.models) {
  if (m.provider === 'trae' || m.provider === 'cline') {
    if (m.billed !== false) fail('free provider marked billed: ' + m.provider)
    if (Math.abs(m.cost) > 1e-9) fail('free provider charged ' + m.provider + ' = ' + m.cost)
  }
}
if (Math.abs(row.todayCost - 0) > 1e-12 && row.updatedAt) {
  // todayCost depends on the real clock; only assert it is a number
}
if (typeof row.todayCost !== 'number') fail('todayCost missing')

// live increment: a new assistant/message event must add its own cost
const [, onEvent] = listeners.find(([name]) => name === 'session/event') || []
if (!onEvent) fail('no session/event listener')
else {
  onEvent({ id: 'session-a' }, ev(6, T_VALLEY, 'deepseek-v4-flash', { inputTokens: 0, cacheReadTokens: 0, outputTokens: 250_000 }))
  const chunks2 = []
  await captured.handler(
    { method: 'GET', url: '/dsh-session-cost/data.json?wait=1', headers: {} },
    { statusCode: 0, setHeader() {}, end(body) { chunks2.push(body) } },
  )
  const report2 = JSON.parse(chunks2.join(''))
  const expected2 = EXPECTED + 0.25 * 4 // 250k output at Flash valley 4/M
  if (Math.abs(report2.totals.cost - expected2) > 1e-9) {
    fail('incremental cost ' + report2.totals.cost + ' != ' + expected2)
  }
  // 閲嶅鎶曢€掑悓涓€鏉?seq 蹇呴』骞傜瓑
  onEvent({ id: 'session-a' }, ev(6, T_VALLEY, 'deepseek-v4-flash', { inputTokens: 0, cacheReadTokens: 0, outputTokens: 250_000 }))
  const chunks3 = []
  await captured.handler(
    { method: 'GET', url: '/dsh-session-cost/data.json?wait=1', headers: {} },
    { statusCode: 0, setHeader() {}, end(body) { chunks3.push(body) } },
  )
  const report3 = JSON.parse(chunks3.join(''))
  if (Math.abs(report3.totals.cost - expected2) > 1e-9) fail('replayed event double counted: ' + report3.totals.cost)
}

// 方法不允许
const chunks4 = []
await captured.handler(
  { method: 'POST', url: '/dsh-session-cost/data.json?wait=1', headers: {} },
  { statusCode: 0, setHeader() {}, end(body) { chunks4.push(body) } },
)
const rejected = JSON.parse(chunks4.join(''))
if (rejected.ok !== false) fail('POST should be rejected')

// Agent 工具：注册 + 摘要渲染
if (!capturedTool) fail('session_cost_report tool was not registered')
else {
  if (capturedTool.name !== 'session_cost_report') fail('unexpected tool name ' + capturedTool.name)
  const value = await capturedTool.execute({ limit: 5, refresh: true })
  if (!value || value.ok !== true) fail('tool returned no report: ' + JSON.stringify(value))
  // refresh=true 浼氶噸璇绘棩蹇楋紝鎵€浠ュ閲忎簨浠?涓嶅湪鏃ュ織閲?琚涪寮?鈬?鍥炲埌鏃ュ織閲岀殑鍚堣
  if (Math.abs(value.totals.cost - EXPECTED) > 1e-9) fail('tool total ' + value.totals.cost)
  const blocks = capturedTool.output.render({ limit: 5 }, value)
  const text = blocks.map((block) => block.text).join('\n')
  console.log('--- tool output ---\n' + text + '\n-------------------')
  if (text.indexOf('娴嬭瘯浼氳瘽') === -1) fail('summary misses the session title')
  if (text.indexOf('deepseek-v4-pro') === -1) fail('summary misses the model breakdown')
}

// ---- 浣欓璐︽湰瀵硅处锛氭€婚蹇呴』鐢辫处鏈璇濓紝token 浼扮畻闄嶇骇涓哄弬鑰?----
{
  const ledDir = './__ledger_fixture__'
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  mkdirSync(ledDir, { recursive: true })
  const book = 'test-book-CNY'
  writeFileSync(ledDir + '/.dshw-usage.json', JSON.stringify({
    lastBalance: 6.81,
    accounting: {
      version: 1,
      active: book,
      books: {
        [book]: {
          currency: 'CNY',
          days: {
            '2026-10-31': { day: '2026-10-31', debitUnits: 5_79056700, creditUnits: 0, firstAt: 1, lastAt: 2 },
            '2026-11-01': { day: '2026-11-01', debitUnits: 3_18543300, creditUnits: 0, firstAt: 1, lastAt: 2 },
          },
        },
      },
    },
  }))

  let ledger = null
  let ledgerTool = null
  const ledgerServices = {
    webServer: { register(r) { ledger = r; return () => {} } },
    tools: { register(d) { ledgerTool = d; return () => {} } },
    sessionQuery: {
      async listSessions() {
        return [{ header: { id: 'session-a', createdAt: Date.parse('2026-11-01T10:00:00+08:00') }, live: true, persisted: true }]
      },
      async readSession(id) {
        return {
          session: { id },
          events: [
            ev(1, Date.parse('2026-11-01T10:00:00+08:00'), 'deepseek-v4-flash', { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }),
          ],
        }
      },
      async readTitleSnapshots(ids) {
        return [{ sessionId: 'session-a', status: 'fulfilled', value: { title: { title: '璐︽湰浼氳瘽' } } }]
      },
    },
  }
  const ledgerCtx = {
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
    on() { return () => {} },
    inject(deps, callback) { return callback(ledgerServices) || (() => {}) },
    get(name) { return ledgerServices[name] },
  }
  apply(ledgerCtx, { dshHome: ledDir })

  const body = []
  await ledger.handler(
    { method: 'GET', url: '/dsh-session-cost/data.json?wait=1', headers: {} },
    { statusCode: 0, setHeader() {}, end(b) { body.push(b) } },
  )
  const r = JSON.parse(body.join(''))
  if (!r.ledger || r.ledger.available !== true) fail('ledger should be available')
  const REAL = 5.790567 + 3.185433
  if (Math.abs(r.totals.cost - REAL) > 1e-9) fail('total must come from ledger: ' + r.totals.cost + ' != ' + REAL)
  if (Math.abs(r.ledger.totalDebit - REAL) > 1e-9) fail('ledger.totalDebit ' + r.ledger.totalDebit)
  if (r.ledger.lastBalance !== 6.81) fail('lastBalance ' + r.ledger.lastBalance)
  if (r.ledger.coverage.days !== 2) fail('coverage days ' + r.ledger.coverage.days)
  // token 浼扮畻淇濈暀涓哄弬鑰冿紝涓斾笉绛変簬鏉冨▉鎬婚
  if (!(r.ledger.estimateTotal > 0)) fail('estimateTotal lost')
  if (Math.abs(r.totals.cost - r.ledger.estimateTotal) < 1e-9) {
    fail('estimate and ledger total collapsed into one number')
  }
  const et = ledgerTool.output.render({}, r).map((b) => b.text).join('\n')
  if (et.indexOf('真实扣费') === -1) fail('tool summary must lead with ledger truth')
  if (et.indexOf('余额账本') === -1) fail('tool summary must mention the ledger')
  rmSync(ledDir, { recursive: true, force: true })
}

// ---- 按天查询（day=YYYY-MM-DD）----
// 5 条合成事件全在 2026-11-02（T_VALLEY 20:00 / T_PEAK 15:00 都是 +08:00），
// 所以查这一天应拿到全部 5 次调用；查隔天应为空而不是报错。
{
  const read = async (url) => {
    const c = []
    await captured.handler(
      { method: 'GET', url, headers: {} },
      { statusCode: 0, setHeader() {}, end(b) { c.push(b) } },
    )
    return JSON.parse(c.join(''))
  }
  const onDay = await read('/dsh-session-cost/data.json?wait=1&day=2026-11-02')
  if (!onDay.ok) fail('day query not ok')
  if (!onDay.day) fail('day report missing')
  if (onDay.day.day !== '2026-11-02') fail('wrong day echoed: ' + onDay.day.day)
  if (onDay.day.calls !== 5) fail('day.calls should be 5, got ' + onDay.day.calls)
  if (onDay.day.billedCalls !== 3) fail('day.billedCalls should be 3, got ' + onDay.day.billedCalls)
  if (onDay.day.freeCalls !== 2) fail('day.freeCalls should be 2, got ' + onDay.day.freeCalls)
  if (onDay.day.sessions !== 1) fail('day.sessions should be 1, got ' + onDay.day.sessions)
  // 当天金额 = 三条计费事件的估算合计（与累计一致，因为事件都在同一天）
  if (Math.abs(onDay.day.cost - EXPECTED) > 1e-9) fail('day.cost ' + onDay.day.cost + ' != ' + EXPECTED)
  // token 分项
  const tk = onDay.day.tokens
  const expectIn = 1_000_000 + 0 + 0 + 5_000_000 + 5_000_000
  const expectCache = 0 + 1_000_000 + 0 + 0 + 0
  const expectOut = 0 + 0 + 1_000_000 + 5_000_000 + 5_000_000
  if (tk.input !== expectIn) fail('day.tokens.input ' + tk.input + ' != ' + expectIn)
  if (tk.cacheRead !== expectCache) fail('day.tokens.cacheRead ' + tk.cacheRead + ' != ' + expectCache)
  if (tk.output !== expectOut) fail('day.tokens.output ' + tk.output + ' != ' + expectOut)
  if (tk.total !== expectIn + expectOut + expectCache) fail('day.tokens.total')
  // 按会话 / 按模型明细
  if (!Array.isArray(onDay.day.sessionRows) || onDay.day.sessionRows.length !== 1) fail('day.sessionRows list')
  if (onDay.day.sessionRows[0].calls !== 5) fail('day.sessionRows[0].calls')
  if (!Array.isArray(onDay.day.models) || onDay.day.models.length !== 4) fail('day.models should have 4 buckets, got ' + (onDay.day.models || []).length)
  for (const m of onDay.day.models) {
    if ((m.provider === 'trae' || m.provider === 'cline') && Math.abs(m.cost) > 1e-9) {
      fail('free provider charged on day: ' + m.provider)
    }
  }
  // 行级 day 数据
  const dayRow = onDay.sessions[0]
  if (!dayRow.day || dayRow.day.calls !== 5) fail('row.day missing/wrong')

  // 无活动的另一天：全 0，不能报错、不能把累计数据漏过去
  const empty = await read('/dsh-session-cost/data.json?wait=1&day=2026-11-03')
  if (!empty.ok) fail('empty day query not ok')
  if (empty.day.day !== '2026-11-03') fail('empty day echo')
  if (empty.day.calls !== 0 || empty.day.cost !== 0 || empty.day.sessions !== 0) {
    fail('empty day should be all zero: ' + JSON.stringify(empty.day))
  }
  if (empty.day.sessionRows.length !== 0) fail('empty day sessionRows list')
  if (empty.sessions[0].day !== null) fail('row.day should be null when no activity')

  // 非法日期回退到今天，不应报错
  const bad = await read('/dsh-session-cost/data.json?wait=1&day=not-a-date')
  if (!bad.ok || !bad.day || !/^\d{4}-\d{2}-\d{2}$/.test(bad.day.day)) fail('invalid day should fall back to today')

  // 不传 day 时默认今天，且返回结构里仍有 day
  const dflt = await read('/dsh-session-cost/data.json?wait=1')
  if (!dflt.day || !/^\d{4}-\d{2}-\d{2}$/.test(dflt.day.day)) fail('default day missing')
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  if (dflt.day.day !== today) fail('default day should be Beijing today: ' + dflt.day.day + ' != ' + today)

  // 工具摘要里应带「【日期 用量】」
  if (typeof capturedTool?.output?.render === 'function') {
    const text = capturedTool.output.render({}, onDay).map((b) => b.text).join('\n')
    if (!text.includes('2026-11-02 用量')) fail('tool summary missing day section')
    if (!text.includes('5 次调用')) fail('tool summary missing day calls')
  }
}

console.log(JSON.stringify({ ok: !process.exitCode, cost: row.cost, expected: EXPECTED, models: row.models }, null, 2))

