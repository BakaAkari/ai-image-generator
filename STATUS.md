# Project Status — aka-ai-image-generator newapi 适配器重构

## 当前 Epic
- E1: new-api 通用适配器重构（yunwu → newapi），解决 openlux 兼容（MJ endpoint 命名 + billing usage 参数）

## 已完成
- [x] TASK-000: 设计文档 `plans/aka-ai-image-generator-newapi-adapter.md` + 基线（b817267）

## 进行中
- [ ] TASK-001: suppliers/newapi 适配器（client 端点配置化 + usage 参数 + registry）

## 待开始
- [ ] TASK-002: catalog 层分发 + 类型
- [ ] TASK-003: 契约层改名
- [ ] TASK-004: 配置 schema + migration + index.ts
- [ ] TASK-005: service/providers 引用清理
- [ ] TASK-006: 前端
- [ ] TASK-007: 测试全量更新
- [ ] TASK-008: 构建 + 部署 + 冒烟 + CHANGELOG

## 阻塞
- 无

## 已知问题
- 契约 id 改名影响面大（57 处 yunwu 引用、20+ 测试文件），需全量测试兜底
- 旧 settings.json `activeSupplier: 'yunwu'` 依赖 migration
- config-hardcoding.test.ts 断言 `src/catalog/newapi-client.ts` 不存在 → 新适配器必须放 `src/suppliers/newapi/`
