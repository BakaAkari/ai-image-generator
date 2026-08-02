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
- [x] TASK-007: 测试全量更新 + probe 脚本重命名（scripts/测试 yunwu 残留清理，515 测试全绿）

## 进行中
- [ ] TASK-008: 构建 + 部署 + 冒烟 + CHANGELOG

## 待开始
（无）

## 阻塞
- 无

## 已知问题
- 契约 id 改名影响面已通过全量测试兜底（515 测试全绿）
- 旧 settings.json `activeSupplier: 'yunwu'` 由 migration 迁移
- config-hardcoding.test.ts 断言 `src/catalog/newapi-client.ts` 不存在 → 新适配器放 `src/suppliers/newapi/` 已满足
