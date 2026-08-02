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
