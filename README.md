# dsh-session-cost · 会话消费

给 [DeepSeek Harness](https://github.com/deepseek-ai) 的 Web 界面加一个「会话消费」面板：**每个会话到底花了多少钱**，以及**你账户里真实扣掉了多少钱**。

- 💰 顶部显示**真实扣费**与**当前余额**（读余额账本，权威）
- 📊 按会话列出 token 用量与花费，可点开看按模型明细
- 🆓 自动识别免费/别家渠道（trae、cline、raccoon、qodercn…），**只算真花你钱的那部分**
- 🤖 同时注册一个 Agent 工具 `session_cost_report`，可以直接问「这次会话花了多少钱」
- ⚡ 磁盘持久化缓存，重启后秒开（实测 ~4ms 出全部会话）
- 🔒 **纯本地只读**，不联网、不上传任何数据

## 安装

在 DSH 的「插件 → 添加插件」里粘贴本仓库地址即可：

```
https://github.com/muti2607/dsh-session-cost
```

也可以填本地目录，或安装后可自选配置。

> 插件是**只读**的：只读会话日志与余额账本，不写入你的会话、不发任何网络请求。

## 界面

- 左侧面板栏多一个「会话消费」图标，点开就是消费页面
- 顶部四张卡：**真实扣费** / **今日花费 + 余额** / **Token 估算** / **会话·调用数**
- 表格按花费排序（点列头可切换），点一行展开**按模型明细**
- 20 秒自动刷新；手动「刷新」立刻返回，后台重扫不阻塞

## Agent 工具

插件注册了只读工具 `session_cost_report`：

- 直接问「这次会话 / 最近花了多少钱」「哪个会话最烧钱」，Agent 会自动调用
- 参数：`limit`（返回前 N 个会话，默认 20）、`refresh`（跳过缓存重扫）
- 返回金额、调用/轮次、输入（含缓存命中）与输出 tokens、按模型明细，按花费降序

## 计算方式

### 只有真花钱的渠道才计费

Harness 的同一条会话里可以混用多家渠道。**别家渠道走免费额度或你自己的第三方 key，不会从你的 DSH 账户余额扣钱**，所以一律记 **¥0**：

- 默认只有 `billedProviders` 里的 provider 才折算金额（默认 `deepseek-account`、`deepseek`）
- 其余渠道的 token 照常统计、单独列出并标注「免费」，但不进入总花费
- 想让某个渠道也算钱，加进配置的 `billedProviders` 即可

### 单价

```
未命中缓存输入 = usage.inputTokens      × miss 价
命中缓存输入   = usage.cacheReadTokens  × hit  价
输出           = usage.outputTokens     × out  价
```

Harness 保证 `reasoningTokens ⊆ outputTokens`，所以 reasoning 不单独累加（否则输出侧会重复计费）。

时间按**北京时间**判定峰谷，峰时按 `peakMultiplier` 倍计：

- 峰时：周一至周五 9:00–12:00、14:00–18:00，且不是法定节假日
- 其余时段（含周末、法定节假日全天）按谷时价

内置价目表（元 / 百万 token，谷时价，峰时 ×2）：

| 模型匹配 | 命中 | 未命中 | 输出 |
| --- | --- | --- | --- |
| `deepseek-v4-pro` | 0.15 | 4.5 | 13.5 |
| 其它（`*`，Flash 系） | 0.02 | 1 | 4 |

### 总额以「真实扣费」为准

**面板顶部的总花费和今日花费不是 token 估算，而是你账户里真实扣掉的钱。**

- 余额账本按天记录 `debitUnits`（已用余额差额校准，充值单独记为 credit）
- 面板读取这本账，顶部数字与你账户扣款一致，同时显示当前余额和覆盖天数
- **会话行里的金额仍是 token 估算**——账本按天记账、没有会话维度，无法把某一天的钱精确拆回每条会话，所以那些数字只用来比较「哪个会话更费」
- 账本读不到时（没装 whale-widget / 换机器），面板自动退化为纯 token 估算，并标注「Token 估算 · 与真实扣费差 X」

为什么会有差：会话日志的 token 用量是**逐步(step)记录的理论值**，而余额是**每次 API 调用真实扣减**。重试、失败重试、fork/重放、跨天累计、历史定价期都会造成偏差。

### 和官方用量页对不上？

余额账本是**按天观测**的，只在「DSH 界面开着 + 能取到余额」时记录：

- 面板会显示覆盖区间，例如 `10-19 ~ 11-05（18 天账本）`
- 界面关闭期间的花费**本地观测不到**，所以面板金额可能比官方「近 30 天」略少
- 想精确比对，请把官方页面切到**与账本相同的日期范围**

## 配置（可选）

在 profile 的 `cordis.patch.yml` 里覆盖这一行的 `config`：

```yaml
- id: session-cost
  config:
    currency: CNY
    cacheTtlMs: 60000          # 扫描结果缓存时长（毫秒），5s–10min
    peakMultiplier: 2          # 峰时价格倍数
    billedProviders:           # 只有这些渠道会扣你的钱；别的渠道一律记 0 元
      - deepseek-account
      - deepseek
    prices:                    # match 是模型名子串，'*' 是兜底；最长命中优先
      - match: deepseek-v4-pro
        hit: 0.15
        miss: 4.5
        out: 13.5
      - match: '*'
        hit: 0.02
        miss: 1
        out: 4
    holidays:                  # 法定节假日（全天按谷时价），每年更新一次
      - '2026-10-01'
    dshHome: ''                # 账本所在目录；留空则用 $DSH_HOME 或 ~/.dsh
    persistCache: true         # 扫描结果写入磁盘，重启后秒开
    cacheDir: ''               # 磁盘缓存目录；留空则用插件目录下的 .cache
```

## 速度与磁盘缓存

面板**从不会让你干等**：

- 每次点开「会话消费」都先渲染上次的数据（含切走再切回、进程重启后）
- 后台以并发 2 补齐/刷新会话，面板显示「后台计算中 N」，扫完自动更新
- 20 秒轮询、手点「刷新」都是毫秒级返回

扫描结果持久化到磁盘，**只写非系统盘**：

- 位置优先级：配置 `cacheDir` → 插件目录下的 `.cache` → 环境变量 `DSF_SC_CACHE_DIR`
- 任何候选路径只要在 `C:` 上就**直接跳过**；一个可用位置都没有就关闭持久化，绝不写 C 盘
- 4 秒防抖落盘；会话被删后缓存条目同步清理，不会无限膨胀

## 数据接口

只注册一个**只读**路由：

```
GET /dsh-session-cost/data.json
```

| 参数 | 作用 |
| --- | --- |
| `wait=1` / `full=1` | 等全部会话扫完再返回 |
| `refresh=1` | 标记已扫描结果为过期，后台重扫（仍立刻返回旧数据） |

返回结构（节选）：

```jsonc
{
  "ok": true,
  "currency": "CNY",
  "pricing": {
    "peakMultiplier": 2, "peakNow": false,
    "prices": [], "billedProviders": ["deepseek-account", "deepseek"]
  },
  "ledger": {
    "available": true,
    "lastBalance": 6.81,
    "todayDebit": 0,
    "totalDebit": 48.62,
    "estimateTotal": 7.2,
    "delta": -41.42,
    "coverage": { "fromDay": "2026-10-19", "toDay": "2026-11-05", "days": 18 },
    "days": [{ "day": "2026-11-04", "debit": 8.49, "estimate": 0, "credit": 0 }]
  },
  "totals": { "cost": 48.62, "todayCost": 0, "sessions": 12, "calls": 340, "tokens": {} },
  "sessions": [
    {
      "id": "session-…",
      "title": "…",
      "calls": 40,
      "turns": 12,
      "tokens": { "input": 0, "output": 0, "cacheRead": 0, "total": 0 },
      "cost": 0.42,
      "billedCalls": 40,
      "freeCalls": 0,
      "models": [{ "provider": "deepseek-account", "model": "deepseek-v4-pro", "billed": true, "calls": 40, "tokens": 0, "cost": 0.42 }]
    }
  ]
}
```

有账本时 `totals.cost` 就是 `ledger.totalDebit`（真实扣费）；`sessions[].cost` 是逐会话的 token 估算。

## 隐私

- **不联网**：插件不发任何网络请求，所有数据都在本机
- **不写入会话**：只读会话日志与余额账本
- **不采集**：不上报任何用量或个人信息
- 唯一的落盘位置是本地缓存文件（前面说的非系统盘 `.cache`）

## 已知限制

- 冷会话要读一次完整日志；会话多/长时首次扫描约 1.5 秒，之后走磁盘缓存（≈4ms）
- 价目表与节假日是内置常量，官方调价后请改 `config.prices` / `config.holidays`
- 只统计 `assistant/message` 上确实带 `usage` 的调用；被中断且无 usage 的不计费
- 会话级金额是估算：账本按天记账、没有会话维度
- 「真实扣费」依赖余额账本（`.dshw-usage.json`），没有该文件时自动退化为纯估算

## 许可

MIT
