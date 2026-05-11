# koishi-plugin-aka-ai-image-generator

[![npm](https://img.shields.io/npm/v/koishi-plugin-aka-ai-image-generator?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-aka-ai-image-generator)

自用 AI 图像生成插件 V2（image-only）。

> 范围：仅图像生成。视频生成不在本插件范围内。

## 支持的供应商

- 云雾（自适应：Gemini / OpenAI 协议）
- GPT God
- Google Gemini 官方
- Grok（xAI，可经云雾中转）
- OpenAI 兼容（支持 OpenAI Images API 与 Chat Completions 多模态两种协议）
- OpenAI 官方 GPT Image

## OpenAI 兼容配置

第三方聚合站点优先按协议格式通用化，不按云雾 / 米醋 / Packy 等供应商硬编码：

- `openai-images`：适用于 GPT-image 类接口，调用 `/v1/images/generations` 与 `/v1/images/edits`。
- `openai-chat`：适用于 Gemini Banana / Nano Banana 类多模态 Chat Completions 接口，调用 `/v1/chat/completions`。

配置 OpenAI 兼容供应商时填写 `baseUrl + apiKey + model`，再通过“接口格式”选择实际协议；如第三方站点要求特殊请求头，可在额外请求头中填写。

## 命令（v0.3.0 MVP）

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

- v0.1.x：架构骨架（Provider Registry + Tagged Union Schema + 6 个图像 Provider）
- v0.2.x：MVP（Service + 简化版 Orchestrator + 文生图 / 图生图 / 额度查询命令）
- v0.3.0：OpenAI 兼容协议验证 MVP（无前缀命令 + `openai-images` / `openai-chat` 协议选择）
- v0.4.x（计划，Phase 5）：完整命令族（合成图 / 风格迁移 / 改姿势 / 修改设计 / 变像素 / 充值 / 参数指令）+ ChatLuna 桥接 + 用户数据迁移工具
