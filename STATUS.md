# Project Status — aka-ai-image-generator newapi 适配器重构

## 当前 Epic
- E1: new-api 通用适配器重构（yunwu → newapi），解决 openlux 兼容（MJ endpoint 命名 + billing usage 参数）

## 已完成
- [x] TASK-000: 设计文档 `plans/aka-ai-image-generator-newapi-adapter.md` + 基线（b817267）
- [x] TASK-001: suppliers/newapi 适配器（75a6f6c）
- [x] TASK-002: catalog 层切换 + 删除 yunwu 适配器（1ef46a4）
- [x] TASK-003: 契约层改名（395987d）
- [x] TASK-004: 配置 schema + migration + index.ts（5714832）
- [x] TASK-005: service/providers 引用清理（df70e21）
- [x] TASK-006: 前端 newapi 支持（27fe53d）
- [x] TASK-007: 测试全量更新 + probe 脚本重命名（292084c）
- [x] TASK-008: 构建 + 部署 + 实机验证（f13b8e3）

## 进行中
- 无（Epic 完成）

## 实机验证结果（openlux, 2026-08-02）
- Koishi 重启后无 ValidationError；`model catalog refreshed: supplier=newapi models=118 unsupported=363`
- mj_imagine 进入可用列表（endpointAliases 配置 "MJ imagine" → mj:text-to-image）
- billing usage 无参返回 200（total_usage 2.7078 → 0.0000054156 供应商积分；日志显示 0.00 为小数位截断）
- 部署方式：构建后覆盖 `koishi-app/node_modules/koishi-plugin-aka-ai-image-generator/{lib,dist}`（npm 硬副本，非 file: 链接）；原副本备份于 /tmp/aka-ai-image-generator-npm-backup-1.3.8

## 阻塞
- 无

## 待办（用户控制）
- [ ] 版本 bump + 发布（用户授权后）
- [ ] 手测：文生图/图生图/MJ/定价展示/余额面板

## 已知问题
- config-hardcoding.test.ts 断言 `src/catalog/newapi-client.ts` 不存在 → 适配器放 `src/suppliers/newapi/` 已满足
- openaiCompatibleApiBase schema 默认值改为 ''（不引导特定站）；老用户配置已迁移
