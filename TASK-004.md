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
