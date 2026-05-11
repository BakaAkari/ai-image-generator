# Changelog

## 0.5.3

- 清理当前阶段不应暴露的 ChatLuna 集成配置项，避免控制台出现尚未实现的兼容选项。
- 清理未实现命令族与后续阶段能力在运行时代码中的常量、提示和导出入口残留，当前阶段仅保留 `文生图`、`图生图`、`图像额度`。
- 图像上下文记忆保留为内部生成记录能力，不再通过 ChatLuna 配置控制。

## 0.5.2

- 修复 `0.5.1` 中供应商设置在 Koishi 控制台整体消失的问题。
- 将供应商配置 Schema 从顶层裸 `union` 调整为稳定展示的普通对象分组：供应商选择、OpenAI 兼容设置、OpenAI 官方设置、Gemini 官方设置。
- 修复模型映射覆盖运行时 Provider 时仍按顶层语义供应商读取凭证的问题，避免 `openai-chat` / `gemini` / `openai-images` 跨通道调用时使用错误密钥、模型或 base URL。

## 0.5.1

- 修复控制台选择 `openai-compatible` 后 OpenAI 兼容分支配置项未展开的问题。
- 将供应商配置 Schema 从“独立供应商字段 + union 分支”的交叉结构调整为单一 Tagged Union，避免 Koishi 控制台重复同名字段导致分支配置项不显示。
- 注意：该版本后续确认在部分 Koishi 控制台中会导致供应商设置整体不显示，已在 `0.5.2` 改为稳定对象分组结构。

## 0.5.0

- 重写控制台顶层供应商入口为语义化三选项：`openai-compatible`（OpenAI 兼容格式）、`openai-official`（OpenAI 官方）、`gemini-official`（Gemini 官方）。
- 将 OpenAI 兼容入口内部的接口格式明确拆分为 `openai-images`（GPT-image / Images API）与 `openai-chat`（Gemini Banana / Chat Completions 多模态）。
- 服务层新增供应商语义到运行时 Provider 的路由映射：OpenAI 兼容按接口格式路由，OpenAI 官方固定路由到 `openai-images`，Gemini 官方固定路由到 `gemini`。
- 控制台数值配置改为数字输入，不再使用滑竿。
- 这是配置结构调整版本：从 `0.4.0` 升级时需要在控制台按新的三类供应商入口重新填写凭证、模型和 base URL。

## 0.4.0

- 重写控制台图像配置为协议优先模型，只保留 `openai-images`、`openai-chat`、`gemini` 三类顶层通道。
- 移除历史第三方供应商顶层选项与 Provider 注册别名，第三方聚合站统一通过 OpenAI-compatible 的 `baseUrl + apiKey + model + extraHeaders` 配置。
- 重写服务层 Provider 路由，删除供应商标签到协议标签的兼容分支，模型映射直接指向协议 / 通道。
- 这是配置结构清理版本：从 `0.3.0` 升级时需要在控制台重新选择协议并填写对应通道的凭证与模型。

## 0.3.0

- 新增 OpenAI 兼容协议选择：`openai-images` 用于 GPT-image 类 Images API，`openai-chat` 用于 Gemini Banana / Nano Banana 类 Chat Completions 多模态接口。
- 新增 OpenAI 兼容站点额外请求头配置，便于适配需要 `User-Agent` 等自定义请求头的第三方 API 站点。
- 新增 `openai-chat` 图像 Provider，并在服务层按 OpenAI 兼容协议路由到对应 Provider。
- 调整 MVP 命令为无前缀直呼格式：`文生图`、`图生图`、`图像额度`，保留 `t2i`、`i2i`、`quota` 别名。
- 修正 OpenAI Images API base URL 规范化，避免配置中包含 `/v1` 时重复拼接。

## 0.2.2

- 保持 V2 MVP 架构与基础图像命令可用。
