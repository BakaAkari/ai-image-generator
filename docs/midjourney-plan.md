# Midjourney + Kling 异步 Provider（已实现）

> 状态：✅ 已实现（2026-07-24）

## 架构

Kling 和 Midjourney 共用同一个 `MjProvider`（`src/providers/midjourney.ts`），yunwu 将两者统一封装为异步 task API。

### API 端点

```
POST /mj/submit/imagine  →  { result: taskId }
GET  /mj/task/{id}/fetch →  { status, imageUrl, progress }
```

### 流程

1. `POST /mj/submit/imagine { prompt, model }` → 获取 `task_id`
2. 每 3s 轮询 `GET /mj/task/{task_id}/fetch`
3. `status === 'SUCCESS'` → 返回 `imageUrl`
4. `status === 'FAILURE'` → 抛异常
5. 超时 300s → 抛 `TimeoutError`

### 注意事项

- yunwu MJ 端点返回 `Content-Type: text/plain`，需要手动 `JSON.parse`
- yunwu 会在 prompt 后自动追加 `--v 7 --stylize 100 --relax` 等参数
- MJ 任务链（放大/变体/重绘）依赖上一次的 `task_id`，需在 session 层存储，尚未实现

## 模型清单

### 已对接（18 个可执行）

| 协议 | 模型数 | 代表模型 |
|------|--------|---------|
| mj | 15 | mj_imagine, mj_upscale, mj_variation, mj_blend, mj_describe, mj_modal, ... |
| kling | 3 | kling-image, kling-omni-image, kling-image-recognize |

### 定价

全部为 `quota_type: 1`（per-call），按 `pricePerCall × groupRatio` 结算，无需 per-token 公式。

| 模型 | 供应商积分/次 |
|------|-------------|
| mj_imagine | ⚡0.30 |
| mj_upscale | ⚡0.15 |
| mj_variation | ⚡0.30 |
| mj_blend | ⚡0.30 |
| mj_describe | ⚡0.15 |
| kling-image | ⚡0.017 |
| kling-omni-image | ⚡0.017 |
| kling-image-recognize | ⚡0.017 |

## 待实现

- MJ 动作链（放大/变体/重绘/平移/缩放）
- 多图参考生成（kling多图生图）
- 识图返回文本流程
