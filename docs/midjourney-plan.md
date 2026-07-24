# Midjourney + Kling 对接方案（统一异步 Provider）

> 状态：调研完成，API 全部确认可用。待实施。

## 调研结论

Kling 和 Midjourney 在 yunwu 上使用**完全相同的异步 API**，只需开发 **1 个 `MjProvider`** 同时覆盖两者。

**已验证通过的端点**：

| 端点 | 方法 | 用途 | 测试模型 | 结果 |
|------|------|------|---------|------|
| `/mj/submit/imagine` | POST | 文生图 | kling-image | ✅ 返回 task_id |
| `/mj/submit/describe` | POST | 图生文/识图 | kling-image-recognize | ✅ 返回 task_id |
| `/mj/task/{id}/fetch` | GET | 轮询结果 | kling-image | ✅ SUCCESS + imageUrl |

## 模型清单

### 图像模型（16 个，在 `/v1/models` 中已确认）

**MJ 系列**（12 个）：

| 模型 | 端点 | 价格 |
|------|------|------|
| `mj_imagine` | mj想象模式 | ⚡0.30 |
| `mj_upscale` | mj动作 | ⚡0.15 |
| `mj_variation` | mj动作 | ⚡0.30 |
| `mj_high_variation` | mj动作 | ⚡0.30 |
| `mj_low_variation` | mj动作 | ⚡0.30 |
| `mj_reroll` | mj动作 | ⚡0.30 |
| `mj_pan` | mj动作 | ⚡0.30 |
| `mj_zoom` | mj动作 | ⚡0.30 |
| `mj_blend` | mj混合 | ⚡0.30 |
| `mj_describe` | mj描述模式 | ⚡0.15 |
| `mj_modal` | mj模态模式 | ⚡0.30 |
| `mj_upload` | mj图片上传 | ⚡0.003 |

> ⚠️ `mj_custom_zoom`、`mj_inpaint` 定价为 0，需真实调用一次确认实际扣费。

**Kling 系列**（3 个）：

| 模型 | 端点 | 价格 |
|------|------|------|
| `kling-image` | kling生图, kling多图生图, kling扩图 | ⚡0.017 |
| `kling-omni-image` | omni-image | ⚡0.017 |
| `kling-image-recognize` | 图像识别 | ⚡0.017 |

**非图像模型**（需过滤）：

13 个音视频/未知类型模型（`kling-video`、`kling-audio` 等）已有 `model_type` 字段区分，现有目录过滤器会自动排除。

---

## 与 GPT/Gemini 的关键差异

| 维度 | GPT/Gemini（同步） | MJ/Kling（异步） |
|------|-------------------|-----------------|
| Provider 接口 | `generateImages()` 直接返回 `string[]` | `generateImages()` **内部阻塞轮询**后返回 `string[]` |
| 时间 | 3–30s | 30–120s |
| 响应格式 | 返回图片 URL 数组 | 单个 `imageUrl`（非数组） |
| 定价 | per-call / per-token | per-call（全部 `quota_type: 1`） |
| 多图生成 | `n` 参数 | 始终返回 1 张（yunwu 代理限制） |

---

## 实现计划

### 必须的代码改动

**1. 路由映射**（`src/suppliers/yunwu/routes.ts`）

`ENDPOINT_ROUTE_MAP` 新增 12 行：

```typescript
// Midjourney
{ endpoint: 'mj想象模式', protocol: 'mj', capability: 'text-to-image' },
{ endpoint: 'mj动作',     protocol: 'mj', capability: 'image-edit' },
{ endpoint: 'mj混合',     protocol: 'mj', capability: 'image-edit' },
{ endpoint: 'mj描述模式', protocol: 'mj', capability: 'image-recognize' },
{ endpoint: 'mj模态模式', protocol: 'mj', capability: 'text-to-image' },
{ endpoint: 'mj图片上传', protocol: 'mj', capability: 'image-edit' },
// Kling
{ endpoint: 'kling生图',     protocol: 'mj', capability: 'text-to-image' },
{ endpoint: 'kling多图生图', protocol: 'mj', capability: 'text-to-image' },
{ endpoint: 'kling扩图',     protocol: 'mj', capability: 'image-edit' },
{ endpoint: 'omni-image',    protocol: 'mj', capability: 'text-to-image' },
{ endpoint: '图像识别',      protocol: 'mj', capability: 'image-recognize' },
```

`model-catalog.ts` 需新增 `image-recognize` 能力类型。

**2. MjProvider**（`src/providers/midjourney.ts`）

```typescript
class MjProvider extends BaseImageProvider {
  async generateImages(prompt, imageUrls, numImages, options, onImageGenerated) {
    // 1. POST /mj/submit/imagine { prompt, model }
    const { result: taskId } = await this.submitImagine(prompt);

    // 2. 轮询 GET /mj/task/{taskId}/fetch
    const imageUrl = await this.pollTask(taskId, 300_000); // 最多 5 分钟

    // 3. 回调 + 返回
    if (onImageGenerated) await onImageGenerated(imageUrl, 0, 1);
    return [imageUrl];
  }

  private async submitImagine(prompt: string): Promise<{ result: string }> {
    return http.post(`${apiBase}/mj/submit/imagine`, {
      model: this.modelId,
      prompt,
    });
  }

  private async pollTask(taskId: string, timeoutMs: number): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const task = await http.get(`${apiBase}/mj/task/${taskId}/fetch`);
      if (task.status === 'SUCCESS') return task.imageUrl;
      if (task.status === 'FAILURE') throw new ProviderError(task.failReason);
      await sleep(3000);
    }
    throw new TimeoutError('MJ 任务超时');
  }
}
```

**3. Provider 注册**（`src/index.ts`）

在 `ProviderRegistry` 中注册 `mj` 协议 → `MjProvider`。

**4. 结算**（无改动）

所有 MJ/Kling 模型为 `quota_type: 1`（per-call），现有 `computeSupplierCreditsFromCatalog` 直接适用，无需修改。

### 不在此阶段实现的功能

| 功能 | 原因 |
|------|------|
| MJ 动作链（放大/变体/重绘） | 需要存储 `lastMjTaskId`，依赖 Phase 1 的 Provider 稳定后再加 |
| 多图参考生成 | 需确认 yunwu 的 payload 参数格式（image 字段） |
| 识图（describe） | 端点已验证，但返回文本而非图片，需独立的命令流 |

---

## 需注意的边界问题

### yunwu 自动注入 MJ 参数

yunwu 会在 prompt 后追加 `--ar 1:1 --v 7 --stylize 100 --relax`。如果用户 prompt 中已包含参数（如 `--ar 16:9`），需确认 yunwu 如何处理冲突。建议在 Provider 中去除用户 prompt 中的 `--` 参数，或允许用户通过选项显式传入。

### 单图返回

yunwu 代理的 MJ API 始终返回 1 张图（`imageUrl` 单数），不支持 `n` 参数批量。这不是 bug，是 yunwu 的限制。

### 定价为 0 的模型

`mj_custom_zoom` 和 `mj_inpaint` 在 `/api/pricing` 中 `model_price: 0`。作为 per-call 模型，`computeSupplierCreditsFromCatalog` 会返回 `0 × groupRatio = 0`。需用一次真实调用来确认 yunwu 实际扣费，如果确实免费则保持 0，如果扣费则需要 yunwu 修正定价数据。

### 轮询超时

当前命令超时为 300s（`COMMAND_TIMEOUT_SECONDS`），与 MJ Provider 的轮询超时一致。如果 MJ 任务超过 300s 仍未完成，Provider 抛出 `TimeoutError`，Orchestrator 按生成失败处理并释放预授权。不会造成积分泄漏。

---

## 工作量估计

| 文件 | 改动量 |
|------|--------|
| `routes.ts` | +12 行 |
| `model-catalog.ts` | +1 能力类型 |
| `midjourney.ts`（新） | ~150 行 |
| `index.ts` | +5 行（Provider 注册） |
| **合计** | **~170 行** |
