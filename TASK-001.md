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
