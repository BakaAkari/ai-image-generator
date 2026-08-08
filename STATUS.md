# Project Status — aka-ai-image-generator

## 当前 Epic
- E1: new-api 通用适配器重构（yunwu → newapi），解决 openlux 兼容（MJ endpoint 命名 + billing usage 参数） ✅
- E2: 动态倍率定价（预扣上界 + 实际路由结算），消除固定 mapping.groupRatio 依赖 ✅
- E3: MJ Blend 合成图（`合成图 -mj` → `/mj/submit/blend`，与 Imagine 垫图语义分离） ✅
- E4: aka-tools 总览页真实数据（修复 registerConsoleService 漏传 service 导致用量统计断线） ✅
- E5: 日志真源精确结算（`/api/log/self` 权威 quota 优先于公式链）+ 计费探测移除 + quotaPerUnit 迁移 ✅
- E6: 定价双模式收敛（auto / simple）+ simple 固定积分接真实结算链路 + grok/qwen 契约 + 计价对账 ✅

## 已完成
- [x] TASK-000: 设计文档 + 基线（b817267）
- [x] TASK-001: suppliers/newapi 适配器（75a6f6c）
- [x] TASK-002: catalog 层切换 + 删除 yunwu 适配器（1ef46a4）
- [x] TASK-003: 契约层改名（395987d）
- [x] TASK-004: 配置 schema + migration + index.ts（5714832）
- [x] TASK-005: service/providers 引用清理（df70e21）
- [x] TASK-006: 前端 newapi 支持（27fe53d）
- [x] TASK-007: 测试全量更新 + probe 脚本重命名（292084c）
- [x] TASK-008: 构建 + 部署 + 实机验证（f13b8e3）
- [x] TASK-009: 动态倍率定价（E2）——预扣上界 + 实际路由结算
- [x] v2.3.0: MJ Blend 接入（`newapi.mj.blend` 契约 + `submitBlend` + 语义规则 `mj:image-edit`；commit a8d28f7）
- [x] v2.3.1: 修复总览页用量统计断线（registerConsoleService 补传 service；commit 2fd1d29）
- [x] v2.3.2: 死代码清理（移除未接线的 PricingSnapshotService）+ 文档归档更新
- [x] v2.3.3: 空目录防护（models.data.data.length 校验，拒绝空快照覆盖有效缓存）
- [x] v2.4.0: MJ 日志精确结算（日志真源 → 公式链）+ 移除计费探测 + quotaPerUnit 迁移（5000→500000）
- [x] v2.4.1: Gemini 结算路由分组捕获修复（少算约 3.6 倍）
- [x] v2.5.0: qwen-image-max / grok-imagine 系列契约接入 + qwen `size=auto` 修复
- [x] v2.6.0: 定价双模式收敛（auto / simple）+ simple 固定积分 `resolveMappingFixedCost` + 供应商页恢复 + 迁移保值 + 总览定价简介卡
- [x] v2.6.1: UI 收尾——保存后自动刷新（删刷新按钮、保存成功自动 loadState）+ 布局对齐（统一 box-sizing: border-box）

## 进行中
- 无

## 实机验证结果（openlux）
- Koishi 重启无 ValidationError；`model catalog refreshed: supplier=newapi models=40 unsupported=442`
- `mj_imagine` → `mj:text-to-image`、`mj_blend` → `mj:image-edit` 均在可用目录
- billing usage 无参返回 200（total_usage → 供应商积分）
- **动态倍率验证**：真实生成捕获 `x-routing-group`；预扣上界 ≥ 结算实际倍率 ✅
- **grok / qwen 真实计价对账（v2.6.0）**：沙盒真实生成，系统结算 vs 平台 `/api/log/self` 权威 quota 一致——grok 1.0442 积分 ↔ quota 7647（$0.015294）；qwen 2.5102 ↔ quota 18383（$0.036766，4dp 舍入差 1e-6）。历史旧系统两路亦一致。
- **v2.6.1 UI 实测**：保存后自动刷新（切 simple → 保存 → tabs 5→4 自动切换）；5 tab 无右缘越界（DOM 几何断言）；浮动工具条 4 图标。
- 部署方式：构建后覆盖 `koishi-app/node_modules/koishi-plugin-aka-ai-image-generator/{lib,dist}`（npm 硬副本，非 file: 链接）

## 阻塞
- 无

## 测试基线
- 全量 `619 passed`（v2.6.x 基线），`tsc` clean
- 覆盖：迁移、动态倍率、console、blend 路由/契约/body、mapping-fixed-cost、effective-mode、config-autopilot、prompt-groups 供应商 tab 断言

## 已知问题
- `/mj/submit/imagine` 与 `/mj/submit/blend` 上游偶发 `all_retries_failed` / `429`（供应商侧饱和，非路由问题）
- openlux `/api/models` 直连返回 `Permission denied, invalid access token`（文档级核验受限）
- 3001 QQ adapter ECONNRESET 持续断连重试（代码 1006）——运行环境网络问题，非插件问题
- config-hardcoding.test.ts 断言 `src/catalog/newapi-client.ts` 不存在 → 适配器放 `src/suppliers/newapi/` 已满足
- openaiCompatibleApiBase schema 默认值改为 ''（不引导特定站）；老用户配置已迁移
