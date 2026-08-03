# Project Status — aka-ai-image-generator newapi 适配器重构

## 当前 Epic
- E1: new-api 通用适配器重构（yunwu → newapi），解决 openlux 兼容（MJ endpoint 命名 + billing usage 参数） ✅
- E2: 动态倍率定价（预扣上界 + 实际路由结算），消除固定 mapping.groupRatio 依赖 ✅
- E3: MJ Blend 合成图（`合成图 -mj` → `/mj/submit/blend`，与 Imagine 垫图语义分离） ✅
- E4: aka-tools 总览页真实数据（修复 registerConsoleService 漏传 service 导致用量统计断线） ✅

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

## 进行中
- 无

## 实机验证结果（openlux）
- Koishi 重启无 ValidationError；`model catalog refreshed: supplier=newapi models=40 unsupported=442`
- `mj_imagine` → `mj:text-to-image`、`mj_blend` → `mj:image-edit` 均在可用目录
- billing usage 无参返回 200（total_usage → 供应商积分）
- **动态倍率验证**：真实生成捕获 `x-routing-group`；预扣上界 ≥ 结算实际倍率 ✅
- **总览页**：users.v2.json 真实数据可聚合（2 用户 / 39 张 / 485.2 积分）
- 部署方式：构建后覆盖 `koishi-app/node_modules/koishi-plugin-aka-ai-image-generator/{lib,dist}`（npm 硬副本，非 file: 链接）

## 阻塞
- 无

## 测试基线
- 全量 `547 passed`（54 files），`tsc` clean
- 迁移 8 例、动态倍率 12 例、console 32 例、blend 路由/契约/body 测试

## 已知问题
- `/mj/submit/imagine` 与 `/mj/submit/blend` 上游偶发 `all_retries_failed` / `429`（供应商侧饱和，非路由问题）
- openlux `/api/models` 直连返回 `Permission denied, invalid access token`（文档级核验受限）
- config-hardcoding.test.ts 断言 `src/catalog/newapi-client.ts` 不存在 → 适配器放 `src/suppliers/newapi/` 已满足
- openaiCompatibleApiBase schema 默认值改为 ''（不引导特定站）；老用户配置已迁移
