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
