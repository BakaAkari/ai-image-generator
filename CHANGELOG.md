# Changelog

## Unreleased

- 暂无。

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
