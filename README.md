# koishi-plugin-aka-ai-image-generator

[![npm](https://img.shields.io/npm/v/koishi-plugin-aka-ai-image-generator?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-aka-ai-image-generator)

自用 AI 图像生成插件 V2（image-only），当前版本采用供应商语义 + 协议路由配置界面。

> 范围：仅图像生成。视频生成不在本插件范围内。

## 支持的供应商入口 / 协议路由

控制台顶层只暴露三类用户可理解的图像生成供应商入口，不再把第三方聚合站名称硬编码成供应商选项：

- `openai-compatible`：OpenAI 兼容格式，适用于第三方聚合站点。填写 `baseUrl + apiKey + model`，并在内部选择接口格式。
- `openai-official`：OpenAI 官方，固定路由到 Images API，适用于 GPT-image 类模型。
- `gemini-official`：Gemini 官方，固定路由到 Google Gemini 原生接口。

OpenAI 兼容格式内部再选择运行时协议 / 通道：

- `openai-images`：GPT-image / Images API，调用 `/v1/images/generations` 与 `/v1/images/edits`。
- `openai-chat`：Gemini Banana / Chat Completions 多模态，调用 `/v1/chat/completions`。

Gemini 官方入口使用运行时 `gemini` 通道，调用 `/v1beta/models/{model}:generateContent`。如第三方站点要求 `User-Agent` 等特殊请求头，可在 OpenAI 兼容入口的额外请求头中填写。

配置页里的次数、窗口、超时等数值字段使用数字输入，不使用滑竿。

## 命令（v0.5.x MVP）

命令统一采用无前缀直呼格式，不使用 `aig.` 前缀。

| 命令 | 别名 | 说明 |
| --- | --- | --- |
| `文生图 <prompt>` | `t2i` | 纯文字描述生成图片 |
| `图生图 [img] <prompt>` | `i2i` | 单张图片 + 修改描述 |
| `图像额度` | `quota` | 查询当前用户额度 |

支持的修饰符（紧跟在命令后）：

- `--n <数量>` 一次生成图片数量
- `--model <模型>` 覆盖默认模型
- `--ar <宽高比>` 例如 `1:1`、`16:9`
- `--res <分辨率>` 例如 `1024x1024`

## 状态

- v0.1.x：架构骨架（Provider Registry + Tagged Union Schema + 多 Provider 验证）。
- v0.2.x：MVP（Service + 简化版 Orchestrator + 文生图 / 图生图 / 额度查询命令）。
- v0.3.0：OpenAI 兼容协议验证 MVP（无前缀命令 + `openai-images` / `openai-chat` 协议选择）。
- v0.4.0：协议优先配置重写（控制台仅保留 `openai-images` / `openai-chat` / `gemini`，移除历史供应商顶层选项与注册别名）。
- v0.5.0：供应商语义 UI 重写（控制台顶层仅保留 `openai-compatible` / `openai-official` / `gemini-official`，OpenAI 兼容入口内部选择 `openai-images` 或 `openai-chat`；数值配置改为数字输入）。
- v0.5.1：尝试修复 OpenAI 兼容入口选择后配置项未展开的问题；后续确认该 Tagged Union 结构在控制台中仍不稳定。
- v0.5.2：修复供应商设置整体消失问题，改为稳定对象分组结构，并修复模型映射跨运行时 Provider 时的凭证来源错误。供应商相关配置组会同时显示，只有当前选择的供应商对应配置实际生效。
- v0.5.3：清理当前阶段不应暴露的 ChatLuna 集成配置、未实现命令族常量和后续阶段运行时代码残留；当前阶段只保留 `文生图`、`图生图`、`图像额度`。
- 后续计划：完整命令族、ChatLuna 桥接和用户数据迁移工具仅保留在规划文档中，未在当前版本运行时暴露。
