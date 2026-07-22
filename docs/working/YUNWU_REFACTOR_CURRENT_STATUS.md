# Yunwu 重构当前开发状态

更新时间：2026-07-22
分支：`refactor/yunwu-no-hardcoding`
隔离工作区：`.worktrees/yunwu-no-hardcoding`
当前 HEAD：`037fd8a`（文档生成前）

## 总体状态

当前目标尚未完成。Task 1–6 的主要代码已落盘；Task 7 正在进行；Task 8、全分支审查、容器验收和 GitHub 推送仍未执行。

## 已完成并提交

- `d16d164`：Yunwu 原始类型、Client、脱敏 fixture、契约测试。
- `e25125c`：fail-closed Catalog、能力与 endpoint route 解析。
- `62dfafa`：Pricing/CostQuote/ChargePolicy/Settlement 基础领域类型。
- `34ce373`：旧配置迁移基础和清空默认模型映射。
- `8c9dd25`：scope 原子缓存与热更新 Scheduler 基础。
- `e6f7b7b`：Catalog 缓存/Scheduler 接入运行服务与配置热更新。
- `78e3f4c`：per-token 无明确公式时 fail-closed，删除 `$2/M token` 隐式估算。
- `309b333`：显式 chargePolicy 迁移；删除具体默认模型、名称猜协议和全局默认积分运行回退。
- `7b623d0`：真实积分 reserve→settle/release；并发防超卖、部分交付守恒、幂等、豁免、持久化和过期恢复；主链、ChatLuna、YesImBot 全部接线。

## 最新已提交基线验证

Task 6 提交前的完整验证：

- `npm run test`：93 tests passed。
- `npm run typecheck`：通过。
- `npm run build`：通过。
- 搜索确认旧 `checkAndReserveQuota` 和生成后直接 `recordUsage` 消费入口无生产消费者，并已删除。

## Task 7：aka-tools 后端契约与页面重构（进行中）

### 已实现但尚未提交

- 新增 `src/console/view-model.ts`：后端生成模型目录、供应商状态、目录价格、成本报价和运营收费标签。
- 修改 `src/console/service.ts`：`get-state` 改为消费后端 view-model。
- 修改 `client/page.vue`：
  - 删除 `autoCredits()` 和 `0.004` 等前端价格公式。
  - 展示后端 `catalogPrice`、`costQuote`、`chargePolicy`。
  - 模型下拉只使用后端 `selectableModels`。
  - 新模型映射默认 `disabled`，要求显式选择收费策略。
  - 只把 yunwu 标记为完整维护；其他供应商显示暂未适配。
  - 删除“全局默认每张积分”表单。
- 新增测试：
  - `tests/console/view-model.test.ts`
  - `tests/console/frontend-no-pricing-formula.test.ts`

### Task 7 已验证证据

当前未提交 Task 7 修改曾运行并通过：

- Console targeted tests：7 passed。
- `npm run typecheck`：通过。
- `npm run build`：通过。

### Task 7 当前状态

- `CatalogSnapshot` 已持有独立 `unsupportedModels`；刷新时保留未知/非生成 endpoint 模型。
- Console 后端转发 unsupported 数据，页面独立分组展示并标记“不可选择”。
- 待运行全量 test/typecheck/build 后提交 Task 7。

## 当前未提交工作树

- Modified: `client/page.vue`
- Modified: `src/console/service.ts`
- Untracked: `src/console/view-model.ts`
- Untracked: `tests/console/`

当前 `git diff --check` 通过。

## 后续顺序

1. 完成 Task 7 unsupported 数据链、全量验证、文档更新和独立提交。
2. Task 8：只读 Yunwu probe、真实脱敏 fixture 更新、旧代码零消费者清理、README/ROADMAP/CHANGELOG、版本升级。
3. 备份并部署到 `mita_koishi` 测试容器，核对本地/容器哈希，执行低成本文生图和图生图 smoke，验证 reservation/settlement/ledger。
4. 全分支独立审查，修复所有 Critical/Important，重新全验。
5. 写最终 verification 文档，push GitHub，建立 PR，验证 CI，合并后核对远端 SHA。

## 已知风险

- Task 7 未提交代码不能视为稳定检查点。
- 生产容器尚未部署本分支，真实生成与账本尚未验收。
- Task 8 前不能删除 `src/catalog/newapi-client.ts` 或旧 Catalog 类型；必须先证明零消费者。
- 测试 fixture 中少数 endpoint 为审计后补全，最终须用只读 probe 获取真实脱敏快照替换并复核。

## Task 8 最新进展

- 只读 probe、旧 Client 清理、0.9.0 版本与发布文档已完成。
- 本机 `.secret` 未发现 Yunwu Key；认证 probe 和真实 smoke 尚未执行。
