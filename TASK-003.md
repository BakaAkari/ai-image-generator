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
