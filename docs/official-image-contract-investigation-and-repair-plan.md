# OpenAI / Gemini / Midjourney 官方接口契约调查与修复执行方案

> 状态：**v1.2.7 release-ready（2026-07-29）**。Phase A–F 已完成；Kari 已完成真实手工验收，MJ Imagine 与 OpenAI GPT Image 2 文生图均成功。尚未覆盖的官方渠道、参考图和未实现能力仍按本文标注保留，不扩大验证结论。
>
> 目标插件：`koishi-plugin-aka-ai-image-generator`
>
> Apifox 契约快照：`docs/yunwu-apifox-image-contract-snapshot.json`
>
> 获取方法：从 Apifox 页面 `performance.getEntriesByType('resource')` 定位公开的 published-project JSON 接口，再按 API ID 直接读取结构化 schema；不依赖截图、OCR 或页面滚动。本次项目 ID `5427167`、分支 ID `5118384`，共提取 9 个图像接口。

## 实施状态一览（2026-07-29）

| Phase | 状态 | 落地位置 |
|---|---|---|
| A. route + contract 精确选择 | ✅ | `src/contracts/registry.ts`、`src/service/model-route-selection.ts`、`src/index.ts::catalogRouteLookup`（按 operation 精确匹配 route） |
| B. contract-driven 参数层 | ✅ | `src/contracts/param-resolver.ts`、`src/contracts/openai-size.ts`、`src/shared/generation-setup.ts`（命中契约走契约层，未命中回退 PROTOCOL_PARAMS） |
| C. OpenAI Provider 重写 | ✅ | `src/providers/openai.ts`：JSON create + multipart edit + 契约驱动 size + 契约级 n / quality / format / background / moderation 校验 |
| D. Gemini Provider 重写 | ✅ | `src/providers/gemini.ts`：云雾/官方契约分离 + 编辑不发 imageConfig + 图生图输入失败 fail-closed + inlineData/URL/b64_json 响应解析 |
| E. MJ Imagine 重写 | ✅ | `src/providers/midjourney.ts`：官方 Body（botType/prompt/base64Array）+ 非 Imagine 契约 id 拒绝 |
| F. 五入口统一 | ✅ | `commands/image.ts`、`wizard/wizard-handler.ts`、`bridge/chatluna/tool-runtime.ts`、`bridge/yesimbot/tool-runtime.ts`、`AiImageGeneratorService.requestProviderImages` |
| catalog fail-closed（本轮增补） | ✅ | `src/suppliers/yunwu/capability.ts` NON_GENERATION_PATTERNS、`routes.ts` 仅保留 `mj想象模式`、`normalizer.ts` blocking reasons 扩充 |
| 契约 + provider 测试 | ✅ | `tests/contracts/*.test.ts`（36）、`tests/providers/midjourney.test.ts`（7）、`tests/providers/openai-contract.test.ts`（6）、`tests/providers/gemini-contract.test.ts`（8）、`tests/shared/generation-setup-contract.test.ts`（4） |
| 真实低成本 smoke | ✅ 已完成核心路径 | MJ Imagine、OpenAI GPT Image 2 文生图成功；其它矩阵仍待后续按需验证 |
| Kari 手工验收 | ✅ 已完成 | 多轮真实测试反馈正常，详见 §7.4 |

真实探针仍需补齐的文档矛盾（详见 CHANGELOG“仍需真实探针确认”一节）：
1. MJ 服务端是否自动追加 `--stylize/--relax/--v`；重复 `--stylize` 是否 400。
2. 云雾 GPT Image 1 页面 schema 与 example 的 size / model 矛盾。
3. 云雾 Gemini 请求鉴权是否允许仅 Authorization（当前仍走 query `?key=`）。
4. Gemini 官方 imageSize 各模型的枚举差异（本轮 fail-closed 列出 1K/2K/4K）。
5. OpenAI 官方 GPT Image 编辑响应实际字段（Apifox 已知误填）。

未实现的范围（本次显式 fail-closed，模型进入 unsupported）：MJ Action / Blend / Describe / Modal / Upload、Kling 生图 / 多图生图 / 扩图、omni-image、图像识别。

## 1. 背景与问题定义

当前插件已经建立“识别用户完整指令 → 根据 catalog route 选择协议 → 补齐缺失参数 → 调用 Provider”的公共链路，但现有抽象只精确到 `openai / gemini / mj` 三个粗粒度协议。

真实供应商接口并不只由协议名决定，还取决于：

- 当前供应商：云雾、OpenAI 官方、Gemini 官方；
- 当前 route 对应的具体能力：文生图、图像编辑、MJ Imagine、Action、Blend、Describe 等；
- 当前模型及供应商分组支持的参数集合；
- 请求方言：JSON、multipart/form-data、Gemini `generateContent`、异步 task API；
- 响应方言：URL、base64、Gemini inlineData、异步任务状态。

因此，真正需要统一的不是“把所有模型强制转成同一组字段”，而是：

1. 统一用户意图与参数规范化；
2. 根据最终 route 选择精确的接口契约；
3. 由契约适配器把统一参数转换为供应商实际接受的请求；
4. 缺失参数补安全默认值，显式但不支持的参数不得静默降级；
5. 未确认契约的 route 必须 fail-closed，不能猜测接口。

## 2. 用户需求的准确边界

### 2.1 必须实现的行为

- 用户使用任意已配置模型后缀时，系统从 catalog route 确认协议和能力，不按模型名称猜协议。
- 用户只提供部分参数时，补齐该 route 契约的缺失默认值：
  - 只发 `-1k`：补默认比例；
  - 只发 `-16:9`：补默认清晰度/尺寸等级；
  - 未发尺寸参数：补该契约的安全默认参数。
- 用户显式参数优先。
- 用户显式参数不受当前 route 支持时，返回明确、可理解的错误；不能偷偷换成默认值。
- Provider 只发送当前接口契约声明的字段。
- 普通命令、Prompt 预设、向导、ChatLuna、YesImBot 共享同一套 route + contract + normalization 结果。
- 错误日志必须能区分：本地参数校验失败、HTTP 提交失败、异步任务失败、响应解析失败。

### 2.2 非目标

- 不把 OpenAI、Gemini、MJ 变成完全相同的请求字段。
- 不根据 `modelId` 字符串包含 `gpt`、`gemini`、`mj` 来猜接口。
- 不在本轮实现 MJ Upscale、Variation、Action、Blend、Describe 等完整动作链。
- 不为未验证的模型能力写“看起来合理”的硬编码。
- 不修改权限、计费、试用、限流与交互模式。
- 未经 Kari 授权，不升版、不 Commit、Push、Tag、Publish。

## 3. 权威来源与证据等级

### 3.1 云雾官方 Apifox 文档

- 文档首页：<https://yunwu.apifox.cn/>
- OpenAI / GPT Image：
  - GPT Image 1 创建：<https://yunwu.apifox.cn/api-290549047>
  - GPT Image 2 创建：<https://yunwu.apifox.cn/api-447792717>
  - GPT Image 2 编辑：<https://yunwu.apifox.cn/api-446294920>
- Gemini 原生格式：
  - Gemini 2.5 Flash Image 比例：<https://yunwu.apifox.cn/api-358030171>
  - Gemini 3 Pro Image 比例与清晰度：<https://yunwu.apifox.cn/api-379838953>
  - Gemini 图片编辑：<https://yunwu.apifox.cn/api-305488471>
- Midjourney：
  - 上传图片：<https://yunwu.apifox.cn/api-277975070>
  - 提交 Imagine：<https://yunwu.apifox.cn/api-232421938>
  - 查询任务：<https://yunwu.apifox.cn/api-232421939>

### 3.2 上游官方文档

- OpenAI Images API：<https://platform.openai.com/docs/api-reference/images>
- Google Gemini 图片生成：<https://ai.google.dev/gemini-api/docs/image-generation>
- Midjourney Prompt Basics：<https://docs.midjourney.com/hc/en-us/articles/32023408776205-Prompt-Basics>

### 3.3 证据规则

- 云雾供应商调用以云雾 Apifox 的实际契约为直接权威。
- OpenAI 官方供应商以 OpenAI 官方文档为权威。
- Gemini 官方供应商以 Google 官方文档为权威。
- 文档与真实返回冲突时，以经过脱敏记录的真实 API 响应为运行时证据，同时记录文档差异。
- 项目旧文档、注释和测试只能作为历史线索，不能覆盖当前官方契约。
- Apifox 页面展示层与结构化 schema 不一致时，必须同时保留并标注“文档内部矛盾”，不得自行选择看起来合理的一边。
- 已确认云雾 OpenAI 创建接口的 response schema 被误填为 Chat Completions；Gemini response schema 为空；MJ task fetch 的 request schema 也明显复制自图像生成。相关响应和查询行为必须用真实低成本探针验证，不能照抄错误文档实现。

## 4. 已验证的当前差异

### 4.1 Midjourney：已确认的阻断级错误

云雾 Imagine 官方 Body：

- `botType`：必需，值为 `MID_JOURNEY` 或 `NIJI_JOURNEY`；
- `prompt`：必需；
- `base64Array`：可选；
- `notifyHook`：可选；
- `state`：可选。

当前 `src/providers/midjourney.ts` 实际发送：

- `prompt`；
- `model: this.modelId`；
- 有参考图时发送 `imageUrl`。

已确认差异：

- 漏发必需字段 `botType`；
- 发送官方契约未声明的 `model`；
- 参考图字段使用 `imageUrl`，而官方 Imagine 契约为 `base64Array`；
- 当前 catalog 把 MJ Imagine、MJ Action、Blend、Describe、上传，以及 Kling 多类 endpoint 都压成 `protocol=mj`；
- 当前 `MjProvider` 无论 route 能力是什么，都调用 `/mj/submit/imagine`；
- `catalogRouteLookup` 只取 `model.routes[0]`，没有按本次生成模式选择具体 capability；
- 项目旧文档 `docs/midjourney-plan.md` 中的 `{ prompt, model }` 与官方契约冲突。

历史故障与最终闭环：

- 输入：`文生图 一只猫 -mj -16:9`；
- 已正确选择 `provider=mj`、`modelId=mj_imagine`；
- 云雾返回 taskId 后，异步任务最终 `FAILURE`，`failReason=parameter error`。
- v1.2.7 日志长度对比确认真正根因：Koishi `[prompt:text]` 保留了动态模型后缀 `-mj`；
  它虽然已被用于模型选择，却仍进入最终 prompt，被 Midjourney 当成非法参数。
- `botType` 缺失、非契约 `model/imageUrl` 是旧实现中的真实契约差异，但不是修正 Body 后仍出现
  `parameter error` 的最终根因；服务端重复追加 `--stylize` 也没有证据支持。
- 新增 `stripImageCommandControls()` 后，控制后缀从最终 prompt 移除，真实 Imagine 任务返回 `SUCCESS`。

风险：**P0 / 阻断**。

### 4.2 OpenAI：参数抽象与实际 size 契约未对齐

云雾 GPT Image 2 创建接口为：

- `POST /v1/images/generations`；
- 必需：`model`、`prompt`、`n`；
- 可选：`size`、`quality`、`format`；
- 文档列出固定尺寸并说明自定义尺寸限制。

云雾 GPT Image 2 编辑接口为：

- `POST /v1/images/edits`；
- `multipart/form-data`；
- 页面参数表明确：必需 `image`、`prompt`；可选 `mask`、`model`、`n`、`quality`、`size`、`background`、`moderation`。
- Apifox JSON schema 却把 `image/prompt/mask/model/n/quality/response_format/size` 全标为 required，且未收录页面参数表已有的 `background/moderation`。这是官方文档内部矛盾，实施时不能直接把 schema required 全量当真。

当前差异：

- 公共层把 `resolution=1k/2k/4k` 作为 OpenAI 协议参数，但 Provider 对这些预设只记录“ignored”，不会转换成对应像素尺寸；
- 最终 `size` 主要由 `aspectRatio` 决定，导致用户显式 `-2k/-4k` 可能完全不生效；
- `4:3` 当前映射为 `1536x1024`，实际比例为 `3:2`，语义不一致；
- `9:16` 等映射是否被当前模型/分组接受，未按 route/model 契约验证；
- 自定义 `数字x数字` 只做正则校验，未执行云雾文档的边长、16 倍数、比例和总像素限制；
- 编辑请求当前先尝试 JSON + data URL，再失败回退 multipart；官方编辑契约明确为 multipart，当前流程会产生一次预期失败请求；
- 公共参数 `n` 限制为 1–4，而云雾文档为 1–10。这可以作为产品限制保留，但必须明确，不得误称为接口上限；
- `gpt-image-2-c` 的目录描述明确写“暂不支持 n 参数”，当前粗粒度 `openai` 契约无法表达模型级差异；
- 云雾 GPT Image 1 创建页面 schema 要求 `prompt/n/size`，但示例额外发送 `model`，且示例尺寸 `1024x1536` 不在页面声称的 `256x256/512x512/1024x1024` 集合中，属于文档内部矛盾。
- 云雾 GPT Image 1/2 创建响应 schema 和示例被误填为 Chat Completions（`choices/message`），不能作为 Images API 响应实现依据；必须真实探针确认 `data[].url/b64_json` 与 usage。

风险：

- `-2k/-4k` 不生效：**P0 / 用户显式参数失真**；
- OpenAI 编辑先发错误 JSON：**P1**；
- 尺寸映射和自定义尺寸校验：**P1**；
- 响应形态与模型级 `n`：**P1**。

### 4.3 Gemini：供应商方言与模型能力未分层

云雾 Gemini 原生接口：

- `POST /v1beta/models/{model}:generateContent`；
- `contents[].parts[]`；
- `generationConfig.responseModalities`；
- `generationConfig.imageConfig`；
- `response_format` 是云雾扩展，可请求 URL；不填默认 base64；
- 图生图使用 `inline_data`；
- Gemini 3 Pro 文档支持宽高比和 `imageSize`。
- 结构化示例已确认：Gemini 2.5 Flash Image 发送 `imageConfig.aspectRatio`，不发送 `imageSize`；Gemini 3 Pro Image 示例发送 `aspectRatio + imageSize: "1K"`；Gemini 3 Pro 编辑示例只发送 `responseModalities`，未发送 `imageConfig`。

当前实现接近基础契约，但存在以下问题：

- `supportsImageConfig = true` 是无效变量，实际逻辑对所有 Gemini route 都假设支持 `imageConfig`；这会把 Gemini 3 Pro 的清晰度字段错误套给只在官方页面声明比例控制的 Gemini 2.5。
- 公共 `PROTOCOL_PARAMS.gemini` 对所有 Gemini 模型统一开放 `1K/2K/4K` 与同一组比例，但结构化契约已证明至少 Gemini 2.5 与 Gemini 3 Pro 的字段能力不同；
- Gemini 官方与云雾共用同一个 Provider，但 `imageSize` 映射由 apiBase 字符串判断：官方映射为 `LOW/MEDIUM/4K`，云雾映射为 `1K/2K/4K`；当前 Google 图片文档强调图片大小使用大写 `K`，官方 `LOW/MEDIUM` 映射需要重新核实，不能继续当作已确认契约；
- 云雾三个 Gemini 页面都声明 `response_format=url` 可返回 URL，不填默认 base64；当前未使用。这本身不一定错误，但应由云雾 contract 明确选择，不能污染 Gemini 官方请求。
- Gemini 2.5、Gemini 3 Pro、Gemini 3.1 Flash/Lite 对分辨率、比例和参考图数量支持不同，当前粗粒度协议无法表达；
- 所有输入图片下载失败时，当前 Gemini Provider仍可能退化为文生图，需要确认是否应明确报“输入图下载失败”；
- Gemini 2.5/3 Pro 生成页面结构化契约要求 query `key`；编辑页面同时把 query `key` 标为必需、Authorization 标为可选。当前 query key 路径与文档一致；Authorization 是否需要无需先假设，真实探针只需验证当前 query key 即可。

风险：

- 官方 Gemini `imageSize` 映射可能错误：**P0 / 官方渠道潜在阻断**；
- 模型级能力未表达：**P1**；
- 图生图输入全部失败后行为：**P1**；
- URL/base64 与鉴权方言：**P2 / 需验证**。

### 4.4 跨协议架构差异

当前路由和参数链路存在共同根因：

1. `GenerationRoute` 只有 `protocol + capability + endpointName`，没有稳定的 `contractId/dialect/operation`；
2. `catalogRouteLookup` 固定取 `routes[0]`，没有按文生图/图生图/合成图选择 route；
3. `PROTOCOL_PARAMS` 只按 `openai/gemini/mj` 定义参数，无法表达模型与 endpoint 差异；
4. `ImageGenerationOptions` 只有 `resolution/aspectRatio`，无法承载已验证的 `quality/format/botType` 等契约参数；
5. 参数 resolver 同时承担用户参数、协议默认和 MJ prompt 拼接，边界过粗；
6. Provider 内部仍有隐式默认和忽略逻辑，导致“公共层显示已补全”不等于“供应商实际收到并生效”。

## 5. 调查方案

调查必须先完成，再开始修复。每个结论标记为 `[已验证]` 或 `[待探针]`。

### 5.1 建立可版本化的契约快照

已经生成第一份结构化快照：

- `docs/yunwu-apifox-image-contract-snapshot.json`

后续实施时将其中稳定字段拆成测试 fixture：

- `tests/fixtures/contracts/yunwu/openai-gpt-image-1-create.json`
- `tests/fixtures/contracts/yunwu/openai-gpt-image-2-create.json`
- `tests/fixtures/contracts/yunwu/openai-gpt-image-2-edit.json`
- `tests/fixtures/contracts/yunwu/gemini-2.5-image.json`
- `tests/fixtures/contracts/yunwu/gemini-3-pro-image.json`
- `tests/fixtures/contracts/yunwu/mj-imagine.json`
- `tests/fixtures/contracts/yunwu/mj-task-fetch.json`

快照只保存字段、必需性、枚举、端点和脱敏后的示例结构，不保存密钥或大型 base64。

验收：

- 每份 fixture 标注来源 URL、抓取日期、契约摘要；
- 文档更新时能通过 diff 看出字段变化；
- 代码测试引用 fixture，不复制另一套字段列表。

### 5.2 调查 route 选择是否正确

逐个检查当前配置模型：

- `gpt-image-2`
- `gemini-3-pro-image-preview`
- `mj_imagine`
- 其他配置映射

验证：

- catalog 的全部 routes；
- 文生图应选择的 capability；
- 图生图/编辑应选择的 capability；
- `routes[0]` 是否与本次操作一致；
- endpointName 是否足以映射到具体 contract。

产出：`modelId + operation → routeId + contractId` 清单。

### 5.3 OpenAI 调查矩阵

对云雾 GPT Image 1、GPT Image 2，以及当前映射使用的其他 OpenAI route，分别调查：

- 文生图支持的 size；
- 编辑支持的 size；
- 自定义尺寸规则；
- `n` 支持情况；
- `quality/format/background/moderation` 支持情况；
- JSON 与 multipart 要求；
- URL/base64 响应；
- usage 字段。

最小真实探针（需 Kari 同意产生供应商费用后执行）：

1. 1K、1:1、n=1 文生图；
2. 仅比例 16:9，观察实际返回 size；
3. 2K 请求；
4. 一个合法自定义尺寸；
5. 一个非法自定义尺寸，确认错误码；
6. 单图编辑 multipart；
7. 对声明不支持 n 的模型测试 n=2，确认 fail-closed 规则。

### 5.4 Gemini 调查矩阵

按“供应商方言 + 模型”调查：

- 云雾 Gemini 2.5 Flash Image；
- 云雾 Gemini 3 Pro Image；
- Gemini 官方当前配置模型；
- 如目录已出现 Gemini 3.1，则独立建能力项。

验证：

- `generationConfig.responseModalities`；
- `generationConfig.imageConfig.aspectRatio`；
- `imageConfig.imageSize` 的合法枚举；
- 文生图与图生图的 parts 结构；
- 最大参考图数量；
- `response_format=url` 是否稳定；
- query key 与 Authorization 的实际要求；
- inlineData/inline_data/fileData 响应形态；
- usageMetadata。

最小真实探针：

1. 不传 imageConfig，验证服务端默认；
2. 1K + 1:1；
3. 2K + 16:9；
4. 小写 `1k` 作为负例；
5. 单参考图编辑；
6. `response_format=url` 与默认 base64 各一次；
7. 官方 Gemini 渠道使用官方字段值单独验证。

调查判定预期：

- 云雾 Gemini 2.5 contract 初始能力仅声明 `aspectRatio`，不默认发送 `imageSize`；
- 云雾 Gemini 3 Pro contract 声明 `aspectRatio + 1K/2K/4K imageSize`；
- 编辑操作是否发送 imageConfig 由编辑 contract 决定，不沿用文生图参数表；
- Gemini 官方 contract 独立读取 Google 当前文档，不复用云雾扩展 `response_format`。

### 5.5 Midjourney 调查矩阵

只先调查 Imagine 主链路，不把其他动作混入：

- `POST /mj/submit/imagine` 的完整必需 Body；
- `botType=MID_JOURNEY`；
- prompt 中 `--ar`；
- prompt 中 `--stylize`；
- 云雾是否服务端自动追加 `--stylize/--relax/--v`；
- 重复 `--stylize` 是否导致 `parameter error`；
- task 状态枚举和失败结构；
- 参考图应走 `base64Array` 还是“先上传、再用 URL/ID”；
- Niji 是否应作为独立 contract 或 botType 配置。

结构化契约新增确认：

- 上传端点为 `POST /mj/submit/upload-discord-images`，Body 要求 `base64Array: string[]`；
- Imagine 自身也接受可选 `base64Array`，因此参考图可先下载转 data URL 后直接按该字段提交；是否必须先经过上传端点需要真实探针，不能仅凭旧文档断言必须两步；
- task fetch response schema 完整列出了 `id/action/botType/prompt/imageUrl/status/progress/failReason/buttons/properties.finalPrompt` 等字段；
- task fetch request schema 明显复制了 DALL-E 字段，与 GET 查询行为无关，实施时应忽略该请求 Body schema，以路径 taskId + Authorization 为准。

最小真实探针：

1. 官方最小 Body：`botType + prompt`；
2. 加 `--ar 16:9`；
3. 加 `--stylize 100`；
4. 同时带两者；
5. 故意重复 stylize，确认错误；
6. 单张 base64Array 参考图；
7. 查询 SUCCESS 与 FAILURE 的完整脱敏响应。

### 5.6 日志与观测要求

所有探针和后续运行日志必须记录但脱敏：

- `supplier`
- `modelId`
- `routeId`
- `contractId`
- `operation`
- 请求字段名列表，不记录完整 prompt/base64/key；
- HTTP 状态；
- taskId 仅保留内部关联，不在用户回复中暴露；
- 供应商错误 code/description/failReason；
- 实际返回的 size/format/usage。

## 6. 修复执行方案

### Phase A：把 route 升级为精确契约选择

扩展内部 route 表达，建议增加：

- `contractId`
- `operation`
- `dialect`
- `endpoint`
- `supports`

示例 contractId：

- `yunwu.openai.images.generate`
- `yunwu.openai.images.edit`
- `openai.official.images.generate`
- `openai.official.images.edit`
- `yunwu.gemini.generate-content.image`
- `gemini.official.generate-content.image`
- `yunwu.mj.imagine`

把 `catalogRouteLookup(modelId)` 改为：

`catalogRouteLookup(modelId, operation)`

禁止继续固定取 `routes[0]`。

验收：

- 文生图只选择 text-to-image contract；
- 图生图只选择 image-edit/image-to-image contract；
- MJ Action/Describe/Kling 不会误进 Imagine Provider；
- 没有匹配 contract 时在提交前明确 fail-closed。

### Phase B：建立 contract-driven 参数层

将当前 `PROTOCOL_PARAMS` 拆成两层：

1. 用户统一参数：分辨率等级、比例、数量等；
2. route contract 能力：支持字段、默认值、枚举、转换器。

建议结构：

- `src/contracts/types.ts`
- `src/contracts/registry.ts`
- `src/contracts/yunwu-openai.ts`
- `src/contracts/yunwu-gemini.ts`
- `src/contracts/yunwu-mj.ts`
- `src/contracts/official-openai.ts`
- `src/contracts/official-gemini.ts`

输出统一的 `ResolvedGenerationRequest`，其中明确区分：

- 用户显式参数；
- 自动补全参数；
- 被拒绝的不支持参数；
- Provider 请求参数；
- prompt additions。

关键规则：

- 缺失参数可以补默认；
- 显式无效参数必须报错，不静默丢弃；
- 显式但 route 不支持的参数必须报错；
- Provider 不再自行忽略重要参数。

### Phase C：修复 OpenAI Provider

1. 按 contract 构建文生图 JSON。
2. 按 contract 直接构建编辑 multipart，不先发送非契约 JSON。
3. 新增尺寸解析器：
   - 输入：resolution level + aspect ratio + model/contract；
   - 输出：准确 `size`；
   - 不能表达的组合返回错误；
   - 自定义尺寸执行官方限制校验。
4. `quality/format` 仅在 contract 支持时发送。
5. `n` 采用 contract 策略：
   - 支持 n：一次请求或保留逐张请求需明确；
   - 不支持 n：逐张调用或明确限制，由测试证明；
   - 用户产品上限 4 可继续保留。
6. 响应解析覆盖 URL、base64、usage；空数据必须报协议解析错误。

必须新增测试：

- 1K/2K/4K + 每个比例的 size 映射；
- 4:3 不再映射成 3:2；
- 合法/非法自定义尺寸；
- create JSON 契约；
- edit multipart 契约；
- n 支持/不支持策略；
- URL/base64/usage 响应。

### Phase D：修复 Gemini Provider

1. 将云雾与官方 Gemini 方言分离，不再只靠 `apiBase.includes(...)` 推断全部行为。
2. 按 contract 选择鉴权、imageSize 枚举和 response_format。
3. 为模型声明能力：
   - 支持的 imageSize；
   - 支持的 aspectRatio；
   - 最大参考图；
   - 是否支持 imageConfig。
4. 图生图时若所有参考图下载失败，明确失败，不退化为文生图。
5. 输出解析覆盖云雾 URL、默认 base64、Google inlineData 与 usageMetadata。
6. 大小写规范化只发生在用户输入层；发送层严格输出契约要求的大写 `K`。

必须新增测试：

- 云雾与官方 contract 分流；
- 1K/2K/4K 大写输出；
- 不支持清晰度的模型不发送 imageSize；
- 比例能力；
- 单图/多图 parts；
- 全部图片下载失败；
- URL/base64/inlineData 响应。

### Phase E：修复 Midjourney Imagine Provider

1. 新建仅负责 `yunwu.mj.imagine` 的请求构建器。
2. Body 严格为：
   - `botType`
   - `prompt`
   - `base64Array`（需要时）
   - `notifyHook/state`（仅配置需要时）
3. 删除 `model` 和 `imageUrl` 非契约字段。
4. `modelId=mj_imagine` 只用于 catalog/计费/展示，不进入官方 Body。
5. 确认云雾是否自动追加 stylize：
   - 若服务端自动追加，则插件默认不重复追加；
   - 用户显式 stylize 是否允许覆盖，以真实探针为准；
   - 该结论写入 contract，而不是散落在 Provider。
6. task 轮询按正式状态枚举处理，并保留 description/failReason。
7. 参考图先按官方 Imagine 可选 `base64Array` 实现；仅当真实探针证明必须经过上传端点时，再接入 `/mj/submit/upload-discord-images`，不提前制造两步硬依赖。
8. 非 Imagine 的 MJ/Kling route 先标为 unsupported；后续分别实现专用 contract。

必须新增测试：

- 最小 Body 含 botType/prompt；
- Body 不含 model/imageUrl；
- ar/stylize 的单一事实源与去重；
- submit 无 result；
- SUCCESS/FAILURE/timeout；
- 非 Imagine route fail-closed；
- 参考图 base64Array。

### Phase F：统一入口回归

对五个入口建立同一 contract 结果测试：

- 普通命令；
- Prompt/style；
- 向导；
- ChatLuna；
- YesImBot。

每个协议至少覆盖：

- 无参数；
- 仅清晰度；
- 仅比例；
- 完整参数；
- 显式无效参数；
- route 不支持参数；
- 未知 route；
- 文生图与图生图 route 分离。

## 7. 验证与发布门禁

### 7.1 自动验证

- contract fixture 测试；
- request builder 单元测试；
- Provider HTTP mock 测试；
- route selection 测试；
- 五入口一致性测试；
- `pnpm test`；
- `pnpm typecheck`；
- `pnpm build`。

当前已有 4 个 Yunwu catalog 测试失败必须单独处理，因为它们暴露了 recognition endpoint 被误判为可生成 route 的问题；本次 route/contract 修复完成后，不能继续把这些失败视为无关基线。

### 7.2 本地运行验证

- 同步至现有 `koishi-app`；
- 重启唯一 Koishi 实例；
- 检查插件启动、目录刷新、映射校验、Console bundle；
- 确认日志无 key/base64/完整敏感 prompt 泄漏。

### 7.3 经授权的真实低成本 smoke

在 Kari 明确允许产生供应商费用后：

- OpenAI：1 次文生图 + 1 次编辑；
- Gemini：1 次文生图 + 1 次编辑；
- MJ：1 次最小 Imagine + 1 次带 16:9；
- 检查返回图片、请求 contractId、错误结构、计费结算和任务释放。

### 7.4 Kari 手工验收

最终交付时逐项提供准确命令、入口、预期结果和应保持不变行为；不只说“请测试”。

## 8. 建议实施顺序

1. **P0：MJ Imagine 官方 Body 修正与非 Imagine route 隔离。**
2. **P0：OpenAI 1K/2K/4K + 比例到 size 的真实映射。**
3. **P0：Gemini 官方/云雾 imageSize 方言确认与分离。**
4. **P1：route 按 operation 选择，移除 `routes[0]`。**
5. **P1：OpenAI 编辑 multipart-first。**
6. **P1：Gemini 图生图输入失败与模型级能力。**
7. **P1：修复当前 4 个 catalog fail-closed 测试。**
8. **P2：URL/base64 策略、quality/format 等增强字段。**

实际编码建议作为一个“契约层主改造”统一实施，但提交审查可按 Phase A–F 分块，避免一次 diff 无法审阅。

## 9. 完成定义

只有同时满足以下条件，才能声称修复完成：

- 三个协议的供应商请求与当前官方契约一致；
- 每次请求都能定位到 `routeId + contractId + operation`；
- 用户缺失参数被安全补全；
- 用户显式无效/不支持参数得到明确错误；
- MJ 不再发送 `model/imageUrl` 到 Imagine；
- OpenAI `-2k/-4k` 实际改变请求 size；
- Gemini 云雾与官方渠道发送各自合法的 imageSize；
- catalog 不再把 recognition/upload/video/Kling 路由误当 Imagine 生成；
- 全部新测试、类型检查、构建通过；
- 真实低成本 smoke 成功；
- Kari 完成手工验收；
- 发布版本确定为 `1.2.7`，四次迭代边界见 `CHANGELOG.md`。

## 10. 已确认决策与后续边界

1. `contractId + operation` 契约层已采用并完成实施。
2. 未实现的 MJ Action/Blend/Describe/Kling/omni-image/识图 route 继续目录级 fail-closed。
3. v1.2.7 已完成 MJ Imagine 与 OpenAI GPT Image 2 核心真实 smoke；其它真实探针按成本和需求后续单独执行。
4. 新能力必须先新增独立 contract、请求构建器和测试，再从 `unsupported` 放行。
