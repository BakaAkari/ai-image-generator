# Yunwu 单供应商无硬编码重构设计

状态：已批准设计，等待实施计划  
日期：2026-07-22  
项目：`koishi-plugin-aka-ai-image-generator`

## 1. 目标

把 yunwu 建成插件第一个完整、严格、可验证的供应商实现，覆盖模型发现、能力识别、请求路由、供应商定价、用户积分策略、预授权、事后结算、缓存刷新和 Console 展示。

最终实现不得依赖具体模型 ID、静态价格表、模型名称协议猜测、未知能力默认放行或前后端重复价格公式。

## 2. 明确不做

本阶段不实现 GPTGod、OpenAI 官方、Gemini 官方的对等目录与价格能力。

其他供应商只保留稳定接口边界并返回结构化 `unsupported`，不提供伪兼容、不复用 yunwu 规则猜测结果、不阻塞 yunwu 使用供应商特有字段。

本阶段不承诺从 yunwu 获得每次请求的官方精确成本。供应商没有返回足够证据时，系统必须明确标记 `estimated` 或 `unknown`。

## 3. 不可违反的设计约束

1. 源码不得把具体 yunwu 模型 ID 作为运行默认值。
2. 源码不得维护 yunwu 模型价格表。
3. 模型是否可执行必须由规范化能力和已验证 route 决定。
4. 未知能力和未知 endpoint 必须 fail-closed。
5. 不得通过模型名是否包含 `gemini` 等字符串选择协议。
6. 供应商目录价、成本报价、用户售价、预授权和最终结算必须独立建模。
7. 所有估算必须记录公式版本、输入、假设和置信状态。
8. 前端只展示后端提供的规范化报价，不得自行复制成本公式。
9. 固定用户售价必须明确标记为运营策略，不能显示成供应商成本。
10. 换 API Key 后不得继续使用旧 Key 范围的模型缓存。
11. 配置热重载后刷新调度器必须使用新间隔。
12. 相关迭代必须同步更新 `docs/working/YUNWU_IMPLEMENTATION_BASELINE.md`。

## 4. 总体架构

```text
YunwuClient
  -> SupplierRawSnapshot
  -> YunwuCatalogNormalizer
      -> CapabilityResolver
      -> RouteResolver
      -> PricingNormalizer
  -> CatalogRepository
  -> GenerationQuoteService
  -> UserChargePolicyService
  -> GenerationSettlementService
  -> AiImageGeneratorService
  -> commands / aka-tools / ledger
```

边界原则：

- Client 只负责 HTTP 和原始响应。
- Normalizer 只负责把 yunwu 字段转成稳定领域模型。
- Resolver 只依据明确字段和经过 fixture 验证的 endpoint 映射。
- Quote 只计算或声明供应商成本状态。
- Charge policy 只决定用户积分售价。
- Settlement 只根据实际成功结果结算。
- UI 不参与业务计算。

## 5. 文件边界

计划新增：

- `src/suppliers/types.ts`：通用供应商契约。
- `src/suppliers/yunwu/client.ts`：yunwu HTTP 客户端。
- `src/suppliers/yunwu/raw-types.ts`：完整原始响应类型。
- `src/suppliers/yunwu/capability.ts`：能力规范化。
- `src/suppliers/yunwu/routes.ts`：endpoint 到执行 route 的映射。
- `src/suppliers/yunwu/pricing.ts`：定价字段规范化。
- `src/catalog/model-catalog.ts`：稳定领域目录类型。
- `src/catalog/catalog-repository.ts`：缓存、原子持久化和 key scope。
- `src/catalog/catalog-scheduler.ts`：可重建的刷新调度器。
- `src/billing/types.ts`：价格、报价、售价、预授权和结算类型。
- `src/billing/quote-service.ts`：供应商成本报价。
- `src/billing/charge-policy.ts`：用户积分策略。
- `src/billing/settlement-service.ts`：生成后结算。
- `tests/fixtures/yunwu/`：脱敏契约 fixture。
- `tests/suppliers/yunwu/`：adapter 契约测试。
- `tests/catalog/`：目录、能力、路由和缓存测试。
- `tests/billing/`：报价、策略和结算测试。
- `scripts/probe-yunwu-catalog.mjs`：生产只读探针。

计划逐步替换：

- `src/catalog/newapi-client.ts`
- `src/catalog/image-catalog.ts`
- `src/shared/billing.ts`
- `src/service/AiImageGeneratorService.ts` 中的名称路由和默认模型 fallback
- `client/page.vue` 中的价格公式

旧文件只有在所有消费者迁移完成并通过回归后才删除。

## 6. 供应商契约

```ts
export interface ImageSupplierAdapter {
  readonly id: string
  fetchSnapshot(signal?: AbortSignal): Promise<SupplierRawSnapshot>
  normalize(snapshot: SupplierRawSnapshot): CatalogSnapshot
  buildRequest(route: GenerationRoute, request: GenerationRequest): SupplierRequest
  parseResponse(route: GenerationRoute, response: unknown): SupplierGenerationResult
}
```

其他供应商暂时实现：

```ts
throw new SupplierUnsupportedError('catalog', supplierId)
```

不允许返回 yunwu 目录或复用 yunwu endpoint 推断。

## 7. 原始快照

```ts
export interface SupplierRawSnapshot {
  schemaVersion: 1
  supplier: 'yunwu'
  fetchedAt: number
  keyScopeFingerprint: string
  endpoints: {
    models: RawEndpointResult<YunwuModelItem[]>
    pricing: RawEndpointResult<YunwuPricingItem[]>
    billing: RawEndpointResult<YunwuBillingPayload | null>
    status: RawEndpointResult<YunwuStatusPayload | null>
  }
}
```

`RawEndpointResult` 必须包含：

- URL path；
- HTTP status；
- fetchedAt；
- success/error；
- 原始 data；
- 响应结构摘要；
- 不包含 API Key 或 Authorization。

`keyScopeFingerprint` 使用供应商 ID、base URL 和 API Key 的 SHA-256 摘要生成，只保存截断摘要。

## 8. 规范化模型目录

```ts
export interface CatalogModel {
  id: string
  supplier: 'yunwu'
  availability: 'available' | 'unavailable' | 'unknown'
  capabilities: ModelCapability[]
  routes: GenerationRoute[]
  prices: SupplierPrice[]
  executable: boolean
  confidence: 'exact' | 'derived' | 'unknown'
  unsupportedReasons: string[]
  raw: {
    model: YunwuModelItem
    pricing?: YunwuPricingItem
  }
}
```

完整目录保留全部模型；可执行下拉只展示 `executable=true` 的模型。

模型缺少价格不等于不可生成。模型缺少明确生成 route 才不可执行。

## 9. 能力解析

能力解析优先级：

1. `available=false`：不可执行。
2. `model_type` 明确为音视频且没有图像生成 endpoint：不可执行。
3. `supported_endpoint_types` 映射到已验证 operation/route。
4. `tags/type` 只能补充信息，不能单独放行。
5. 未识别 endpoint：保留原始值，标记 unsupported，不生成 route。

规范化能力：

- `text-to-image`
- `image-to-image`
- `multi-image-compose`
- `image-recognition`
- `image-upload`
- `image-to-video`
- `video-generation`
- `unknown`

以下条目必须不可作为图片生成模型：

- `kling-avatar-image2video`
- `kling-image-recognize`
- `mj_upload`
- `pixverse-image-template`
- `mj_video`

模型名关键词只能用于诊断提示，不能用于 `executable=true`。

## 10. Route 解析

```ts
export interface GenerationRoute {
  id: string
  operation: 'text-to-image' | 'image-to-image' | 'multi-image-compose'
  protocol: 'openai-images' | 'gemini-generate-content'
  endpointType: string
  verifiedBy: 'fixture' | 'live-smoke'
  supports: {
    resolutions?: string[]
    aspectRatios?: string[]
    multipleInputImages?: boolean
  }
}
```

route 由 `supported_endpoint_types` 的显式映射产生。每项映射必须有 fixture；实际生成通过后升级为 `live-smoke`。

未识别 endpoint 不得回退到 OpenAI Images。

同一模型可以拥有多个 route。生成请求根据 operation 选择 route，不再从 modelId 推导协议。

## 11. 定价模型

```ts
export interface SupplierPrice {
  source: 'yunwu-pricing'
  billingMode: 'per-call' | 'per-token' | 'resolution' | 'duration' | 'unknown'
  currency: 'USD'
  modelPrice?: number
  modelRatio?: number
  imageRatio?: number
  completionRatio?: number
  enableGroups: string[]
  raw: YunwuPricingItem
}
```

不得丢弃 yunwu 返回的定价字段。

`/api/pricing` 的数据标记为 `catalog-public`。没有当前 Key 分组证据时，不得标记为 `key-effective`。

## 12. 成本报价

```ts
export interface CostQuote {
  status: 'catalog-quote' | 'estimated' | 'unknown' | 'actual'
  currency: 'USD'
  amount?: number
  source: 'supplier-catalog' | 'configured-formula' | 'unavailable'
  formulaId?: string
  formulaVersion?: number
  assumptions: string[]
  inputs: Record<string, string | number | boolean>
}
```

规则：

- per-call 且请求没有供应商声明的变量价格：可以给 `catalog-quote`，但它只是目录报价，不是当前 Key 最终价格或账单实扣证明。
- `actual` 只允许来自供应商响应中的请求级结算证据或可唯一归因的账单记录；当前 yunwu 未提供时不得生成该状态。
- per-token 只有 `model_ratio` 而没有完整计算证据：返回 `unknown`。
- 禁止保留 2000 token/图和 2 USD/M 的内置估算。
- 若以后需要估算，通过配置化 `PricingFormula` 注册，包含来源说明和版本。

## 13. 用户积分策略

```ts
export type ChargePolicy =
  | { mode: 'cost-plus'; policyId: string; exchangeRate: number; markup: number; acceptEstimated: boolean }
  | { mode: 'fixed'; creditsPerImage: number }
  | { mode: 'disabled' }
```

模型映射：

```ts
export interface ModelMappingConfig {
  suffix: string
  modelId: string
  restricted: boolean
  chargePolicy: ChargePolicy
}
```

规则：

- `cost-plus` 默认接受 `catalog-quote`；只有 `acceptEstimated=true` 时才接受 `estimated` quote。
- `unknown` quote 默认不可用于 cost-plus。
- `fixed` 明确显示“运营固定售价”。
- `disabled` 禁止普通调用并给出原因。
- 不再使用隐式 `defaultCreditCostPerImage` 回退。

## 14. 旧配置迁移

迁移必须无损：

- 有 `creditCostPerImage`：迁移为 `fixed`。
- 无 `creditCostPerImage` 且可获得 `catalog-quote`：迁移为 `cost-plus`，并设置 `acceptEstimated=false`。
- 无固定价且报价未知：迁移为 `disabled`，不能静默收全局默认价。
- 第一条 mapping 仍是默认选择，但不创建内置 mapping。
- 没有 mapping 时命令明确提示管理员配置默认模型。
- 旧字段保留一个发布周期的只读兼容解析，并输出一次迁移警告。

迁移前后必须对用户余额、账本和历史流水保持兼容，不重写旧流水。

## 15. 预授权与结算

生成前：

1. 解析 model mapping 和 route。
2. 生成 CostQuote。
3. 生成 UserChargeQuote。
4. 预留请求图片数量对应积分。
5. 将 quote/policy/formula 证据绑定到 requestId。

生成后：

1. 按成功发送图片数计算实际用户积分。
2. 释放未使用预留。
3. 写入 settlement ledger。
4. 记录供应商成本证据状态，不伪造供应商实扣。

```ts
export interface GenerationSettlement {
  requestId: string
  reservedCredits: number
  settledCredits: number
  releasedCredits: number
  requestedImages: number
  deliveredImages: number
  costQuote: CostQuote
  chargePolicy: ChargePolicy
}
```

## 16. 缓存与刷新

```ts
export interface CatalogCacheEnvelope {
  schemaVersion: 1
  parserVersion: string
  supplier: 'yunwu'
  keyScopeFingerprint: string
  fetchedAt: number
  expiresAt: number
  rawSnapshot: SupplierRawSnapshot
  catalog: CatalogSnapshot
}
```

要求：

- 写临时文件、flush/fsync、原子 rename。
- 读取时校验 schema、supplier、fingerprint。
- 换 base URL 或 API Key 后旧缓存不加载。
- 缓存过期后可用于只读展示，但标记 stale。
- stale 缓存是否允许新生成由明确配置决定，默认仅允许已有 fixed policy；未知成本的 cost-plus 禁止生成。
- scheduler 暴露 `start()`、`updateInterval()`、`stop()`。
- 热重载 `catalogRefreshHours` 必须调用 `updateInterval()`。
- 并发刷新继续使用 single-flight。

## 17. aka-tools 设计

模型目录分成：

- 可执行图片模型；
- 非图片生成能力；
- 未适配 endpoint；
- 不可用模型。

每行显示：

- model ID；
- model_type；
- capabilities；
- routes；
- availability；
- 供应商目录计费；
- 成本 quote 状态；
- 用户 charge policy；
- 数据来源；
- 更新时间；
- 不可执行原因。

示例：

```text
供应商目录价：$0.3300/次
用户售价：固定 0.3 积分/张
关系：运营固定售价，不随目录价自动变化
```

```text
供应商计费：token 倍率 0.875
成本报价：未知
原因：供应商未提供足够的单请求计算证据
用户策略：disabled
```

前端删除 `autoCredits()` 公式，只渲染后端 quote。

## 18. 配置界面

当前阶段只显示 yunwu 为可维护供应商。

其他供应商入口可以隐藏或显示“暂未适配”，但不能让用户误以为具备动态目录和准确价格能力。

模型映射只允许从可执行目录选择；失效旧映射保留并标红，不自动删除。

运营人员必须显式选择 charge policy。新 mapping 默认 `disabled`，避免未知成本时自动收费。

## 19. 观测与日志

刷新日志必须包含：

- supplier；
- key scope fingerprint；
- raw model/pricing 数量；
- executable/unsupported/unknown 数量；
- pricing mode 数量；
- cache age；
- parser version；
- 新增/删除/能力变化/价格变化摘要。

日志不得包含 API Key、Authorization 或完整敏感响应。

每次生成日志必须包含 requestId、modelId、routeId、quote status、charge policy、reserved/settled/released credits。

## 20. 测试策略

### 契约 fixture

保存脱敏：

- `/v1/models`
- `/api/pricing`
- billing
- status

fixture 保留当前未消费字段，字段变化必须让契约测试失败或生成明确 diff。

### 单元测试

- capability 解析正例、反例、未知 endpoint；
- route 多能力选择；
- per-call、per-token、unknown pricing；
- fixed、cost-plus、disabled；
- 旧配置迁移；
- key scope 缓存隔离；
- 原子写恢复；
- scheduler interval 热更新；
- 部分成功 settlement。

### 生产只读探针

`scripts/probe-yunwu-catalog.mjs`：

- 使用当前配置读取真实 yunwu；
- 不生成图片、不改配置；
- 输出字段变化、目录统计、未识别 endpoint 和价格变化；
- API Key 只显示 fingerprint。

### 真实 smoke

对每个启用 route 选择管理员确认的低成本模型：

- 文生图 1 次；
- 图生图 1 次；
- 核对图片返回、日志、预授权、结算、ledger；
- 不能用目录价格替代实际账单证据。

## 21. 必须覆盖的反例

- `kling-avatar-image2video` 不进入图片生成选择器。
- `kling-image-recognize` 不得到文生图 route。
- `mj_upload` 不可执行生成。
- 未知 endpoint 不回退 OpenAI。
- per-token 参数不足不显示精确每张价格。
- fixed 售价不显示为供应商成本。
- 换 Key 后旧缓存不生效。
- 刷新间隔热更新后旧 timer 被销毁。
- 目录刷新失败不破坏最后完整缓存。
- 没有默认 mapping 时不回退具体模型。

## 22. 实施切片

1. yunwu 原始类型、client、fixture 和契约测试。
2. 规范化 catalog、fail-closed capability 和 route resolver。
3. pricing、CostQuote、ChargePolicy 和 Settlement 领域模型。
4. 旧配置迁移并移除默认模型、全局价格回退和名称路由。
5. 原子 CatalogRepository、key scope 和动态 scheduler。
6. 生成链路接入 quote/预授权/settlement。
7. aka-tools 页面和后端 state contract 重构。
8. 生产只读 probe、真实 smoke、清理旧代码和文档同步。

每个切片必须经过 RED、GREEN、完整 typecheck/build/test、容器部署验证。涉及实际生成和扣费的切片必须读取 ledger 和容器日志完成实物验收。

## 23. 总验收标准

- 无具体 yunwu 模型 ID 运行默认值。
- 无静态模型价格表。
- 无模型名协议推断。
- 无未知能力默认放行。
- 无前后端重复报价公式。
- 无隐式全局积分价格回退。
- 所有模型售价都是显式策略。
- 所有成本显示都有来源和证据状态；目录报价不会标记为实际成本。
- fixed、目录价、估算价、结算结果不会混淆。
- yunwu 响应结构变化可被契约测试发现。
- 换 Key/base 后缓存隔离正确。
- 文生图和图生图真实 smoke 通过。
- 预授权、成功图片数、最终结算和 ledger 一致。
- README、ROADMAP、CHANGELOG 和实现基线已同步。

## 24. 停止条件

出现以下任一情况时停止当前切片，不继续叠加功能：

- 无法从 yunwu 字段证明某 endpoint 对应的生成协议；
- 成本未知却仍被系统标记为精确或自动 cost-plus；
- 测试 fixture 与生产响应结构明显不一致；
- 换 Key 后仍加载旧目录；
- 部分成功时预授权与 ledger 不守恒；
- 非图片生成模型重新进入可执行选择器；
- 运行容器产物与源码构建产物不一致。
