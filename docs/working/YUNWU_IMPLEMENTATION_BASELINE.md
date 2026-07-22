# Yunwu 实现基线与持续审计记录

状态：临时但必须持续维护的工程基线  
最后核验：2026-07-22  
适用项目：`koishi-plugin-aka-ai-image-generator`

## 维护规则

本文档是 yunwu 模型目录、能力识别、定价、计费和运行路由的当前事实基线。

每次修改以下任一内容时，必须在同一个提交中更新本文档：yunwu API 端点/响应字段、模型筛选与能力识别、协议路由、价格解析、积分换算与结算、目录缓存与刷新、aka-tools 价格展示、生产计费配置、现场验证结论。

维护时必须更新“最后核验”、实现状态、已知限制和验证证据。不能只改代码而保留过期结论。

## 当前开发范围

当前只重点维护 yunwu。

- yunwu 是模型目录、能力、价格和生成协议的唯一优先实现。
- GPTGod、OpenAI 官方、Gemini 官方暂不继续扩展或做对等实现。
- 其他供应商只保留明确 adapter/interface 边界，不能限制 yunwu 功能完整度。
- yunwu 稳定后，其他供应商以其 adapter 和契约测试为模板实现。

## 已验证运行版本

- 包版本：`0.8.13`
- 源码：`/mnt/user/code-project/koishi-plugins/aka-ai-image-generator`
- 运行副本：`mita_koishi:/koishi/node_modules/koishi-plugin-aka-ai-image-generator`
- 源码构建产物与容器中的 `lib/index.js`、Console bundle 哈希一致。

## 当前数据流

`apply -> restore disk cache -> register dynamic options -> immediate refresh -> /v1/models + /api/pricing + billing -> merge by model id -> local capability inference -> persist model-catalog.json -> rebuild options -> validate mappings`

缓存：`/koishi/data/aka-ai-image-generator/model-catalog.json`

刷新触发：启动立即刷新、定时刷新、aka-tools 手动刷新、`图像模型 刷新`、供应商/凭证变化。失败时保留旧缓存并记录 `snapshot.error`。

## 供应商现场验证

2026-07-22 使用生产 yunwu Key：

- `/v1/models`：HTTP 200，426 个 Key 可见模型；
- `/api/pricing`：HTTP 200，454 条平台价格记录；
- 插件筛选缓存：44 个；
- 39 个 per-call、3 个 per-token、2 个 unknown；
- 42 个 remote-pricing、2 个 remote-models；
- 缓存时间：`2026-07-22T03:27:06.030Z`；
- 重复现场请求未发现缓存中已匹配模型的 `model_price/model_ratio` 变化。

## 当前消费的远端字段

`/v1/models`：`id`、`model_type`、`description`、`supported_endpoint_types`。

`/api/pricing`：`quota_type`、`model_price`、`model_ratio`、`enable_groups`。

接口实际返回但插件未消费：`image_ratio`、`completion_ratio`、`available`、`type`、`tags`、`vendor_id`、`sort_order` 等。

billing：`total_usage`、`soft_limit_usd`、`hard_limit_usd`、`token_name`。

## 价格事实边界

`/api/pricing` 不带 API Key 也能返回公开目录，因此当前得到的是平台公开目录价，不能证明是当前 Key 所属分组的最终实扣价。

当前没有：识别 Key 有效分组、应用组倍率、处理分辨率/质量/输入图/输入输出 token 差异、通过响应 usage 或账单增量做单请求事后核算。

UI 必须分别表达：供应商目录价、插件估算成本、用户固定售价、预授权金额、实际结算结果、无法确认。不能统称“真实价格”。

## 当前硬编码和配置覆盖

代码中仍有：

- 默认模型 `gpt-image-2`；
- Schema 默认映射 `gpt-image-2`、`gemini-3-pro-image-preview`；
- per-token 估算 2000 token/图、2 USD/百万 token；
- 前端等价常量 `0.004 * model_ratio`；
- 默认汇率 1 USD=1000 积分、默认加成 1.3；
- 默认刷新 6 小时；
- 模型关键词和模式推断关键词；
- 能力未知时默认文生图+图生图；
- 模型名包含 `gemini` 时走 Gemini，否则走 OpenAI；
- 固定供应商 URL、API path、尺寸映射、GPT Image 最低超时。

协议 URL、API path、标准枚举可作为 adapter 内协议常量；模型、价格、能力、分组、计费参数和运营售价不应作为业务硬编码。

当前生产配置：

- `gpt -> gpt-image-2`，无固定单价，走 per-token 本地估算；
- `gem -> gemini-3-pro-image-preview`，固定 `creditCostPerImage: 0.3`；
- `grok -> grok-imagine-image`，固定 `creditCostPerImage: 0.3`；
- 全局 `defaultCreditCostPerImage: 0.3`。

因此 gem/grok 扣费不跟随远端价格，gpt-image-2 使用本地估算。

## 现场价格样例

- `gemini-3-pro-image-preview`：per-call，`model_price=0.33`；
- `gemini-3-pro-image`：per-call，`model_price=0.792`；
- `grok-imagine-image`：per-call，`model_price=0.208`；
- `gpt-image-2-c`：per-call，`model_price=0.12`；
- `gpt-image-2`：per-token，`model_ratio=0.875`，另有 `image_ratio=1.6`、`completion_ratio=6`，当前未消费后二者。

## 已知目录误收

- `kling-avatar-image2video`：音视频/数字人；
- `kling-image-recognize`：图像识别；
- `mj_upload`：上传动作；
- `pixverse-image-template`：音视频图片模板；
- `mj_video`：视频相关且价格未知。

根因：按模型名/宽泛 model_type 粗筛，无法识别 endpoint 时又默认双生成能力。目标必须改为 fail-closed：只有明确受支持的生成 endpoint/capability 才进入可执行目录。

## 风险级别

P0：per-token “约积分/张”是忽略关键远端字段的本地公式，却容易被理解成真实成本。

P1：公开目录价未结合 Key 分组；固定积分价覆盖远端价格；目录误收非生成模型；协议按名称猜测；未知能力 fail-open；目录价/估算/售价/结算未独立建模。

P2：刷新间隔热更新不重建 timer；缓存写入非原子；README/ROADMAP 中版本和架构描述过期；快照缺少 schema/parser 版本与 key scope 证据。

## yunwu 目标原则

1. 模型、能力、价格和可用状态来自 yunwu 响应或供应商元数据，不维护静态模型/价格表。
2. 未知能力 fail-closed。
3. 目录价、成本估算、用户售价、预授权、事后结算分别建模。
4. 所有估算携带来源、公式版本、输入和置信状态，不能伪装成精确值。
5. 请求通过 catalog capability 解析出的 endpoint adapter 路由，不按模型名猜协议。
6. 规范化快照保留原始远端字段，便于后续演进。
7. 缓存包含 schemaVersion、provider、keyScopeFingerprint、fetchedAt、expiresAt、parserVersion，并原子写入。
8. 配置热重载真正更新刷新调度器。
9. UI 显示数据来源、新鲜度、价格类型和覆盖关系。
10. 每次相关迭代同步更新本文档和自动化契约测试。

## 下一阶段边界

第一阶段只完成 yunwu adapter、规范化目录、fail-closed 能力、价格分层、无业务硬编码计费策略、原子缓存与动态刷新、aka-tools 展示、契约 fixture、生产只读探针和真实生成 smoke test。

其他供应商只保留接口和 `unsupported` 状态，不做功能填充。

## 当前实施状态

### Task 1：Yunwu 原始契约、Client 与脱敏 Fixture
- 状态：完成（commit `d16d164`）
- 产物：`src/suppliers/types.ts`、`src/suppliers/yunwu/{raw-types,client}.ts`、脱敏 fixture 与契约测试。
- 当前验证基线：纳入全量测试持续回归。
- 已知限制：fixture 中少数 endpoint 是基于已审计供应商数据补全，Task 8 必须用真实只读 probe 更新并复核。

### Task 2：fail-closed Catalog、Capability 与 Route
- 状态：完成基础实现（commit `e25125c`），最终接线仍由 Task 5/6 完成。
- 产物：`src/catalog/model-catalog.ts`、`src/suppliers/yunwu/{capability,routes,normalizer}.ts`。
- 反例：识别、上传、视频、数字人模型不进入 executable projection。

### Task 3：Pricing、CostQuote、ChargePolicy、Settlement
- 状态：硬编码返修完成，真实预授权/结算接线仍属于 Task 6。
- 已完成：`PricingEngine`、`CostQuote`、`ChargePolicy`、Settlement/Ledger 类型。
- 已修复：per-token 路径不再使用 `$2/M token` 或隐式 token 数；无显式 request formula 时返回 `estimate + chargeable=false`，不产生美元/积分数值。
- 未完成：领域层尚未接入真实预授权/结算。

### Task 4：旧配置迁移与删除隐式默认
- 状态：完成。
- 已完成：Schema 默认 `modelMappings` 清空；新增显式 `fixed` / `cost-plus` / `disabled` chargePolicy。
- 已完成：旧 `creditCostPerImage` 无损迁移为 fixed；可用 per-call catalog quote 迁移为 cost-plus（`acceptEstimated=false`）；未知价格映射迁移为 disabled。
- 已完成：删除 `DEFAULT_OPENAI_MODEL_ID`、按 `/gemini/i` 猜协议和运行时全局默认积分回退；空映射/缺目录 route 显式报错。
- 已完成：目录 endpoint route 是协议唯一来源；新增源码硬编码回归测试。

### Task 5：原子 CatalogRepository、Key Scope 与热更新 Scheduler
- 状态：完成。
- 已完成：
  - `src/catalog/catalog-repository.ts`：scope 校验、stale 标记、临时文件写入、`fsync`、原子 rename、完整备份回退。
  - `src/catalog/catalog-scheduler.ts`：single-flight、interval 热更新、stop 清理。
  - `tests/catalog/catalog-{repository,scheduler}.test.ts`：8 个针对性测试。
- 已接线：`src/catalog/image-catalog.ts` 使用 scope cache 与 Scheduler；`src/index.ts` 在热重载时调用 `updateRefreshHours()`，凭证变化仍立即刷新，dispose 显式 stop。
- 当前验证：全量 71 测试通过，`npm run typecheck`、`npm run build` 通过。

### Task 6：真实预授权、生成链路结算与账本证据
- 状态：完成代码接线，待最终容器 smoke 验收。
- 已完成：`reserveCredits` 在 `dataLock` 内冻结免费/已购余额；并发请求不可超卖。
- 已完成：`settleReservation` 按实际交付图片数结算并释放差额；`releaseReservation` 失败全额释放；操作幂等且满足 `reserved = settled + released`。
- 已完成：reservation 单独原子持久化，重启后可继续 settle/release；过期 active hold 启动时自动 reconcile。
- 已完成：管理员、永久会员、豁免平台记录交付但不扣费。
- 已完成：主编排器、ChatLuna、YesImBot 全部切到 reserve→settle/release；旧伪预检和生成后直接 consume 入口已删除。
- 当前验证：93 tests、typecheck、build 通过。

### Task 7–9
- 状态：未开始。
- 包含 aka-tools 后端视图模型与前端去公式、只读 probe/真实 smoke/旧代码清理、全分支审查、容器验收及 GitHub PR/合并。
