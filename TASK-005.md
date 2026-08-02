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
