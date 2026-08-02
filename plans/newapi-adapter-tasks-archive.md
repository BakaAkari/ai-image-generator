# TASK-001: suppliers/newapi 通用适配器（替代 suppliers/yunwu）

## 范围
- 新建 `src/suppliers/newapi/`（client.ts、raw-types.ts、normalizer.ts、capability.ts、routes.ts）
- 新建 `src/suppliers/registry.ts`（供应商适配器注册表）
- **不动** catalog/contracts/config/service/providers/前端/测试（后续 TASK）
- 不删除 `src/suppliers/yunwu/`（TASK-002 才切换引用并删除）

## 目标
把云雾专属适配器泛化为 new-api 通用适配器：
1. `client.ts`：端点路径可配置（models/pricing/usage/subscription），usage 支持查询参数（openlux 需要 start_date/end_date）
2. `raw-types.ts`：new-api 原始契约类型（结构与 yunwu 相同，仅重命名）
3. `capability.ts` / `routes.ts`：endpoint 名称映射改为「内置默认表 + 配置覆盖」
4. `registry.ts`：按 ActiveSupplier 分发适配器（当前实现 newapi；openai-official/gemini-official 返回 null）

## 详细设计

### registry.ts
```ts
export type SupplierAdapterFactory = (config: SupplierCredentials, fetchLike?: FetchLike) => ImageSupplierAdapter | null
export class SupplierRegistry {
  register(id: string, factory: SupplierAdapterFactory): void
  create(id: string, config: SupplierCredentials): ImageSupplierAdapter | null
  list(): string[]
}
```
默认注册 `newapi` → NewApiClient。旧 id `yunwu`/`gptgod` 兼容注册指向同一工厂（TASK-002 切换后由 migration 迁移）。

### newapi/client.ts
- `NewApiClientConfig extends SupplierCredentials`，新增可选 `endpoints?: SupplierEndpointsConfig`
```ts
export interface SupplierEndpointsConfig {
  models?: string            // 默认 '/v1/models'
  pricing?: string           // 默认 '/api/pricing'
  usage?: string             // 默认 '/v1/dashboard/billing/usage'
  usageQuery?: Record<string, string>  // 默认 {}（保持 yunwu 行为）；openlux 需要 { start_date, end_date }
  subscription?: string      // 默认 '/v1/dashboard/billing/subscription'
}
```
- `fetchSnapshot()` 并行请求 4 端点，URL 拼接 `${apiBase}${endpoint}${queryString}`（usage 带 usageQuery 时拼 `?k=v&...`）
- `normalizeApiBase` 逻辑保留（去尾部 `/`、去 `/v1` 后缀）
- `createKeyScopeFingerprint` 逻辑保留（supplier 名用 `newapi`）
- getJson 错误返回结构保留（`HTTP ${status}: ${text.slice(0,200)}`）

### newapi/raw-types.ts
- 复制 yunwu/raw-types.ts，命名改为 `NewApiModelItem`/`NewApiPricingItem`/`NewApiBillingPayload`/`NewApiStatusPayload`/`NewApiModelsPayload`/`NewApiPricingPayload`/`NewApiRawEndpoints`/`NewApiRawSnapshot`
- 字段结构完全保留（new-api 与 yunwu 同源）

### newapi/normalizer.ts
- 复制 yunwu/normalizer.ts，类型改 newapi 命名
- `normalizePricing` / `normalizeModel` 逻辑不变（source: 'remote-pricing'）
- 导出 `NewApiCatalogNormalizer` / `normalizeNewApiSnapshot`

### newapi/capability.ts
- 保持能力推导逻辑（OPENAI_IMAGE_ENDPOINTS 等默认集 + 正则），类型改 newapi 命名
- **新增**：接受可选 `aliases?: EndpointAliasMap` 参数，把别名并入默认集后再判定
```ts
export interface EndpointAliasMap { [endpointName: string]: { protocol: 'openai' | 'gemini' | 'mj'; capability: 'text-to-image' | 'image-to-image' | 'image-edit' } }
```
- 导出 `resolveNewApiCapabilities(item, aliases?)` / `isNewApiExecutableImageModel(item, aliases?)`

### newapi/routes.ts
- 保留 ENDPOINT_ROUTE_MAP 默认表（含云雾中文名兼容）
- **新增**：`resolveNewApiRoutes(endpoints, aliases?)` —— 先查别名表，再查默认表；别名优先级更高
- 保留 `resolveRoutesFromCapabilities`

## 验收标准
1. `npx tsc --project tsconfig.json --noEmit` 通过（新增文件不破坏现有编译）
2. `npx vitest run tests/suppliers/yunwu/client.test.ts` 仍通过（旧适配器未动）
3. 新增测试 `tests/suppliers/newapi/client.test.ts`：
   - 默认端点路径正确（4 端点）
   - usageQuery 配置生效（openlux 场景：URL 带 start_date/end_date 且返回 200）
   - 不序列化 apiKey
4. 新增测试 `tests/suppliers/newapi/routes.test.ts`：
   - 默认表：'mj想象模式' → mj:text-to-image
   - 别名表：'MJ imagine' → mj:text-to-image（openlux 场景）
5. 不修改 package.json version、不 git commit

## 依赖
- 前置：TASK-000（已完成）
- 阻塞：TASK-002

## 状态
- [x] 未开始
- [ ] 实现中
- [ ] 待验证
- [ ] 已完成
# TASK-002: catalog 层切换（ActiveSupplier 扩展 + image-catalog 注册表化 + 删除 yunwu 适配器）

## 范围
- `src/catalog/model-catalog.ts`：`ActiveSupplier` 类型改 `'newapi' | 'openai-official' | 'gemini-official'`（移除 'yunwu'/'gptgod'）
- `src/catalog/types.ts`：同步
- `src/catalog/image-catalog.ts`：`if (supplier !== 'yunwu')` 硬拒绝 → 用 SupplierRegistry 分发；日志/注释 yunwu → newapi
- `src/catalog/billing-info.ts`：normalize 函数改用 NewApi 类型 + `SUPPLIER_CREDIT_TO_RMB` 保持
- `src/suppliers/yunwu/` 目录**删除**
- 同步更新依赖 yunwu 适配器的测试（tests/catalog/*、tests/suppliers/yunwu/*）

## 目标
catalog 层彻底切换到 newapi 适配器，旧 yunwu 目录删除，不留残留。

## 详细设计

### 1. ActiveSupplier 类型（model-catalog.ts + catalog/types.ts）
```ts
export type ActiveSupplier = 'newapi' | 'openai-official' | 'gemini-official'
```
（两处定义保持同步；测试引用 ActiveSupplier 的地方需同步）

### 2. image-catalog.ts 改造
- 顶部 import：`NewApiClient` 替换 `YunwuClient`；`normalizeNewApiSnapshot` 替换 `normalizeYunwuSnapshot`；`NewApiRawSnapshot` 替换 `YunwuRawSnapshot`；`resolveNewApiCapabilities` 等
- `canPublishYunwuSnapshot` → `canPublishNewApiSnapshot`（检查 endpoints.models.success）
- `doRefresh`：
  - 移除 `if (cfg.supplier !== 'yunwu')` 硬拒绝，改为：
    ```ts
    if (cfg.supplier !== 'newapi') {
      const message = `supplier ${cfg.supplier} is not adapted; only newapi is maintained`
      ...（沿用原逻辑）
    }
    ```
  - 用 SupplierRegistry 创建适配器：`const registry = new SupplierRegistry(); registry.register('newapi', (c) => new NewApiClient(c)); const client = registry.create(cfg.supplier, {...})`；client 为 null 时 fail-closed
  - 构造 NewApiClient 时传入 `endpoints` 配置（从 cfg 带过来，cfg 类型扩展 `endpoints?: SupplierEndpointsConfig`）
- snapshot.supplier / 日志 yunwu → newapi
- `createKeyScopeFingerprint` 用 newapi 版本（导出自 newapi/client.ts）

### 3. billing-info.ts
- `normalizeYunwuBilling` → `normalizeNewApiBilling`（参数 `NewApiRawSnapshot`）
- SUPPLIER_CREDIT_TO_RMB 保持 0.5（TASK-005 再配置化）

### 4. 删除 suppliers/yunwu/
- 删除 src/suppliers/yunwu/ 整个目录
- 同步更新引用它的测试：
  - tests/suppliers/yunwu/client.test.ts → tests/suppliers/newapi/ 已有覆盖，删除
  - tests/suppliers/yunwu/contract.test.ts → 契约测试迁移到 newapi 契约（或删除，TASK-003 契约改名时重建）
  - tests/catalog/yunwu-normalizer.test.ts → 改 newapi-normalizer.test.ts
  - tests/catalog/capability.test.ts、routes.test.ts → 改指向 newapi 模块
  - tests/catalog/billing-normalize.test.ts → normalizeNewApiBilling
  - tests/catalog/image-catalog-wiring.test.ts → newapi

## 验收标准
1. `npx tsc --project tsconfig.json --noEmit` 通过
2. `npx vitest run` 全绿
3. `grep -r yunwu src/ tests/` 仅剩合理的过渡引用（normalizer 注释/CHANGELOG 提及），代码路径无 yunwu 适配器残留
4. 不修改 package.json version、不 git commit

## 依赖
- 前置：TASK-001（已完成）
- 阻塞：TASK-003

## 状态
- [x] 未开始
- [ ] 实现中
- [ ] 待验证
- [ ] 已完成
# TASK-003: 契约层改名（ContractSupplier yunwu → newapi）

## 范围
- `src/contracts/types.ts`：ContractSupplier 类型 `'yunwu'` → `'newapi'`
- `src/contracts/registry.ts`：契约定义中 supplier 字段、契约 id（`yunwu.openai.*` → `newapi.openai.*` 等）、注释
- `src/contracts/param-resolver.ts`：引用 yunwu 的注释/命名（如有）
- `src/service/AiImageGeneratorService.ts`：mapSupplierToContract 中 'yunwu' → 'newapi'（仅本函数，其他 TASK-005 处理）
- `src/shared/generation-setup.ts`：引用 yunwu 契约 id 的注释（如有）
- 同步更新测试：tests/contracts/*、tests/providers/*、tests/shared/generation-setup-contract.test.ts、tests/wizard/*、tests/catalog/image-catalog-wiring.test.ts、tests/console/config-store.test.ts 等所有引用 yunwu 契约 id 或 ContractSupplier 'yunwu' 的测试

## 目标
契约层完全切换到 newapi 命名，旧 yunwu 契约 id 不留残留。

## 详细设计

### 1. contracts/types.ts
- `ContractSupplier` 类型：`'yunwu'` → `'newapi'`（注释同步：new-api 兼容站）

### 2. contracts/registry.ts（最大头，57 处 yunwu 引用）
- 所有契约的 `supplier: 'yunwu'` → `supplier: 'newapi'`
- 契约 id：`yunwu.openai.gpt-image-2.generate` → `newapi.openai.gpt-image-2.generate`（全部 yunwu. 前缀替换为 newapi.）
- 常量名 YUNWU_* → NEWAPI_*（如 YUNWU_OPENAI_GPT_IMAGE_2_GENERATE → NEWAPI_OPENAI_GPT_IMAGE_2_GENERATE）
- resolveContract 中 MJ 特判 `c.id === 'yunwu.mj.imagine.reference'` → `'newapi.mj.imagine.reference'`
- 注释/文档字符串中 yunwu → new-api（或保留历史说明但不再作为标识符）

### 3. AiImageGeneratorService.ts mapSupplierToContract
```ts
function mapSupplierToContract(
  activeSupplier: string | undefined,
  supplier: ImageProvider,
): 'newapi' | 'openai-official' | 'gemini-official' | undefined {
  if (activeSupplier === 'newapi' || activeSupplier === 'yunwu' || activeSupplier === 'gptgod') return 'newapi'
  if (activeSupplier === 'openai-official') return 'openai-official'
  if (activeSupplier === 'gemini-official') return 'gemini-official'
  if (supplier === 'openai-compatible') return 'newapi'
  ...
}
```
（保留 yunwu/gptgod 兼容输入，输出统一 newapi）

### 4. 测试更新（机械替换）
- 所有测试中 `'yunwu.openai.` / `'yunwu.gemini.` / `'yunwu.mj.` 契约 id 前缀 → `'newapi.`
- 所有测试中 `supplier: 'yunwu'` → `supplier: 'newapi'`
- 涉及 yunwu 语义断言（如 registry.test.ts 匹配 supplier）同步
- 测试文件名/描述可保留（不必改名测试描述，但内容要过）

## 验收标准
1. `npx tsc --project tsconfig.json --noEmit` 通过
2. `npx vitest run` 全绿（507 基线）
3. `grep -rn "'yunwu'" src/contracts/ src/service/AiImageGeneratorService.ts` 无契约标识符残留（mapSupplierToContract 的兼容输入除外）
4. 不修改 package.json version、不 git commit

## 依赖
- 前置：TASK-002（已完成）
- 阻塞：TASK-004

## 状态
- [x] 未开始
- [ ] 实现中
- [ ] 待验证
- [ ] 已完成
# TASK-004: 配置 schema + migration + index.ts 凭证解析（newapi）

## 范围
- `src/shared/config.ts`：ActiveSupplierSchema 改 newapi；新增 `supplierEndpoints`、`endpointAliases`、`supplierCreditToRmb` 配置项
- `src/config/migration.ts`：迁移旧 `activeSupplier: 'yunwu'/'gptgod'` → `'newapi'`
- `src/index.ts`：resolveCredentials 传 endpoints/aliases 到 catalog 配置；supplier 归一化
- `src/console/view-model.ts`：suppliers 列表 label 更新（如需要）
- `src/commands/catalog.ts`：supplierName 映射（可能已由 TASK-002 处理）
- 相关测试更新

## 目标
用户配置层支持 newapi：schema 单选显示 newapi，migration 自动迁移旧值，凭证解析把 endpoints/aliases 配置传给 catalog 客户端。

## 详细设计

### 1. shared/config.ts
- ActiveSupplierSchema：
  ```ts
  activeSupplier: Schema.union([
    Schema.const('newapi').description('NewAPI 兼容站（云雾 / openlux / GPTGod 等，使用上方"第三方"凭证）'),
    Schema.const('openai-official').description('OpenAI 官方（使用上方 OpenAI 凭证）'),
    Schema.const('gemini-official').description('Gemini 官方（使用上方 Gemini 凭证）'),
  ]).default('newapi')
  ```
- Config interface 新增字段：
  ```ts
  /** 供应商端点覆盖（可选；默认 new-api 标准路径） */
  supplierEndpoints?: {
    models?: string
    pricing?: string
    usage?: string
    usageQuery?: Record<string, string>
    subscription?: string
  }
  /** endpoint 名称 → 协议/能力 别名表（可选；按站补充，如 "MJ imagine"） */
  endpointAliases?: Record<string, { protocol: 'openai' | 'gemini' | 'mj'; capability: 'text-to-image' | 'image-to-image' | 'image-edit' }>
  /** 供应商积分 → 人民币汇率（默认 0.5） */
  supplierCreditToRmb?: number
  ```
- Schema 里这三项放「运营/高级」或「供应商」分组（隐藏可编辑或保持默认；重点是运行期 interface 有）
  - 简单做法：加在 ActiveSupplierSchema 同组的 hidden 对象里（与业务字段一致，由 aka-tools 面板管理）

### 2. config/migration.ts
- 在 migrateConfig 中新增：
  ```ts
  if (clone.activeSupplier === 'yunwu' || clone.activeSupplier === 'gptgod') {
    clone.activeSupplier = 'newapi'
    actions.push(`migrated activeSupplier ${old} → newapi`)
    changed = true
  }
  ```

### 3. index.ts resolveCredentials
- 当前（TASK-002 后）：
  ```ts
  const active = config.activeSupplier ?? 'newapi'
  if (active === 'yunwu' || active === 'gptgod' || active === 'newapi') {
    ...
    return { supplier: 'newapi', apiBase, apiKey, timeoutSec, refreshHours, extraHeaders }
  }
  ```
- 扩展返回对象：`endpoints: config.supplierEndpoints`（传给 ImageCatalogService 的 getConfig 类型）
- 确保 ImageCatalogService.getConfig 返回类型已含 endpoints（TASK-002 已加 CatalogConfig.endpoints）
- 若 config.supplierEndpoints 为空，client 用默认端点（new-api 标准），行为不变

### 4. 测试
- tests/config/migration.test.ts：新增迁移用例（activeSupplier yunwu/gptgod → newapi）
- tests/console/config-store.test.ts：如断言 activeSupplier 默认值同步
- tests/catalog/image-catalog-wiring.test.ts：如构造 cfg 时传 endpoints 验证透传

## 验收标准
1. `npx tsc --project tsconfig.json --noEmit` 通过
2. `npx vitest run` 全绿
3. `grep -rn "Schema.const('yunwu')\|Schema.const('gptgod')" src/` 为空
4. 不修改 package.json version、不 git commit

## 依赖
- 前置：TASK-003（已完成）
- 阻塞：TASK-005

## 状态
- [x] 未开始
- [ ] 实现中
- [ ] 待验证
- [ ] 已完成
# TASK-005: service/providers 引用清理（默认域名 + 汇率配置化）

## 范围
- `src/service/AiImageGeneratorService.ts`：
  - `DEFAULT_OPENAI_API_BASE = 'https://yunwu.ai'`（87 行）→ 改为 `'https://api.openai.com'`？**不**——这是 openai-compatible 的默认，应改为空/通用或保留但由配置覆盖。设计决定：改为 `'https://yunwu.ai'` 保留无意义，改为 `'https://api.openai.com'` 会误导。**最干净：改为常量注释说明"仅作兜底，生产由 openaiCompatibleApiBase 配置覆盖"，值改为空字符串 ''**，避免任何站点硬编码
  - `resolveActiveSupplierRoute`（741 行）`active === 'gptgod' || active === 'yunwu'` → `active === 'newapi' || active === 'gptgod' || active === 'yunwu'`（兼容输入保留）
  - mapSupplierToContract 已由 TASK-003 处理，不动
- `src/providers/midjourney.ts`：
  - 52 行 `apiBase: (config.apiBase as string) || 'https://yunwu.ai'` → `|| ''`（空；无配置时 MJ 请求会失败但提示清晰，不硬编码站点）
  - 14 行注释 yunwu → new-api
- `src/shared/billing.ts`：
  - `SUPPLIER_CREDIT_TO_RMB = 0.5`（39 行）→ 导出保持常量（默认值），但**调用点改为从 config.supplierCreditToRmb 读取**（TASK-004 已加配置项）
  - 检查谁消费 SUPPLIER_CREDIT_TO_RMB / PLATFORM_CREDIT_TO_RMB：grep 确认后，在定价/结算入口传入 config 值
- 相关测试更新（tests/billing/legacy-billing-bridge.test.ts、tests/catalog/billing-normalize.test.ts 等）

## 目标
- 代码里不再硬编码任何站点域名（默认 base 空，由配置驱动）
- 汇率 0.5 从配置读取（默认 0.5），不同 new-api 站可覆盖

## 详细设计

### 1. AiImageGeneratorService.ts
- 87 行：`const DEFAULT_OPENAI_API_BASE = ''`，注释：`/** 兜底 base；生产由 providerSettings.openaiCompatibleApiBase 覆盖，禁止硬编码特定站点。 */`
- 检查 818 行 `normalizeApiBase(settings.openaiCompatibleApiBase) || DEFAULT_OPENAI_API_BASE`：空串时 normalizeApiBase('') 返回 ''，`'' || ''` = ''，请求会失败——需要确认调用链会不会用空 base。若会，改为「无配置时抛错」或保留一个通用默认 `'https://api.openai.com'` 仅用于 gpt-official（826 行本来就是 DEFAULT_OPENAI_API_BASE 且那是 gpt-official 分支）。
  - **注意区分**：818 行是 openai-compatible 分支（用 settings.openaiCompatibleApiBase），826 行是 gpt-official 分支。**gpt-official 用 OpenAI 官方 base 是合理的**，保持 'https://api.openai.com' 正确。
  - 所以：openai-compatible 分支的兜底改为空字符串会导致失败——更稳妥：保留一个中性兜底 `'https://api.openai.com'` 仅当 openaiCompatibleApiBase 完全没配时用，但加注释说明。**最终决定**：openai-compatible 分支兜底保持 `DEFAULT_OPENAI_API_BASE = 'https://api.openai.com'`（中性 OpenAI 兼容入口，非特定中转站），注释明确"生产由 openaiCompatibleApiBase 覆盖；此处仅兜底，禁止指向特定中转站"。
- 741 行：`if (active === 'newapi' || active === 'gptgod' || active === 'yunwu') return 'openai-compatible'`

### 2. midjourney.ts
- 52 行：`apiBase: (config.apiBase as string) || ''`，注释更新：`/** apiBase 由 providerSettings.openaiCompatibleApiBase 传入；未配置时请求失败以暴露配置缺失 */`

### 3. billing.ts
- 保持 `export const SUPPLIER_CREDIT_TO_RMB = 0.5` 作为**默认值**（向后兼容）
- 新增 `export function resolveSupplierCreditToRmb(configValue?: number): number` 返回 `configValue ?? SUPPLIER_CREDIT_TO_RMB`
- grep 消费方：如果定价/结算链路上传入了 supplierCreditToRmb 配置就用配置值

## 验收标准
1. `npx tsc --project tsconfig.json --noEmit` 通过
2. `npx vitest run` 全绿
3. `grep -rn "https://yunwu.ai" src/` 为空（或仅注释）
4. 不修改 package.json version、不 git commit

## 依赖
- 前置：TASK-004（配置项 supplierCreditToRmb 已存在）
- 阻塞：TASK-006

## 状态
- [ ] 未开始
- [ ] 实现中
- [ ] 待验证
- [x] 已完成
# TASK-006: 前端（page.vue、normalize.ts）newapi 文案与配置

## 范围
- `client/page.vue`：activeSupplier 选项/文案、供应商 UI 里的 yunwu/gptgod 分支
- `client/normalize.ts`：activeSupplier 默认值、旧字段清理
- 相关前端测试（tests/console/frontend-no-pricing-formula.test.ts 等如涉及）

## 目标
前端显示 newapi 选项，不再引导用户选 yunwu/gptgod；供应商配置区支持 NewAPI 兼容站。

## 当前已知引用（TASK-002 后）
```
client/page.vue:117: <template v-if="cfg.activeSupplier === 'yunwu' || cfg.activeSupplier === 'gptgod'">
client/page.vue:118:   label 'yunwu API Key' / 'GPTGod API Key'
client/page.vue:122:   placeholder 'https://yunwu.ai/v1' / 'https://gptgod.cloud/v1'
client/page.vue:175: row.yunwuCost 展示（保留？这是展示字段名，可保留）
client/page.vue:404: hint 'yunwu 官方约定值'
client/page.vue:669: m.yunwuCost?.label
client/page.vue:794: if (supplier === 'yunwu' || supplier === 'gptgod') { ... 校验 }
client/normalize.ts:83: c.activeSupplier ??= 'yunwu'
client/normalize.ts:104-107: yunwuGroupRatio / yunwuGroup 删除（保留）
client/normalize.ts:225-226: 'yunwuGroup', 'yunwuCreditToRmb' 字段白名单（保留，兼容旧配置反序列化）
```

## 详细设计

### 1. client/page.vue
- 117 行条件：`cfg.activeSupplier === 'newapi' || cfg.activeSupplier === 'yunwu' || cfg.activeSupplier === 'gptgod'`（兼容显示）
- 118 行 label：`cfg.activeSupplier === 'newapi' ? 'NewAPI API Key' : (cfg.activeSupplier === 'yunwu' ? 'yunwu API Key' : 'GPTGod API Key')`
- 122 行 placeholder：newapi → 'https://api.openlux.ai/v1'（示例），yunwu/gptgod 保留原样
- 404 行 hint：'yunwu 官方约定值' → 'NewAPI 兼容站官方约定值（默认 0.5）'
- 794 行校验：supplier === 'newapi' 加入（`supplier === 'newapi' || supplier === 'yunwu' || supplier === 'gptgod'`），错误文案 'NewAPI API Key'
- 175/669 行 yunwuCost 是展示字段名（后端 view-model 输出的行字段），可保留原名不动（改名会波及 view-model 与测试，收益低；如果顺手改则保持一致）

### 2. client/normalize.ts
- 83 行：`c.activeSupplier ??= 'newapi'`
- 104-107、225-226 行保持（兼容旧配置）

### 3. 测试
- 前端 guard 测试（frontend-no-pricing-formula.test.ts）检查 activeSupplier 相关断言（如有）
- page.vue 的 activeSupplier 校验相关若有单元测试同步

## 验收标准
1. `npx tsc --project tsconfig.json --noEmit` 通过
2. `npx vitest run` 全绿
3. `grep -rn "activeSupplier === 'yunwu'" client/` 无（或仅兼容分支内）
4. 不修改 package.json version、不 git commit

## 依赖
- 前置：TASK-005
- 阻塞：TASK-007

## 状态
- [x] 未开始
- [ ] 实现中
- [ ] 待验证
- [ ] 已完成
# TASK-007: 测试全量更新 + probe 脚本重命名（残留清理）

## 范围
- `scripts/probe-yunwu-catalog.mjs` → `scripts/probe-newapi-catalog.mjs`（内容 supplier/env 改名）
- `tests/scripts/probe-yunwu-catalog.test.ts` → `tests/scripts/probe-newapi-catalog.test.ts`
- `package.json` scripts.probe:yunwu → probe:newapi
- 清理 tests/ 里剩余的 yunwu 引用（注释保留历史说明，标识符/断言同步）
- 全量测试验证

## 目标
测试层与脚本层不再有 yunwu 标识符残留（注释历史说明除外）。

## 当前 tests/ 残留（grep 确认）

```
tests/config/migration.test.ts:3       ← migration 兼容用例（保留，断言 yunwu→newapi）
tests/contracts/param-resolver.test.ts:9  ← 查看内容，多为注释/契约引用
tests/contracts/registry.test.ts:5     ← 同上
tests/providers/gemini-contract.test.ts:5
tests/providers/openai-contract.test.ts:2
tests/providers/openai-apibase.test.ts:6  ← 可能断言默认 base，需查
tests/providers/midjourney.test.ts:1
tests/catalog/image-catalog-wiring.test.ts:2
tests/shared/generation-setup-contract.test.ts:2
tests/scripts/probe-yunwu-catalog.test.ts:5  ← 重命名
tests/billing/legacy-billing-bridge.test.ts:1
tests/console/view-model.test.ts:8     ← view-model 已改 newapi，测试可能已同步（查残留）
tests/console/config-store.test.ts:2
```

## 详细设计

### 1. probe 脚本重命名
- `scripts/probe-yunwu-catalog.mjs` → `scripts/probe-newapi-catalog.mjs`
- 内容修改：
  - `supplier: 'yunwu'` → `supplier: 'newapi'`
  - 环境变量 `YUNWU_API_BASE` → `NEWAPI_API_BASE`（默认 `''`，不再默认 yunwu.ai）；`YUNWU_API_KEY` → `NEWAPI_API_KEY`
  - 错误提示 'YUNWU_API_KEY is required' → 'NEWAPI_API_KEY is required'
  - KNOWN_GENERATION_ENDPOINTS 增加 'MJ imagine' 英文名（与 newapi 适配器一致）
- `tests/scripts/probe-yunwu-catalog.test.ts` → `tests/scripts/probe-newapi-catalog.test.ts`，import 路径与断言同步

### 2. package.json
- `"probe:yunwu": "node scripts/probe-yunwu-catalog.mjs"` → `"probe:newapi": "node scripts/probe-newapi-catalog.mjs"`

### 3. 测试残留清理
逐文件检查 tests/ 里的 yunwu 引用：
- **保留**：migration 兼容用例（断言旧值 yunwu/gptgod 迁移到 newapi）、注释里的历史说明
- **修改**：断言默认值/URL/契约 id 的，同步为 newapi；引用已删除模块的，修复
- 重点检查：
  - tests/providers/openai-apibase.test.ts（6 处）——可能断言 DEFAULT base，改 api.openai.com
  - tests/console/view-model.test.ts（8 处）——view-model 已改，测试应已同步，确认无失败
  - tests/providers/midjourney.test.ts（1 处）——默认 base '' 相关

## 验收标准
1. `npx tsc --project tsconfig.json --noEmit` 通过
2. `npx vitest run` 全绿（预期 515+，probe 测试随重命名更新）
3. `grep -rn "probe-yunwu\|YUNWU_API" scripts/ tests/ package.json` 为空
4. `grep -rn "yunwu" tests/` 仅剩 migration 兼容用例与历史注释
5. 不修改 package.json version（scripts 改名不算 version 变更）、不 git commit

## 依赖
- 前置：TASK-006（已完成）
- 阻塞：TASK-008

## 状态
- [x] 未开始
- [ ] 实现中
- [ ] 待验证
- [ ] 已完成
