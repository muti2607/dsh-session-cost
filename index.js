/**
 * dsh-session-cost — Host half.
 *
 * 把每个会话日志里的真实 token 用量（`assistant/message` 事件上的 `usage`）折算成
 * 人民币，供 Web 面板列出「每个会话花了多少钱」。
 *
 * 数据来源（全部是 Harness 的既有能力，插件不自己造状态）：
 *   - `sessionQuery.listSessions()`   列出全部逻辑会话
 *   - `sessionQuery.readSession(id)`  读一条完整会话日志（活会话 / 冷会话都行）
 *   - `sessionQuery.readTitleSnapshots(ids)` 折叠标题
 *   - `session/event`                 活会话增量（assistant/message 带 usage）
 *
 * 计费口径（重要：只有「会从你账户扣钱」的 provider 才计入金额）：
 *   - 每条 `assistant/message` 都带 `data.message.source.provider` 和 `.model`。
 *   - 只有 provider 命中 `billedProviders`（默认 `deepseek-account` / `deepseek`）的调用才折算成钱；
 *     其余渠道（trae / cline / raccoon / qodercn / our-free-model … 自带额度或免费的）
 *     一律记为 0 元，token 用量照常统计并单独标注，不污染总花费。
 *   - 输入未命中缓存 = usage.inputTokens        × miss 价
 *   - 输入命中缓存   = usage.cacheReadTokens    × hit  价
 *   - 输出           = usage.outputTokens       × out  价
 *     （Harness 保证 reasoningTokens ⊆ outputTokens，所以不再单独累加 reasoning）
 *   - 峰时（北京时间 周一至周五 9:00–12:00 / 14:00–18:00，法定节假日与周末除外）按 peakMultiplier 倍计。
 *
 * 金额一律用 1e-8 的整数单位累加，避免浮点漂移。
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCALE = 1e8
const BEIJING_OFFSET_MS = 8 * 3600 * 1000
const ROUTE_DATA = '/dsh-session-cost/data.json'
const LOG_PREFIX = '[session-cost]'

/** 内置价目表（元 / 百万 token），空闲时段价。峰时 = ×2（DeepSeek 官方峰谷规则）。 */
const DEFAULT_PRICES = [
  { match: 'deepseek-v4-pro', hit: 0.15, miss: 4.5, out: 13.5 },
  { match: '*', hit: 0.02, miss: 1, out: 4 },
]

/**
 * 默认「会扣你账户余额」的 provider。
 * DSH 的 provider id 里 `deepseek-account` 是走你账号余额的官方通道；
 * 其它 provider（trae/cline/raccoon/qodercn/our-free-model…）用的是别家渠道或免费额度，
 * 不花你的钱，所以默认不计费、只统计 token。
 * 想让某个渠道也算钱，把它加进配置里的 `billedProviders` 即可。
 */
const DEFAULT_BILLED_PROVIDERS = ['deepseek-account', 'deepseek']

/** 法定节假日全天谷价（只需列放假的日期；调休上班日都落在周末，本来就按谷价算）。 */
const DEFAULT_HOLIDAYS = [
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
]

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function moneyUnits(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * SCALE)
}

function beijingDateString(timeMs) {
  const t = Number.isFinite(Number(timeMs)) ? Number(timeMs) : Date.now()
  return new Date(t + BEIJING_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * 读「真实扣费」账本。
 *
 * 为什么要有这个：会话日志里的 token 用量是**逐步(step)记录的理论值**，而账户余额是按
 * **每次 API 调用**真实扣减的。两者天生对不上——重试、失败重试、fork/重放、跨天累计、
 * 以及历史定价期都会造成偏差。所以「花了多少钱」这件事只能以余额差值为准。
 *
 * 账本由 whale-widget 维护在 `$DSH_HOME/.dshw-usage.json`：
 *   accounting.books[<book>].days[<YYYY-MM-DD>] = {
 *     openingUnits, lastUnits, debitUnits, creditUnits, firstAt, lastAt }
 * `debitUnits` 已由它按余额差额校准（充值计入 creditUnits），是权威的「当天真扣了多少」。
 *
 * 读不到就返回空，面板自动退化为纯 token 估算并标注「无账本」。
 */
function readLedger(cfg) {
  const home = String(cfg.dshHome || process.env.DSH_HOME || '').trim()
    || (process.env.USERPROFILE ? process.env.USERPROFILE + '\\.dsh' : '')
  if (!home) return null
  const file = join(home, '.dshw-usage.json')
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    return { ok: false, path: file, reason: 'not-found' }
  }
  let doc
  try {
    doc = JSON.parse(raw)
  } catch (err) {
    return { ok: false, path: file, reason: 'bad-json' }
  }
  const accounting = doc && doc.accounting
  if (!accounting || accounting.version !== 1 || !accounting.books) {
    return { ok: false, path: file, reason: 'no-accounting' }
  }
  const book = accounting.books[accounting.active]
  if (!book || !book.days) return { ok: false, path: file, reason: 'no-book' }
  const days = {}
  for (const key of Object.keys(book.days)) {
    const row = book.days[key] || {}
    const debit = Number(row.debitUnits)
    const credit = Number(row.creditUnits)
    days[key] = {
      debit: Number.isFinite(debit) ? debit / SCALE : 0,
      credit: Number.isFinite(credit) ? credit / SCALE : 0,
      firstAt: Number(row.firstAt) || 0,
      lastAt: Number(row.lastAt) || 0,
    }
  }
  return {
    ok: true,
    path: file,
    currency: book.currency || 'CNY',
    days,
    lastBalance: Number.isFinite(Number(doc.lastBalance)) ? Number(doc.lastBalance) : null,
    mtime: 0,
  }
}

function normalizeConfig(config) {
  const c = config && typeof config === 'object' ? config : {}
  const prices = Array.isArray(c.prices) && c.prices.length ? c.prices : DEFAULT_PRICES
  const ttl = Number(c.cacheTtlMs)
  const peak = Number(c.peakMultiplier)
  const billed = Array.isArray(c.billedProviders) && c.billedProviders.length
    ? c.billedProviders.map((p) => String(p).trim().toLowerCase()).filter(Boolean)
    : DEFAULT_BILLED_PROVIDERS
  return {
    currency: typeof c.currency === 'string' && c.currency ? c.currency : 'CNY',
    cacheTtlMs: Number.isFinite(ttl) ? Math.min(600000, Math.max(5000, ttl)) : 60000,
    peakMultiplier: Number.isFinite(peak) && peak > 0 ? peak : 2,
    prices,
    billedProviders: billed,
    dshHome: typeof c.dshHome === 'string' ? c.dshHome.trim() : '',
    cacheEnabled: c.persistCache === false ? false : true,
    cacheDir: typeof c.cacheDir === 'string' ? c.cacheDir.trim() : '',
    holidays: Array.isArray(c.holidays) && c.holidays.length
      ? c.holidays.map((d) => String(d))
      : DEFAULT_HOLIDAYS,
  }
}

function createPricer(cfg) {
  const entries = []
  for (const raw of cfg.prices) {
    if (!raw || typeof raw !== 'object') continue
    const match = String(raw.match == null ? '' : raw.match).trim().toLowerCase()
    if (!match) continue
    entries.push({ match, hit: num(raw.hit), miss: num(raw.miss), out: num(raw.out) })
  }
  // 最长命中优先，避免短关键字误伤
  entries.sort((a, b) => b.match.length - a.match.length)
  const wildcard = entries.find((e) => e.match === '*') || null
  const specific = entries.filter((e) => e.match !== '*')
  const holidays = new Set(cfg.holidays)

  function isPeak(timeMs) {
    const t = Number.isFinite(Number(timeMs)) ? Number(timeMs) : Date.now()
    const d = new Date(t + BEIJING_OFFSET_MS)
    const dow = d.getUTCDay()
    if (dow === 0 || dow === 6) return false
    if (holidays.has(d.toISOString().slice(0, 10))) return false
    const hour = d.getUTCHours()
    return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
  }

  function rateFor(model) {
    const m = String(model == null ? '' : model).toLowerCase()
    for (const entry of specific) {
      if (m.indexOf(entry.match) !== -1) return entry
    }
    return wildcard
  }

  return {
    currency: cfg.currency,
    rateFor,
    isPeak,
    /** 这个 provider 的调用会不会真扣用户的钱。 */
    isBilled(provider) {
      const p = String(provider == null ? '' : provider).trim().toLowerCase()
      if (!p) return false
      return cfg.billedProviders.indexOf(p) !== -1
    },
    costOf(usage, model, timeMs, provider) {
      // 免费的渠道一分钱都不算，哪怕 token 用量很大
      if (!this.isBilled(provider)) return 0
      const rate = rateFor(model)
      if (!rate || !usage || typeof usage !== 'object') return 0
      const input = num(usage.inputTokens)
      const cacheRead = num(usage.cacheReadTokens)
      const output = num(usage.outputTokens)
      const perMillion = input * rate.miss + cacheRead * rate.hit + output * rate.out
      const factor = isPeak(timeMs) ? cfg.peakMultiplier : 1
      return (perMillion / 1e6) * factor
    },
    describe() {
      return {
        currency: cfg.currency,
        peakMultiplier: cfg.peakMultiplier,
        prices: entries.map((e) => ({ match: e.match, hit: e.hit, miss: e.miss, out: e.out })),
        billedProviders: cfg.billedProviders.slice(),
        peakNow: isPeak(Date.now()),
      }
    },
  }
}

function newEntry() {
  return {
    computedAt: 0,
    lastSeq: -1,
    turns: 0,
    calls: 0,
    billedCalls: 0,
    freeCalls: 0,
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    costUnits: 0,
    todayDay: beijingDateString(Date.now()),
    todayUnits: 0,
    updatedAt: 0,
    models: new Map(),
    error: '',
  }
}

/**
 * 磁盘持久化缓存：把扫描结果存到**非系统盘**，重启后也能秒开。
 *
 * 位置优先级（全部在 D:/E:/… 这类非系统盘上，绝不写 C 盘）：
 *   1. 配置里的 `cacheDir`
 *   2. 插件自己所在目录旁的 `.cache`（即插件装在哪个盘就用哪个盘）
 *   3. 环境变量 DSF_SC_CACHE_DIR
 * 一个可用位置都找不到就**直接放弃持久化**（宁可不缓存，也不碰 C 盘）。
 */
function pickCacheDir(cfg) {
  const isC = (p) => /^c:(\\|\/)/i.test(String(p || '').trim())
  const candidates = []
  if (cfg.cacheDir) candidates.push(String(cfg.cacheDir).trim())
  try {
    // 插件自己所在目录（install_bundle 用 link: 指向工作区，通常在 D 盘）
    const here = fileURLToPath(import.meta.url)
    candidates.push(join(dirname(here), '.cache'))
  } catch (err) { /* ignore */ }
  if (process.env.DSF_SC_CACHE_DIR) candidates.push(String(process.env.DSF_SC_CACHE_DIR).trim())
  for (const dir of candidates) {
    if (!dir || isC(dir)) continue          // 明确排除 C 盘
    try {
      mkdirSync(dir, { recursive: true })
      return dir
    } catch (err) { /* 该位置不可写就看下一个 */ }
  }
  return ''
}

function entryToJson(entry) {
  return {
    computedAt: entry.computedAt,
    lastSeq: entry.lastSeq,
    turns: entry.turns,
    calls: entry.calls,
    billedCalls: entry.billedCalls,
    freeCalls: entry.freeCalls,
    totals: entry.totals,
    costUnits: entry.costUnits,
    todayDay: entry.todayDay,
    todayUnits: entry.todayUnits,
    updatedAt: entry.updatedAt,
    models: [...entry.models.values()],
    error: entry.error || '',
  }
}

function entryFromJson(raw) {
  const entry = newEntry()
  if (!raw || typeof raw !== 'object') return entry
  entry.computedAt = Number(raw.computedAt) || 0
  entry.lastSeq = Number(raw.lastSeq)
  if (!Number.isFinite(entry.lastSeq)) entry.lastSeq = -1
  entry.turns = Number(raw.turns) || 0
  entry.calls = Number(raw.calls) || 0
  entry.billedCalls = Number(raw.billedCalls) || 0
  entry.freeCalls = Number(raw.freeCalls) || 0
  const t = raw.totals || {}
  entry.totals = {
    input: Number(t.input) || 0,
    output: Number(t.output) || 0,
    cacheRead: Number(t.cacheRead) || 0,
    cacheWrite: Number(t.cacheWrite) || 0,
    reasoning: Number(t.reasoning) || 0,
  }
  entry.costUnits = Number(raw.costUnits) || 0
  if (typeof raw.todayDay === 'string') entry.todayDay = raw.todayDay
  entry.todayUnits = Number(raw.todayUnits) || 0
  entry.updatedAt = Number(raw.updatedAt) || 0
  entry.error = String(raw.error || '')
  entry.models = new Map()
  for (const bucket of Array.isArray(raw.models) ? raw.models : []) {
    if (!bucket || typeof bucket !== 'object') continue
    const model = String(bucket.model || 'unknown')
    const provider = String(bucket.provider || '')
    entry.models.set((provider ? provider + '/' : '') + model, {
      model,
      provider,
      billed: bucket.billed !== false,
      calls: Number(bucket.calls) || 0,
      tokens: Number(bucket.tokens) || 0,
      costUnits: Number(bucket.costUnits) || 0,
    })
  }
  return entry
}

/** 折叠一条会话事件（纯计算，扫描与增量共用）。 */
function foldEvent(entry, event, pricer) {
  if (!entry || !event || typeof event !== 'object') return
  const data = event.data
  if (!data || typeof data !== 'object') return
  if (Number.isFinite(event.time) && event.time > entry.updatedAt) entry.updatedAt = event.time
  if (Number.isFinite(event.seq) && event.seq > entry.lastSeq) entry.lastSeq = event.seq
  if (event.type !== 'assistant/message') return

  const turn = Number(data.turn)
  if (Number.isFinite(turn) && turn > entry.turns) entry.turns = turn

  const usage = data.usage
  if (!usage || typeof usage !== 'object') return

  const input = num(usage.inputTokens)
  const output = num(usage.outputTokens)
  const cacheRead = num(usage.cacheReadTokens)
  const cacheWrite = num(usage.cacheWriteTokens)
  const reasoning = num(usage.reasoningTokens)

  entry.calls += 1
  entry.totals.input += input
  entry.totals.output += output
  entry.totals.cacheRead += cacheRead
  entry.totals.cacheWrite += cacheWrite
  entry.totals.reasoning += reasoning

  const source = (data.message && data.message.source) || {}
  const model = String(source.model == null ? '' : source.model)
  const provider = String(source.provider == null ? '' : source.provider)
  const at = Number.isFinite(event.time) ? event.time : Date.now()
  const billed = pricer.isBilled(provider)
  // 免费渠道的 token 不进金额，只进用量
  const units = billed ? moneyUnits(pricer.costOf(usage, model, at, provider)) : 0

  entry.costUnits += units
  const day = beijingDateString(at)
  if (day !== entry.todayDay) {
    entry.todayDay = day
    entry.todayUnits = 0
  }
  entry.todayUnits += units
  if (billed) entry.billedCalls += 1
  else entry.freeCalls += 1

  const key = (provider ? provider + '/' : '') + (model || 'unknown')
  let bucket = entry.models.get(key)
  if (!bucket) {
    bucket = { model: model || 'unknown', provider, billed, calls: 0, tokens: 0, costUnits: 0 }
    entry.models.set(key, bucket)
  }
  bucket.calls += 1
  bucket.tokens += input + output + cacheRead
  bucket.costUnits += units
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const width = Math.max(1, Math.min(limit, items.length || 1))
  const workers = []
  for (let w = 0; w < width; w += 1) {
    workers.push((async () => {
      for (;;) {
        const index = next
        next += 1
        if (index >= items.length) return
        out[index] = await fn(items[index], index)
      }
    })())
  }
  await Promise.all(workers)
  return out
}

function sendJson(res, statusCode, body) {
  try {
    res.statusCode = statusCode
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  } catch (err) {
    /* 客户端已断开时忽略 */
  }
}

function formatMoneyText(value, currency) {
  const n = Number(value) || 0
  const symbol = String(currency || 'CNY').toUpperCase() === 'USD' ? '$' : '¥'
  if (!(n > 0)) return symbol + '0.00'
  if (n >= 1) return symbol + n.toFixed(2)
  if (n >= 0.01) return symbol + n.toFixed(3)
  if (n >= 0.0001) return symbol + n.toFixed(4)
  return symbol + '<0.0001'
}

function formatTokenText(value) {
  const n = Number(value) || 0
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k'
  return String(n)
}

/** 给 Agent 工具用的纯文本摘要（模型看到的就是这段）。 */
function summarizeReport(report, limit) {
  if (!report || report.ok === false) {
    return '会话消费统计失败：' + String((report && report.error) || '未知错误')
  }
  const currency = report.currency || 'CNY'
  const totals = report.totals || {}
  const rows = Array.isArray(report.sessions) ? report.sessions : []
  const max = Math.max(1, Math.min(200, Number(limit) || 20))
  const peak = !!(report.pricing && report.pricing.peakNow)
  const lines = []
  lines.push('会话消费（' + currency + '，当前' + (peak ? '峰时价' : '谷时价') + '）')
  const led = report.ledger || {}
  if (led.available) {
    lines.push('真实扣费 ' + formatMoneyText(totals.cost, currency)
      + ' · 今日 ' + formatMoneyText(totals.todayCost, currency)
      + (led.lastBalance != null ? ' · 余额 ' + formatMoneyText(led.lastBalance, currency) : '')
      + '（来自余额账本，权威）')
    const days = led.coverage && led.coverage.days
    if (days) {
      lines.push('覆盖 ' + led.coverage.fromDay + ' 至 ' + led.coverage.toDay + '，共 ' + days + ' 天')
      if (Number(led.coverage.missingBeforeDays) > 0) {
        lines.push('⚠ 账本从 ' + led.coverage.fromDay + ' 才开始记录，更早的消费没有本地观测；'
          + '官方用量页（如近 30 天）的金额会比这里更大，差额来自那段空白。')
      }
    }
    // token 估算只作参考，明确标注偏差
    const est = Number(led.estimateTotal) || 0
    if (est > 0) {
      const delta = est - (Number(totals.cost) || 0)
      const pct = totals.cost > 0 ? (delta / totals.cost) * 100 : 0
      lines.push('（token 估算 ' + formatMoneyText(est, currency)
        + '，比真实扣费' + (delta >= 0 ? '高 ' : '低 ') + formatMoneyText(Math.abs(delta), currency)
        + (totals.cost > 0 ? '，' + (delta >= 0 ? '+' : '') + pct.toFixed(0) + '%' : '')
        + '；仅作参考）')
    }
  } else {
    lines.push('合计 ' + formatMoneyText(totals.cost, currency)
      + ' · 今日 ' + formatMoneyText(totals.todayCost, currency)
      + ' · ' + (totals.sessions || 0) + ' 个会话（' + (totals.sessionsWithCost || 0) + ' 个花钱）'
      + '（无余额账本，以下为 token 估算，可能与真实扣费有偏差）')
  }
  lines.push((totals.sessions || 0) + ' 个会话 · ' + (totals.calls || 0) + ' 次调用')
  const billedProviders = (report.pricing && report.pricing.billedProviders) || []
  const freeCalls = Number(totals.freeCalls) || 0
  if (billedProviders.length) {
    lines.push('计费渠道：' + billedProviders.join(', ')
      + (freeCalls > 0 ? '；另有 ' + freeCalls + ' 次调用走免费/别家渠道，不计钱' : ''))
  }
  if (Number(totals.sessionsFreeOnly) > 0) {
    lines.push('（其中 ' + totals.sessionsFreeOnly + ' 个会话完全走免费渠道，花了 ¥0）')
  }
  const tokens = totals.tokens || {}
  lines.push('tokens：输入 ' + formatTokenText(tokens.input)
    + ' / 缓存命中 ' + formatTokenText(tokens.cacheRead)
    + ' / 输出 ' + formatTokenText(tokens.output))
  lines.push('')
  if (!rows.length) {
    lines.push('（还没有可统计的会话）')
    return lines.join('\n')
  }
  lines.push('按花费降序，前 ' + Math.min(max, rows.length) + ' 个：')
  rows.slice(0, max).forEach((row, index) => {
    const id = String(row.id || '')
    const shortId = id.length > 12 ? '…' + id.slice(-8) : id
    const rowTokens = row.tokens || {}
    lines.push((index + 1) + '. ' + formatMoneyText(row.cost, currency)
      + ' · ' + (row.calls || 0) + ' 次 · ' + (row.turns || 0) + ' 轮'
      + ' · 输入 ' + formatTokenText(rowTokens.input) + '（命中 ' + formatTokenText(rowTokens.cacheRead) + '）'
      + ' · 输出 ' + formatTokenText(rowTokens.output)
      + ' — ' + (row.title || '未命名会话') + ' [' + shortId + ']')
    const models = Array.isArray(row.models) ? row.models : []
    if (models.length) {
      const parts = models.slice(0, 3).map((model) => {
        const name = (model.model === 'unknown' ? '未知模型' : model.model)
        const who = model.provider ? model.provider + ' ' : ''
        return who + name + ' ' + (model.billed === false ? '（免费）' : formatMoneyText(model.cost, currency))
      })
      lines.push('   └ ' + parts.join(' · ') + (models.length > 3 ? ' · 另 ' + (models.length - 3) + ' 个模型' : ''))
    }
  })
  if (rows.length > max) lines.push('（还有 ' + (rows.length - max) + ' 个会话未列出）')
  lines.push('')
  if (led.available) {
    lines.push('说明：合计与今日金额来自余额账本，是你账户真实扣掉的钱；')
    lines.push('上面每个会话的金额是按 token 用量估算的（账本没有会话维度），仅供比较哪个会话更费。')
  } else {
    lines.push('金额按内置峰谷价目表估算，实际扣费以官方账单为准。')
  }
  return lines.join('\n')
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const pricer = createPricer(cfg)
  /** @type {Map<string, ReturnType<typeof newEntry>>} */
  const cache = new Map()

  // ---- 磁盘持久化缓存（重启后秒开）----
  // 只在非系统盘上工作；找不到可写位置就放弃持久化，绝不写 C 盘。
  const cacheDir = cfg.cacheEnabled ? pickCacheDir(cfg) : ''
  const cacheFile = cacheDir ? join(cacheDir, 'session-cost-cache.json') : ''
  let dirty = false
  let flushTimer = null

  function loadDiskCache() {
    if (!cacheFile) return
    try {
      const raw = readFileSync(cacheFile, 'utf8')
      const doc = JSON.parse(raw)
      if (!doc || typeof doc !== 'object' || !doc.sessions) return
      for (const key of Object.keys(doc.sessions)) {
        const entry = entryFromJson(doc.sessions[key])
        if (entry && entry.computedAt) cache.set(key, entry)
      }
    } catch (err) { /* 首次没有文件、或文件损坏：忽略即可 */ }
  }

  function flushDiskCache() {
    flushTimer = null
    if (!cacheFile || !dirty) return
    dirty = false
    try {
      const sessions = {}
      for (const [id, entry] of cache) sessions[id] = entryToJson(entry)
      const tmp = cacheFile + '.tmp'
      // 只保留必要字段；条数上限由会话总数天然决定
      writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: Date.now(), sessions }), 'utf8')
      renameSync(tmp, cacheFile)
    } catch (err) {
      try { unlinkSync(cacheFile + '.tmp') } catch (e2) { /* ignore */ }
    }
  }

  function markDirty() {
    dirty = true
    if (flushTimer) return
    flushTimer = setTimeout(flushDiskCache, 4000)
    if (typeof flushTimer.unref === 'function') flushTimer.unref()
  }

  loadDiskCache()

  function getService(name) {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch (err) {
      return undefined
    }
  }

  function trustRejection(req) {
    const conn = getService('connection')
    if (!conn || typeof conn.requestRejection !== 'function') return null
    try {
      const code = conn.requestRejection(req)
      if (code === undefined || code === null || code === false) return null
      return typeof code === 'number' ? code : 403
    } catch (err) {
      if (!trustRejection.warned) {
        trustRejection.warned = true
        try {
          console.warn(LOG_PREFIX + ' 信任栅栏抛出异常，按放行处理（只读路由）：' + String((err && err.message) || err))
        } catch (e2) { /* ignore */ }
      }
      return null
    }
  }

  /**
   * 后台补扫队列：面板轮询永远不等它，它慢慢把过期/新的会话补齐。
   * 同一会话在队列里只保留一份（Map 去重），并发最多 2 个，避免和 UI 抢 IO。
   */
  const bgQueue = new Map()
  let bgRunning = 0
  let bgTimer = null
  const BG_CONCURRENCY = 2

  function pumpBackground() {
    if (bgRunning >= BG_CONCURRENCY) return
    if (!bgQueue.size) return
    const [id, job] = bgQueue.entries().next().value
    bgQueue.delete(id)
    bgRunning += 1
    Promise.resolve()
      .then(() => computeEntry(job.sessionQuery, job.record))
      .then((entry) => { cache.set(id, entry); markDirty() })
      .catch(() => { /* 单个会话读失败不影响其它 */ })
      .finally(() => {
        bgRunning -= 1
        if (bgQueue.size) pumpBackground()
      })
  }

  function scheduleBackgroundScan(id, record, sessionQuery) {
    if (bgQueue.has(id)) return           // 已在队列里，不重复排
    bgQueue.set(id, { record, sessionQuery })
    if (bgRunning >= BG_CONCURRENCY) return
    // 让出一拍，避免和当前这次请求的 IO 挤在一起
    if (bgTimer) return
    bgTimer = setTimeout(() => {
      bgTimer = null
      pumpBackground()
    }, 0)
    if (typeof bgTimer.unref === 'function') bgTimer.unref()
  }

  async function computeEntry(sessionQuery, record) {
    const entry = newEntry()
    const snapshot = await sessionQuery.readSession(record.header.id)
    const events = (snapshot && snapshot.events) || []
    for (const event of events) foldEvent(entry, event, pricer)
    entry.computedAt = Date.now()
    // 记下这次读到的最后一笔事件，下次用它判断「会话有没有变」
    entry.watermark = entry.lastSeq
    entry.eventCount = events.length
    return entry
  }

  function rowFrom(record, entry, title) {
    const header = (record && record.header) || {}
    const today = beijingDateString(Date.now())
    const totals = entry.totals
    const models = [...entry.models.values()]
      .map((bucket) => ({
        model: bucket.model,
        provider: bucket.provider,
        billed: bucket.billed,
        calls: bucket.calls,
        tokens: bucket.tokens,
        cost: bucket.costUnits / SCALE,
      }))
      .sort((a, b) => b.cost - a.cost)
    return {
      id: String(header.id || ''),
      title: title || '',
      cwd: header.cwd || '',
      createdAt: Number(header.createdAt) || 0,
      updatedAt: entry.updatedAt || Number(header.createdAt) || 0,
      live: !!record.live,
      persisted: !!record.persisted,
      isSubagent: header.origin === 'subagent' || !!header.parentSession,
      parentSession: header.parentSession || null,
      agentPreset: header.agentPreset || '',
      turns: entry.turns,
      calls: entry.calls,
      tokens: {
        input: totals.input,
        output: totals.output,
        cacheRead: totals.cacheRead,
        cacheWrite: totals.cacheWrite,
        reasoning: totals.reasoning,
        total: totals.input + totals.output + totals.cacheRead,
      },
      cost: entry.costUnits / SCALE,
      todayCost: entry.todayDay === today ? entry.todayUnits / SCALE : 0,
      billedCalls: entry.billedCalls,
      freeCalls: entry.freeCalls,
      models: models.slice(0, 8),
      modelCount: models.length,
      error: entry.error || '',
    }
  }

  /**
   * 构建报告。
   *
   * 速度约定（面板每 20s 拉一次，用户还会手点刷新）：
   *   - `wait:false`（面板自动轮询的默认路径）——**立刻**用手上的缓存返回一份快照，
   *     同时把缺的/过期的会话丢进后台队列慢慢补；用户永远不用干等。
   *   - `wait:true`（首次打开、手点「刷新」）——把所有会话补齐再返回，慢一点但数据是全的。
   * 这样「首次打开」和「点刷新」才是唯一需要等待的两种情况，其余都是毫秒级。
   */
  async function buildReport(force, opts) {
    const options = opts && typeof opts === 'object' ? opts : {}
    const wait = options.wait !== false   // 默认等待（保持旧行为，路由自己决定要不要等）
    const strict = !!options.strict        // 必须最新（Agent 工具）
    const sessionQuery = getService('sessionQuery')
    if (!sessionQuery || typeof sessionQuery.listSessions !== 'function') {
      return { ok: false, error: 'sessionQuery 服务不可用（当前 Harness 没有会话查询后端）' }
    }

    const records = (await sessionQuery.listSessions()) || []
    const now = Date.now()
    const ttl = cfg.cacheTtlMs

    // 标题：一次批量折叠（读不到就留空，前端回退成短 id）
    const ids = []
    for (const record of records) {
      if (record && record.header && record.header.id) ids.push(record.header.id)
    }
    const titles = new Map()
    if (ids.length && typeof sessionQuery.readTitleSnapshots === 'function') {
      try {
        const snapshots = await sessionQuery.readTitleSnapshots(ids)
        for (const item of snapshots || []) {
          if (!item || item.status !== 'fulfilled') continue
          const value = item.value || {}
          const title = value.title && value.title.title
          if (typeof title === 'string' && title.trim()) titles.set(String(item.sessionId), title.trim())
        }
      } catch (err) {
        /* 标题是装饰性的，失败不影响金额 */
      }
    }

    const pairs = await mapLimit(records, wait ? 6 : 1, async (record) => {      const header = record && record.header
      if (!header || !header.id) return null
      const id = String(header.id)
      const cached = cache.get(id)
      const fresh = !!(cached && !force && now - cached.computedAt < ttl)
      let entry = fresh ? cached : null

      // strict（Agent 工具用）：必须给出最新完整数据，过期就当场重扫
      if (strict && !entry) {
        try {
          entry = await computeEntry(sessionQuery, record)
        } catch (err) {
          entry = newEntry()
          entry.error = String((err && err.message) || err)
        }
        cache.set(id, entry)
        markDirty()
        return { record, entry }
      }

      // 旧数据也先拿来显示：用户要的是立刻看到数字，而不是空白等 1.5 秒。
      if (!entry && cached) entry = cached

      // 只有「这个会话一次都没扫过」且调用方愿意等，才当场扫
      if (!entry && wait) {
        try {
          entry = await computeEntry(sessionQuery, record)
        } catch (err) {
          entry = newEntry()
          entry.error = String((err && err.message) || err)
        }
        cache.set(id, entry)
        markDirty()
        return { record, entry }
      }

      const needsScan = !entry || !fresh
      if (!entry) entry = newEntry()      // 占位，后台马上补
      if (needsScan) scheduleBackgroundScan(id, record, sessionQuery, force)
      return { record, entry }
    })

    // 清掉已经不存在的会话（磁盘缓存也跟着缩小，不会无限变大）
    const alive = new Set(ids.map((id) => String(id)))
    for (const key of [...cache.keys()]) {
      if (!alive.has(key)) {
        cache.delete(key)
        markDirty()
      }
    }

    const rows = []
    const totals = {
      cost: 0,
      todayCost: 0,
      calls: 0,
      billedCalls: 0,
      freeCalls: 0,
      turns: 0,
      sessions: 0,
      sessionsWithCost: 0,
      sessionsFreeOnly: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
    }
    for (const pair of pairs) {
      if (!pair) continue
      const row = rowFrom(pair.record, pair.entry, titles.get(String(pair.record.header.id)))
      rows.push(row)
      totals.sessions += 1
      if (row.cost > 0) totals.sessionsWithCost += 1
      else if (row.calls > 0) totals.sessionsFreeOnly += 1
      totals.cost += row.cost
      totals.todayCost += row.todayCost
      totals.calls += row.calls
      totals.billedCalls += row.billedCalls
      totals.freeCalls += row.freeCalls
      totals.turns += row.turns
      totals.tokens.input += row.tokens.input
      totals.tokens.output += row.tokens.output
      totals.tokens.cacheRead += row.tokens.cacheRead
      totals.tokens.cacheWrite += row.tokens.cacheWrite
      totals.tokens.reasoning += row.tokens.reasoning
      totals.tokens.total += row.tokens.total
    }

    // ---- 与真实余额账本对账 ----
    // 余额账本按 API 调用真实扣减，是唯一权威的「花了多少钱」。
    // 上面的 token 估算只作参考：重试、失败重试、fork 重放、跨天累计都会让两者产生偏差。
    const ledger = readLedger(cfg)
    const today = beijingDateString(now)
    const ledgerInfo = {
      available: !!(ledger && ledger.ok),
      path: (ledger && ledger.path) || '',
      reason: (ledger && !ledger.ok && ledger.reason) || '',
      lastBalance: (ledger && ledger.ok) ? ledger.lastBalance : null,
      todayDebit: 0,
      totalDebit: 0,
      days: [],
      estimateTotal: 0,
      delta: 0,
      coverage: { fromDay: '', toDay: '', days: 0 },
    }
    if (ledger && ledger.ok) {
      const dayKeys = Object.keys(ledger.days).sort()
      let total = 0
      for (const key of dayKeys) {
        const debit = ledger.days[key].debit
        total += debit
        ledgerInfo.days.push({
          day: key,
          debit,
          estimate: 0,
          credit: ledger.days[key].credit,
        })
      }
      ledgerInfo.totalDebit = total
      ledgerInfo.todayDebit = ledger.days[today] ? ledger.days[today].debit : 0
      if (dayKeys.length) {
        const fromDay = dayKeys[0]
        const toDay = dayKeys[dayKeys.length - 1]
        // 账本起点之前是「记账系统还没开始记」的历史空白，不是花费为 0。
        // 官方用量页通常展示更长的窗口（如近 30 天），两边数字因此会有差；
        // 这里明确算出来，让面板能如实说明「本账本只覆盖 X 天，更早的没有观测」。
        const firstMs = Date.parse(fromDay + 'T00:00:00+08:00')
        const lastMs = Date.parse(toDay + 'T00:00:00+08:00')
        const spanDays = Number.isFinite(firstMs) && Number.isFinite(lastMs)
          ? Math.round((lastMs - firstMs) / 86400000) + 1
          : dayKeys.length
        ledgerInfo.coverage = {
          fromDay,
          toDay,
          days: dayKeys.length,
          spanDays,
          // 起点之前缺失了几天（相对 30 天窗口），仅用于提示
          missingBeforeDays: Math.max(0, 30 - spanDays),
        }
      }
      // 把估算按「会话最后活动日」摊到账本的每一天，用于展示偏差
      const estByDay = new Map()
      for (const row of rows) {
        if (!(row.cost > 0)) continue
        const day = beijingDateString(row.updatedAt || row.createdAt || 0)
        estByDay.set(day, (estByDay.get(day) || 0) + row.cost)
      }
      for (const entry of ledgerInfo.days) {
        entry.estimate = estByDay.get(entry.day) || 0
      }
      ledgerInfo.estimateTotal = totals.cost
      ledgerInfo.delta = totals.cost - total
      // 面板与工具的总金额一律改由账本说话
      totals.cost = total
      totals.todayCost = ledgerInfo.todayDebit
    }

    rows.sort((a, b) => (b.cost - a.cost) || (b.updatedAt - a.updatedAt))

    return {
      ok: true,
      currency: pricer.currency,
      pricing: pricer.describe(),
      totals,
      ledger: ledgerInfo,
      sessions: rows,
      scannedAt: now,
    }
  }

  // ---- 路由：只读 JSON ----
  // 用 ctx.inject 等 webServer 就绪后再注册：apply() 可能先于 web 行激活，
  // 直接 ctx.get('webServer') 会拿到 undefined —— 那样路由就根本不存在（请求会落到 fallback 的 404）。
  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped && scoped.webServer ? scoped.webServer : getService('webServer')
    if (!webServer || typeof webServer.register !== 'function') {
      try { console.warn(LOG_PREFIX + ' 当前部署没有 webServer 服务，消费面板的数据接口未注册') } catch (err) { /* ignore */ }
      return () => {}
    }
    return webServer.register({
      kind: 'exact',
      path: ROUTE_DATA,
      handler: async (req, res) => {
        const rejected = trustRejection(req)
        if (rejected) {
          sendJson(res, rejected, { ok: false, error: 'forbidden' })
          return
        }
        const method = String((req && req.method) || 'GET').toUpperCase()
        if (method !== 'GET' && method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        let force = false
        let wait = false
        try {
          const url = new URL(String((req && req.url) || ROUTE_DATA), 'http://localhost')
          force = url.searchParams.get('refresh') === '1'
          // full=1 / wait=1 → 等全部扫完再返回（首次打开、用户主动刷新才用）；
          // 默认 → 立刻返回缓存快照，缺的由后台补。
          const f = url.searchParams.get('full')
          const w = url.searchParams.get('wait')
          wait = f === '1' || w === '1'
          // refresh=1 只表示「把我扫过的标记作废」；要不要等它扫完由 wait 决定。
          // 这样「点刷新」也能立刻出结果，后台扫完面板下次轮询自然刷新。
        } catch (err) { /* ignore */ }
        try {
          const report = await buildReport(force, { wait })
          report.generatedAt = Date.now()
          report.wait = wait
          // 还有多少会话排队/正在后台补，给面板显示「后台仍在计算」
          report.scanning = bgQueue.size + bgRunning
          sendJson(res, 200, report)
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    })
  })

  // ---- 同能力的 Agent 工具：不打开界面也能问「每个会话花了多少钱」 ----
  ctx.inject(['tools'], (scoped) => {
    const tools = scoped && scoped.tools ? scoped.tools : getService('tools')
    if (!tools || typeof tools.register !== 'function') return () => {}
    return tools.register({
      name: 'session_cost_report',
      description: '按会话统计 DeepSeek Harness 的 token 用量并折算成花费（默认人民币，按峰谷价目表估算）。'
        + '返回每个会话的金额、调用/轮次、输入（含缓存命中）与输出 tokens、以及按模型的明细，'
        + '按花费降序。适合回答「这次会话/最近花了多少钱」，或找出最烧钱的会话；不修改任何数据。',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 200,
            description: '只返回花费最高的前 N 个会话，默认 20；总计仍是全部会话的合计。',
          },
          refresh: {
            type: 'boolean',
            description: '跳过缓存、重新读取全部会话日志（默认 false，缓存 60 秒）。',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          return [{ type: 'text', text: summarizeReport(value, args && args.limit) }]
        },
      },
      async execute(args) {
        const input = args && typeof args === 'object' ? args : {}
        // 工具调用一定要拿到最新完整数据，所以显式要求 strict
        const report = await buildReport(!!input.refresh, { wait: true, strict: true })
        report.generatedAt = Date.now()
        return report
      },
    })
  })

  // ---- 活会话增量：会话日志提交后即时增量累计，不用等缓存过期 ----
  ctx.on('session/event', (session, event) => {
    try {
      if (!session || !event) return
      const id = String(session.id || '')
      if (!id) return
      const entry = cache.get(id)
      if (!entry) return
      if (Number.isFinite(event.seq) && event.seq <= entry.lastSeq) return
      foldEvent(entry, event, pricer)
    } catch (err) {
      /* 增量失败只影响新鲜度，下次扫描会纠正 */
    }
  })
}
