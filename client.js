/**
 * dsh-session-cost — Client half (Web).
 *
 * 在左侧面板列里加一个图标，并在主面板里渲染「会话消费」页面。
 * 数据来自宿主路由 /dsh-session-cost/data.json（同源 GET，只读）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-cost',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-session-cost'
    const API = '/dsh-session-cost/data.json'

    /**
     * 跨挂载的全局缓存：面板被切走再切回来时组件会重新挂载，
     * 但这份数据没有理由丢掉 —— 有它在，第二次点开「会话消费」就是瞬间出内容。
     */
    const sessionCache = { data: null, at: 0 }

    const ZH = {
      'meta.title': '会话消费',
      'meta.description': '按会话统计 token 用量与花费（元），看每个会话到底花了多少钱。',
      'panel.title': '会话消费',
      'panel.subtitle': '按会话折叠真实 token 用量，用峰谷价目表折算成人民币',
      'panel.refresh': '刷新',
      'panel.refreshing': '刷新中…',
      'panel.loading': '正在读取会话日志…',
      'panel.peak': '峰时价',
      'panel.valley': '谷时价',
      'panel.totalCost': '全部花费',
      'panel.todayCost': '今日花费',
      'panel.tokens': 'Token 总量',
      'panel.sessions': '会话 / 调用',
      'panel.colSession': '会话',
      'panel.colWhen': '最近活动',
      'panel.colCalls': '调用',
      'panel.colInput': '输入（命中缓存）',
      'panel.colOutput': '输出',
      'panel.colCost': '花费',
      'panel.empty': '还没有可统计的会话',
      'panel.untitled': '未命名会话',
      'panel.subagent': '子会话',
      'panel.live': '进行中',
      'panel.updated': '更新于',
      'panel.models': '模型明细',
      'panel.error': '读取失败',
      'panel.retry': '重试',
      'panel.note': '只有走你账号余额的渠道（默认 deepseek-account / deepseek）才折算成钱，别家渠道和免费额度一律记 0 元、只统计 token。金额按内置 DeepSeek 峰谷价目表估算（元 / 百万 token，峰时 ×2），实际以官方账单为准。点一行可展开按模型明细。',
      'panel.currentSession': '当前会话',
      'panel.sortHint': '点列头排序',
      'panel.sessionsUnit': '个会话',
      'panel.unknownModel': '未知模型',
      'panel.free': '免费',
      'panel.turnsUnit': '轮',
      'panel.freeCallsHint': '次调用走免费/别家渠道（不计钱）',
      'panel.realCost': '真实扣费',
      'panel.fromLedger': '来自余额账本（权威）',
      'panel.balance': '余额',
      'panel.coveredDays': '覆盖 {n} 天账本数据',
      'panel.scanning': '后台计算中 {n}',
      'panel.coveredRange': '{from} ~ {to}（{n} 天账本）',
      'panel.ledgerGap': '⚠ 账本从 {day} 才开始记录，更早的消费没有本地数据；官方用量页（如近 30 天）金额会比这里大，差额就来自那段空白。',
      'panel.estimate': 'Token 估算',
      'panel.matches': '与真实扣费一致',
      'panel.offBy': '与真实扣费差 {v}（仅供参考）',
      'panel.estimateNote': '会话行金额按 token 用量估算，账本没有会话维度，仅供比较哪个会话更费。',
    }

    const EN = {
      'meta.title': 'Session cost',
      'meta.description': 'Estimated spending per DSH session, folded from real token usage.',
      'panel.title': 'Session cost',
      'panel.subtitle': 'Real token usage per session, priced with peak/off-peak rates',
      'panel.refresh': 'Refresh',
      'panel.refreshing': 'Refreshing…',
      'panel.loading': 'Reading session logs…',
      'panel.peak': 'Peak rate',
      'panel.valley': 'Off-peak rate',
      'panel.totalCost': 'All time',
      'panel.todayCost': 'Today',
      'panel.tokens': 'Tokens',
      'panel.sessions': 'Sessions / calls',
      'panel.colSession': 'Session',
      'panel.colWhen': 'Last activity',
      'panel.colCalls': 'Calls',
      'panel.colInput': 'Input (cached)',
      'panel.colOutput': 'Output',
      'panel.colCost': 'Cost',
      'panel.empty': 'No sessions yet',
      'panel.untitled': 'Untitled session',
      'panel.subagent': 'Sub-session',
      'panel.live': 'Live',
      'panel.updated': 'Updated',
      'panel.models': 'By model',
      'panel.error': 'Failed to load',
      'panel.retry': 'Retry',
      'panel.note': 'Only providers that bill your account balance (default: deepseek-account / deepseek) are priced; third-party and free-tier channels count as ¥0 and only contribute tokens. Amounts are estimates from the built-in DeepSeek peak/off-peak table (CNY per million tokens, peak ×2). The official bill wins. Click a row for the per-model breakdown.',
      'panel.currentSession': 'Current session',
      'panel.sortHint': 'Click a column header to sort',
      'panel.sessionsUnit': 'sessions',
      'panel.unknownModel': 'Unknown model',
      'panel.free': 'free',
      'panel.turnsUnit': 'turns',
      'panel.freeCallsHint': 'calls on free / third-party channels (not charged)',
      'panel.realCost': 'Actual spend',
      'panel.fromLedger': 'from the balance ledger (authoritative)',
      'panel.balance': 'Balance',
      'panel.coveredDays': 'covering {n} days of ledger data',
      'panel.scanning': 'scanning {n} in background',
      'panel.coveredRange': '{from} ~ {to} ({n} days of ledger)',
      'panel.ledgerGap': '⚠ The ledger only starts at {day}; anything earlier has no local observation. The official usage page (e.g. last 30 days) will show a larger number, and that gap is exactly that missing stretch.',
      'panel.estimate': 'Token estimate',
      'panel.matches': 'matches actual spend',
      'panel.offBy': 'off by {v} vs actual (reference only)',
      'panel.estimateNote': 'Per-session amounts are estimated from token usage; the ledger has no per-session dimension, so use them only to compare which session is pricier.',
    }

    const CSS = `
.dshsc-root{box-sizing:border-box;min-height:100%;overflow:auto;padding:20px 24px 28px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.dshsc-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px}
.dshsc-title{margin:0;font-size:17px;font-weight:600;letter-spacing:.2px}
.dshsc-sub{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshsc-actions{display:flex;align-items:center;gap:10px;flex-shrink:0}
.dshsc-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:999px;font-size:11px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dshsc-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary);display:inline-block}
.dshsc-dot-off{background:var(--dsw-alias-state-idle-primary)}
.dshsc-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:7px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit}
.dshsc-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dshsc-btn:disabled{opacity:.55;cursor:default}
.dshsc-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px}
.dshsc-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:10px 13px}
.dshsc-card-label{font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:4px}
.dshsc-card-value{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}
.dshsc-card-hint{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px;font-variant-numeric:tabular-nums}
.dshsc-table{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.dshsc-row{display:grid;grid-template-columns:minmax(0,1fr) 92px 62px 132px 92px 104px;gap:8px;align-items:center;padding:8px 13px;border-top:1px solid var(--dsw-alias-border-l1);font-variant-numeric:tabular-nums}
.dshsc-row-head{border-top:none;padding-top:9px;padding-bottom:9px;font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);cursor:pointer;user-select:none}
.dshsc-row-head>div{cursor:pointer}
.dshsc-row-body{cursor:pointer}
.dshsc-row-body:hover{background:var(--dsw-alias-bg-layer-2)}
.dshsc-name{display:flex;align-items:center;gap:7px;min-width:0}
.dshsc-name-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.dshsc-where{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
.dshsc-tag{font-size:10px;padding:0 5px;border-radius:4px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);flex-shrink:0}
.dshsc-num{text-align:right;color:var(--dsw-alias-label-secondary);font-size:12px}
.dshsc-cost{text-align:right;font-weight:600;font-size:13px}
.dshsc-muted{color:var(--dsw-alias-label-secondary)}
.dshsc-detail{grid-column:1 / -1;padding:6px 0 4px;font-size:12px}
.dshsc-model-row{display:grid;grid-template-columns:minmax(0,1fr) 62px 108px 100px;gap:8px;padding:3px 0;color:var(--dsw-alias-label-secondary)}
.dshsc-model-row span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.dshsc-model-row span:not(:first-child){text-align:right;font-variant-numeric:tabular-nums}
.dshsc-empty{padding:40px 16px;text-align:center;color:var(--dsw-alias-label-secondary)}
.dshsc-error{margin:0 0 14px;padding:9px 12px;border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:12px;display:flex;justify-content:space-between;gap:12px;align-items:center}
.dshsc-foot{margin-top:12px;font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.6}
.dshsc-note{margin:0 0 12px;padding:8px 11px;border-radius:8px;font-size:11px;line-height:1.6;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.dshsc-live{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex-shrink:0}
`

    const CSS_ID = 'dsh-session-cost-style'

    function formatMoney(value, currency) {
      const n = Number(value) || 0
      const symbol = String(currency || 'CNY').toUpperCase() === 'USD' ? '$' : '¥'
      if (!(n > 0)) return symbol + '0.00'
      if (n >= 1) {
        const text = n.toFixed(2)
        const parts = text.split('.')
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
        return symbol + parts.join('.')
      }
      if (n >= 0.01) return symbol + n.toFixed(3)
      if (n >= 0.0001) return symbol + n.toFixed(4)
      return symbol + '<0.0001'
    }

    function formatTokens(value) {
      const n = Number(value) || 0
      if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
      if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M'
      if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k'
      return String(n)
    }

    function formatCount(value) {
      const n = Number(value) || 0
      return n.toLocaleString('en-US')
    }

    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    function formatWhen(ms) {
      const n = Number(ms) || 0
      if (!n) return '—'
      const d = new Date(n)
      const now = new Date()
      const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
      if (sameDay) return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
      return (d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
    }

    function baseName(path) {
      const text = String(path || '')
      const parts = text.split(/[\\/]+/).filter(Boolean)
      return parts.length ? parts[parts.length - 1] : text
    }

    function shortId(id) {
      const text = String(id || '')
      return text.length > 8 ? text.slice(0, 8) : text
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)

        ctx.effect(() => {
          const disposers = []
          for (const dict of [
            ['zh', ZH], ['zh-CN', ZH], ['zh-Hans', ZH],
            ['en', EN], ['en-US', EN],
          ]) {
            try {
              disposers.push(ctx.locale.register(NS, dict[0], dict[1]))
            } catch (err) { /* 未知语言标签就跳过 */ }
          }
          return () => {
            for (const dispose of disposers) {
              try { dispose() } catch (err) { /* ignore */ }
            }
          }
        })

        function PanelIcon(props) {
          const size = Number(props && props.size) || 18
          const active = !!(props && props.active)
          const color = active ? 'var(--dsw-alias-brand-primary)' : 'currentColor'
          return h('svg', {
            width: size, height: size, viewBox: '0 0 20 20', fill: 'none',
            'aria-hidden': true, style: { display: 'block' },
          },
          h('rect', { x: 2.6, y: 4.4, width: 14.8, height: 11.2, rx: 2.4, stroke: color, strokeWidth: 1.4 }),
          h('path', { d: 'M6.4 8.4l2.1 3 1.5-2 1.5 2 2.1-3', stroke: color, strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
          h('path', { d: 'M6.6 13.1h6.8', stroke: color, strokeWidth: 1.4, strokeLinecap: 'round' }))
        }

        function CostPanel() {
          const [state, setState] = React.useState({
            // 直接用上次留下的数据渲染 —— 重新挂载不该再出现白屏/转圈
            loading: !sessionCache.data,
            busy: false,
            data: sessionCache.data || null,
            error: '',
          })
          const [sort, setSort] = React.useState({ key: 'cost', dir: -1 })
          const [expanded, setExpanded] = React.useState({})
          const aliveRef = React.useRef(true)

          const load = React.useCallback((mode) => {
            // 前端永远不等全量：后端已经做了磁盘持久化缓存，
            // 重启后第一次请求也能从磁盘立刻给出全部会话。
            // 所以这里干脆不带 wait —— 拿到的要么是磁盘缓存、要么是后台正在补，
            // 面板永远有东西可渲染，不会出现「转圈 1.5 秒」。
            const force = mode === 'refresh'
            setState((prev) => (prev.data ? prev : { ...prev, loading: true }))
            setState((prev) => ({ ...prev, busy: true, action: mode }))
            const url = API + (force ? '?refresh=1' : '')
            fetch(url, { cache: 'no-store' })
              .then((response) => {
                if (!response.ok) throw new Error('HTTP ' + response.status)
                return response.json()
              })
              .then((data) => {
                if (data && data.ok === false) {
                  if (!aliveRef.current) return
                  setState({ loading: false, busy: false, data: null, error: String(data.error || t('panel.error')) })
                  return
                }
                // 即使是已卸载的旧实例，也把数据留在全局缓存里给下一次点开用
                if (data) {
                  sessionCache.data = data
                  sessionCache.at = Date.now()
                }
                if (!aliveRef.current) return
                setState({ loading: false, busy: false, data, error: '' })
                // 还有会话在后台补算 → 过一会儿再拉一次，让数字自己长上来
                if (data && Number(data.scanning) > 0 && !pollSoonRef.current) {
                  pollSoonRef.current = true
                  setTimeout(() => {
                    pollSoonRef.current = false
                    if (aliveRef.current) loadRef.current('poll')
                  }, 1200)
                }
              })
              .catch((err) => {
                if (!aliveRef.current) return
                setState((prev) => ({ loading: false, busy: false, data: prev.data, error: String((err && err.message) || err) }))
              })
          }, [])

          const pollSoonRef = React.useRef(false)
          const loadRef = React.useRef(load)
          React.useEffect(() => { loadRef.current = load }, [load])

          React.useEffect(() => {
            aliveRef.current = true
            // 一律走 'poll'：有全局缓存时这一句只是后台补一次数据；
            // 真的什么都没有（进程刚起）时 load 内部才会退化成等待全量。
            load('poll')
            const timer = setInterval(() => load('poll'), 20000)
            return () => {
              aliveRef.current = false
              clearInterval(timer)
            }
          }, [])

          const data = state.data
          const currency = (data && data.currency) || 'CNY'
          const sessions = (data && Array.isArray(data.sessions)) ? data.sessions : []
          const totals = (data && data.totals) || {}
          const peakNow = !!(data && data.pricing && data.pricing.peakNow)

          const rows = React.useMemo(() => {
            const key = sort.key
            const dir = sort.dir
            const pick = (row) => {
              if (key === 'cost') return row.cost
              if (key === 'today') return row.todayCost
              if (key === 'when') return row.updatedAt
              if (key === 'calls') return row.calls
              if (key === 'tokens') return (row.tokens && row.tokens.total) || 0
              if (key === 'input') return (row.tokens && (row.tokens.input + row.tokens.cacheRead)) || 0
              if (key === 'output') return (row.tokens && row.tokens.output) || 0
              return row.cost
            }
            return [...sessions].sort((a, b) => {
              const diff = pick(a) - pick(b)
              if (diff !== 0) return diff * dir
              return (b.updatedAt || 0) - (a.updatedAt || 0)
            })
          }, [sessions, sort])

          const toggleSort = (key) => {
            setSort((prev) => (prev.key === key ? { key, dir: -prev.dir } : { key, dir: -1 }))
          }

          const sortMark = (key) => (sort.key === key ? (sort.dir < 0 ? ' ↓' : ' ↑') : '')

          const headerCell = (key, label, align) => h('div', {
            key,
            onClick: () => toggleSort(key),
            className: 'dshsc-num',
            style: align === 'left' ? { textAlign: 'left' } : undefined,
            title: t('panel.sortHint'),
          }, label + sortMark(key))

          const led = data && data.ledger ? data.ledger : null
          const hasLedger = !!(led && led.available)
          const realTotal = hasLedger ? led.totalDebit : totals.cost
          const realToday = hasLedger ? led.todayDebit : totals.todayCost
          const estimateTotal = hasLedger ? Number(led.estimateTotal || 0) : totals.cost
          const delta = hasLedger ? (estimateTotal - realTotal) : 0

          const cards = [
            h('div', { className: 'dshsc-card', key: 'total' },
              h('div', { className: 'dshsc-card-label' }, hasLedger ? t('panel.realCost') : t('panel.totalCost')),
              h('div', { className: 'dshsc-card-value' }, formatMoney(realTotal, currency)),
              hasLedger
                ? h('div', { className: 'dshsc-card-hint' }, t('panel.fromLedger'))
                : h('div', { className: 'dshsc-card-hint' }, String(totals.sessionsWithCost || 0) + ' / ' + String(totals.sessions || 0) + ' ' + t('panel.sessionsUnit')),
              totals.freeCalls ? h('div', { className: 'dshsc-card-hint' }, String(totals.freeCalls) + ' ' + t('panel.freeCallsHint')) : null),
            h('div', { className: 'dshsc-card', key: 'today' },
              h('div', { className: 'dshsc-card-label' }, t('panel.todayCost')),
              h('div', { className: 'dshsc-card-value' }, formatMoney(realToday, currency)),
              h('div', { className: 'dshsc-card-hint' },
                hasLedger && led.lastBalance != null
                  ? t('panel.balance') + ' ' + formatMoney(led.lastBalance, currency)
                  : (peakNow ? t('panel.peak') : t('panel.valley'))),
              hasLedger && led.coverage && led.coverage.days
                ? h('div', { className: 'dshsc-card-hint' },
                  t('panel.coveredRange')
                    .replace('{from}', String(led.coverage.fromDay).slice(5))
                    .replace('{to}', String(led.coverage.toDay).slice(5))
                    .replace('{n}', String(led.coverage.days)))
                : null),
            h('div', { className: 'dshsc-card', key: 'tokens' },
              h('div', { className: 'dshsc-card-label' }, hasLedger ? t('panel.estimate') : t('panel.tokens')),
              h('div', { className: 'dshsc-card-value' }, hasLedger ? formatMoney(estimateTotal, currency) : formatTokens(totals.tokens && totals.tokens.total)),
              h('div', { className: 'dshsc-card-hint' },
                hasLedger
                  ? (Math.abs(delta) < 0.005
                    ? t('panel.matches')
                    : t('panel.offBy').replace('{v}', (delta >= 0 ? '+' : '-') + formatMoney(Math.abs(delta), currency)))
                  : formatTokens(totals.tokens && totals.tokens.input) + ' / ' + formatTokens(totals.tokens && totals.tokens.cacheRead) + ' / ' + formatTokens(totals.tokens && totals.tokens.output)),
              hasLedger && totals.tokens
                ? h('div', { className: 'dshsc-card-hint' }, formatTokens(totals.tokens.total) + ' tokens')
                : null),
            h('div', { className: 'dshsc-card', key: 'calls' },
              h('div', { className: 'dshsc-card-label' }, t('panel.sessions')),
              h('div', { className: 'dshsc-card-value' }, formatCount(totals.sessions)),
              h('div', { className: 'dshsc-card-hint' }, formatCount(totals.calls) + ' ' + t('panel.colCalls'))),
          ]

          const body = []
          for (const row of rows) {
            const open = !!expanded[row.id]
            const title = row.title || t('panel.untitled')
            body.push(h('div', {
              key: row.id,
              className: 'dshsc-row dshsc-row-body',
              onClick: () => setExpanded((prev) => ({ ...prev, [row.id]: !prev[row.id] })),
            },
            h('div', { className: 'dshsc-name' },
              row.live ? h('span', { className: 'dshsc-live', title: t('panel.live') }) : null,
              h('div', { style: { minWidth: 0 } },
                h('div', { className: 'dshsc-name-text', title: title + ' · ' + row.id }, title),
                h('div', { className: 'dshsc-where', title: row.cwd || row.id },
                  baseName(row.cwd) || shortId(row.id),
                  row.isSubagent ? ' · ' + t('panel.subagent') : '',
                  row.error ? ' · ' + t('panel.error') : ''))),
            h('div', { className: 'dshsc-num' }, formatWhen(row.updatedAt)),
            h('div', { className: 'dshsc-num' }, formatCount(row.calls)),
            h('div', { className: 'dshsc-num' }, formatTokens(row.tokens && row.tokens.input) + ' / ' + formatTokens(row.tokens && row.tokens.cacheRead)),
            h('div', { className: 'dshsc-num' }, formatTokens(row.tokens && row.tokens.output)),
            h('div', { className: 'dshsc-cost' }, formatMoney(row.cost, currency))))

            if (open) {
              const modelRows = (row.models || []).map((model) => h('div', { className: 'dshsc-model-row', key: (model.provider || '') + '/' + model.model },
                h('span', { title: (model.provider ? model.provider + ' · ' : '') + model.model },
                  (model.provider ? model.provider + ' · ' : '') + (model.model || t('panel.unknownModel'))),
                h('span', null, formatCount(model.calls)),
                h('span', null, formatTokens(model.tokens)),
                h('span', null, model.billed === false ? t('panel.free') : formatMoney(model.cost, currency))))
              body.push(h('div', { className: 'dshsc-row', key: row.id + '::detail', style: { cursor: 'default' } },
                h('div', { className: 'dshsc-detail' },
                  h('div', { style: { marginBottom: 4, color: 'var(--dsw-alias-label-secondary)' } },
                    t('panel.models') + ' · ' + String(row.modelCount || 0) + ' · ' + String(row.turns || 0) + ' ' + t('panel.turnsUnit')),
                  modelRows.length ? modelRows : h('div', { className: 'dshsc-muted' }, '—'))))
            }
          }

          const table = sessions.length
            ? h('div', { className: 'dshsc-table' },
              h('div', { className: 'dshsc-row dshsc-row-head' },
                h('div', { className: 'dshsc-num', style: { textAlign: 'left' } }, t('panel.colSession')),
                headerCell('when', t('panel.colWhen')),
                headerCell('calls', t('panel.colCalls')),
                headerCell('input', t('panel.colInput')),
                headerCell('output', t('panel.colOutput')),
                headerCell('cost', t('panel.colCost'))),
              body)
            : h('div', { className: 'dshsc-table' },
              h('div', { className: 'dshsc-empty' }, state.loading ? t('panel.loading') : t('panel.empty')))

          return h('div', { className: 'dshsc-root' },
            h('style', { id: CSS_ID, dangerouslySetInnerHTML: { __html: CSS } }),
            h('div', { className: 'dshsc-head' },
              h('div', null,
                h('h1', { className: 'dshsc-title' }, t('panel.title')),
                h('p', { className: 'dshsc-sub' },
                  t('panel.subtitle'),
                  data && data.generatedAt ? ' · ' + t('panel.updated') + ' ' + formatWhen(data.generatedAt) : '')),
              h('div', { className: 'dshsc-actions' },
                data && Number(data.scanning) > 0
                  ? h('span', { className: 'dshsc-chip' }, t('panel.scanning').replace('{n}', String(data.scanning)))
                  : null,
                h('span', { className: 'dshsc-chip' },
                  h('span', { className: peakNow ? 'dshsc-dot' : 'dshsc-dot dshsc-dot-off' }),
                  peakNow ? t('panel.peak') : t('panel.valley')),
                h('button', {
                  className: 'dshsc-btn',
                  onClick: () => load('refresh'),
                  disabled: state.busy,
                }, state.busy ? t('panel.refreshing') : t('panel.refresh')))),
            state.error ? h('div', { className: 'dshsc-error' },
              h('span', null, t('panel.error') + ': ' + state.error),
              h('button', { className: 'dshsc-btn', onClick: () => load('refresh') }, t('panel.retry'))) : null,
            h('div', { className: 'dshsc-cards' }, cards),
            hasLedger && led.coverage && Number(led.coverage.missingBeforeDays) > 0
              ? h('div', { className: 'dshsc-note' },
                t('panel.ledgerGap').replace('{day}', String(led.coverage.fromDay)))
              : null,
            table,
            h('div', { className: 'dshsc-foot' },
              hasLedger && t('panel.estimateNote') ? t('panel.estimateNote') + ' ' : '',
              t('panel.note')))
        }

        // 一个最小的错误边界：面板里任何意外异常都只坏掉这个面板，不连累整个 main 槽位。
        class PanelBoundary extends React.Component {
          constructor(props) {
            super(props)
            this.state = { error: null }
          }

          static getDerivedStateFromError(error) {
            return { error }
          }

          render() {
            if (this.state.error) {
              const message = String((this.state.error && this.state.error.message) || this.state.error)
              return h('div', { className: 'dshsc-root' },
                h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
                h('div', { className: 'dshsc-error' }, '会话消费面板出错：' + message))
            }
            return this.props.children
          }
        }

        function SessionCostPanel(props) {
          return h(PanelBoundary, null, h(CostPanel, props))
        }

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'session-cost',
          order: 30,
          label: () => t('panel.title'),
        }, PanelIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'session-cost',
        }, SessionCostPanel))
      },
    }
  },
})
