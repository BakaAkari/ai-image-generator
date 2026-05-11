# Changelog

## 0.3.0

- 新增 OpenAI 兼容协议选择：`openai-images` 用于 GPT-image 类 Images API，`openai-chat` 用于 Gemini Banana / Nano Banana 类 Chat Completions 多模态接口。
- 新增 OpenAI 兼容站点额外请求头配置，便于适配需要 `User-Agent` 等自定义请求头的第三方 API 站点。
- 新增 `openai-chat` 图像 Provider，并在服务层按 OpenAI 兼容协议路由到对应 Provider。
- 调整 MVP 命令为无前缀直呼格式：`文生图`、`图生图`、`图像额度`，保留 `t2i`、`i2i`、`quota` 别名。
- 修正 OpenAI Images API base URL 规范化，避免配置中包含 `/v1` 时重复拼接。

## 0.2.2

- 保持 V2 MVP 架构与基础图像命令可用。
