# Changelog

## [2.3.0] - 2026-08-03

### 新增

- **接入 MJ Blend 合成图**：`合成图 -mj` 现在走真正的 Midjourney 多图融合接口 `/mj/submit/blend`，不再复用 Imagine 垫图语义。
  - 新增契约 `newapi.mj.blend`（operation=`compose-image`，endpoint=`/mj/submit/blend`）。
  - `resolveContract()` 对 `protocol=mj + operation=compose-image` 优先匹配 blend 契约，确保合成图与图生图区分：
    - `图生图 -mj` → Imagine + base64Array（垫图 / 参考图生成）
    - `合成图 -mj` → Blend + base64Array（多图融合）
  - MjProvider 新增 `submitBlend()`：按 openlux 文档发送 `{ botType, base64Array, dimensions }`，至少 2 张输入图，任务完成仍复用 `/mj/task/{id}/fetch` 轮询。
  - `dimensions` 按比例自动映射：`1:1→SQUARE`，横图→`LANDSCAPE`，竖图→`PORTRAIT`。
  - 语义规则引擎新增 `MJ blend` → `mj:image-edit`，`mj_blend` 进入可用模型目录。
- 测试：新增契约解析、provider body、输入图数量校验与 `MJ blend` 路由测试；全量 `547 passed`，`tsc` clean。

## [2.2.0] - 2026-08-03

### 重构（端点能力识别：语义规则引擎）

**不再穷举硬编码端点名 → 端点名由语义规则自动分类**（解决"内置端点表是否必须硬编码"的根因）。

- **语义规则引擎**（routes.ts）：端点名按语义识别（阻断 / 协议+能力），openlux 实测 18 种图像端点全量分类正确：
  - 阻断：video / recognition / upload / template / 未接入契约的 MJ 操作 / Kling（含 omni-image）
  - mj：`mj想象模式` / `MJ imagine` → mj:text-to-image
  - gemini：`gemini` → text-to-image + image-to-image
  - openai 编辑语义：`edit` / `编辑` / `修图` / `ps` 等 → image-edit
  - openai 生成语义：`generation` / `dall-e` / `绘图` / `绘画` 等 → text-to-image
- **能力判定复用同一语义规则**（capability.ts）：删除独立端点集合，消除两套逻辑漂移。
- **normalizer 不再叠加 capability 推导**：推导把协议写死 openai 会产生 mj/gemini 伪 openai 路由；空端点模型 fail-closed。
- **endpointAliases 保留为最高优先级**：用户显式覆盖先于语义规则判定。
- **效果**：
  - gpt-image 全系（1/1-mini/1.5/2/2-c）图生图/合成图路由正确（英文 `OpenAI image edit` 自动识别）
  - mj_imagine 不再依赖手动 endpointAliases 配置（英文 `MJ imagine` 直接识别）
  - 未来新端点名（如 `image edit 2`、`dall-e-4`）自动识别，无需改代码
  - 全目录从 118 → 38 个可用图像模型（之前 capability 推导把大量非契约端点误判为可用）
- 测试：+13 个语义规则用例（18 种真实端点全量 + 变体鲁棒性 + alias 优先级），542 全绿。

## [2.1.2] - 2026-08-03

### 修复

- **gpt-image 系列图生图/合成图能力误判**：new-api 站点对 gpt-image-2/gpt-image-1.5/gpt-image-1/gpt-image-2-c/gpt-image-1-mini 声明 `supported_endpoint_types` 为 `["OpenAI image edit", "image-generation"]`（英文端点名），但路由表只识别中文 `openai-编辑`/`openai编辑图片`，导致这些模型被误判为"仅支持文生图"，`图生图`/`合成图` 命令报 `MissingCatalogRouteError`。
  - 路由表补齐英文端点名：`openai image edit` / `images/edit` / `images/edits` / `images-edits` / `image-edits` / `edit` → `image-edit`。
  - capability 判定表同步补齐（保持 hasOpenai/hasEdit 一致）。
  - 实测验证：openlux gpt-image-2 `/v1/images/edits` 单图（图生图）与多图（合成图）均返回 200；目录刷新后 5 个 gpt-image 模型获得 `image-edit` 路由。
  - 合成图（compose-image）与图生图同契约（`normalizeOperation` 归一为 image-edit），走同一 `/v1/images/edits` 接口。

## [2.1.1] - 2026-08-03

### 修复

- **图生图/合图命令遇到模型能力不支持时给出友好提示**：此前 `图生图 -gpt`（gpt-image-2 仅支持文生图）会抛出 `MissingCatalogRouteError` 裸堆栈；现在转成中文提示（"模型 gpt-image-2 不支持图生图（image-edit）"，并提示换模型或改用文生图命令）。文生图/图生图/合图/风格四条命令路径统一处理。

## [2.1.0] - 2026-08-03

### 清理（废弃 UI 与字段）

- **移除模型映射「倍率」列**（aka-tools 面板）：`mapping.groupRatio` 不再展示可编辑入口。倍率已由 `/api/pricing` 动态 group_ratio 表 + `x-routing-group` 响应头自动结算，手动倍率仅作为三级回退最末端（基本永不命中）。schema 字段保留用于旧配置反序列化兼容。
- **移除 yunwu/gptgod 供应商 UI 兼容分支**：aka-tools 面板凭证区只保留 `newapi`（NewAPI API Key / Base URL）。旧供应商仅剩反序列化兼容。
- **migration 清理遗留字段**：`dailyFreeCredits`、`modelCostProbes`、`yunwuCreditToRmb` 在启动迁移时自动删除。
- **运行态 settings.json 已清理**：3 个废弃字段（dailyFreeCredits/modelCostProbes/yunwuCreditToRmb）已移除，`supplierCreditToRmb: 0.5`、`creditsPerCny: 10`、`pricingMarkupPercent` 保留不变。

## [2.0.0] - 2026-08-02

### 修复（计费精确性）

- **per-token 计费公式对齐 new-api 权威结算**：移除无依据的 `tokenRatio × 5` fallback，改为 new-api `text_quota.go` 分支 A 的权威公式——`quota = (prompt + completion × completionRatio) × model_ratio × group_ratio`，`供应商积分 = quota / 500000`（= 美元口径）。
  - provider 层新增捕获 `usage.input_tokens` / `output_tokens`（OpenAI images API 实测返回 `input_tokens: 9, output_tokens: 4380` 这类拆分），结算时精确计算 prompt + completion×ratio，不再用 total_tokens 粗估。
  - 无 input/output 拆分时按 `total × completionRatio` 保守估算（补全 token 通常占大头，保证不低估）。
- **预扣上界充足化**：per-token 预扣改用 `DEFAULT_TOKEN_ESTIMATE × (1+completionRatio) × tokenRatio / 500000 × 上界倍率`（假定全部为补全 token），保证预扣 ≥ 任何实际路由成本，余额不足直接拒绝。
- **修复 `actualCost=0` 误回退预扣**：`UserManager.settleReservation` 中真实成本为 0（极小成本 round 后为 0）时不再回退到预授权估算，而是按真实成本结算（多退少补精确生效）。
- 实测校准：gpt-image-1.5 单张（9 input + 4380 output tokens, Codex-Gpt-2 分组）真实成本 ≈ 0.00825 美元 ≈ 0.056 元 ≈ 0.56 平台积分；gpt-image-2 类似量级。此前 ×5 fallback 会高估数倍。

### 改进

- **动态倍率定价（E2）**：计费不再依赖用户手配的固定 `mapping.groupRatio`（默认 1），改为从 `/api/pricing` 的 `group_ratio` 表动态取倍率。
  - **预扣用上界**：`computeUpperBoundSupplierCredits` 取该模型 `enable_groups` 中最大的 group_ratio（`model_price × max(enable_groups 倍率)`），保证预扣 ≥ 任何实际路由成本 → 余额不足直接拒绝（防滥用，且随资费调整自动更新，非硬编码）。
  - **结算用实际路由**：provider 捕获响应头 `x-routing-group`（openai/mj submit），`computeActualSupplierCredits` 按实际分组倍率结算，多退少补；分组不在表中回退 `default` → mapping 固定值 → 1。
  - 新增 `src/catalog/pricing-snapshot.ts`：`/api/pricing` 实时拉取 + 60s 进程内缓存（TTL 可配），供后续结算/预扣复用最新倍率。
  - `settlement-audit` 日志新增 `routingGroup` / `groupRatio` / `inputTokens` / `outputTokens` 字段，可追溯每次生成的实际路由分组与倍率。
  - 实机验证：真实生成捕获 `x-routing-group: Doubao-1`；预扣 0.0735 ≥ 结算 0.0074 供应商积分，动态倍率闭环成立。

### 重构

- **new-api 通用适配器（yunwu → newapi）**：把云雾专属适配层泛化为 new-api 系中转站通用适配器，换站（任何 new-api 兼容站）只改 `openaiCompatibleApiBase` + `openaiCompatibleApiKey`，不再依赖代码。方案见 `plans/aka-ai-image-generator-newapi-adapter.md`。
  - `src/suppliers/newapi/` 替代 `src/suppliers/yunwu/`：端点路径可配置（models/pricing/usage/subscription + usageQuery），endpoint 名称映射「默认表 + 配置覆盖」。
  - 新增 `supplierEndpoints` / `endpointAliases` / `supplierCreditToRmb` 配置项（均带默认值，隐藏于设置页）。
  - `activeSupplier` 旧值 `yunwu`/`gptgod` 自动迁移为 `newapi`（migration + schema 兼容旧值反序列化）。
  - 契约层 `yunwu.*` → `newapi.*`（运行时生成，无持久化依赖）；`mapSupplierToContract` 保留旧值兼容输入。
  - 移除站点硬编码：默认 apiBase 不再指向 yunwu.ai；汇率默认 0.5 可配置。
  - probe 脚本 `probe-yunwu-catalog.mjs` → `probe-newapi-catalog.mjs`（`NEWAPI_API_BASE`/`NEWAPI_API_KEY`）。
- **实机验证（openlux）**：模型目录 118 可用（此前 35），`mj_imagine` 通过 `endpointAliases: {"MJ imagine": {protocol:"mj", capability:"text-to-image"}}` 进入可用列表；billing usage 无参返回 200 已兼容。

### 改进

- **设置页改为顶部分页式**：与视频生成页同款信息架构与页头（`el-radio-group` 分段 tabs + 刷新/保存全部按钮）。原 ①–⑤ 手风琴长页拆分为 7 个 tab：总览、供应商、模型目录、模型映射、预设、定价、运营（含生成默认值）。模型目录与模型映射相互独立（与视频页划分一致），添加映射后不再挤占目录空间；表单类 tab 限宽 900px 居中，表格类 tab 全宽。
- **总览页用量统计**：对齐视频页的统计预览能力。新增 console 监听器 `image-generator/get-overview-stats` 与纯聚合模块 `console/overview-stats.ts`；总览页展示 8 张用量统计卡（总用户 / 累计请求 / 累计生成 / 累计失败 / 成功率 / 累计消耗积分 / 购买余额总计 / 试用已用）、全量模型用量表（生成张数 + 占比）和用户用量排行表（Top 20：生成 / 请求 / 失败 / 消耗积分 / 购买余额 / 试用 / 最近使用）。原“模型排行”折叠卡由新统计区取代（`get-model-ranking` 监听器保留兼容）。
- **页面宽度收敛**：内容区不再左右占满——页头与主体 `max-width: 1320px` 居中，页面右侧预留 4.5rem 给浮动工具条（保存/切换插件按钮），与视频页规则一致；视频页同步应用相同宽度规则。

## 1.3.8 - 2026-07-30

依赖式参数引导:OpenAI 契约「分辨率 × 比例」组合级约束在交互层消失。方案见 `plans/aka-ai-image-generator-dependent-resolution-params.md`。

### 新增

- **向导「先选分辨率 → 再收窄比例」两步参数流**:多等级 OpenAI 契约(如 gpt-image-2:1K 有 1:1/3:2/2:3,4K 才有 16:9/9:16)选定模型后先进入分辨率选择页,选定后按比例可用集合收窄——非法组合(如 1K + 9:16)在交互层直接消失,不再在输入后才报错。收窄幂等重算,支持「上一步」反复进出(参数页/确认页均回分辨率页);确认页补充展示已选分辨率。gpt-image-1(单等级)、Gemini / MJ(参数相互独立)、未知模型(无契约)保持原单页行为。

### 改进

- **组合错误文案列出可用组合**:`resolveOpenAiSize` 组合 miss 时输出「1K 可用比例:1:1、3:2、2:3｜9:16 可用于:4K」,高级模式经 rejected 参数错误自动获得可操作提示;新增 `availableResolutionLevels` / `availableAspectRatios` / `levelsForAspectRatio` 契约辅助函数。

### 测试

- 新增 `tests/wizard/wizard-dependent-resolution.test.ts`(7 例:逐级收窄/跳过默认/上一步导航/幂等重选/完整链路),`openai-size.test.ts` 补 5 例(新文案 + 辅助函数),`wizard-contract-params.test.ts` 2 例改写为依赖流。`pnpm test` 506 全绿,`typecheck` / `build` 通过。

## 1.3.7 - 2026-07-30

上游错误透出修复（生产排障盲区收口）。分析与方案见 `plans/aka-ai-image-generator-sticker-error-surfacing.md`。

### 修复

- **供应商 HTTP 错误不再只剩 statusText**：`normalizeProviderError` 现在从错误响应体提取供应商原始错误信息（兼容 new-api/OpenAI 的 `error.message`、扁平 `message`/`msg`、纯文本），脱敏截断后并入 `ProviderError.message`——例如云雾 403 从干巴巴的「Forbidden」变为「Forbidden｜当前分组 xxx 无可用渠道」这类可操作信息，直接呈现在「生成失败 - 原因」中。
- **internal: 图片下载失败保留状态码**：`downloadImageAsBase64` 对 Koishi internal 协议下载失败提取上游 HTTP 状态码（如飞书资源 500），外层不再用「下载图片失败，请检查图片链接是否有效」笼统文案吞掉详细错误。
- **「所有输入图片下载失败」聚合错误带首个失败原因**：openai / gemini / midjourney 三个 provider 在全部输入图下载失败时，把首个具体失败原因附在错误后（如「｜无法获取飞书/Lark 图片资源(HTTP 500)，可能是表情包等飞书不开放下载的资源或资源已失效」）。

### 背景

- 生产环境实测确认：飞书「获取消息中的资源文件」API **不支持表情包资源下载**（官方文档明确），自定义表情（msg_type=sticker）经适配器解码为 img 元素后，图生图下载阶段必现上游 500。贴纸转图像的可行性探测与适配器侧配合改动见上述计划文档，待探测结果后实施。
- 适配器侧（`koishi-plugin-aka-adapter-lark` 0.4.2）新增 internal 路由上游错误日志，生产可直接看到飞书返回的真实错误体。

### 测试

- 新增 `tests/providers/errors.test.ts`（11 例：上游信息提取 7 例 + 归一化透出 4 例）、`tests/providers/download-utils.test.ts`（2 例）。`pnpm test` 494 全绿，`typecheck` / `build` 通过。

## 1.3.6 - 2026-07-30

计费兼容性修复与旧用户数据迁移。分析与方案见 `plans/aka-ai-image-generator-billing-compat-migration.md`。

### 修复

- **有购买余额的用户被「模型不在免费列表」误拦**：`checkFreeTrialForModel()` 改为异步且余额感知——豁免用户（管理员/永久会员/免计费平台）与有 `purchasedCredits` 余额的用户放行任意模型，最终扣费仍由 `reserveCredits()` 原子完成；无余额用户仍仅放行 `freeTrialModelId` 每日免费模型；余额读取失败按无余额处理，不崩溃。5 处命令层调用点（文生图/图生图/合成图/style 命令 + 向导选模型）同步改为 `await`。
- **旧版（积分制）用户数据迁移层**：`UserManager.normalizeStore` 加载时对每个用户幂等执行 `normalizeBalanceShape`——`purchasedCredits`/`totalGrantedCredits` 等积分字段同名无损继承；缺失的 `trialImagesUsed`/`trialDate` 补全；旧 `dailyResetDate === 当天` 且 `dailyFreeCreditsUsed > 0` 时当天免费额度视为已用完（保守，不重复赠送）；`trialDate` 继承旧 `dailyResetDate`。顶层格式非 schemaVersion 2 时日志告警（原文件仍有 .backup 备份），不再静默重置。
- **`getTrialRemaining` NaN 防御**：`trialImagesUsed` 缺失/非数值按 0 处理，消除部分写入记录导致试用判断静默失效的分支。

### 测试

- 新增 `tests/services/billing-compat.test.ts`（11 例：余额感知 5 例 + 迁移 6 例，含幂等性与平铺格式告警）。`pnpm test` 481 全绿，`typecheck` / `build` 通过。

### 验收注意

- 本地 lark 默认在 `freePlatforms` 中会绕过全部计费检查，验收计费场景需临时把 lark 移出 `freePlatforms`。

## 1.3.5 - 2026-07-30

向导契约感知参数过滤：引导过程中就按所选模型的契约收窄可选参数。方案见 `plans/aka-ai-image-generator-wizard-contract-params.md`。

- aka-tools 集成完成：图像页「视频生成设置」按钮跳转 `/aka-tools-video`，视频页已独立实现完整 aka-tools 浮动工具条。视频插件同时暴露 Koishi 左侧导航「视频生成」入口。

### 变更

- **不可用参数不再显示**：新增 `src/contracts/wizard-params.ts` 的 `filterParamsForContract()`，选定模型后按契约收窄参数定义——OpenAI 按 `fixedByResolutionAndAspect` 过滤分辨率等级与宽高比（如 gpt-image-1 只剩 1K + 1:1，gpt-image-2 不再显示 4:3），`supportsN=false`（如 gpt-image-2-c）移除「生成张数」；Gemini 按 `imageSizes`/`aspectRatios` 过滤，`imageConfig.enabled=false`（编辑契约）或不发送 `imageSize`（云雾 2.5）时移除对应参数；MJ 按 `aspectRatios`/`supportsStylize` 过滤并收窄 stylize 范围。过滤后默认值不再合法时替换为首个可选项，保证「跳过」必为合法组合。无契约的未知模型保守展示协议全集。
- **非法组合即时报错**：OpenAI 的「分辨率 × 比例」组合冲突（如 1K + 16:9 无固定 size）单选项过滤排除不掉，`handleParamSelect` 输入时即用 `resolveOpenAiSize` 试算，非法立即提示「参数组合不被当前模型接受｜…请重新输入」，停留参数步骤重选，不再等确认生成时才失败。
- 向导参数页、确认页、「上一步」回退渲染统一使用过滤后的参数定义（`WizardSession.paramDefs`）。

### 测试

- 新增 `tests/contracts/wizard-params.test.ts`（10 例，基于 registry 真实契约）与 `tests/wizard/wizard-contract-params.test.ts`（4 例向导链路）。`pnpm test` 470 全绿，`typecheck` / `build` 通过。

## 1.3.4 - 2026-07-30

按用户明确决策回退 1.3.3 的向导会话频道隔离：恢复「跟账户走」语义。

### 变更

- **向导会话键恢复为用户级（platform:userId）**：每个用户全局有且仅有一条图像生成链路——跨群/私聊共享同一条向导，用户在任何频道发消息都会驱动这唯一的向导，重复发起报冲突，「取消」全局生效。设计意图：避免同一账户并发发起多条生成链路、防止频繁调用。1.3.3 的 `platform:channelId:userId` 频道隔离为错误方向，已回退。
- 保留 1.3.3 的超时修复（Bug 3.3）：每步超时由 `apiTimeout` 驱动、超时后第一次发消息提醒一次并放行。

### 测试

- `tests/wizard/wizard-session-scope.test.ts` 改写为用户级语义（跨频道共享唯一向导、B 频道消息驱动同一向导、重复发起冲突、取消全局生效）。`pnpm test` 456 全绿，`typecheck` / `build` 通过。

## 1.3.3 - 2026-07-30

向导会话收口（第三批），诊断与实施记录见 `plans/aka-ai-image-generator-i2i-flow-bugfix.md`。至此该计划内 Bug 1-7 全部修复。

### 修复

- **向导会话键（Bug 3.4，已于 1.3.4 回退）**：1.3.3 曾将会话键改为 `platform:channelId:userId` 做频道隔离；用户明确设计决策为「跟账户走」（每用户全局唯一链路），1.3.4 已回退为用户级键。
- **向导每步超时与配置不一致（Bug 3.3）**：`WizardSessionManager` 超时由配置驱动（`apiTimeout`，与编排器等待提示同源），替代硬编码 120s；超时回收后用户下一次发消息时会收到一次「之前的生成向导已超时退出，请重新发起指令」提醒，且该消息正常放行（新指令不被吞），不再静默落空。

### 测试

- 新增 `tests/wizard/wizard-session-scope.test.ts`（6 例：跨频道隔离、同频道冲突保护、按频道取消、配置驱动超时、超时提醒仅一次且消息放行、未超时不提醒）。`pnpm test` 456 全绿，`typecheck` / `build` 通过。

## 1.3.2 - 2026-07-30

合成图链路修复（引导向导 + 高级模式），诊断与实施记录见 `plans/aka-ai-image-generator-i2i-flow-bugfix.md`。

### 修复

- **合成图 guided 模式错走文生图向导（Bug 4）**：`WizardSession.mode` 与向导入口支持 `compose-image`；`合成图` 命令（及 compose-image 模式的 style 命令）进入向导后跨消息累计 2-8 张图片、再收合成描述，确认页显示「模式 · 合成图 / 图片 · N 张」，确认后走 `executeComposeImage`，不再错走文生图；confirm 步骤收到图片时按合成语义追加（最多 8 张）并提示「已更新图片（当前 N 张）」。
- **合成图同条消息/引用图片被忽略（Bug 6）**：`ImageGenerationOrchestrator.collectComposeInput` 重写——先合并向导预收集图片（`initialImages`）、命令同条消息图片与引用图片（去重，上限 8 张），≥2 张且有描述时直接生成，不再要求用户重发；不足时按进度提示（「已收到 N 张，合成至少需要 2 张」）后进入等待循环。`executeComposeImage` 新增 `options.includeQuote / initialImages`，向导确认路径传 `includeQuote: false`。
- **补图等待对非图消息静默空转（Bug 7）**：图生图补图循环收到贴纸/表情/语音等既无图又无文字的消息时，反馈「未检测到图片，还需 1 张图片；回复『取消』中止」后继续等待，不再无响应空转。

### 测试

- 新增 `tests/wizard/wizard-compose.test.ts`（3 例）；`tests/orchestrators/image-input-collection.test.ts` 补充 Bug 7 反馈用例与合成图收集 5 例。`pnpm test` 450 全绿，`typecheck` / `build` 通过。

### 已知残留（后续批次）

- 向导每步超时 120s 与提示文案不一致、向导会话键仅 `userId`（第三批，后续小版本）。

## 1.3.1 - 2026-07-30

图生图流程修复（引导向导 + 高级模式），诊断与实施记录见 `plans/aka-ai-image-generator-i2i-flow-bugfix.md`。

### 修复

- **向导确认后误报「请在 240 秒内发送 1 张图片」**：图片 URL 采集层只接受 `http`/`data:` 字符串，Lark 默认入站图（`internal:` 协议）在向导「确认」传给编排器时被静默丢弃。新增 `src/utils/input.ts` 的 `isSupportedImageUrl()`，统一接受 `http/https/data:/internal:/file:/base64://`，与下载层 `downloadImageAsBase64()` 能力对齐；`collectImagesFromParamAndQuote`、`wizard-handler`、`utils/parser` 三处统一改用。
- **高级/直连模式不支持"先命令后图"**：删除 `commands/image.ts` 中"同一条消息必须附带图片"的提前拒绝，无图时统一进入编排器的等待补图流程（方案 A，与用户对齐），与 style 命令行为一致。
- **等待补图/补描述期间新指令被 `session.prompt` 吞掉**：`ImageGenerationOrchestrator` 新增 `waitUserInput()`，基于 `session.prompt(callback)` 语义——检测到可解析的新指令时放行给指令系统并静默结束收集；收到「取消」明确中止；文生图/图生图/合成图三个收集函数全部改用，等待提示统一补充「回复『取消』中止」。
- **向导杂项**：图生图带图无描述的提示从「请发送画面描述」修正为「请输入修改描述」；model-select / param-select / confirm 步骤收到图片时更新图片并重新渲染（此前静默吞掉）；`executeImageToImage` 新增 `options.includeQuote`，向导确认路径传 `false`，防止「确认」消息引用的无关图片混入。

### 测试

- 新增 `tests/utils/input.test.ts`、`tests/wizard/wizard-i2i-confirm.test.ts`、`tests/orchestrators/image-input-collection.test.ts`；`tests/commands/image-command-routing.test.ts` 补充无图直连 2 例。`pnpm test` 441 全绿，`typecheck` / `build` 通过。

### 已知残留（后续批次）

- 合成图 guided 模式错走文生图向导、合成图同条消息图片被忽略、补图等待对非图消息静默空转（第二批）。
- 向导每步超时 120s 与提示文案不一致、向导会话键仅 `userId`（后续小版本）。

## 1.2.7 - 2026-07-29

本轮从 `1.2.3` 起进行了四次迭代（`1.2.4 → 1.2.5 → 1.2.6 → 1.2.7`），四次迭代均在同一天完成、未逐版单独发布，统一以 `1.2.7` 打包。四次迭代的真实边界如下。

### 1.2.4 — auto/advanced 直接意图与五入口共享参数补全

- 新增 `src/shared/direct-intent.ts` 的 `detectDirectIntent`，配置驱动地识别本次消息是否包含直接命令语法：任一已配置 `modelMappings.suffix` 被 `parseStyleCommandModifiers` 解析成功、任一参数修饰符（预设分辨率 `-1k/-2k/-4k`、自定义分辨率 `-数字x数字`、比例 `-1:1/-4:3/-16:9/-9:16/-3:2/-2:3`、`-add`），或存在有效 `-n <数字>`。命中即视为直接生成意图，`auto` 模式下跳过向导；`advanced` 保持始终直接生成；`guided` 保持始终强制向导。动态新增的 mapping 后缀立即生效，不硬编码模型名。
- 新增协议参数规范化 + 缺失值自动补全的公共层：`src/shared/protocol-param-resolver.ts` 与 `src/shared/generation-setup.ts`。所有五个入口（命令 `文生图`/`图生图`/`合成图`、Prompt/style 快捷命令、交互向导、ChatLuna bridge、YesImBot bridge）共享同一份 `buildProtocolRequestContext`：用户显式值优先；只传 `-1k` 自动补 `1:1`，只传 `-16:9` 自动补默认分辨率；未指定尺寸参数时按协议默认补齐；未知协议保守不盲补也不阻止请求。
- MJ 协议的 `ar` / `stylize` 在公共层统一转成 `--ar` / `--stylize` prompt 后缀，并对 `--ar` / `--stylize` / `--s` 做去重；`ImageRequestContext` 新增可选 `promptAppends`。
- 兼容性回归：`PROTOCOL_PARAMS` 的 openai / gemini / mj `aspectRatio`（含 MJ `ar` prompt flag）补齐 `3:2` / `2:3`，与 `parser.ts` 的 `validAspectRatios`、provider `ASPECT_RATIO_SIZE_MAP` 归入同一事实源。
- 核心 `文生图` / `图生图` / style 命令补齐 `-n <num>` 选项声明（此前仅 `合成图`）。修复 style 命令未把 `wizardHandler` 透传到 `registerStyleCommands` 的旧遗漏；guided 对 style 命令也真正生效。

### 1.2.5 — contractId + operation 精细契约层与 fail-closed 路由

- 将“协议默认”升级为“供应商 + 协议 + 操作 + 模型”四元组精确契约。新增 `src/contracts/`：`types.ts`、`registry.ts`、`param-resolver.ts`、`openai-size.ts`。当前注册的契约覆盖：yunwu OpenAI GPT Image 1 / 2 / 2-c create、GPT Image 2 edit（multipart-first）、yunwu Gemini 2.5 / 3 Pro 生成与编辑、Gemini 官方 create / edit、yunwu MJ Imagine（文生图 + 参考图两个 id）、OpenAI 官方 create / edit。
- `src/contracts/openai-size.ts` 完整实现 GPT Image 2 固定 size 表 + 自定义尺寸规则（≤3840、16 倍数、长短边比 ≤3:1、总像素 655 360..8 294 400）；`-2k` / `-4k` 现在真正改变请求 `size`；`4:3` 无对应固定 size 时 fail-closed，不再偷偷降级为 3:2。
- `src/service/model-route-selection.ts` 引入 `operation` 参数；`src/index.ts` 中 `service.catalogRouteLookup` 按 `operation` 精确匹配 route，禁止继续固定取 `routes[0]`。图生图 fallback 到 text-to-image（MJ Imagine 图生图同 endpoint + `base64Array`）。
- `AiImageGeneratorService.buildGenerationSetup / requestProviderImages` 均按 operation 定位契约，找不到契约时 fail-closed 抛错。契约 id 通过 `ImageRequestContext.contractId` 透传到 provider。
- Provider 全面重写为契约驱动：
  - `providers/midjourney.ts` 严格按官方 Imagine Body 发送 `botType + prompt`，可选 `base64Array/notifyHook/state`；**删除**旧实现里非契约的 `model` 与 `imageUrl` 字段。参考图统一为 data URL 放入 `base64Array`；输入图全部下载失败 → fail-closed，不退化为文生图；非 Imagine 契约 id → 拒绝。
  - `providers/openai.ts` 编辑直接走 multipart `/v1/images/edits`（不再先发 JSON 再回退）；`size` 由契约层 param-resolver 决定；`quality/format/background/moderation` 仅在契约声明枚举时才发送；不支持 n 的契约（如 `gpt-image-2-c`）逐张调用；响应解析同时兼容 `data[].url` / `data[].b64_json` / `usage.total_tokens`；忽略 Apifox 中被误填成 Chat Completions 的 response schema。
  - `providers/gemini.ts` 拆分云雾与官方方言：云雾 2.5 生成契约不发送 `imageSize`；云雾 3 Pro 生成契约发送大写 `1K/2K/4K`；云雾编辑契约不发送 `imageConfig`，只发送 `responseModalities`；`response_format=url` 仅在云雾契约允许时携带；官方 Gemini 移除未经验证的 `LOW/MEDIUM` 映射，改为契约声明的大写 `1K/2K/4K`；图生图输入全部下载失败 → fail-closed。响应解析新增顶层 `data[].url` / `b64_json`（云雾 URL 扩展）。
- catalog fail-closed 修复：`src/suppliers/yunwu/capability.ts` 增加 `图像识别 / 上传 / 视频 / 模板` 以及非 Imagine MJ / Kling endpoint 的 `NON_GENERATION_PATTERNS`；`src/suppliers/yunwu/routes.ts` 仅保留有契约支持的 endpoint（当前仅 `mj想象模式`）；`normalizer.ts` 把上述 reason 视为阻断，模型进入 `unsupported`。修复此前 4 个 catalog 测试失败。
- 入口统一透传 operation：命令入口 `文生图 / 图生图 / 合成图 / style` 分别以 `text-to-image / image-edit / compose-image` 调用；`wizard-handler.ts` 通过 `service.resolveContractForMapping` 定位契约；`bridge/chatluna/tool-runtime.ts` 与 `bridge/yesimbot/tool-runtime.ts` 的 `buildRequestContextAndCost` 全部新增 operation 参数。五类入口共享同一契约选择结果。

### 1.2.6 — contract 参数分层、拒绝语义与 route 可达性防御

- `src/shared/generation-setup.ts` 明确产出 `contractFields`、`defaults`、`rejectedParams`，命中契约时精确记录哪些字段来自用户显式值、哪些是契约默认、哪些被契约拒绝（例：`quality=low` 传给未声明 quality 的契约）。
- `ContractRejectedParamsError` 在五入口的计费预授权与 provider 调用之前拦截并 fail-closed，避免把不被支持的参数偷偷丢弃。
- route 可达性防御：service 层在解析 contract 前先按 `operation` 校验模型是否存在匹配 route；找不到时明确抛错并区分“模型未在 catalog / 无对应 operation route / 无对应契约”三类失败路径。
- 契约层与五入口测试进一步收口：`tests/contracts/registry.test.ts` / `openai-size.test.ts` / `param-resolver.test.ts`、`tests/providers/midjourney.test.ts` / `openai-contract.test.ts` / `gemini-contract.test.ts`、`tests/shared/generation-setup-contract.test.ts`、`tests/commands/image-command-routing.test.ts` 覆盖：contract-driven 分支写入 `requestContext` 与被拒参数、OpenAI 固定 / 自定义 size、Gemini 云雾 / 官方分流、MJ 最小 Body 与 ar/stylize 去重、`4:3` 不错配、Imagine SUCCESS/FAILURE、`base64Array` 参考图与下载失败 fail-closed、多入口 auto/guided/advanced 路由。发布前 `pnpm test` 将重新运行完整套件。

### 1.2.7 — 修复动态模型后缀 / 控制参数污染最终 prompt（本次真实实测发布点）

- 真实实测定位到 MJ 文生图 `parameter error` 的根因：Koishi `[prompt:text]` 会保留未识别 option（例如动态模型后缀 `-mj`、`-16:9`、`-2k`、自定义 `-1024x1024`、`-add`、`-n <数字>`），命令入口把这段“未剥离控制语法”的原始文本作为 prompt 发给 provider，导致 MJ 服务端解析成非法参数。此前一度怀疑是服务端自动追加 `--stylize` 引发的重复 flag，被真实日志与本轮 `1.2.5` 的去重路径证伪。
- 修复：新增 `src/utils/parser.ts` 中的 `stripImageCommandControls(prompt, modelMappingIndex)`，按当前 `modelMappings` 索引 + 预设分辨率/比例/`-add`/`-n` 集合识别控制 token 并从 prompt 剥离。命令入口（`文生图 / 图生图 / 合成图` 及 style 快捷命令）与向导内联路径统一在计费预授权与 provider 调用前调用 strip，得到干净 prompt 再进入契约层。
- 实测结果：
  - Midjourney `文生图 <描述> -mj -16:9` 返回 `SUCCESS`，异步任务 `finalPrompt` 中不再残留 `-mj`；此前的 `parameter error` 已消除。
  - OpenAI GPT Image 2 `文生图 <描述> -<gpt 后缀> -2k`（走 yunwu 官方契约 `/v1/images/generations`）返回图像，`size` 由契约层 param-resolver 决定，`-2k` 真正生效。
  - 后续多轮 style 预设、参考图、`-add` 组合实测由 Kari 完成，反馈“一切正常”。
- 日志脱敏保持不变：不记录完整 prompt / base64 / API key；只记录 `supplier / modelId / routeId / contractId / operation / 请求字段名列表 / HTTP 状态`，taskId 仅内部关联。

### 仍需真实探针继续观察（非阻断）

- 云雾 MJ 服务端是否在特定 botType / 帐户下自动追加 `--stylize/--relax/--v`；本次真实文生图未观察到该现象，也未观察到重复 flag，但样本量有限，作为观察项保留。
- 云雾 GPT Image 1 页面 schema 与 example 的字段矛盾（size / model），本轮以契约层 fail-closed 兜底，不当作默认路径。
- 云雾 Gemini 请求鉴权当前仍走 query `?key=`，是否可仅用 Authorization 未验证。
- Gemini 官方 `imageSize` 是否所有模型都接受大写 `1K/2K/4K`，本轮 fail-closed 保守列出。
- OpenAI 官方 GPT Image 编辑响应结构（Apifox 已知误填）仍以真实响应为准。

### 未实现范围（目录级 fail-closed）

- MJ Action / Blend / Describe / Modal / Upload、Kling 生图 / 多图生图 / 扩图、omni-image、图像识别 —— 相关模型进入 `unsupported`，后续按需拆分独立契约再放行。

### 文档

- `README.md` 全面重写以匹配 v1.2.7 现状（契约驱动 routing、参数补全、`ContractRejectedParamsError` fail-closed、auto/guided/advanced、per-platform override、`freePlatforms`、模型排行、`图像充值` 人民币语义、ChatLuna / YesImBot 桥接、控制后缀不进入最终 prompt）。
- `ROADMAP.md` 将本轮从 Next 移入 Completed milestone，Next 聚焦未实现契约（MJ Action / Kling / omni-image / 图像识别）。
- `docs/midjourney-plan.md` 状态改为已实现并完成 v1.2.7 真实文生图验证；根因结论更新为“控制后缀污染最终 prompt”，此前对服务端 stylize 追加的怀疑不再作为主根因。
- `docs/official-image-contract-investigation-and-repair-plan.md` 状态改为 v1.2.7 release-ready，Kari 手工验收已完成；MJ / OpenAI GPT Image 2 真实文生图成功证据入档，不泄露具体 prompt / 用户 / taskId。

## 1.2.3

- 控制台配置页新增「模型排行」折叠面板，默认收起并位于页面底部，展开时按需拉取聚合统计。
  - 展示插件调用次数（所有用户 `totalGenerationRequests` 累加）、总生成张数（所有用户 `totalImagesGenerated` 累加）、按模型统计的生成张数与占比表格，以及使用最多的模型。
  - 无数据时提示「暂无数据，生成图片后将自动统计。」，不展示价格 / 积分 / 计费信息。
- 用户统计（`UserStatisticsV2`）新增 `modelUsageCounts: Record<string, number>`，`recordUsageOnly` 和 `settleReservation`（付费 / 试用路径）成功记录一次生成时按 `modelId` 累加，`getUserData` / `settleReservation` 均通过 `ensureStatisticsShape` 为旧数据回填空对象，保持向后兼容。
- 新增 `UserManager.getModelUsageStats()`、`AiImageGeneratorService.getModelUsageStats()` 和 console API `image-generator/get-model-ranking`，用于返回聚合结果。
- `ImageGenerationOrchestrator.runGeneration` 在免计费与付费两条落地路径均把 `modelId` 传给 `recordUsageOnly` / `settleReservation`，确保排行数据完整。
- 新增 `tests/model-ranking.test.ts` 覆盖：空数据零值、按模型累计、多用户聚合、Top 模型判断、无 `modelUsageCounts` 的旧账户读取与迁移。

## 1.2.2

- 免计费平台（`freePlatforms`）真正跳过积分与试用通道：命令入口、向导流程、ChatLuna / YesImBot 桥接工具在命中时全部绕过 `reserveCredits`、`settleReservation`、`checkFreeTrialForModel` 与试用额度写入，只保留限流与模型访问控制。
  - 新增 `service.isFreePlatform(platform)` 与 `service.recordUsageOnly(userId, userName, commandName, numImages)`：后者只累加 `totalImagesGenerated` / `totalGenerationRequests`，不动积分账本、试用日次数或预授权。
  - 免计费平台生成完成后仅回复图片数量，剥离积分 / 试用 / 余额 / 消耗等文案；向导渲染模型列表与确认页时同步省略成本 / 异步标签。
  - 免计费平台异常路径不再调用 `releaseReservation`，避免为空预授权触发日志噪音。
- 统一入口的限流拦截：`ImageGenerationOrchestrator.runGeneration` 及两个桥接工具运行时都在锁前调用 `userManager.checkRateLimit`，包括免计费平台用户，防止各调用点漏加。
- 向导会话（`WizardSession`）新增 `platform` 字段并在 `startWizardSession` 中记录，保证多步渲染中的免计费判断稳定。
- `commands/image.ts` 与 `wizard/wizard-handler.ts` 中所有 `checkFreeTrialForModel` 调用均在免计费平台下跳过，避免无谓的错误提示。
- 新增 `tests/free-platform.test.ts` 覆盖：`isFreePlatform` 真值表、`recordUsageOnly` 增量与账本零副作用、限流仍生效、受限模型仍受 `checkModelAccess` 拒绝、`checkFreeTrialForModel` 平台豁免。
- 新增 `tests/rate-limit.test.ts` 覆盖：窗口内允许 N 次 / 阻止 N+1 次、窗口滑动后恢复放行、不同用户计数隔离。

## 1.2.1

- 新增 `interactionModeOverrides` 配置：按 `session.platform` 覆盖全局 `interactionMode`，未列出的平台仍使用全局设置。
  - 使用场景：飞书私聊需要走高级直接出图、QQ 群保留自动切换等平台差异化交互策略。
  - 前端 aka-tools 面板「生成默认值 → 交互模式」下方新增紧凑的「按平台覆盖交互模式」键值编辑器（平台 ID + auto/guided/advanced 下拉 + 删除按钮 + 添加按钮）。
  - 后端 `resolveInteractionMode(mode, overrides, session)` 增加平台优先级：`overrides[session.platform]` 命中时以覆盖值为准，否则回退到全局 `mode`。
- 修复 `isGroupChat` 在飞书私聊中被误判为群聊的问题：判断优先级改为 `session.isDirect === true → 私聊`、`isDirect === false → 群聊`，再回退到 `guildId` / `channelId !== userId`。
- 新增 `tests/shared/interaction-mode.test.ts`：覆盖 `isGroupChat` 各类会话状态与 `resolveInteractionMode` 平台覆盖 / 全局兜底路径。
- `图像参数` 命令显示当前平台覆盖列表，帮助管理员核对配置。

## 1.2.0

- 新增 `interactionMode` 配置（auto / guided / advanced），默认 auto：
  - auto：群聊自动进入高级模式直接出图，私聊自动进入引导模式分步选择。
  - guided：文生图 / 图生图 / 合成图 / style 快捷命令始终进入向导。
  - advanced：所有命令始终跳过向导，无参数时使用默认值直接生成。
- 命令入口（文生图 / 图生图 / 合成图 / style 快捷命令）按交互模式分流，高级模式直接使用默认模型、默认数量、默认比例生成。
- 前端 aka-tools 配置页「生成默认值」分组增加「交互模式」下拉选择。
- `图像参数` 命令与 `setupGuide` 文案同步更新，说明三种模式行为。
- 前端 aka-tools 面板保存配置前校验当前供应商对应 API Key：未填写时弹警告并阻止保存，避免用户保存后调用 API 才报 `Unauthorized`。
- 修复 `client/normalize.ts` 读取 `providerSettings` 下 API Key 字段路径错误的问题，刷新页面后 key 不再显示为空。

## 1.1.0

- 删除全局 `yunwuGroupRatio` / `yunwuGroup` 配置入口，避免全局倍率与模型映射计费语义冲突。
- `modelMappings` 每条模型映射新增独立 `groupRatio`，默认 1；前端模型映射表支持逐项编辑倍率，并缩窄列宽避免水平滚动。
- 预扣费、生成后结算、console 目录成本展示均改为按映射级 `groupRatio` 计算。
- 配置迁移会把旧全局倍率下沉到缺失倍率的模型映射，并移除旧全局字段。
- 新增运营页「每日免费试用模型」下拉：从模型映射 `modelId` 动态列表中只能单选一个模型；空值时禁用每日免费。
- 试用额度预检逻辑改为：仅当目标模型 `modelId` 等于管理员选定的 `freeTrialModelId` 时才走每日免费通道；否则普通用户（非管理员/永久会员/免计费平台）需使用已购积分。
- 命令入口（文生图/图生图/合成图/快捷 style 命令）和向导模型选择阶段均增加每日免费模型二次校验，未开放免费的模型在普通用户选择时即时拒绝。
- `setupGuide` 和 `图像参数` 帮助文案同步更新，明确每日免费仅限管理员指定的单个模型。
- 新增 `interactionMode` 配置（auto/guided/advanced），控制命令入口交互模式：
  - auto：群聊跳过向导直接出图，私聊分步引导。
  - guided：文生图/图生图/合成图/style 快捷命令始终进入向导选择模型与参数。
  - advanced：所有命令始终跳过向导，使用默认值直接生成。
- 前端 aka-tools 面板业务运行参数增加 `interactionMode` 下拉选择。
- `图像参数` 命令和 `setupGuide` 文案同步更新，说明三种交互模式行为。
- 新增 `src/shared/interaction-mode.ts`：导出 `resolveInteractionMode` 和 `isGroupChat` 函数。

## 1.0.3

- 模型选择向导：数据源从供应商刷新出的全量目录改为配置页 `modelMappings`（管理员维护的可选模型白名单），与经典命令模式（`-模型后缀`）统一为同一份事实源；显示改为映射 `suffix`，不再显示 catalog modelId/description。
- 受限模型（`restricted: true`）在向导模型列表中对非白名单/非管理员直接过滤，不再列出后选中才拒绝；`model-select` 与 `confirm` 两步均做权限二次校验，防止绕过选择环节直接生成。
- 修复向导路径重新对 `session.content` 分词导致命令词与 `-16:9`/`-1k` 等 flag 混入最终 prompt 的问题：向导 `handleCommand` 现在复用 argv 已解析的 `[prompt:text]` 与 `parseStyleCommandModifiers`，flag 单独存入 `preResolution`/`preAspectRatio`/`preCustomAdditions`，在确认阶段并入请求参数而不污染描述文字。
- Prompt 预设（style 快捷命令）在已配置默认模型（`modelSuffix` 能解析到 `modelMappings` 条目）时跳过多步向导，保持一步直出图；未配置默认模型的预设仍进入向导选模型。
- 向导会话超时从"整体 6 分钟绝对倒计时（`startedAt` 只设置一次）"改为"每步 2 分钟相对刷新"：新增 `lastActivityAt` 字段，中间件收到向导相关消息即 `touch()` 刷新计时。
- 向导模型选择、参数选择两处文案去除多余介绍语，参数选择改为每个可选项独立成行展示，避免选项挤在一行不易区分。
- 修复 `图像充值` 命令的单位语义错误：管理员输入的数值现在被解释为人民币金额，按配置 `creditsPerCny`（1 元 = N 平台积分）自动折算为平台积分后再入账/调整；此前该数值被直接当作积分数使用。命令回复精简为仅显示折算后的积分数值与合计可用余额。
- `setupGuide` 中“图像充值”用法说明同步更新为“人民币金额”，避免管理员误判单位。
- 修复 `openai.ts` 供应商请求路径重复拼接 `/v1`（`apiBase` 本身可能已含 `/v1`）导致的 `/v1/v1/images/...` 错误路径。
- console 静态资源入口解析（`resolvePackagePath`）改为按 `node_modules/<pkg>/<subPath>` 字符串路径查找而非 `require.resolve`/`__dirname`，修复 npm link 软链安装场景下 Koishi console 静态资源守卫 403、客户端 bundle 不加载的问题。

## 0.9.0

- Add the maintained Yunwu catalog, pricing, configuration migration, and JSON settings-store implementation.
- Pin Vitest to the Vite 5 compatible major used by the Koishi console toolchain.
- Declare the `element-plus` client build dependency required by the aka-tools console page.

## 0.9.1

- Koishi 原插件配置页仅保留全局超时、目录刷新间隔和日志级别；其他业务配置统一收敛到 aka-tools。
- aka-tools 补齐额外请求头、余额展示、安全策略、ChatLuna 上下文、Prompt 分组和命令速查等配置。
- 供应商区“yunwu 分组”改为“yunwu 分组倍率”浮点输入；旧字符串配置在有 groupRatio 时按名称映射为倍率，映射失败回退 1。
- 模型目录表格删除“成本报价”和“运营收费”两列，view-model 同步移除相关字段与运算，只保留模型、yunwu 成本、模式、计价。
- 新增管理员专用“费用探测”按钮（authority 4）：点击后直接真实调用一次生成，不弹二级确认窗口；以刷新前后平台积分差 × 0.5 得到人民币成本，明确无法取得增量时报告；不返回图片、脱敏错误、不写入用户流水。
- 归一化 yunwu billing：新增 `platformCredits` 字段（保留 `totalUsageUsd` 同值别名做缓存兼容）；面板与命令统一按平台积分展示，并注明 1 平台积分 = ¥0.5。
- “积分与运营”面板重新分区：A 用户积分规则 / B 自动定价换算 / C 人民币经营参考 / D 生成结果展示 / E 请求限流；所有标签与说明明确输入/输出含义。
- 从面板与 Schema 移除 `yunwuCreditToRmb` 运营字段，固定为约定值 0.5，interface 字段保留仅用于旧配置读取兼容。
- 费用探测内部保留微小真实用量差精度，避免正差值被误判为 0；面板、模型计价、命令输出和日志统一显示两位小数。
- 费用探测将“生成结果”和“费用同步”分开判定：模型生成成功即报告探测成功；用量接口未更新时提示实际扣费尚未同步，不再误报探测失败或展示 ¥0.00 作为实际费用。
- aka-tools Prompt 相关配置合并为单一“Prompt 预设”管理卡片，并放置在模型映射之后、定价设置之前：分组仅作为后台分类容器，聊天命令仍以每个预设自己的 commandName 直接调用，不再生成分组父命令，也不改变运行时 `collectStyleDefinitions` 行为。
- 未分组预设固定作为第一块，绑定顶层 `cfg.styles`；其它分组以可折叠容器展示，组内预设与未分组预设共用同一结构化表单（命令名 / 生成模式 / 模型后缀 / 帮助说明 / 提示词），并可通过“移动到”下拉在分组之间迁移。
- 删除“预设 JSON”文本域及 `formatStyleGroupPrompts` / `updateStyleGroupPrompts`、“旧版分组快捷命令”等错误文案；删除非空分组时组内预设自动移至未分组并给出 ElMessage 提示，避免静默丢失；分组重命名保留全部预设，空名和重名会被拒绝并提示。
- `normalizeConfig` 强化对 `styleGroups` 的防御：非对象 / 数组值全部丢弃，`prompts` 非数组视为空数组，每个预设深拷贝为独立对象，避免面板 v-model 反向改动远端引用；后端持久化格式保持不变。

## 0.9.0

### Added

- Yunwu 专用 raw client、脱敏契约 fixture、fail-closed capability/route normalizer 和只读 `npm run probe:yunwu`。
- Key/base scope 隔离的原子 Catalog 缓存，支持 temp + fsync + rename、完整备份恢复、stale 标记和刷新间隔热更新。
- 显式模型收费策略：`fixed`、`cost-plus`、`disabled`；目录价格、成本报价、运营收费分层展示。
- 真实积分预授权：生成前冻结，按实际交付图片 settle，失败 release；支持并发防超卖、幂等、持久化、重启恢复和过期 hold 自动释放。
- aka-tools 后端 view-model；unsupported 模型单独展示且不可选择。

### Changed

- Yunwu 是当前唯一完整维护供应商；其他供应商入口标记为暂未适配，不再假装共享同一目录契约。
- 生成协议只由供应商 endpoint route 决定，不再按模型名包含 `gemini` 猜测。
- 空模型映射、缺失 route、未知价格和无法计算的 per-token 价格全部 fail-closed。
- ChatLuna、YesImBot 和普通命令统一使用 reserve → settle/release 计费链路。
- 配置升级时，旧 `creditCostPerImage` 迁移为 fixed；明确 per-call 目录价迁移为 cost-plus；未知价格映射迁移为 disabled。

### Removed

- 具体默认模型、全局默认每张积分运行回退、2000-token / `$2/M` / `0.004` 价格公式。
- 旧 `NewApiClient`、模型名/描述启发式 `isImageModel` / `inferModes`。
- 前端所有价格计算；页面只渲染后端视图模型。

### Migration

- 升级后必须至少配置一条有效模型映射，并显式选择收费策略。
- 旧模型映射不会自动删除；不可用或无法报价的映射会显示为失效/禁用。
- 旧用户数据和历史流水不重写；新增 `credit-reservations.v1.json` 保存活动预授权。
- 回滚前应备份插件目录和数据目录；0.8.x 不理解 0.9.0 的 `chargePolicy` 和 reservation 文件。

### Verification status

- 本地单元/契约测试、typecheck 和 build 已通过。
- 认证只读 probe、目标容器部署及真实文生图/图生图 smoke 必须在发布前完成并写入最终 verification 文档。

## 0.8.13

### Fixed

- 限频更新延迟到积分确认后才计入窗口，避免余额不足的失败请求消耗限频配额。
- 任务锁 TTL 上限以命令超时 + 120s 兜底，不再随 `apiTimeout` 配置线性增长。
- 新增 volatile 内存映射（`rateLimitMap`、`securityBlockMap`、`securityWarningMap`）每 5 分钟全局清理，防止内存泄漏。
- `session.userId` 缺失时拒绝执行并返回 "无法识别用户身份" 消息，不再使用 `unknown` 兜底。
- ChatLuna bridge `sendGeneratedImages()` 单张发送失败不影响后续图片发送，并返回成功发送的 URL 列表。
- `downloadImageAsBase64()` 新增魔数校验，拒绝非图片内容（如 HTML 错误页）被当作有效图片向后传递。

## 0.8.12

### Fixed

- 修复命令级超时后旧 Provider Promise 仍在后台完成并触发 `onImageGenerated`，导致用户下一次请求时收到上一轮图片的问题；超时或流程结束后会将本轮生成回调标记为失效，后续旧回调只记录诊断日志，不再发送图片或计费用量。

## 0.8.11

### Fixed

- 修复群聊中多人同时使用图像生成命令时，`开始生成`、`生成完成`、`生成失败`、内容安全拦截和扣费异常提示缺少用户归属的问题；群聊提示现在会以 `[用户名] 标题` 形式标识触发用户，私聊保持原有简洁输出。

## 0.8.9

### Fixed

- **ChatLuna / YesImBot 工具返回结果中 base64 图片数据导致上下文爆炸**：
  - 根因：`runGenerateImageTool`、`runEditImageTool`、`runStylePresetTool` 等工具在返回结果中直接包含 `images` 数组，当 Provider 返回 `data:image/...;base64,...` 内嵌格式时，整个 base64 字符串（单张图可达数十万 token）被 ChatLuna / YesImBot 作为工具结果写入 LLM 对话上下文，导致后续请求超过模型上限（131072 token）并进入无限重试。
  - 修复：在两个桥接的 `tool-runtime.ts` 中引入 `summarizeImageUrl(url)` 辅助函数，将 `data:` 开头的 base64 URL 替换为占位符 `[base64_image]`，仅保留远程 URL。工具结果中仍保留 `imagesCount` 和积分摘要，LLM 仍可感知生成数量与状态，但不会被图片数据撑爆上下文。
  - 影响范围：`plugins/aka-ai-image-generator/src/bridge/chatluna/tool-runtime.ts`（4 处返回） + `plugins/aka-ai-image-generator/src/bridge/yesimbot/tool-runtime.ts`（3 处返回）。

## 0.8.7

### Fixed

- **`showCreditCostInResult` 开关失效修复**：关闭"生成完成后显示本次消耗和剩余积分"后，生成图像仍会回复积分消耗信息。根因是 `ImageGenerationOrchestrator` 中使用 `config.showQuotaInImageCommands || config.showCreditCostInResult` 作为整体判断条件，`showQuotaInImageCommands`（默认 `true`，位于"运行与诊断"分组）会绕过用户对 `showCreditCostInResult` 的关闭。修复后 `showCreditCostInResult` 作为积分结果展示的总开关，关闭时不再显示任何积分相关结果消息；`showQuotaInImageCommands` 降级为子开关，仅在总开关开启时控制是否额外显示剩余积分明细。

## 0.8.6

### Fixed

- **ChatLuna 桥接工具注册时序修复**：修复 V2 中 ChatLuna 工具列表始终为空的问题。根因是 `index.ts` 中 `chatLunaBridgeManager.sync()` 在 `apply()` 阶段直接调用，此时 ChatLuna 服务尚未加载，导致 `enable()` 检测到 service 为 null 后直接返回且不再重试。V1 (`aka-ai-generator`) 使用了 `ctx.inject(['chatluna'], async (ctx) => { await chatLunaBridge.sync(...) })` 正确等待 ChatLuna 就绪。修复方式：将 V2 的直接 `sync()` 调用替换为相同的 `ctx.inject(['chatluna'], ...)` 延迟注册机制，同时在 `accept` 热重载 handler 中添加 `chatluna` 服务可用性检查。

## 0.8.5

### Changed

- **YesImBot 桥接完全重写：ExtensionService → ToolService**。0.8.0–0.8.4 版本错误地使用了 `"yesimbot.extension"`（`ExtensionService`），该服务仅存在于 YesImBot monorepo 的 core 中，npm 发布的 `koishi-plugin-yesimbot@3.x` 根本不包含此服务。正确路径是 `"yesimbot.tool"`（`ToolService`），与 sticker-manager 使用完全相同的注册方式。
  - **root cause**：npm 版 yesimbot 只有 `ToolService`（`services/extension/service.js`），通过 `ctx["yesimbot.tool"].register(instance, enabled)` 注册扩展，`@Extension`/`@Tool` 装饰器也是基于 ToolService 构建的。LLM 工具调用链路为 `AgentCore → HeartbeatProcessor → toolService.invoke()`，`extension.list` 命令读取 `ToolService.extensions` Map。
  - **改造成果**：
    - [`runtime.ts`](plugins/aka-ai-image-generator/src/bridge/yesimbot/runtime.ts) — 类型从 AI SDK 格式替换为 ToolService 格式（`ToolServiceLike`、`ExtensionInstanceLike`、`ToolDefinitionForToolService`、`ToolExecuteResult`）
    - [`tool-definitions.ts`](plugins/aka-ai-image-generator/src/bridge/yesimbot/tool-definitions.ts) — 工具参数从 Zod `inputSchemaBuilder` → Koishi `Schema` 对象
    - [`tool-runtime.ts`](plugins/aka-ai-image-generator/src/bridge/yesimbot/tool-runtime.ts) — execute 签名从 `(params, context) → ToolResultPart[]` → `({ session, ...params }) → { status, result|error }`
    - [`tools.ts`](plugins/aka-ai-image-generator/src/bridge/yesimbot/tools.ts) — 从 `registerYesImBotTools(api)` → `createYesImBotExtensionInstance()` 工厂函数
    - [`manager.ts`](plugins/aka-ai-image-generator/src/bridge/yesimbot/manager.ts) — `getExtensionService()` → `getToolService()`，调用 `toolService.register(instance, true)`
    - [`index.ts`](plugins/aka-ai-image-generator/src/index.ts) — `inject.optional` 中 `'yesimbot.extension'` → `'yesimbot.tool'`
  - **删除不再需要的文件**：[`context-injection.ts`](plugins/aka-ai-image-generator/src/bridge/yesimbot/context-injection.ts)（ToolService 没有 `context:build` 事件系统）、[`types.ts`](plugins/aka-ai-image-generator/src/bridge/yesimbot/types.ts)（仅被 context-injection.ts 引用，成为死代码）。

### Removed

- **YesImBot 上下文注入功能移除**。ToolService 不支持 ExtensionService 的 `context:build` 事件机制，因此上下文注入（`[AIGC_CONTEXT]`）在本次重写中被移除。相关配置字段从 [`config.ts`](plugins/aka-ai-image-generator/src/shared/config.ts) 清理：`yesimbotContextInjectionEnabled`、`yesimbotContextHistorySize`、`yesimbotContextTtlSeconds`、`yesimbotPreferLastGeneratedInPrivateRoom`。

## 0.8.4

### Fixed

- **YesImBot 桥接服务访问修复**：修复 `getExtensionService()` 无法访问 `ctx["yesimbot.extension"]` 服务的问题。根因是 `inject.optional` 中缺少 `"yesimbot.extension"` 声明（之前只有 `"yesimbot"`），导致 Koishi Context Proxy 拦截了所有对该服务的访问路径。

## 0.8.0

### Added

- **YesImBot Bridge 集成**：插件现在可通过 `yesimbotEnabled` 配置开关启用 YesImBot 桥接，将图像生成能力注册为 YesImBot AI Agent 工具。与 ChatLuna 桥接相同，不安装 YesImBot 时插件仍可正常工作。
- **5 个 YesImBot 工具**：`aigc_generate_image`（文生图）、`aigc_edit_image`（图生图/编辑）、`aigc_apply_style_preset`（风格预设）、`aigc_get_quota`（积分查询）、`aigc_list_styles`（风格查询）。工具使用 AI SDK `jsonSchema()` 格式定义，与 YesImBot Extension API 完全适配。
- **YesImBot 上下文注入**：在 `context:build` 事件中注入 `[AIGC_CONTEXT]`，包含最近生成的图像引用和风格候选推荐，与 ChatLuna 桥接共享 `ConversationImageContext` 数据。
- **新增配置项**：`yesimbotEnabled`、`yesimbotContextInjectionEnabled`、`yesimbotExposeQuotaTool`、`yesimbotExposeStyleListTool`、`yesimbotContextHistorySize`、`yesimbotContextTtlSeconds`、`yesimbotPreferLastGeneratedInPrivateRoom`。所有配置在 Koishi Console 中分组于 "🤖 YesImBot 集成" 折叠抽屉中。
- **配置热重载兼容**：YesImBot 桥接状态随 Koishi 配置热重载自动同步（enable/disable），无需外部重启。
- **可选依赖模式**：通过运行时检测 `ctx["yesimbot.extension"]` 和动态加载 `@yesimbot/agent/ai` 模块，不引入编译期依赖。

### Changed

- `index.ts` 启动日志新增 `yesimbot` 状态字段（enabled/disabled）。

## 0.7.0

### Fixed

- **ChatLuna 热重载工具刷新**：修复 `sync()` 在已启用时跳过重新注册的问题。管理员通过 Koishi Console 重载配置后新增的 style 预设现在会正确注册为 ChatLuna 动态工具（`aigc_style_{name}`），无需外部重启。

### Added

- **ChatLuna 桥接集成**：插件现在声明 ChatLuna 为可选依赖（`inject: { optional: ['chatluna'] }`），在 Koishi Console 中提供 `chatlunaEnabled` 开关控制是否启用桥接。
- **5 个基础 ChatLuna 工具**：`aigc_generate_image`（文生图）、`aigc_edit_image`（图生图/编辑）、`aigc_apply_style_preset`（风格预设匹配）、`aigc_get_quota`（积分查询）、`aigc_list_styles`（风格列表）。
- **动态风格工具**：每个已配置的 style 自动注册为独立 ChatLuna 工具（`aigc_style_{name}`），支持 ChatLuna 模型直接按名称或语义匹配调用预设风格。
- **ChatLuna 上下文注入**：在 `chatluna/before-chat` 时注入 `[AIGC_CONTEXT]`（上一张图像引用）和 `[AIGC_STYLE_CANDIDATES]`（风格候选推荐），在 `chatluna/clear-chat-history` 时清除对应会话的图像上下文。
- **积分制 API 适配**：所有 ChatLuna 工具调用完全适配 V2 积分计费体系（`calculateGenerationCost`、`checkAndReserveQuota`、`scaleGenerationCost`、`recordUsage`），返回 `creditSummary` 供 ChatLuna 展示。
- **新增配置项**：`chatlunaEnabled`、`chatlunaContextInjectionEnabled`、`chatlunaExposeQuotaTool`、`chatlunaExposeStyleListTool`、`chatlunaContextHistorySize`、`chatlunaContextTtlSeconds`、`chatlunaPreferLastGeneratedInPrivateRoom`。
- **配置热重载兼容**：ChatLuna 桥接状态随 Koishi 配置热重载自动同步（enable/disable），无需外部重启。

### Changed

- `index.ts` 启动日志新增 `chatluna` 状态字段（enabled/disabled）。

## 0.6.3

### Changed

- 删除固定命令 `图像额度`，由 `图像查询` 无参数模式接管用户自助积分余额查询。
- 删除固定命令 `图像扣除`，管理员余额变动统一收敛到 `图像充值`；输入负数积分时作为余额修正处理。
- `图像查询` 支持普通用户查自己、管理员 `@用户` 查别人；普通用户查询他人会被权限拒绝。
- `图像账单` 支持普通用户查自己的最近流水、管理员 `@用户` 查别人、管理员 `--all` 查全局流水。
- Koishi Console 设置页顶部的只读说明扩展为命令速查，直接展示首次配置顺序、普通用户命令、管理员命令、常用参数和权限规则。

## 0.6.2

### Fixed

- 管理员执行 `图像扣除` 时区分全额扣除、部分扣除和余额不足未扣除，避免实际扣除为 0 时仍显示普通完成。
- 管理员、永久会员或豁免平台用户首次记录生成统计时使用当前配置初始化用户积分快照，保持 `dailyFreeCredits` 展示一致。

## 0.6.1

### Changed

- 模型映射配置移除上游成本和定价备注字段，仅保留用户侧每张积分单价，降低设置页噪音。
- `creditCostPerImage`、`defaultCreditCostPerImage`、`dailyFreeCredits`、`creditsPerCny`、`minRechargeCredits` 改为支持小数输入，积分仍按两位小数归一化。

## 0.6.0

### Added

- 新增积分制计费：生成前按预计张数与模型单价预检积分，生成完成后按成功发送图片数扣费。
- 新增用户数据 v2：使用 `users.v2.json` 保存每日免费积分、已购积分、累计充值、累计消耗和生成统计。
- 新增积分流水账本：`credit-ledger.v2.jsonl` 记录充值、消费、调整等事件，`recharge-records.v2.jsonl` 记录管理员充值审计。
- 模型映射新增 `creditCostPerImage` 字段，支持按模型设置每张图积分单价，积分支持小数。
- 新增管理员命令 `图像充值 @用户 积分 [原因]`、`图像扣除 @用户 积分 [原因]`、`图像账单 [@用户] [-n 数量]`。

### Changed

- `图像额度`、`图像查询`、`图像排行榜` 和生成完成提示从“次数配额”改为“积分余额 / 历史消耗 / 已生成张数”。
- Koishi Console 配置分组调整为管理员运营、用户豁免与白名单、积分计费与限流、运行与诊断，降低 `0.6.0` 计费配置混杂度。
- 管理员、永久会员和 `unlimitedPlatforms` 平台继续跳过扣费与限流，但只记录生成统计；模型白名单仍只控制受限模型访问，不代表免费。

### Migration Note

- `0.6.0` 第一版使用新的 v2 积分文件，不会直接改写旧次数制数据；升级后建议先配置 `dailyFreeCredits`、`defaultCreditCostPerImage` 与模型单价，再通过管理员充值命令给需要的用户补充已购积分。
- 发布前请重点远端验证扣费、部分成功扣费、管理员充值 / 扣除 / 查账和 `unlimitedPlatforms` 豁免行为。

## 0.5.23

### Fixed

- 最终生成失败、未返回图片和内容安全拦截提示改为显式发送到聊天窗口，不再依赖 Koishi command action 的返回值自动回复。
- 保持中间重试、FormData fallback 等兼容性警告仅记录日志，避免把可恢复过程误提示给用户。

## 0.5.22

### Changed

- 精简 Koishi Console 模型映射与 Prompt 预设表格列标题，减少多行换行。
- 模型映射列标题调整为 `命令名`、`模型 ID`、`供应商`、`接口格式`、`限制项`。
- Prompt 预设列标题调整为 `命令名`、`生成模式`、`生成模型`、`帮助说明`、`提示词`。

## 0.5.21

### Changed

- 将日志级别显示文案从普通 / 调试改为 `simple` / `detail`，降低配置语义歧义。
- 新增日志级别归一化工具，兼容旧配置值 `info` / `debug`，其中 `debug` 会映射为 `detail`。
- `simple` 仅保留关键流程日志；`detail` 额外输出脱敏请求诊断，包括请求 URL、模型、尺寸、超时、headers 摘要和请求体摘要。
- OpenAI 请求体诊断不再记录 prompt 预览，仅保留 prompt 长度和图片载荷摘要，降低调试日志泄露用户提示词的风险。

## 0.5.20

### Changed

- 将参数帮助命令从 `参数指令` 改名为 `图像参数`，与 `图像指令` 保持统一的图像命令命名前缀。
- `图像参数` 输出标题同步改名，`图像指令` 末尾的参数入口提示会指向新命令名。

## 0.5.19

### Changed

- 统一润色聊天可见输出文案，额度、查询、排行榜、输入引导、生成状态、完成提示、权限拒绝和失败提示改为更规整的短标题与一行式条目格式。
- `图像额度`、`图像查询`、`图像排行榜` 输出增加明确标题，并统一使用 `字段｜内容` / `用户｜总 X｜今日 Y｜剩余 Z` 的紧凑格式。
- 额度不足、模型受限、内容安全拦截、生成失败和等待超时提示改为先给结果，再给原因或下一步建议。

## 0.5.18

### Changed

- 重写 `图像指令` 输出为紧凑分区格式：仅展示核心生成命令和当前 `styles` / `styleGroups` 快捷命令。
- `图像指令` 不再展示 prompt 分组、默认模型、模型后缀映射、查询命令、帮助命令或管理命令，降低聊天窗口信息噪声。
- 重写 `参数指令` 输出为通用参数、尺寸、比例、受限模型分区；受限模型只列出 `restricted = true` 的模型后缀与真实模型 ID。

## 0.5.17

### Added

- 新增 Koishi Console 配置页顶部只读初始化说明，引导首次配置顺序：供应商凭证、模型映射、快捷命令。
- 初始化说明补充核心概念边界：供应商决定凭证，协议决定请求格式，模型映射第一条为默认模型，`styles` / `styleGroups` 重载配置后自动刷新，永久会员不自动获得受限模型权限。

## 0.5.16

### Changed

- 调整 Koishi Console 配置页说明文案：字段描述适度补充用途、单位、默认行为和权限影响，避免过度简化导致用户误解。
- 继续保持下拉选项、表格列名和枚举显示文本极简，例如供应商仍显示第三方 / OpenAI / Gemini，模式仍显示文生图 / 图生图 / 合成图。
- 补充模型映射、Prompt 预设、styleGroups、权限、限流、安全策略和通用设置的说明，重点解释供应商与协议的分工、模型后缀引用、配置重载后快捷命令刷新、永久会员与受限模型权限边界。

## 0.5.15

### Fixed

- 修复 `styles` / `styleGroups` 动态快捷命令只在插件启动时注册，点击 Koishi Console 重载配置后新增命令仍不生效的问题。
- 配置热重载现在会在 `service.updateConfig(next)` 后注销旧 style 命令并按最新配置重新注册，避免刷新顺序读到旧配置。

### Changed

- `图像指令` 现在会展示当前配置中生效的 `styles` / `styleGroups` 快捷命令、所属分组、默认模式和默认模型后缀。

## 0.5.14

### Changed

- 精简 Koishi Console 供应商凭证与模型映射中的供应商显示名，只显示第三方 / OpenAI / Gemini。
- 本版本仅调整用户可见文案，内部配置值与运行时路由保持兼容不变。

## 0.5.13

### Changed

- 模型映射协议名称收敛为 `openai` / `gemini`，其中 `openai` 对应 OpenAI Images API 路径。
- 清理未使用的聊天补全图像通道，避免配置页、源码和当前文档继续暴露不使用的协议选项。
- Provider 注册、日志 provider 名称与默认模型路由同步使用 `openai`。

### Migration Note

- 升级后请在 Koishi Console 将 GPT / OpenAI Images API 模型映射的协议改为 `openai`。
- Gemini 官方或第三方 Gemini generateContent 模型继续使用 `gemini`。

## 0.5.12

### Fixed

- 修复上游生成请求失败、网络中断或命令级异常后，用户图像任务锁可能残留，导致后续请求仍提示“已有正在处理的任务”的问题。
- 图像任务锁新增 requestId 与过期时间，失败路径仍会按当前 requestId 释放；若进程内遗留锁超过 TTL，会在下一次任务检查时自动清理。

## 0.5.11

### Changed

- 精简 Koishi Console 配置页文案，将供应商、模型路由、Prompt 预设、权限、配额、安全和通用设置改为短标签。
- 本版本仅调整配置页显示文案，不改变运行时路由、命令行为或配置字段语义。

## 0.5.10

### Fixed

- 修复 `0.5.9` 模型映射只能选择运行时协议、无法显式选择供应商凭证入口的问题。
- 模型映射新增 `supplier` 与 `protocol` 语义：`supplier` 选择 `openai-compatible` / `gpt-official` / `gemini-official`，`protocol` 选择 OpenAI Images API 或 Gemini generateContent 协议。
- `gpt-official` 凭证现在可通过模型映射显式使用，并固定走 OpenAI 官方 Images API。
- 运行时改为按 `supplier` 取凭证、按 `protocol` 选择 Provider，避免 Gemini 官方、云雾 Gemini、GPT 官方、云雾 GPT 混在隐式 fallback 中。

### Migration Note

- `0.5.9` 中模型映射的 `provider` 字段在 `0.5.10` 起语义上改为 `protocol`；运行时仍兼容读取旧 `provider` 字段。
- 建议在 Koishi Console 重新检查每条模型映射，显式填写供应商与协议：
  - OpenAI 官方 GPT：`supplier = gpt-official`，`protocol = openai`。
  - 云雾 / 第三方 GPT Images：`supplier = openai-compatible`，`protocol = openai`。
  - 云雾 / 第三方 Gemini generateContent：`supplier = openai-compatible`，`protocol = gemini`。
  - Gemini 官方：`supplier = gemini-official`，`protocol = gemini`。

## 0.5.9

### Changed

- **配置架构重构：供应商与模型完全分离**
  - 删除 Koishi Console 全局 `provider` 单选控件；供应商仅保留凭证，不再包含 `modelId`。
  - 重命名供应商避免混淆：`openai-compatible`（第三方兼容站）、`gemini-official`（Gemini 官方）、`gpt-official`（OpenAI 官方 GPT）。
  - 模型统一在「模型映射」中配置：suffix + modelId + provider（OpenAI Images API 或 Gemini generateContent 协议）。该字段在 `0.5.10` 起改名为 `protocol`，并新增显式 `supplier`。
  - 系统默认使用 `modelMappings` 第一条作为默认模型；若未配置映射，则回退到内置默认值。
- **运行时凭证路由更新**
  - OpenAI Images API 通道读取 `openai-compatible` 凭证（apiKey + apiBase + extraHeaders）。
  - `gemini` 优先读取 `gemini-official` 凭证（apiKey，固定官方 base）；若未配置官方密钥，则 fallback 到 `openai-compatible` 的 base URL，以兼容云雾等第三方 Gemini 端点。
- **Gemini  provider imageSize 映射适配**
  - 官方端点继续使用 `LOW / MEDIUM / 4K`。
  - 非官方端点（如云雾）自动切换为 `1K / 2K / 4K` 数值格式。

### Removed

- 从供应商配置中移除所有 `modelId` 字段（`openaiCompatibleModelId`、`openaiOfficialModelId`、`geminiOfficialModelId`）。
- 移除旧版全局 `provider` 单选（`openai-official` 等值不再作为运行时路由依据）。

### Migration Note

- 从 `<= 0.5.8` 升级后，控制台中的 `provider` 选择和供应商级 `modelId` 设置不再生效。
- 请在 Koishi Console 重新配置：
  1. 「供应商凭证」中填写对应 apiKey（openai-compatible 还需填写 apiBase）。
  2. 「模型映射」中至少添加一条映射作为默认模型，并确保 `provider` 字段选择正确的运行时协议。

## 0.5.8

- 新增 `合成图 [-n 数量]`：命令后进入多图收集状态，支持一条消息一张图或一条消息多张图，收到 prompt 文字后才开始执行；`-n` 仅表示生成结果数量。
- 新增管理员只读命令 `图像查询 @用户` 与 `图像排行榜 [-n 数量]`，查询不存在的历史用户时不创建新用户数据，排行榜默认按总用量排序。
- `styles` prompt 预设新增默认模式与默认模型后缀，默认模式支持文生图、图生图和合成图，默认模型引用 `modelMappings.suffix`，显式命令模型后缀优先。
- 优化 Koishi Console 配置页布局：供应商、模型映射、Prompt 预设、管理员与权限、配额与限流、安全策略、通用设置分组展示，低频配置默认折叠。
- 保持 `风格迁移` 不作为独立硬编码命令；如需该能力，可由用户在 `styles` 中维护为 `compose-image` prompt 预设。

## 0.5.7

- 修复供应商详细设置在 Koishi Console 中没有真正折叠的问题：将供应商详细设置从顶层 `Schema.intersect` 分组改为顶层供应商分组内的嵌套对象，并对该嵌套对象应用 `.collapse()`。
- 服务层读取供应商配置时优先使用新的 `providerSettings` 嵌套字段，并保留 `0.5.6` 及更早版本 flat provider 字段的运行时 fallback，降低升级风险。
- 更新 README、ROADMAP 与阶段计划，将动态风格预设命令后移到后续 patch，避免与配置页 UI 修复混在一次发布中。

## 0.5.6

- 新增 `图像指令` 与 `参数指令`，用于展示当前真实支持的图像命令、参数、模型后缀和权限规则。
- 为 `文生图` 与 `图生图` 显式注册 `-n <num:number>`，命令层读取 `argv.options.num` 后将生成数量裁剪到 1-4，并用于后续额度预检和生成请求。
- 补齐 restricted 模型权限拦截：受限模型后缀仅管理员和模型白名单用户可用，永久会员不自动获得受限模型权限。
- 更新 README 与路线图，将当前版本状态、远端验证步骤和 `0.5.7` 动态风格命令边界对齐到实际代码。

## 0.5.5

- 将 OpenAI 兼容、OpenAI 官方、Gemini 官方三类供应商详细配置合并到一个默认收起的 `供应商详细设置` 抽屉中，避免配置页平铺过长。
- 保留顶层供应商选择项独立展示，继续使用稳定对象分组，避免重新引入 tagged union 渲染不稳定问题。

## 0.5.4

- 增强 OpenAI / OpenAI-compatible 调用链路的脱敏诊断日志，debug 模式下输出实际请求 URL、模型、尺寸、超时、密钥配置状态和脱敏请求摘要。
- 增强 Provider 错误归一化的上下文采集，记录脱敏后的 HTTP 状态、响应摘要、网络错误 code / errno / syscall / hostname / cause 等诊断字段。
- 修正生成请求入口日志中的 `modelId: default` 易误导问题，改为记录实际解析后的默认模型与模型来源。

## 0.5.3

- 清理当前阶段不应暴露的 ChatLuna 集成配置项，避免控制台出现尚未实现的兼容选项。
- 清理未实现命令族与后续阶段能力在运行时代码中的常量、提示和导出入口残留，当前阶段仅保留 `文生图`、`图生图`、`图像额度`。
- 图像上下文记忆保留为内部生成记录能力，不再通过 ChatLuna 配置控制。

## 0.5.2

- 修复 `0.5.1` 中供应商设置在 Koishi 控制台整体消失的问题。
- 将供应商配置 Schema 从顶层裸 `union` 调整为稳定展示的普通对象分组：供应商选择、OpenAI 兼容设置、OpenAI 官方设置、Gemini 官方设置。
- 修复模型映射覆盖运行时 Provider 时仍按顶层语义供应商读取凭证的问题，避免 不同图像协议 跨通道调用时使用错误密钥、模型或 base URL。

## 0.5.1

- 修复控制台选择 `openai-compatible` 后 OpenAI 兼容分支配置项未展开的问题。
- 将供应商配置 Schema 从“独立供应商字段 + union 分支”的交叉结构调整为单一 Tagged Union，避免 Koishi 控制台重复同名字段导致分支配置项不显示。
- 注意：该版本后续确认在部分 Koishi 控制台中会导致供应商设置整体不显示，已在 `0.5.2` 改为稳定对象分组结构。

## 0.5.0

- 重写控制台顶层供应商入口为语义化三选项：`openai-compatible`（OpenAI 兼容格式）、`openai-official`（OpenAI 官方）、`gemini-official`（Gemini 官方）。
- 将 OpenAI 兼容入口内部的接口格式明确拆分为 OpenAI Images API 与 Gemini generateContent。
- 服务层新增供应商语义到运行时 Provider 的路由映射：OpenAI 兼容按接口格式路由，OpenAI 官方固定路由到 OpenAI Images API，Gemini 官方固定路由到 `gemini`。
- 控制台数值配置改为数字输入，不再使用滑竿。
- 这是配置结构调整版本：从 `0.4.0` 升级时需要在控制台按新的三类供应商入口重新填写凭证、模型和 base URL。

## 0.4.0

- 重写控制台图像配置为协议优先模型，收敛图像协议通道配置。
- 移除历史第三方供应商顶层选项与 Provider 注册别名，第三方聚合站统一通过 OpenAI-compatible 的 `baseUrl + apiKey + model + extraHeaders` 配置。
- 重写服务层 Provider 路由，删除供应商标签到协议标签的兼容分支，模型映射直接指向协议 / 通道。
- 这是配置结构清理版本：从 `0.3.0` 升级时需要在控制台重新选择协议并填写对应通道的凭证与模型。

## 0.3.0

- 新增 OpenAI 兼容协议选择：OpenAI Images API 用于 GPT-image 类图像接口，Gemini generateContent 用于 Gemini 图像接口。
- 新增 OpenAI 兼容站点额外请求头配置，便于适配需要 `User-Agent` 等自定义请求头的第三方 API 站点。
- - 调整 MVP 命令为无前缀直呼格式：`文生图`、`图生图`、`图像额度`，保留 `t2i`、`i2i`、`quota` 别名。
- 修正 OpenAI Images API base URL 规范化，避免配置中包含 `/v1` 时重复拼接。

## 0.2.2

- 保持 V2 MVP 架构与基础图像命令可用。
