# Midjourney Imagine 契约（yunwu.mj.imagine）

> 状态：✅ Imagine 契约已实现并完成 v1.2.7 真实文生图验证（2026-07-29）
>
> 历史：旧文档中的 `POST /mj/submit/imagine { prompt, model }` 与参考图字段 `imageUrl` **已过时**。
> 当前实现遵循云雾 Apifox `published-project 5427167/232421938` 官方契约。

## 架构

`MjProvider`（`src/providers/midjourney.ts`）仅负责 **Imagine** 主链路（`yunwu.mj.imagine` / `yunwu.mj.imagine.reference`）。
MJ Action/Blend/Describe/Modal/Upload、Kling 生图/多图生图/扩图、omni-image、图像识别等目录 endpoint
本轮尚未接入契约层，`resolveYunwuRoutes` 将其排除，模型归类为 unsupported，运行时 fail-closed。

## 官方契约

### 端点

```
POST /mj/submit/imagine
GET  /mj/task/{taskId}/fetch
```

### 请求 Body（Imagine）

```jsonc
{
  "botType": "MID_JOURNEY",   // 必需；本轮仅暴露 MID_JOURNEY
  "prompt": "...",             // 必需
  "base64Array": ["data:..."], // 可选，垫图 data URL 列表
  "notifyHook": "https://...",// 可选
  "state": "..."                // 可选
}
```

**关键差异（相对旧实现）：**

- 不再发送 `model` 字段（官方契约未声明）。
- 不再发送 `imageUrl`；参考图先下载为 data URL 放入 `base64Array`。
- `--ar` / `--stylize` 由公共层 `resolveContractParams` 生成，作为 `promptAppends`
  拼接到 prompt 尾部；重复 flag 会被 `applyPromptAppends` 去重。
- Niji 需要单独契约声明 `botTypes: ['NIJI_JOURNEY']` 后才能开启；本轮不暴露。
- 云雾是否会在特定 botType / 帐户下自动追加 `--stylize/--relax/--v` 仍作为非阻断观察项；
  当前真实文生图验证未观察到重复 flag。

### v1.2.7 真实故障闭环

- 初次真实请求曾异步返回 `parameter error`。
- 日志对比确认实际 prompt 长度比合法描述多出动态模型后缀的长度：Koishi `[prompt:text]`
  保留了 `-mj`，它虽然已用于模型选择，却仍污染了发送给 Midjourney 的最终 prompt。
- 根因不是 `botType` 缺失，也没有证据表明是服务端重复追加 `--stylize`。
- `stripImageCommandControls()` 现在会在计费和 Provider 调用前剥离模型后缀、尺寸、比例、
  `-n` 与 `-add` 控制语法；修复后真实 Imagine 任务返回 `SUCCESS`。

### 任务查询

- `GET /mj/task/{taskId}/fetch` 只需 taskId + Authorization；忽略 Apifox 中被误填的
  DALL-E 风格 request body schema。
- 状态枚举：`SUCCESS` / `FAILURE` / 其它中间状态。
- 失败时读取 `failReason || description` 作为错误信息。

### 注意事项

- yunwu MJ 端点返回 `Content-Type: text/plain`，需要手动 `JSON.parse`。
- 图生图输入若全部下载失败，`MjProvider` fail-closed 抛错，不退化为文生图。
- MJ 任务链（Upscale / Variation / Reroll）依赖 `buttons[].customId`，本轮尚未实现。

## 可执行范围

- 当前只将 `mj_imagine` 作为可执行 MJ 路由。
- 定价从 yunwu 实时目录读取，并按当前模型映射的 `groupRatio` 结算；文档不固定抄写可能变化的目录价格。
- MJ Action / Blend / Describe / Modal / Upload 与 Kling 等端点即使存在于供应商目录，也因尚无独立契约而进入 `unsupported`。

## 待实现

- MJ 动作链（放大/变体/重绘/平移/缩放）
- 多图参考生成（kling多图生图）
- 识图返回文本流程
