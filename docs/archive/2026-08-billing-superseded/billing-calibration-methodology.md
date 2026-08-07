# aka-ai-image-generator 计费探测方法论与校准记录

作者：Kael（配合 Kari 实测）
日期：2026-08-05 → 2026-08-06（探针规格经二次评审修订，2026-08-06）
状态：已实测验证；探针功能实施规格定稿，待实现

---

## 0. TL;DR

**公式推导不可信，真实扣费必须实测。** 本次调查发现插件原计费模型与 OpenLux 真实扣费存在三类系统性偏差（per-token 除数 100 倍、MJ 倍率 off-table、汇率残渣 13.5 倍），全部通过「余额位移法」（balance-delta）实测定位并修正。本文档给出可复用的探测方法论，以及把该过程产品化为「模型映射列表探测按钮」的完整实施规格（经用户/管理员/运营三方评审，含 12 项缺口修订）。

---

## 1. 调查过程（2026-08-05/06）

### 1.1 触发
Kari 要求对照 OpenLux 文档（doc.openlux.ai/en）从头到尾分析扣费链路。文档公开部分（Apifox 式门户，需门户 token 才能读正文）只有一句计费口径：「经 yunwu.ai 网关转发，按平台计费规则扣费」，**不含任何 quota/倍率公式**。真实计费事实只能来自实盘 API。

### 1.2 使用的实盘接口（只读 + 真实生成）
- `GET /api/pricing` → 模型计价字段（model_price / model_ratio / completion_ratio / quota_type / enable_groups）+ 95 组 group_ratio 表
- `GET /v1/dashboard/billing/usage` → `total_usage`（累计消耗，美元口径）
- `POST /v1/images/generations`、`POST /mj/submit/imagine` + `GET /mj/task/{id}/fetch` → 真实生成（花真钱，用于校准）
- 响应头 `x-routing-group` → 实际路由分组（同步端点有，**MJ 异步端点没有**）

### 1.3 核心发现（全部实测证据）

| # | 发现 | 证据 | 影响 |
|---|---|---|---|
| 1 | OpenLux per-token 计费除数 = **5000**，非 NewAPI 默认 500000 | gpt-image-2 三组隔离样本精确吻合 `USD = eff_tokens × tokenRatio × group_ratio / 5000`（M:0.03433/L:0.24529/XL:1.4197，误差 <0.1%） | 插件原 `/500000` 少收恰好 **100 倍**（6 个 per-token 模型全中招） |
| 2 | MJ 真实倍率 ≈**4.49**，不在 group_ratio 表内（表最大 1.176） | 4 次 mj_imagine 余额位移：1.3236/1.3236/1.3236/1.3694 → 0.3×4.49=1.347 | 插件按表内倍率（≤0.735）低估约 **6 倍**；NewAPI 对 MJ 走渠道侧 mj_ratio 独立计费，`/api/pricing` 不公开 |
| 3 | MJ 异步链路（submit + task fetch）**无 x-routing-group 头**、任务体无计费字段 | 多次请求验证 | 无法动态取真实倍率，只能靠校准值 |
| 4 | `total_usage`/`model_price` 为**美元口径**；`supplierCreditToRmb=0.5` 是 yunwu 时代残渣（1 积分=¥0.5） | total_usage=27.49 与模型价量纲一致 | 旧汇率让用户价只有真实成本 **7.5%**（约 13.5 倍低估） |
| 5 | 余额记账有**滞后与精度限制** | 小额生成（<$0.05）4 秒内显示 0.0000；大额 0.2452/1.4198 可精确对账；gpt 的 0.1092 延迟滚入下一个 MJ 测量窗口 | 单次小额归因不可靠；批量/累计法可靠 |
| 6 | 路由分组显著影响成本 | gpt-image-2 同 prompt 路由 Codex-Gpt-2(0.0588) vs Openai-Gpt-1(0.5882)，差 10 倍 | 预扣必须用保守上界，结算用实际路由 |

### 1.4 修正后的公式（OpenLux 实测口径）

```
per-call:   USD = model_price × 渠道有效倍率（MJ 用校准因子 4.49，表内模型用 group_ratio[实际分组]）
per-token:  USD = (input + output×completion_ratio) × tokenRatio × group_ratio[实际分组] / quotaPerUnit(5000)
用户积分    = USD × usdToRmb(6.76) × creditsPerCny(10) × (1 + pricingMarkupPercent/100)
```

预扣（reserve）= 上界：per-call 用 max(enable_groups 倍率, ratioOverride)；per-token 用 perTokenEstimateTokens(2000) × (1+completionRatio) × tokenRatio × 上界倍率 / 5000。
结算（settle）= 实际：响应头 x-routing-group 命中表 → ratioOverride（MJ 默认 4.49）→ 表 default → 1；per-token 按真实 usage 4dp 精度。**settledCredits 封顶于预扣**，余额永不为负；超预扣记 `settlement-overrun` 告警。

---

## 2. 方法论：余额位移法（balance-delta）

### 2.1 原理
同一 API key 的累计消耗 `total_usage`（或供应商余额）在生成前后的差值 = 真实成本。不需要理解供应商内部计费公式——**直接测量输出**。

### 2.2 标准流程
1. 读余额 `GET /v1/dashboard/billing/usage` → before
2. 发 1 次真实生成（标准 prompt，建议 ≥150 字符，保证可测额度）
3. 抓响应：`x-routing-group` 头、usage（input/output/total tokens）
4. 等待记账（实测滞后 4s ~ 60s+，小额可能不入账）
5. 读余额 → after → `delta = after - before`

### 2.3 关键坑与对策
- **记账滞后/精度**：小额（<$0.05）可能显示 0.0000 → 用长 prompt（更大额度）或**批量法**（连续 N 次生成后读一次差 ÷ N）
- **归因法**：先校准已知恒定项（如 MJ=1.3236），残差归因给不确定项（发现 gpt 实际 ≈0.1092）
- **路由随机性**：同一模型可路由不同分组（差 10 倍）→ 探测结果记录 routing group；预扣保持保守上界；多次探测取保守值
- **公式自证**：把实测 delta 代入候选公式，误差 <1% 才算确认（本次 M/L/XL 三样本全部 <0.1%）

### 2.4 计价形态识别（2 次探测即可分类）
- **per-call**：两次不同长度 prompt 的成本基本相同 → 存 cost/image
- **per-token**：成本随 token 数线性缩放 → 用 usage 拟合 cost/token（= delta / eff_tokens）
- **off-table / 混合**：公式推不出 → 直接存实测单位成本（不依赖任何公式）

---

## 3. 探测按钮功能（模型映射列表）——完整实施规格

### 3.1 目标
任意供应商（含非 NewAPI），单次（或双次）探测后自适应该模型的真实计费，**不依赖对供应商内部公式的理解**。

### 3.2 核心原则（二次评审修订）
1. **探测 = 余额位移法**：测量真实输出，不猜公式
2. **预扣/显示分离**：预扣永远保守上界（fail-safe）；「预计消耗」展示用 probe 实测估值（真实值）
3. **探测结果按「模型 + 供应商 key 指纹」存储**（成本是模型+供应商+key 的属性，非映射属性），映射引用；换 key/换站自动失效
4. **专用探测 key 是并发污染正解**（推荐配置：管理员单独配一把探测 key）；无专用 key 时探测结果标记 `polluted` 风险并提示低峰重测
5. **应用前预览**：探测成功后展示换算后的用户价格，管理员确认才生效
6. **可清除/重测**：探测结果可一键清除回退公式链，随时重测

### 3.3 存储模型
```
modelProbes: {
  [keyScopeFingerprint]: {          // = createKeyScopeFingerprint(supplier, apiBase, apiKey)
    [modelId]: {
      form: 'per-call' | 'per-token' | 'unknown'
      costPerImageUsd?: number       // per-call：单张实测 USD
      costPerTokenUsd?: number       // per-token：每 eff-token 实测 USD（delta/eff_tokens）
      routingGroup?: string          // 本次探测实际路由（审计/漂移参考）
      modes: ['text-to-image'] | ['text-to-image','image-to-image']
      promptFingerprint: string      // 标准探测 prompt 哈希（可复现、可比较）
      probeSize: string              // 探测尺寸（默认 1024x1024）
      sampleTokens?: number          // 探测 usage 的 eff tokens
      measuredAt: number
      status: 'ok' | 'below-precision' | 'polluted' | 'pending' | 'failed'
      lastError?: string
    }
  }
}
```
- 独立持久化文件（如 `model-probes.v2.json`），**不并入目录快照**（避免目录刷新覆盖）
- key 指纹变化（换 key/换站）→ 旧探测自动失效，UI 提示重新探测

### 3.4 探测流程（管理员触发）
1. 模型映射列表每行「探测」按钮（**仅管理员**；含禁用的模型映射）
2. 弹窗确认：将真实生成 1-2 张并产生供应商费用；含单日探测上限提示
3. 后端编排（`services/model-probe.ts`）：
   a. **单飞锁**：同一模型并发探测请求直接拒绝（防互相污染）
   b. 选 key：优先专用探测 key（config 新增 `probeApiBase/probeApiKey`，可复用供应商凭据配置）；无则用主 key
   c. 读余额 before（`getBalance()`，供应商 adapter 能力）
   d. 标准长 prompt（≥150 字符，固定模板，记录 promptFingerprint）文本生成 1 张（默认 1024×1024）
   e. 抓 `x-routing-group` + usage（input/output/total tokens）
   f. 等记账：轮询余额，窗口 60-120s；超时 → `status=pending` 提示稍后重测或自动转批量法（N=3 后一次读差）
   g. delta = after - before；delta ≤ 0 或 < 精度阈值 → `below-precision`（提示换更长 prompt / 批量法）
   h. 分类：
      - 有 usage 且 delta/eff_tokens 稳定 → per-token（存 costPerTokenUsd）
      - 无 usage 或与 prompt 长度无关 → per-call（存 costPerImageUsd）
      - 不确定 → 自动补第 2 次探测（不同长度 prompt）做斜率判定；仍不确定 → `unknown` + 手动 ratioOverride 指引
   i. 写回存储 + probe 审计日志（谁/何时/模型/delta/花费）
4. **应用前预览**：展示换算后用户价格（USD × usdToRmb × creditsPerCny × markup，含当前 markup），管理员确认后才生效；同时给出「与目录价对比」提示（若偏离 >2× 或 <0.5× 标黄）
5. 支持「清除探测」+ 重测

### 3.5 运行时结算接入
- **结算优先级**：`probe(新鲜且 ok) → ratioOverride → 表链公式`
  - per-call：cost = costPerImageUsd × 换算链
  - per-token：cost = 本次 eff_tokens × costPerTokenUsd × 换算链（usage 缺失时回退公式链）
- **预扣不变**（保守上界）；「预计消耗」展示 = 有 probe 时用 probe 估值（min(probe 估值, 预扣)），无 probe 时维持现状
- **模式覆盖**：per-token 自动覆盖 i2i（输入图 token 缩放，安全）；per-call 仅 text-to-image 已校准 → i2i 走 probe 值但记风险提示，鼓励补充校准
- **陈旧**：>30 天 → 结算仍可用但 UI 标黄 + 日志提示
- **漂移检测**：探测时存 `ratioVsCatalog = probeUSD ÷ (model_price × 表倍率)`；目录刷新时重算对比，偏离 >2× / <0.5× 标黄提示重测

### 3.6 非 NewAPI 适配
- 供应商 adapter 暴露 `getBalance()`：有 → 余额位移同法
- 无余额接口但响应含 usage：per-token 可算；per-call 无基准 → 官方公开价 curated 表 + 手动覆盖（诚实降级）
- 两者皆无 → 提示手动配置 ratioOverride，不阻塞

### 3.7 安全与运营
- 仅管理员；弹窗明示花费；**单日探测上限**（默认 10 次/小时，防连点烧钱）
- **并发锁**（同模型单飞）；用户生成期间探测 → 未用专用 key 时标记 `polluted` + 提示低峰重测
- **probe 审计日志独立于用户 ledger**（谁/何时/模型/delta/花费可追溯）
- 清除/重测入口；陈旧告警；漂移标黄；配置变更进现有 `config-audit`

### 3.8 实施范围
- 新 `src/services/model-probe.ts`（探测编排：余额读取、生成、等待、分类、拟合、存储、单飞锁）
- console listener `image-generator/probe-model`（+ probe-status / probe-clear）+ client 按钮/弹窗/预览
- config schema：`probeApiBase/probeApiKey`（可选，专用探测 key）、`probeRateLimit`、`probePrompt`（可选覆盖）
- 存储：`model-probes.v2.json`（独立于目录快照与用户 ledger）
- 结算接入：ImageGenerationOrchestrator 结算优先级 + 「预计消耗」展示
- 测试：分类（per-call/per-token 模拟）、滞后兜底（批量法）、并发锁、key 指纹失效、陈旧/漂移标黄、结算优先级、清除/重测、单日上限

---

## 4. 已知局限（诚实声明）
- 余额记账滞后使小额探测不可靠 → 必须长 prompt/批量；站点若批量结算（小时级），探测只能标记 pending 提示人工重试
- 探测结果随供应商调价漂移 → 定期重测 + 陈旧告警 + 漂移标黄
- 路由随机性 → 预扣保守上界兜底，探测记录路由供审计；探测值对「更贵路由」不保证覆盖，靠结算封顶 + overrun 告警兜底
- 探测本身花真钱（每次 1-3 张图成本）——这是获得真实定价的代价；用专用探测 key + 单日上限控制
- 官方直连（无余额 API）只能回退公开价 + 手动覆盖，无法全自动
- per-call 模型的图生图/编辑成本可能 ≠ 文生图 → 覆盖范围提示 + 补充校准

## 5. 附：本次校准原始数据（可复现）

### 5.1 探针功能真机验证（2026-08-06，生产代码 + 真实花费）

| 模型 | 探测结果 | 说明 |
|---|---|---|
| mj_imagine | per-call，costPerImageUsd=**1.3236** | 与 4 次历史校准完全一致；异步 submit+poll 路径真机跑通（可信） |
| gemini-3.1-flash-image-preview | ~~per-call，costPerImageUsd=1.217~~ **污染误报，作废** | OpenLux 官方计费日志证明真实扣费 **$0.01217**（= 0.1655×0.07353 公式精确值，路由 Reverse-Gemini-1）；探测窗口（120s）内撞上 ~1.2 美元延迟入账导致读数失真。**Gemini 不是 off-table，公式链正确** |

### 5.1b 教训：balance-delta 探测的并发污染（本功能最重要的实测教训）
- 探测结果 `polluted=1.217` 与供应商官方日志 `0.01217` 相差 100 倍——不是公式错，是**测量窗口污染**（同 key 上有其他延迟入账）。
- 结论：**未配置专用探测 key 的探测结果（polluted）不得自动用于结算/预扣**；必须配置专用 key（`probeApiKey`，独立 token，无并发）重测得到 ok 后才自动应用。已在代码中强制（computeProbeSupplierCredits / computeProbeReservationUsd 仅接受 status=ok）。
- 交叉验证法：可信测量必须多样本一致（MJ 4 次 1.3236 一致才可信）；单样本 polluted 一律存疑。

### 5.1c 日志通道核查结论（2026-08-06，影响机制定案）
- `/api/log/self`（官方 UserAuth）在 OpenLux 被额外限制，token 无权。
- `/api/log/token`（官方 TokenAuthReadOnly，GetLogByKey 按 `WHERE token_id=?` 查）认证通过但返回空——OpenLux fork 的日志表未按 token_id 落库，供应商无法开放。
- NewAPI **无服务端日志下载/导出端点**（控制台导出是前端本地生成 CSV；`/api/performance/logs` 是系统运行日志非计费日志）。
- **结论：日志精确结算通道关闭**。机制按不依赖日志定案：
  - 无头模型（MJ）结算 = 探测分布 max（政策 a）——**永久方案**，非「等日志升级」；
  - 验证手段 = 多样本一致性 + 专用 key 隔离 + 余额交叉验证；**专用探测 key 是唯一可靠路径**；
  - CSV 日志对账（供应商导出 → 离线解析 → 对账/校准）列为二期可选增强，不纳入本轮。

### 5.2 真机验证暴露并修复的 2 个实现缺陷
1. **Gemini 探测生成器端点错误**：原先把 gemini 模型发到 `/v1/images/generations`（OpenLux 网关 HTTP 500 拒绝）；修复为与 providers/gemini.ts 一致的 `POST /v1beta/models/{id}:generateContent?key={apikey}`。
2. **分类先验缺失**：Gemini 的 generateContent 总是返回 usage（2524 tokens），无目录先验时会被误判 per-token；修复为 `classifyProbe` 优先使用目录 quota_type（per-call=1 → 强制 per-call）。

### 5.3 校准数据（2026-08-05/06）
见 `plans/aka-ai-image-generator-billing-chain-fix.md`（含 M/L/XL 与 MJ 全样本、余额读数）。
