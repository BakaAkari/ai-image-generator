# koishi-plugin-aka-ai-image-generator

[![npm](https://img.shields.io/npm/v/koishi-plugin-aka-ai-image-generator?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-aka-ai-image-generator)
[![License](https://img.shields.io/npm/l/koishi-plugin-aka-ai-image-generator?style=flat-square)](./LICENSE)

> ⚠️ **WIP / Phase 1**：本仓库是 [`aka-ai-generator`](https://www.npmjs.com/package/koishi-plugin-aka-ai-generator) 的 V2 重写版本，目前仅完成脚手架阶段（Phase 1），暂不可用于生产。

面向多供应商的 Koishi AI 图像生成插件，支持文生图 / 图生图 / 风格迁移 / 视频生成等场景，提供统一的额度、计费与限流体系。

---

## 项目定位

- **插件 ID**：`aka-ai-image-generator`
- **服务名**：`aiImageGenerator`
- **命令前缀**：`aig.`
- **数据目录**：`data/aka-ai-image-generator/`
- **发布平台**：npm（`koishi-plugin-aka-ai-image-generator`）
- **来源**：完全独立于 `aka-ai-generator` 重写，可与 v1 并存

## V1 → V2 设计目标

| 维度 | v1（aka-ai-generator） | V2（aka-ai-image-generator） |
| --- | --- | --- |
| 架构 | Provider 单层、命令耦合编排 | 三层（Provider / Service / Orchestrator）解耦 |
| 配置 | StyleConfig 含运行时字段 | 文生图 / 图生图分模式 + Tagged Union |
| 错误处理 | 散落在 Provider 内 | 统一错误体系 + RetryPolicy + TimeoutPolicy |
| 模型能力 | 字符串 enum 散落 | 中央化 ModelCapabilityRegistry |
| 监控 | 无 | Metrics 钩子 + HealthProbe + CircuitBreaker |
| 类型 | 部分 any | 严格 strict + noUncheckedIndexedAccess |

完整设计文档见 [`plans/ai-generator-v2-architecture.md`](../../plans/ai-generator-v2-architecture.md)。

## 阶段进度

- [x] **Phase 1**：脚手架 + 资产盘点
- [ ] Phase 2：基础设施 + 第一个 Provider（OpenAIImages）
- [ ] Phase 3：Schema 终态 + 全部 Provider
- [ ] Phase 4：服务层 + Orchestrator + 命令
- [ ] Phase 5：迁移工具 + 文档 + 发布

## 数据目录结构

```
data/aka-ai-image-generator/
├── users_data.json              # 用户额度 / 充值 / 消费记录
├── pending_video_tasks.json     # 待结算的视频任务
└── recharge_history.json        # 全量充值流水
```

> 从 v1 迁移：插件首次启动时若检测到 `data/aka-ai-generator/users_data.json` 但 v2 目录尚未初始化，将自动复制一次（详见 Phase 5）。

## 命令规划（V2）

| 命令 | 功能 | 说明 |
| --- | --- | --- |
| `aig.txt2img <prompt>` | 文生图 | 主命令 |
| `aig.img2img <prompt>` | 图生图 | 引用图片或直接传入 |
| `aig.style <preset> <prompt>` | 风格迁移 | 调用预设 StyleConfig |
| `aig.video <prompt>` | 视频生成 | 异步任务，需轮询 |
| `aig.quota` | 查询额度 | 自助查询 |
| `aig.admin.*` | 管理面板 | 仅管理员 |

实际命令以 v1.0.0 发布为准。

## 安装

```bash
# 通过 npm
npm install koishi-plugin-aka-ai-image-generator

# 或在 Koishi 控制台 → 插件市场搜索 aka-ai-image-generator
```

## 开发

```bash
# 在 koishi-dev 工作区下
pnpm install
pnpm --filter koishi-plugin-aka-ai-image-generator build
```

## 目录结构

```
src/
├── index.ts                 # 插件入口
├── shared/                  # 配置 / 常量 / 类型 / 工具
│   ├── config.ts
│   ├── constants.ts
│   ├── types.ts
│   └── prompt-timeout.ts
├── providers/               # 各 AI 供应商适配
│   └── utils.ts
├── services/                # 长期状态管理
│   └── UserManager.ts
├── core/                    # 进程内核心模块
│   └── image-context-store.ts
└── utils/                   # 输入解析 / 命令解析
    ├── input.ts
    └── parser.ts
```

## 许可

MIT © 2026 BakaAkari
