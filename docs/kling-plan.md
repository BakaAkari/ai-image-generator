# Kling 对接方案

> 状态：调研完成，与 MJ 共用异步 Provider

## 调研结论

Kling 在 yunwu 上与 Midjourney 使用**完全相同的异步 API**：

```
POST /mj/submit/imagine  { prompt, model: 'kling-image' }  →  { result: task_id }
GET  /mj/task/{id}/fetch                                  →  { status, imageUrl }
```

已验证：`kling-image` 通过 MJ 端点提交成功，任务正常轮询返回 `IN_PROGRESS`。

## Kling 模型清单

| 模型 | 端点 | 价格 | 能力 |
|------|------|------|------|
| `kling-image` | kling生图, kling多图生图, kling扩图 | ⚡0.017 | 文生图、图生图、**多图参考生图**、**扩图**、图像编辑 |
| `kling-omni-image` | omni-image | ⚡0.017 | 专业创意套件（视频+图像） |
| `kling-image-recognize` | 图像识别 | ⚡0.017 | **图生文/识图** |

## 与 Midjourney 的关系

| 维度 | MJ | Kling |
|------|-----|-------|
| 提交端点 | `POST /mj/submit/imagine` | **相同** |
| 轮询端点 | `GET /mj/task/{id}/fetch` | **相同** |
| 响应格式 | `{ result, status, imageUrl }` | **相同** |
| Provider | `MjProvider` | **共用，仅 model 参数不同** |
| 价格 | ⚡0.15–0.30 | ⚡0.017 |
| 独有能力 | blend, describe, modal | **多图参考、扩图、识图** |

## Kling 独有能力

### 1. 多图参考生成

用户上传 1-3 张参考图 + prompt，Kling 融合多图风格生成新图。

```
mj 参考这张风格，画一只猫  ← 命令格式待定
```

需在 `POST /mj/submit/imagine` 的 payload 中添加参考图参数（Base64 或 URL）。具体字段名需查阅 yunwu 文档或逆向。

### 2. 扩图（Outpainting）

把图片边界向外扩展，AI 填充新区域。

```
mj-扩图 ← 对上次生成的图扩边
```

### 3. 识图（Image-to-Text）

上传图片，返回文字描述。

```
识图 ← 对引用的图片进行描述
```

需确认独立端点：可能是 `/mj/submit/describe`（与 MJ describe 共用）或专用端点。测试时验证。

## 实现计划

**Phase 1**：基础 Kling 文生图（与 MJ Provider 同步实现）
- 在 `ENDPOINT_ROUTE_MAP` 添加 kling 路由
- 共用 `MjProvider`，仅 model 参数区分
- 定价：per-call ⚡0.017

**Phase 2**：Kling 独有能力（MJ Provider 扩展）
- 多图参考生成：`POST /mj/submit/imagine` + image 参数
- 识图：`POST /mj/submit/describe` 或 `/kling/recognize`
- 扩图确认端点

## 路由注册

`ENDPOINT_ROUTE_MAP` 需新增：

```typescript
{ endpoint: 'kling生图',     protocol: 'mj', capability: 'text-to-image' },
{ endpoint: 'kling多图生图', protocol: 'mj', capability: 'text-to-image' },
{ endpoint: 'kling扩图',     protocol: 'mj', capability: 'image-edit' },
{ endpoint: 'omni-image',    protocol: 'mj', capability: 'text-to-image' },
{ endpoint: '图像识别',      protocol: 'mj', capability: 'image-recognize' },
```

## 与 MJ 文档的关系

本方案是 [midjourney-plan.md](./midjourney-plan.md) 的补充。`MjProvider` 的异步轮询、超时策略、结算方式对两者完全一致，不重复描述。
