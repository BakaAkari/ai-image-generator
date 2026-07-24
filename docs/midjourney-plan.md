# Midjourney 对接方案

> 状态：调研完成，待开通 yunwu MJ 渠道后实施

## 调研结论

yunwu 已封装 Midjourney API，使用标准 new-api/midjourney-proxy 协议。

**已确认可用端点**：

| 端点 | 方法 | 用途 | 单价（供应商积分） |
|------|------|------|------------------|
| `/mj/submit/imagine` | POST | 文生图 | ⚡0.3 |
| `/mj/submit/action` | POST | 放大/变体/平移/缩放/重绘 | ⚡0.15–0.3 |
| `/mj/submit/blend` | POST | 多图混合 | ⚡0.3 |
| `/mj/submit/describe` | POST | 图生文 | ⚡0.15 |
| `/mj/task/{id}/fetch` | GET | 轮询任务结果 | 免费 |

**请求格式**（已验证）：
```json
POST /mj/submit/imagine
{ "prompt": "一只猫", "model": "mj_imagine" }
```

**响应格式**（推测，标准 new-api 协议）：
```json
// 提交成功
{ "result": "task_id_string", "status": "SUBMITTED" }

// 轮询中
{ "status": "IN_PROGRESS", "progress": "50%" }

// 完成
{ "status": "SUCCESS", "image_url": "https://..." }

// 失败
{ "status": "FAILURE", "fail_reason": "..." }
```

---

## 架构差异：同步 vs 异步

| 层面 | 当前同步流程（OpenAI/Gemini） | MJ 异步流程 |
|------|---------------------------|-----------|
| **Provider 返回值** | `generateImages()` → `string[]`（图片 URL） | `submitImagine()` → `task_id`，`waitForTask()` → `string[]` |
| **Orchestrator** | 一次性等待 HTTP 响应 | 提交 → 轮询循环 → 超时兜底 |
| **流式回调** | `onImageGenerated(url, i, total)` 每张回调 | MJ 只有完成时回调一次 |
| **超时策略** | HTTP 超时 240s | 独立任务超时，推荐 300s |
| **结算** | per-call 用 `pricePerCall × groupRatio`，per-token 用 `totalTokens / 1M × outputPrice × groupRatio` | 固定 per-call：`model_price × groupRatio` |

---

## 实现计划

### Phase 1：基础 MJ 文生图（`mj` 命令）

**新增文件**：

| 文件 | 说明 |
|------|------|
| `src/providers/midjourney.ts` | `MjProvider`，继承 `BaseImageProvider`，实现异步生成 |
| `src/shared/mj-types.ts` | MJ 任务状态类型（`MjTaskStatus`, `MjSubmitResponse`, `MjFetchResponse`） |

**MjProvider 核心逻辑**：

```
generateImages(prompt, imageUrls, numImages, options, onImageGenerated)
  1. POST /mj/submit/imagine { prompt, model }
  2. 解析 task_id
  3. 轮询 GET /mj/task/{task_id}/fetch（间隔 3s，最多 300s）
  4. status === SUCCESS → 回调 onImageGenerated → 返回 [imageUrl]
  5. status === FAILURE → 抛 ProviderError
  6. 超时 → 抛 TimeoutError
```

**Provider 注册**（`src/index.ts`）：
- 在 `ProviderRegistry` 中注册 `mj` 协议
- 模型目录中 MJ 模型的 `routes[].protocol` 设为 `mj`

**模型目录适配**：
- `src/suppliers/yunwu/routes.ts` 新增 `mj想象模式` / `mj动作` / `mj混合` / `mj描述模式` → `protocol: 'mj'` 路由映射
- `src/suppliers/yunwu/capability.ts` 新增 `text-to-image-mj` 能力类型

**结算**：
- 复用现有 per-call 定价路径，无需改动 `settleReservation`

**命令入口**：
- `mj <prompt>` — 文生图，等同于 `/mj/submit/imagine`
- `mj 一只猫 --ar 16:9` — 支持宽高比参数

---

### Phase 2：MJ 动作链

**新增端点**：`POST /mj/submit/action`

动作类型：upscale(放大)、variation(变体)、high_variation、low_variation、reroll(重绘)、pan(平移)、zoom(缩放)、custom_zoom

**命令设计**：
- `mj-放大 <序号>` — 对上一次生成的图片按序号放大（U1–U4）
- `mj-变体 <序号>` — 变体（V1–V4）
- `mj-重绘` — 重新生成 4 张
- `mj-平移 <方向>` — 方向：left/right/up/down

**状态管理**：
- 需要记住用户上一次 `task_id` 和 `生成结果`（4 张图的序号映射）
- 可在 session 级别存储 `lastMjTaskId` 和 `lastMjImages`

---

### Phase 3：编辑/混合

| 命令 | 端点 | 说明 |
|------|------|------|
| `mj-混合 <图1> <图2>` | `/mj/submit/blend` | 双图混合 |
| `mj-描述 <图>` | `/mj/submit/describe` | 图生文 |

---

## 前置条件

**yunwu API key 需要开通 MJ 渠道**。当前测试返回：

```
分组 优质官转gemini... 下模型 mj_imagine 无可用渠道
```

联系 yunwu 客服开通后即可开发。

---

## 定价一览

所有 MJ 模型均为 `quota_type: 1`（per-call）：

| 模型 | 供应商积分/次 | ≈ 人民币 |
|------|-------------|---------|
| mj_imagine | 0.3 | ¥0.15 |
| mj_upscale | 0.15 | ¥0.075 |
| mj_variation | 0.3 | ¥0.15 |
| mj_blend | 0.3 | ¥0.15 |
| mj_describe | 0.15 | ¥0.075 |
| mj_modal | 0.3 | ¥0.15 |
| mj_reroll | 0.3 | ¥0.15 |

## 与 Kling 的关系

Kling 在 yunwu 上使用与 MJ 完全相同的异步 API（`/mj/submit/imagine` + `/mj/task/{id}/fetch`），两者共用同一个 `MjProvider`。详见 [kling-plan.md](./kling-plan.md)。
