# aka-ai-image-generator 扣费链路修复计划（OpenLux 实测驱动）

日期：2026-08-05 → 2026-08-06（追加汇率/除数修正）
状态：Kari 已确认 4 项决策 + 追加确认（汇率残渣清理、per-token 除数修正），实施中（不 bump 版本、不 commit/push）

## 追加实测发现（2026-08-06，gpt-image-2 隔离校准）

- **OpenLux per-token 计费除数 = 5000，不是 500000**。3 组隔离实测全部精确吻合 `USD = eff_tokens × tokenRatio × group_ratio / 5000`：
  - M(237 tok, Codex-Gpt-2 0.05883): 实测 0.0344 vs 公式 0.03433
  - L(1479 tok, Codex-Gpt-2): 实测 0.2452 vs 0.24529
  - XL(922 tok, Openai-Gpt-1 0.58824): 实测 1.4198 vs 1.4197
- 插件现行 `/500000` 对 per-token 模型**少收恰好 100 倍**；受影响的 per-token 模型 6 个：gpt-image-1/1.5/2、gpt-image-1-mini、gpt-3.5-turbo、gpt-4o
- gpt-image-2 成本随 prompt 长度与路由渠道大幅变化（$0.03 ~ $1.42/张），不是"免费"；此前 0.0004 是错误公式推导值
- MJ per-call 计费不受除数影响（QuotaPerUnit 在 model_price 公式中约掉），4.49 校准保持有效
- 余额位移用于小额单次生成归因有滞后/精度限制（短 prompt 显示 0.0000 但大额可精确对账），大额样本（0.03~1.42）可靠

## 追加设计（汇率残渣清理 + per-token 除数）

### 7. 汇率链语义修正（supplierCreditToRmb 残渣 → usdToRmb）
- OpenLux 供应商积分为**美元口径**（total_usage=27.49、model_price 均美元）；`supplierCreditToRmb=0.5` 是 yunwu 时代残渣（1 积分=¥0.5），导致用户价只有真实人民币成本的 ~7.5%
- 改名 `usdToRmb`（美元→人民币），默认 = 6.76（2026-08-06 open.er-api.com 实时）；migration：旧值 === 0.5（残渣）→ 迁移到新默认；非 0.5 自定义值保留
- 公式：`用户积分 = USD成本 × usdToRmb × creditsPerCny × (1+markup%)`
- 命名清理：UI「供应商积分」→「消耗(USD)」；billing.ts SUPPLIER_CREDIT_TO_RMB、billing-info.ts、view-model CATALOG_SUPPLIER_CREDIT_TO_RMB 全部按 USD 语义改名+注释
- UI：aka-tools 定价区加 `usdToRmb` 输入（附实时汇率提示）+ 变更审计日志（console service 记录谁/何时/从几到几）

### 8. per-token 除数修正（quotaPerUnit）
- `billing.ts` 4 处 `/500000`（tokensToSupplierCredits / computeSupplierCreditsFromCatalog / computeUpperBoundSupplierCredits / computeActualSupplierCredits）改为可配置 `quotaPerUnit`，默认 **5000**（OpenLux 实测）；注释记录 3 样本测量证据
- config：`quotaPerUnit?: number`（schema + settings），migration 无需迁移（默认值变化即生效）
- 测试：更新所有断言 /500000 的用例为 /5000

### 9. per-token 预扣估算重调
- `DEFAULT_TOKEN_ESTIMATE=15000`（按 500000 口径）改为贴近图像的估算，新增可配置 `perTokenEstimateTokens`（默认建议 2000 raw tokens，eff=×(1+completionRatio)）；避免除数修正后预扣爆 100 倍
- 预扣仍按 enable_groups 上界倍率（保守 fail-safe），结算按实际精确值 4dp 多退少补

## 文件清单（追加）
- src/shared/billing.ts — usdToRmb 语义 + quotaPerUnit + DEFAULT_TOKEN_ESTIMATE 重调 + 4 处除数 + 常量改名
- src/shared/config.ts — usdToRmb/quotaPerUnit/perTokenEstimateTokens schema
- src/config/migration.ts — supplierCreditToRmb=0.5 → usdToRmb 迁移
- src/catalog/billing-info.ts — 命名/注释 USD 化
- src/console/view-model.ts — CATALOG_SUPPLIER_CREDIT_TO_RMB → USD 语义
- src/console/service.ts — 汇率变更审计（如无现成机制则加）
- client/page.vue — 定价区加 usdToRmb（+quotaPerUnit 可选展示）；「供应商积分」标签改「消耗(USD)」
- tests/billing/legacy-billing-bridge.test.ts 等 — /500000→/5000、汇率 0.5→6.76 断言更新

## 验证（追加）
- 单测：quotaPerUnit 默认 5000 下的 per-token 结算（用实测 M/L/XL 三组数据做断言 fixture）；usdToRmb 迁移；perTokenEstimate 预扣
- 真实生成：gpt-image-2 一张（长 prompt）→ 结算 ≈ eff×2.5×groupRatio/5000×6.76×10×1.01，余额位移对账（偏差 <5%）
- MJ 一张复核（4.49 不受影响）

## 边界（禁止）
- 不 bump 版本、不 commit/push/tag/publish、不部署 NAS
- 不改 provider 请求形状、不动 freePlatforms/试用/管理员豁免逻辑
- 不部署 koishi-app/node_modules（部署由 Kael 做）

---

# 初始计划（2026-08-05 已实施并验证，保留备查）

## 背景与实测证据（2026-08-05 真实花费验证）

| 项目 | 实测值 |
|---|---|
| gpt-image-2（同步 per-token） | 响应头 `x-routing-group=Codex-Gpt-2`（倍率 0.05883），usage total=259 → 真实成本 ≈0.0004 供应商积分 |
| mj_imagine（异步 per-call）第 1 张 | 余额位移 ≈1.3694 供应商积分 → 有效倍率 4.5647 |
| mj_imagine 第 2 张 | 余额位移 1.3236 → 有效倍率 4.4120 |
| MJ 提交/任务轮询响应头 | 均无 `x-routing-group`（两次请求确认），任务体无任何计费字段 |
| `/api/pricing` group_ratio 表 | 95 组，max=1.17647，default=0.07353；MJ 真实倍率 ≈4.49 **不在表内**（NewAPI 对 MJ 走渠道侧 mj_ratio 独立计费，不公开） |

## 已确认的问题

- **P1 MJ 计价模型错误**：插件按 `model_price × group_ratio(表)` 计价 MJ，真实成本是 `model_price × ≈4.49`。预扣上界（0.735）低估真实成本约 6 倍 → 亏损运营风险；现响应头恒缺失回退 legacy `mapping.groupRatio=6` → 结算 9.09 积分 vs 真实 ≈6.92（多扣 31%），且余额被扣负（-7.98）。
- **P2 settlement 回退语义错误**：`resolveActualRoutingRatio` 在 header 缺失时回退 `mapping.groupRatio`（legacy 全局 6 迁移值），比表最大值还高 5 倍。
- **P3 settleReservation 无封顶**：`settledCredits > reservedCredits` 时余额直接变负，无拦截、无告警。
- **P4 billing 归一化单位错配**：`normalizeNewApiBilling` 把已是美元口径的 `total_usage`（21.446）再除 500000 → 显示 0.00，审计 delta 失真。
- **P5 per-token 取整到 0**：`computePostGenerationCost` 内部 2 位取整，gpt-image-2 实付恒 0.00。

## Kari 决策（2026-08-05 确认）

1. MJ 倍率覆盖默认值 = 实测均值 **4.49**（(4.5647+4.4120)/2）
2. per-token 精度修复：做（结算按精确值 4 位小数，仅展示取整）
3. legacy `mapping.groupRatio` 清理：做（迁移删除，schema 保留兼容、运行时不再使用）
4. billing 显示修复：做（去掉 /500000）

## 设计

### 1. 倍率覆盖 `ratioOverride`（新增）
- `ModelMappingConfig.ratioOverride?: number`（可选）：配置后该模型**预扣与结算**直接使用该倍率，不再查表/读响应头。
- 运行时兜底：模型为 mj 协议且未配置 override 时，用常量 `MJ_CALIBRATED_COST_FACTOR = 4.49`（billing.ts，注释记录实测日期与数值）。
- 生效路径：`computeUpperBoundSupplierCredits(..., ratioOverride?)`、`resolveActualRoutingRatio(..., ratioOverride)`。
- UI：模型映射表单 groupRatio 输入改为 ratioOverride（可选），normalize.ts 同步。

### 2. 结算倍率优先级（resolveActualRoutingRatio 重写）
1. `x-routing-group` 命中倍率表 → 表值（真实路由证据最优）
2. `ratioOverride`（mapping 配置或 MJ 默认因子）→ 覆盖值
3. 表 `default` → default 值
4. 1（最终兜底）
- 删除 `mapping.groupRatio` 参与结算/预扣的任何路径。

### 3. settleReservation 封顶 + 告警
- `settledCredits = roundCreditsPrecise(min(actualCostTotal, reservedCredits), 4)`；一旦 actualCostTotal > reservedCredits 记 `settlement-overrun` 告警日志 + ledger metadata（`overrun: true`），余额永不因结算变负。
- 保留「actualCost=0 是有效值」语义（不回退预扣）。

### 4. 精度（P5）
- `computePostGenerationCost(supplierCredits, config, opts?: { round?: boolean })`；结算传 `round:false` 拿精确值。
- `roundCreditsPrecise(value, dp=4)` 新增；settleReservation 非试用路径的 settled/released/balance 更新用 4 位小数，展示仍 2 位。

### 5. billing 单位（P4）
- `normalizeNewApiBilling`：`supplierCredits = total_usage`（不再 /500000）；更新术语注释；别名字段同值。

### 6. migration 清理（P3 决策 3）
- 新 migration 步骤：逐条删除 `mapping.groupRatio`（记录动作）；**不得**触碰 ratioOverride；保留旧「yunwuGroupRatio→mapping.groupRatio」迁移（对更老配置仍有效），随后执行清理。
- schema：`groupRatio` 保留为 deprecated 可选字段（避免反序列化 ValidationError 先于 migration 触发）；新增 `ratioOverride` 可选字段。

## 文件清单

- `src/shared/billing.ts` — 常量、roundCreditsPrecise、computePostGenerationCost round 参数、computeUpperBoundSupplierCredits override 参数
- `src/shared/types.ts` — ModelMappingConfig.ratioOverride（groupRatio 标 deprecated）
- `src/shared/config.ts` — schema 增 ratioOverride（groupRatio 保留兼容）
- `src/config/migration.ts` — groupRatio 清理步骤
- `src/orchestrators/ImageGenerationOrchestrator.ts` — resolveEffectiveRatioOverride、estimate 传 override、resolveActualRoutingRatio 重写、结算传精确值、audit 日志增 override 字段
- `src/services/UserManager.ts` — settleReservation 封顶 + 4dp + overrun 告警
- `src/catalog/billing-info.ts` — 单位修复
- `src/console/view-model.ts` — groupRatio 展示改为 ratioOverride 语义
- `client/page.vue`、`client/normalize.ts` — 映射表单字段调整
- 测试：更新引用 groupRatio/旧单位的用例；新增优先级矩阵、override 预扣/结算、封顶+overrun、4dp 精度、billing 单位、migration 清理用例

## 验证

1. `npm run typecheck` clean；`npm test` 全量通过（基线 548 passed，须说明新增/变化）
2. 构建 `npm run build`；部署：备份后覆盖 `koishi-app/node_modules/koishi-plugin-aka-ai-image-generator/{lib,dist}`；重启 `start-koishi.sh`
3. 启动日志：插件加载、目录刷新 40 模型、**无 ValidationError**（schema 兼容关键点）
4. 真实生成对账（约 3 积分）：
   - mj 一张：预扣=结算 ≈ 0.3×4.49×0.5×10×1.01 ≈ 6.80 积分，余额位移 ≈6.6-6.9（偏差 <5%）
   - gpt-image-2 一张：按 header 表值结算（0.05883），实付 0.0x 积分（4dp 非 0）
   - 余额/ledger 无负数、无 overrun 告警（校准正确时）

## 边界（禁止）

- 不 bump 版本、不 commit/push/tag/publish、不部署 NAS
- 不改 provider 请求形状、不动 freePlatforms/试用/管理员豁免逻辑
- 不改 koishi-app/node_modules（部署由 Kael 做）
- 不引入无关重构/格式化
