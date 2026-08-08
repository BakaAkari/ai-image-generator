# aka-ai-image-generator 计费机制最终定案

日期：2026-08-06（v2.4.0 定案）；**2026-08-08 追加双模式定案（v2.6.0，见第 9 节）**
状态：基于真实充值/余额铁证与门户「计费过程」读数；本文件为唯一权威设计文档，替代此前所有计费方案文档（已归档）；v2.6.0 起按「定价双模式（auto / simple）」运行，第 1–8 节描述 auto 模式结算机制，第 9 节为双模式总定案

---

## 1. 根因（最终版）

1. **单位误读**：整轮把 `/v1/dashboard/billing/usage.total_usage` 当美元读，再往回推理 quota 除数、探测余额位移、per-call 校准倍率——三处误读叠加，导致 5000/4.49 之类假常数。真相：`total_usage = 真实美元 × 100`；「计费过程」显示的 quota / 500000 才是真实美元。
2. **迁移根因**：yunwu → OpenLux 切换时，计费语义常量被「改名搬运」而非「重新推导」，遗留的 0.5 汇率、500000 与 5000 假设、「1 积分=¥0.5」（yunwu 概念）成为债务源头。
3. **验证根因**：预测错误无闭环反馈——表值失效/供应商调价/渠道故障路由没有任何自动发现机制。

## 2. 实测事实全集（全部经真实扣费验证）

| # | 事实 | 证据 | 影响 |
|---|---|---|---|
| 1 | **真实美元 = quota / 500000**（门户「计费过程」权威值） | MJ mj_imagine 一次真实扣费 $0.013236 = 0.3 × 0.04412；gemini 一次 $0.012169 = 0.1655 × 0.07353。整个会话 ~40 次生成消耗 $1.25（充值 $50 → 余额 $48.96 铁证） | per-call 表值 × group_ratio 精确；per-token 用 tokens × tokenRatio × group_ratio / 500000 |
| 2 | **`total_usage` = 真实美元 × 100**（不是美元、不是 quota） | 会话消耗 $1.25 时 total_usage 增 125（余额位移量），与门户读数一致 | 此前把 total_usage 当美元读是所有下游假设的错源；余额位移法必须 /100 |
| 3 | per-call 模型（含 MJ）用表内 group_ratio × pricePerCall 精确 | 事实 #1 中的 0.04412（MJ-1）、0.07353（gemini fake group）均直接在 `/api/pricing` 表中 | 无需 4.49 等外挂校准；`MJ_CALIBRATED_COST_FACTOR` 已删除 |
| 4 | 同步模型响应头 `x-routing-group` 可用，且路由动态 | gpt 多次 Codex-Gpt-2(0.0588)，偶发 Openai-Gpt-1(0.5882)；gemini 分组同理 | 结算可按实际路由精确计算，路由方差 10×+ |
| 5 | 响应体富信息：usage 带 image/text token 拆分、回显生效参数、多请求 ID | 实测 gpt output_tokens_details.image_tokens、gemini candidatesTokensDetails.modality | 结算可复用 token 拆分；请求 ID 是权威日志匹配键 |
| 6 | 权威日志通道存在但需系统令牌 | `/api/log/self?request_id=...` 用 Bearer `<logAccessApiKey>` + `New-Api-User` 请求头可返回该请求的 quota | 探测/结算可查权威扣费，绕开余额位移的并发/延迟入账污染 |
| 7 | MJ 异步链路仅在 submit 响应带 request_id；后续 poll 无独立扣费信息 | 三个响应面 header/body 实测 | MJ 权威扣费仍需走日志 API（本插件已支持） |
| 8 | 余额位移法有滞后/精度/并发污染 | 探测窗口撞上延迟入账即失真 | 有日志权威路径时优先它；无则 delta/100 |
| 9 | 预扣按 enable_groups max 有时不足 | 表 max 0.9559 vs 实际路由 0.0735~0.1765；渠道故障可越过预扣 | 预扣仍取 max(probe×margin, 公式上界)；封顶+overrun 兜底 |

## 3. 观测面结论（已穷尽）

- **同步模型（gpt/gemini）**：富观测——路由分组、routing 元数据、token modality 拆分、生效参数、请求 ID → 按实际路由精确结算可行
- **MJ 与其它 per-call**：表值即真（真实美元 = pricePerCall × group_ratio），无需外挂校准
- **权威日志 API**：`/api/log/self?request_id=` 是探测和事后对账的唯一权威源；配置 `logAccessApiKey`/`logAccessUserId` 后自动启用

## 4. 最终机制设计

### 4.1 原则
1. **真实美元 = quota / 500000**（默认；自建站非标 QuotaPerUnit 通过 `config.quotaPerUnit` 覆盖）
2. **表值即真**：per-call 模型用 `pricePerCall × group_ratio`；per-token 模型用 `eff_tokens × tokenRatio × group_ratio / 500000`
3. **能观测的用观测**：同步结算用实际路由（x-routing-group）；探测优先走日志 API（`/api/log/self`），退化到余额位移 /100
4. **不能观测的用边界**：预扣用真上界；无头模型结算用保守政策 + 封顶告警

### 4.2 预扣（闸门，不是价格）
- 表真模型：`max(enable_groups 全表倍率) × 单价`（配 `mapping.ratioOverride` 可精确到路由）
- per-token：`token 估算 × tokenRatio × 上界倍率 / quotaPerUnit`
- 有新鲜 probe（ok）时：`max(probe×margin, 公式上界)`
- 按 `numImages` 缩放；封顶 + overrun 双保险

### 4.3 结算
- **同步模型（响应头有 x-routing-group）**：实际分组命中表 → `表值 × 计价`；不在表 → 走 `ratioOverride` / default / 1
- **优先级**：probe(ok/新鲜) → 实际路由表值 → ratioOverride → 表 default → 1
- **精度**：4 位小数记账（`roundCreditsPrecise`），展示 2 位；`actualCost=0` 是合法值不回退预扣
- **probe 结算**：仅 `ok`（专用 key 探测）自动应用；`polluted` 只展示不应用

### 4.4 封顶与告警
- `settledCredits = min(实际, 预扣)`，余额永不因结算变负
- 实际 > 预扣（含容差 0.01）→ `settlement-overrun` 告警 + ledger `overrun:true`

### 4.5 探测（校准分布，不是结算）
- **权威路径（推荐）**：配置 `logAccessApiKey` + `logAccessUserId` → 生成后按响应 request_id 查 `/api/log/self` 拿 quota → 真实 USD = quota / 500000
- **回退路径**：余额位移法，delta / 100 得真实 USD；受并发/延迟入账污染，需专用探测 key（`probeApiKey`）标记 ok
- 分类：目录 quota_type 先验优先（防 Gemini 有 usage 被误判 per-token）；MJ 强制 per-call
- 单日上限（默认 10/h）、单飞锁、陈旧 >30 天不参与

### 4.6 运营监控（聚合闭环，补偿控制）
- 周期：`用户消耗收入（积分 → 人民币）− 供应商实扣（USD → 人民币）`
- 低于阈值 → 告警；试用/管理员免费消耗单列

## 5. 关键常量与配置

| 项 | 常量/字段 | 默认 | 说明 |
|---|---|---|---|
| quota 除数 | `DEFAULT_QUOTA_PER_UNIT` / `config.quotaPerUnit` | 500000 | 真实美元 = quota / 除数 |
| USD→CNY | `USD_TO_RMB` / `config.usdToRmb` | 6.76 | 快照值，需定期人工/cron 更新 |
| per-token 估算 | `DEFAULT_PER_TOKEN_ESTIMATE` / `config.perTokenEstimateTokens` | 2000 | 预扣估算基线 |
| 探测预扣余量 | `PROBE_RESERVE_MARGIN` / `config.probeReserveMargin` | 2 | probe 实测 × 该余量作为预扣基准 |
| 日志权威 key | `config.logAccessApiKey` + `logAccessUserId` | — | 配置后探测走 `/api/log/self` |

## 6. 已实施变更

- `DEFAULT_QUOTA_PER_UNIT` 5000 → 500000（修正单位误读）
- `normalizeNewApiBilling.supplierCredits = total_usage / 100`（真实美元）
- 探测 `sampleDeltaUsd = delta / 100`（余额位移单位是 `total_usage`）
- 探测新增权威日志路径（`/api/log/self`），可选取代余额位移
- 删除 `MJ_CALIBRATED_COST_FACTOR = 4.49` 及全部引用；MJ 与其它 per-call 一致
- 命令与启动日志 label 从「供应商积分」改为「$」/「消耗(USD)」
- `USD_TO_RMB` 统一到 `shared/billing.ts`，`billing-info.ts` 重导出

## 7. 已知边界（诚实声明）

- 供应商调价/表失效有目录刷新窗口 → 靠 4.6 聚合监控兜底
- 探测 key 与主 key 路由宇宙可能不同 → 预扣用 enable_groups 全表不受影响；探测值仅作校准参考
- 渠道故障超预扣的极端成本 → margin + 封顶 + overrun 告警，残留有界损失窗口
- USD→CNY 汇率为快照值，需定期更新

## 8. 归档说明

本文件替代以下文档（已移至 `docs/archive/2026-08-billing-superseded/`）：
- `plans/aka-ai-image-generator-billing-chain-fix.md`（首轮修复计划）
- `docs/working/billing-calibration-methodology.md`（方法论草案）
- `docs/working/billing-mechanism-decision.md`（决策草案）
---

## 9. 双模式定案（v2.6.0 起）

> 追加日期：2026-08-08。第 1–8 节机制在 auto 模式下仍然成立；本节省略为总定案，代码真相以 `src/shared/billing.ts`（resolveMappingFixedCost）、`src/services/config-autopilot.ts`、`src/shared/effective-mode.ts` 为准。

### 9.1 两种模式
- **auto（自动）**：连接供应商（NewAPI 兼容站）后从平台目录自动推导模型价格，按 `USD → 人民币 → 积分 × 加成` 公式链结算；结算优先级 **日志真源 → 公式链**（即第 4.5 节权威路径）。管理员只做运营决策。
- **simple（简易）**：无需供应商凭据也可运行。管理员直接为每个模型设置「每次消耗积分」（`creditCostPerImage`，映射级 schema 字段，默认 1 积分/次），预扣与结算按 `creditCostPerImage × 张数` 短路（`settleSource='fixed'`），**不依赖平台价格、不走公式链**。定价过低 = 亏损、过高 = 用户流失，盈亏由管理员自行承担。
- 默认 simple；auto 但凭据缺失 / 错误 / 目录刷新失败时 UI 自动降级显示 simple（仅 UI 提示，不回写配置）；可在总览右上角切换。

### 9.2 结算短路
- `resolveMappingFixedCost(mapping, configMode)`：simple 模式下返回 `creditCostPerImage`（含迁移保值：旧 `billingPolicy.fixed` 迁移到 `creditCostPerImage` 后删除字段；auto 模式完全不动映射字段）。
- auto 模式两处恒走公式链，不受 simple 字段影响。

### 9.3 双模式对账实证（v2.6.0）
沙盒真实触发 `文生图` 生成，系统结算 vs 平台 `/api/log/self` 权威 quota 完全一致：

| 模型 | 平台 quota | 权威 USD | 系统结算积分 | 反推 USD（÷68.276） | 差异 |
|---|---|---|---|---|---|
| grok-imagine-image | 7647 | $0.015294 | 1.0442 | $0.015294 | 0 |
| qwen-image-max-2025-12-30 | 18383 | $0.036766 | 2.5102 | $0.036765 | 1e-6（4dp 舍入） |

68.276 = usdToRmb 6.76 × creditsPerCny 10 × 1.01（加成）。向导预估按默认分组倍率 1 保守计算，真实结算按平台实际分组倍率 0.07 精确扣费，多退少补行为正确。历史旧系统（8-07）grok quota=45883↔6.2654、qwen quota=18383↔2.5102 亦一致。
