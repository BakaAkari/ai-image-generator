# koishi-plugin-aka-ai-image-generator

[![npm](https://img.shields.io/npm/v/koishi-plugin-aka-ai-image-generator?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-aka-ai-image-generator)

自用 AI 图像生成插件 V2（image-only）。当前 `1.2.7` 版本以“供应商 + 协议 + 操作 + 模型”四元组精确契约为核心：yunwu 是唯一完整维护的目录 / 计价源，OpenAI 官方、Gemini 官方与 Midjourney（yunwu Imagine）已按 Apifox / 官方文档建契约；未接入契约的能力（MJ Action / Blend / Describe、Kling 多图 / 扩图、omni-image、图像识别）目录级 fail-closed。生成链路使用真实积分预授权 + 免计费平台绕过 + 每日免费 + 平台级交互模式路由，并提供 aka-tools 独立管理页面、ChatLuna 与 YesImBot 可选桥接、模型排行折叠面板。

> 范围：仅图像生成。aka-tools Console 页面已实现；视频生成不在当前运行时范围内。

## 当前版本状态

- 当前包版本：`1.2.7`。
- 当前稳定能力：yunwu 完整目录 / 计价 / route，OpenAI（yunwu + 官方）、Gemini（yunwu + 官方）、Midjourney（yunwu Imagine）契约精确到操作 / 模型；contract-driven 请求构建与参数补全；显式非法参数 fail-closed；auto / guided / advanced 三种交互模式 + `interactionModeOverrides` 平台覆盖；`freePlatforms` 免计费平台绕过积分与试用（保留限流）；单模型每日免费；模型级 `groupRatio` + `chargePolicy`；Prompt presets（styles / styleGroups）+ 动态命令热重载；ChatLuna 桥接（5 个基础工具 + 每 style 动态工具 + 上下文注入）；YesImBot 桥接（5 个 AI Agent 工具，通过 `yesimbot.tool` ToolService 注册）；模型排行折叠面板；`图像充值 @用户 人民币金额` 按 `creditsPerCny` 换算。
- 已实现契约覆盖：yunwu OpenAI GPT Image 1 / 2 / 2-c create、GPT Image 2 edit（multipart-first）、yunwu Gemini 2.5 生成、Gemini 3 Pro 生成 / 编辑、Gemini 官方 create / edit、yunwu MJ Imagine（文生图 + 参考图两个 id）、OpenAI 官方 create / edit。
- 目录级 fail-closed（未实现能力）：MJ Action / Blend / Describe / Modal / Upload、Kling 生图 / 多图生图 / 扩图、omni-image、图像识别。相关模型进入 `unsupported`，不会被路由到 provider。
- 后续路线图：见 `ROADMAP.md`。

## 支持的供应商入口 / 模型路由

- `openai-compatible`（yunwu 等第三方兼容站）：当前唯一完整维护的目录 / 计价源。目录从 `/v1/models` + `/api/pricing` 获取，协议 route 仅按 `supported_endpoint_types`；契约由 `src/contracts/registry.ts` 精确注册到具体 endpoint + operation。
- `gpt-official`（OpenAI 官方 GPT）：目录不由 yunwu 维护，按已注册的 OpenAI 官方 create / edit 契约执行；未在契约中声明的字段不发送。
- `gemini-official`（Google Gemini 官方）：按 Gemini 官方 create / edit 契约执行；不复用云雾 `response_format` 扩展；`imageSize` 使用大写 `1K/2K/4K`（当前对全模型保守 fail-closed 相同枚举）。

每条模型映射包含：

- `suffix`：聊天命令和 preset 使用的模型后缀（例如 `mj` / `gpt42` / `gemini25`）。
- `modelId`：必须存在于当前 Key scope 的可执行目录。
- `restricted`：是否需要管理员或模型白名单。
- `groupRatio`：每映射独立倍率，默认 1；用于结算 `platformCredits × groupRatio`。

系统没有具体默认模型。第一条有效映射是默认映射；空映射、缺少 endpoint route 或未匹配契约都会明确拒绝生成。

## 核心机制

### Contract-driven 请求构建

- Catalog route 决定协议（openai / gemini / mj），`service.catalogRouteLookup(modelId, operation)` 按 `text-to-image / image-edit / compose-image` 精确匹配 route；不再固定取 `routes[0]`。
- 契约 id（如 `yunwu.openai.gpt-image-2.generate`、`yunwu.mj.imagine`、`gemini.official.edit`）通过 `ImageRequestContext.contractId` 透传到 provider；provider 只发送契约声明的字段。
- 找不到契约立即 fail-closed，不会退化到旧 `PROTOCOL_PARAMS`。

### 参数补全 vs 拒绝

- 用户显式值优先；缺失可选参数按契约默认补齐：仅传 `-1k` 补 `1:1`，仅传 `-16:9` 补默认清晰度，未指定尺寸参数补齐契约全部默认。
- **控制后缀不会进入最终 prompt**：`src/utils/parser.ts::stripImageCommandControls` 按当前 `modelMappings` 索引 + 预设分辨率 / 比例 / `-add` / `-n` 集合从 `[prompt:text]` 中剥离控制 token；命令入口与向导内联路径都在计费预授权与 provider 调用前完成 strip。`文生图 一只猫 -mj -16:9` 只把“一只猫”交给 MJ Imagine，不会导致服务端返回 `parameter error`。
- 显式无效或契约不支持的参数不静默丢弃：抛出 `ContractRejectedParamsError`，五入口（命令、style、wizard、ChatLuna、YesImBot）在计费预授权之前拦截并 fail-closed，用户看到明确原因。

### 协议差异（简要摘要，完整字段以 `src/contracts/` 与 Apifox / 官方文档为准）

- **Midjourney（yunwu.mj.imagine）**：`POST /mj/submit/imagine`，Body 严格为 `{ botType: 'MID_JOURNEY', prompt, base64Array?, notifyHook?, state? }`；`--ar` / `--stylize` 由公共层作为 `promptAppends` 拼接到 prompt 尾部并去重，不再发送非契约的 `model` 或 `imageUrl`。参考图先下载为 data URL 塞入 `base64Array`；全部下载失败 → fail-closed，不退化为文生图。任务通过 `GET /mj/task/{taskId}/fetch` 轮询，识别 `SUCCESS/FAILURE` + `failReason/description`。
- **OpenAI Images API（yunwu + 官方）**：`POST /v1/images/generations` JSON 创建、`POST /v1/images/edits` multipart-first 编辑（不再先发 JSON 再回退）；`size` 由 `src/contracts/openai-size.ts` 按 `resolution + aspectRatio + 模型` 精确计算，自定义尺寸校验 ≤3840、16 倍数、长短边比 ≤3:1、总像素 655 360..8 294 400；`-2k` / `-4k` 真正改变请求 `size`；`4:3` 无对应固定 size 时 fail-closed；`quality/format/background/moderation` 仅在契约声明枚举时才发送；`gpt-image-2-c` 明确不支持 `n`，走逐张调用。响应解析同时兼容 `data[].url / data[].b64_json / usage.total_tokens`。
- **Gemini generateContent（yunwu 2.5 / 3 Pro / 编辑 + 官方）**：`POST /v1beta/models/{model}:generateContent`；云雾 2.5 生成不发 `imageSize`，云雾 3 Pro 生成发 `1K/2K/4K` 大写，云雾编辑不发 `imageConfig`（只发 `responseModalities`）；云雾扩展 `response_format=url` 仅在云雾契约允许时携带；官方 Gemini 移除未经验证的 `LOW/MEDIUM` 映射；图生图输入全部下载失败 → fail-closed。响应解析覆盖 `inlineData` / 顶层 `data[].url` / `b64_json` / `usageMetadata`。

## 命令

命令统一采用无前缀直呼格式，不使用 `aig.` 前缀。

| 命令 | 别名 | 说明 |
| --- | --- | --- |
| `文生图 [prompt]` | `t2i` | 纯文字描述生成图片 |
| `图生图 [img] [prompt]` | `i2i` | 单张图片 + 修改描述 |
| `合成图 [-n 数量]` | `compose-image` | 命令后收集多张图片，收到 prompt 文字后开始合成 |
| `图像查询 [@用户]` | - | 无 @ 时查询自己的积分余额和生成统计；管理员可 @用户 查询他人 |
| `图像账单 [@用户] [-n 数量]` | - | 无 @ 时查询自己的最近流水；管理员可 @用户 查询他人 |
| `图像账单 --all [-n 数量]` | - | 管理员查看全局最近积分流水 |
| `图像充值 @用户 <人民币金额> [原因]` | - | 管理员按 `creditsPerCny` 折算为平台积分入账；金额为负数时作为余额修正 |
| `图像排行榜 [-n 数量]` | - | 管理员查看用户生成 / 消耗排行 |
| `图像指令` | - | 查看核心生成命令和当前快捷命令 |
| `图像参数` | - | 查看通用参数、尺寸、比例和受限模型后缀 |
| `styles` / `styleGroups` 动态命令 | - | 配置页维护的 prompt 预设，可选择文生图 / 图生图 / 合成图模式与默认模型后缀；重载配置后自动重新注册 |

当前基础修饰符：

- `-n <数量>`：一次生成图片数量，产品上限 1-4；未填写时使用 `defaultNumImages`。
- `-1k` / `-2k` / `-4k`：预设分辨率；命中契约的 `resolution` 声明时真正影响 `size`。
- `-1024x1024`：自定义分辨率；OpenAI 契约会校验合法性，不合法直接 fail-closed。
- `-1:1` / `-4:3` / `-16:9` / `-9:16` / `-3:2` / `-2:3`：画幅比例。
- `-add <补充要求>`：追加生成要求。
- `-<模型后缀>`：切换到 `modelMappings` 中的映射；后缀由 `stripImageCommandControls` 从最终 prompt 中剥离。

命令示例：

```
文生图 一只猫 -mj                # 走 MJ Imagine 契约，final prompt 只有“一只猫”
文生图 一座城市 -16:9 -2k         # OpenAI 契约按比例+2K 计算 size
图生图 <图片> 改成赛博朋克风格 -gemini25
文生图 -add 暖色灯光 一间书房
```

## 交互模式

- `interactionMode`（auto / guided / advanced）默认 `auto`。
  - `auto`：命令包含直接语法（已配置模型后缀、`-1k/-2k/-4k`、自定义 `-数字x数字`、比例、`-add` 或有效 `-n`）时直接生成；否则群聊直接生成、私聊进入向导。
  - `guided`：`文生图` / `图生图` / `合成图` / style 快捷命令始终进入向导（即使命令带模型后缀 / 参数语法）。
  - `advanced`：所有命令始终跳过向导，使用默认值直接生成。
- `interactionModeOverrides`：按 `session.platform` 覆盖全局模式，用于「飞书私聊走 advanced、QQ 群保留 auto」等平台差异化策略。
- 直接路径由 contract-driven 参数补全完成：任意后缀 + `-16:9` 缺分辨率会自动补默认，`-1k` 缺比例会自动补默认，未提供模型后缀时使用 style 默认或第一条映射（用户显式后缀始终优先）。

## 计费与豁免

- 生成前在用户余额中真实冻结预计积分；并发请求不能超卖同一余额。
- 成功后按实际发送图片数结算，未使用部分释放；失败、超时或未返回图片时全额释放。
- reserve / settle / release 幂等，满足 `reserved = settled + released`；活动 hold 持久化到 `credit-reservations.v1.json`。
- 每映射独立 `groupRatio`；运行时根据目录中的计价类型和供应商积分计算成本，目录价格或公式不足时 fail-closed，不生成虚假估算。
- `图像充值 @用户 <金额>` 中的金额是**人民币金额**，按 `creditsPerCny`（1 元 = N 平台积分）折算为平台积分后入账；负数视为余额修正。
- 「每日免费试用模型」下拉从 `modelMappings.modelId` 单选一个模型；只有目标 `modelId` 等于该单选项时才走每日免费通道，管理员 / 永久会员 / 免计费平台除外。
- `freePlatforms`：命中平台绕过 `reserveCredits` / `settleReservation` / `checkFreeTrialForModel` / 每日免费额度写入，只保留限流与模型访问控制；生成完成只回复图片数量，不显示积分文案。
- 管理员、永久会员和 `unlimitedPlatforms` 平台记录交付与统计但不扣费；首次统计初始化按当前 `dailyFreeCredits` 生成积分快照。

## Prompt 预设与快捷命令

- `styles` / `styleGroups` 由配置页维护；每个预设支持 `mode`（文生图 / 图生图 / 合成图）与 `modelSuffix`（引用 `modelMappings.suffix`）。
- 用户显式后缀优先于 style 默认；guided 模式下 style 命令也进入向导。
- 配置重载会先注销旧 style 命令再按最新配置重新注册，无需外部重启。

## ChatLuna / YesImBot 桥接

- **ChatLuna**（`chatlunaEnabled`）：注册 5 个基础工具 `aigc_generate_image / aigc_edit_image / aigc_apply_style_preset / aigc_get_quota / aigc_list_styles`，每个 style 预设额外注册 `aigc_style_{name}` 动态工具；`chatluna/before-chat` 注入 `[AIGC_CONTEXT]` + `[AIGC_STYLE_CANDIDATES]`；`chatluna/clear-chat-history` 清空对应会话图像上下文。
- **YesImBot**（`yesimbotEnabled`）：通过 `ctx["yesimbot.tool"]`（ToolService）注册与 ChatLuna 相同能力集的 5 个工具；execute 签名 `({ session, ...params }) → { status, result|error }`；工具返回结果中的 base64 图片 URL 被 `summarizeImageUrl` 替换为占位符，避免撑爆 LLM 上下文。
- 两个桥接的 `buildRequestContextAndCost` 都透传 `operation`，与命令 / 向导共享同一 contract 结果。
- 两个桥接均随 Koishi 配置热重载自动 enable / disable；未安装对应上游服务时插件启动照常，仅记日志。

## 模型排行

- 控制台底部「模型排行」折叠面板默认收起，展开时通过 `image-generator/get-model-ranking` 拉取聚合统计：插件调用次数、总生成张数、按模型的生成张数与占比。
- 用户统计 `UserStatisticsV2.modelUsageCounts: Record<string, number>` 在付费与免计费两条路径都按 `modelId` 累加；旧账户读取时回填空对象。

## 配置页

- 配置页文案采用分层策略：下拉选项和表格列名保持极简，字段描述适度说明用途、单位和权限影响。
- 数值字段使用数字输入，不使用滑竿；低频设置使用 Koishi Schema 嵌套 `.collapse()` 默认收起。
- 保存配置前会校验当前供应商对应 API Key：未填写时弹警告并阻止保存。
- 顶部提供只读「使用说明 / 命令速查」，按首次配置、普通用户、管理员、常用参数、权限规则分区。
- 日志级别使用 `simple` / `detail`：`simple` 记录关键流程，`detail` 额外记录脱敏请求诊断（`supplier / modelId / routeId / contractId / operation / 请求字段名 / HTTP 状态`；不记录完整 prompt / base64 / API key，taskId 仅内部关联）。

## 安装与配置

1. 在 Koishi 控制台安装 `koishi-plugin-aka-ai-image-generator`。
2. 打开 aka-tools 页面，在「供应商凭证」中填写 apiKey（`openai-compatible` 还需填写 apiBase 与 `extraHeaders`）。
3. 在「模型映射」中至少添加一条映射，配置命令后缀、modelId、受限状态与 `groupRatio`；运行时 supplier / protocol 由激活供应商和目录 route 决定，第一条有效映射即为默认模型。
4. 可选：配置 `freePlatforms`、`interactionMode` / `interactionModeOverrides`、每日免费模型、Prompt 预设、ChatLuna / YesImBot 桥接。
5. 保存配置，插件目录会生成 / 更新 `users.v2.json`、`credit-ledger.v2.jsonl`、`recharge-records.v2.jsonl`、`credit-reservations.v1.json`。

## 验证建议（新增发布或配置变更后回归）

1. 配置页各分组显示与折叠状态正确；保存前 API Key 校验生效。
2. yunwu 目录刷新成功；受限模型进入 `unsupported`（MJ Action / Kling / omni-image / 图像识别）。
3. `文生图 一只猫 -mj -16:9` 成功，`final prompt` 中不残留 `-mj`；Midjourney 任务返回 `SUCCESS`。
4. `文生图 <描述> -<gpt 后缀> -2k` 走 OpenAI 契约，请求 `size` 实际为 2K 对应尺寸；`-4:3` 无对应固定 size 时 fail-closed。
5. `图生图 <图片> 改成赛博朋克风格 -gemini25` 使用云雾 Gemini 编辑契约（不发 `imageConfig`）。
6. auto 模式下私聊仅输入 `文生图 一只猫`（无直接语法）进入向导；`文生图 一只猫 -16:9` 直接生成。
7. `interactionModeOverrides` 中给某平台设 `advanced`，该平台无参数命令也直接生成。
8. `freePlatforms` 命中平台不扣积分、不写入试用日次数；限流仍生效；生成完成提示不含积分文案。
9. 模型级 `groupRatio=2` 时 2 张图按 `pricePerCall × 2 × 2` 结算。
10. `图像充值 @用户 10 测试充值` 按 `creditsPerCny` 折算为平台积分入账；负数触发余额修正分支。
11. `图像充值` 与生成结算写入 `credit-ledger.v2.jsonl`；文件中不出现 API key / 完整 prompt。
12. 控制台底部展开「模型排行」显示正确的调用次数、生成张数与按模型占比。
13. ChatLuna 启用后 `aigc_generate_image` 与动态 `aigc_style_{name}` 可调用并返回 creditSummary。
14. YesImBot 启用后 `extension.list` 显示 `aka-ai-image-generator`，AI Agent 通过 ToolService 调用返回 `{ status: 'success', result: {...} }`。
15. 日志级别切换 `simple` → `detail` 后打印脱敏请求诊断，不泄露 API key / 完整 prompt。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm run test          # vitest 契约 / provider / shared / commands 全套件
pnpm run build         # tsup + koishi-console build
pnpm run probe:yunwu   # 只读脱敏 yunwu 目录探针
```

## 发布

版本、CHANGELOG、README、docs 由维护流程更新后，从仓库根目录：

```sh
./push.sh aka-ai-image-generator
```

会执行 clean + build + `pnpm publish`。发布前 `pnpm test` 与 `pnpm typecheck` 应通过；`prepublishOnly` 会再跑一次 clean + build。
