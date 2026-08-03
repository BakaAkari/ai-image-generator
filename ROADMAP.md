# koishi-plugin-aka-ai-image-generator Roadmap

## Current status

- Current package version: `2.3.1`.
- Current line: v2.3.x 完成 new-api（openlux）适配、动态倍率定价闭环（预扣上界 + 实际路由结算）、MJ Blend 合成图接入、总览页真实用量统计，以及死代码清理（移除未接线的 60s 实时探测模块）。详见 `CHANGELOG.md`。
- Current UI model: aka-tools 管理页（总览统计 / 供应商凭证 / 模型目录 / 模型映射 / Prompt 预设 / 定价 / 运营）+ ChatLuna 桥接 + YesImBot 桥接 + 交互模式配置。
- Current contract coverage（implemented, contract-driven）:
  - `newapi.mj.imagine`（文生图 + 参考图垫图，`/mj/submit/imagine`）
  - `newapi.mj.blend`（合成图多图融合，`/mj/submit/blend`）
  - newapi OpenAI image create / edit（openai 协议）
  - newapi Gemini generateContent（gemini 协议）
  - OpenAI 官方 create / edit、Gemini 官方 create / edit
- Fail-closed at the catalog level（not implemented）: MJ Action / Describe / Modal / Upload、Kling image / multi-image / outpainting、omni-image、image recognition。

## Next version direction

独立契约逐个补齐，每个能力带自己的 request builder + tests 后再从 `unsupported` 移出：

- MJ Action 链（Upscale / Variation / Reroll / Pan / Zoom）：需要 taskId 持久化 + `GET /mj/task/{id}/fetch` 的 `buttons[].customId` 解析 + 群聊并发隔离。
- MJ Describe / Modal / Upload 契约。
- Kling image / multi-image / outpainting 契约（当前与 MJ 共享目录 route，需独立 provider 路径）。
- omni-image 与图像识别契约。

非阻塞的实机跟进项：

- `/mj/submit/imagine` 与 `/mj/submit/blend` 上游偶发 `all_retries_failed` / `429` 饱和——供应商侧稳定性，非插件路由问题。
- openlux `/api/models` 直连仍返回 `Permission denied, invalid access token`（文档级核验受限，目录拉取走业务端点正常）。

## Stable scope

插件仅限图像生成；视频生成不在当前运行时范围内。

稳定运行方向：

1. 供应商凭证与模型配置完全分离：**供应商**（凭证）为 `newapi` / `gpt-official` / `gemini-official`；**模型映射**（协议 + modelId）由目录 route 决定。
2. 默认模型 = `modelMappings` 第一条有效映射。
3. 第三方 new-api 兼容站通过 `apiBase + apiKey + extraHeaders` 配置，不硬编码供应商名。
4. 命令保持无前缀直呼：`文生图` / `图生图` / `合成图` / `图像查询` / `图像账单` / `图像充值` / `图像排行榜` / `图像指令` / `图像参数`。
5. 计费保持「预扣上界 → 实际路由分组结算多退少补」的闭环，倍率来自目录 `group_ratio` 快照（默认 6h 刷新），不引入手工倍率 UI。
6. 契约层 fail-closed：未接入的 endpoint / 参数绝不静默降级。
7. 无诊断工具 / 探测按钮：状态可观察性靠日志（`settlement-audit` 完整定价痕迹 + 脱敏请求诊断）。
