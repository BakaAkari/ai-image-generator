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
