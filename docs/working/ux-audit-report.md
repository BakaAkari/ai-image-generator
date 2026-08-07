# aka-ai-image-generator · 交互面全审计（2026-08-06）

范围：aka-tools 面板（client/page.vue）所有可见分区 + 用户/管理员聊天命令（src/commands/*.ts）+ 隐藏 Koishi 侧字段（src/shared/config.ts）。分类：
- **DELETE**：修复后意义不大 / 误导 / 死配置。
- **CHANGE-INTERACTION**：交互方式应改（收起、弹窗确认、文案重写、位置迁移）。
- **REFACTOR-MERGE**：可合并 / 重构（去重、聚合）。

评级维度：使用频率、误导代价、修复后的价值。**本报告仅审计与建议，不落地任何改动。**

---

## 面板：总览（activeTab === 'overview'）

| # | 元素 | 分类 | 现状 | 理由 | 建议 |
|---|---|---|---|---|---|
| 1 | `stat-card · 消耗(USD)` | CHANGE-INTERACTION | 显示 `billing.supplierCredits` 累计消耗（美元），`overview-stats` 后端使用 `usdToRmb` 汇率转成人民币视图 | 单一 USD 显示对国内运营不直观；账单/充值等其它环节全用人民币 | 增加同行 `≈¥…`（用当前 `usdToRmb`），或改成人民币主展示，USD 悬浮 tooltip |
| 2 | `stat-card · Key 限额` | CHANGE-INTERACTION | 显示 `billing.hardLimitUsd`；仅 NewAPI 系有 | 无限额或非 NewAPI 时永远 `—`，占位空 | 无 hardLimit 时隐藏整块，不占格 |
| 3 | `stat-card · 试用已用（张）` | CHANGE-INTERACTION | 累计试用张数（生命周期总量） | 试用是每日重置的资源；累计张数意义弱 | 改为"今日试用/上限"或"本月试用"，与 `trialImageLimit` 关联 |
| 4 | `k-card · 用户用量排行 Top 20` | CHANGE-INTERACTION | 固定 Top 20 | 用户多时 20 条不够，少时冗长 | 支持分页 / 按输入过滤 userId |

## 面板：供应商与凭证（activeTab === 'credentials'）

| # | 元素 | 分类 | 现状 | 理由 | 建议 |
|---|---|---|---|---|---|
| 5 | `supplier-picker · OpenAI 官方 / Gemini 官方 · disabled` | DELETE | 两卡显示"暂未适配" | 长期 disabled，只是占位；`SupplierOptions` 只维护 `newapi` 一路 | 隐藏 disabled 项，或改成"即将支持"轻量文案避免消耗屏幕 |
| 6 | `额外请求头` 编辑器 | CHANGE-INTERACTION | 键/值裸展示，未提供预设模板（比如 `Referer`、`X-Api-Version`） | 大多数用户不知需要哪些 header | 增加"常用模板"下拉；空数组时给"已足够，无需额外 header"的显式提示 |

## 面板：模型目录（activeTab === 'catalog'）

| # | 元素 | 分类 | 现状 | 理由 | 建议 |
|---|---|---|---|---|---|
| 7 | `预估成本` 列 hint "仅参考，运行时以目录价格为准" | CHANGE-INTERACTION | 每行都嵌一段小字提示 | 重复文案占空间；且"目录价格"术语不清 | 移到列表 header 的一次性提示；说明写清"USD 成本 × 汇率 × 加成/积分 = 最终扣费" |
| 8 | 模式 tag（文生图/图生图/合成图） | REFACTOR-MERGE | 每模型仍展示 `modes[]` | 模型映射页已限定用途，目录页展示重复 | 改为"支持能力"小字标签，不再作为独立列 |

## 面板：模型映射（activeTab === 'mappings'）

| # | 元素 | 分类 | 现状 | 理由 | 建议 |
|---|---|---|---|---|---|
| 9 | ~~`计费探测` 列~~ | 已 DELETE（本次） | — | 本次已删除；见交接单 A.5 | — |
| 10 | `倍率覆盖` 列 | CHANGE-INTERACTION | `el-input-number` 直填，无 tooltip 解释 | 用户不知何时该覆盖，与 `enable_groups` 关系不清 | 改为 tooltip：解释"留空 = 表值自动选最贵渠道上界；MJ 等表内无匹配分组时手填"；置默认提示 `MJ-x 组 ≈ 0.04-0.07` |
| 11 | `状态` 列（可用/失效） | REFACTOR-MERGE | 单独一列显示 valid/invalid | 无法排序；失效模型无操作提示 | 与"模型"列合并（前置图标）；失效行加"点击查看原因/切换目录"链接 |
| 12 | 排序按钮 `↑ ↓` | CHANGE-INTERACTION | 只上下移一格 | 大量映射时低效 | 支持拖拽（首行即默认模型的语义要强化） |

## 面板：Prompt 预设（activeTab === 'presets'）

| # | 元素 | 分类 | 现状 | 理由 | 建议 |
|---|---|---|---|---|---|
| 13 | "分组仅用于后台分类"提示 | CHANGE-INTERACTION | 每次进入 tab 都显示同一段 hint | 老用户看烦 | 首次访问后可关闭 / 用问号图标弹出 |
| 14 | "未分组" 与 分组区结构 | REFACTOR-MERGE | 两个不同的 `preset-section` 但视觉结构完全一致 | 代码/模板重复 | 抽出 `<PresetSection>` 组件，`groupName` 为 null 或 string 复用 |
| 15 | "移动到" 下拉 | CHANGE-INTERACTION | 隐藏在每条预设的 `el-form` 底部 | 深层交互，用户容易漏 | 提到 el-collapse-item 标题栏或加"多选批量移动" |

## 面板：定价（activeTab === 'pricing'）

| # | 元素 | 分类 | 现状 | 理由 | 建议 |
|---|---|---|---|---|---|
| 16 | 分区 A（平台积分）里的"每日免费试用模型" | REFACTOR-MERGE | 与运营页"试用图片张数"割裂 | 试用相关字段散在两处 | 迁到"运营 → 试用"新增独立分区 |
| 17 | 分区 B "自动定价（USD 成本 → 平台积分 → 用户售价）" | CHANGE-INTERACTION | 5 个字段全部裸暴露（`creditsPerCny` / `pricingMarkupPercent` / `usdToRmb` / `quotaPerUnit` / `perTokenEstimateTokens`） | 后两项属于高级参数，日常运营无需接触；错改 `quotaPerUnit` 直接把结算金额缩放 500 倍 | 拆两层：常用（前 3 项）默认可见，高级（`quotaPerUnit`、`perTokenEstimateTokens`）折叠 + 修改前弹二次确认 |
| 18 | 分区 C（日志真源结算凭据） | CHANGE-INTERACTION | 已折叠，标题 "C · 日志真源结算凭据（可选）" | 用户看不出"配置后能做什么" | 加一行说明："配置后 MJ / gemini 等逐任务精确计费的模型按日志真源结算" |
| 19 | 分区 D `showQuotaInImageCommands` 子开关 | CHANGE-INTERACTION | 描述"需先开启上方 showCreditCostInResult" | 交互耦合，`showCreditCostInResult` 关闭时子开关仍可点 | 关闭主开关时 disabled 子开关，避免误配置 |
| 20 | "公式" hint（16px 缩进的小字块） | DELETE | 说明结算公式；重复了分区 B 的意图 | 用户看到公式无法验证；文档应归位到 `docs/` | 移到帮助中心/README；面板保留跳转链接 |

## 面板：运营（activeTab === 'operations'）

| # | 元素 | 分类 | 现状 | 理由 | 建议 |
|---|---|---|---|---|---|
| 21 | 免计费设置分区 | REFACTOR-MERGE | 只有 `freePlatforms` 一个字段 | 单独分区过重 | 与"生成默认值"合并到"运行行为"分区 |
| 22 | 请求限流 / 安全策略 | REFACTOR-MERGE | 4 个数字字段，各自独立分区 | 相关性强（都是防滥用），空间浪费 | 合并为"防滥用"分区，同一个 form 表格 |
| 23 | 用户与权限（管理员 / 永久会员 / 白名单）| REFACTOR-MERGE | 3 个 `el-select multiple` 顺序展示 | 相同结构、相同行为 | 改成 tabs 或"权限矩阵"表格：一行一用户，多列勾选管理员/会员/白名单 |
| 24 | 集成 chatluna / yesimbot | REFACTOR-MERGE | 各自 7 / 3 个开关，均只有 enabled=true 时展开 | 结构一致，风格混乱 | 抽 `<IntegrationCard>` 组件；标题带 `enabled` 状态徽标 |
| 25 | 生成默认值 · 按平台覆盖交互模式 | CHANGE-INTERACTION | 空数组时显示占位，但下拉里能预填 `session.platform` 的建议 | 用户不知有哪些 platform 值；靠猜 | 从 `state.knownPlatforms` 拉运行时已见 platform 列表，作为下拉默认选项 |
| 26 | "全局超时 / 目录刷新间隔 / 日志级别在 Koishi 插件设置页管理" hint | CHANGE-INTERACTION | 底部一行 hint | 用户在这里改想调超时，被踢到别处很割裂 | 加一个"打开 Koishi 设置"直达按钮（`router.push`） |

## 面板：全局

| # | 元素 | 分类 | 现状 | 理由 | 建议 |
|---|---|---|---|---|---|
| 27 | `floating-tools` 视频/存储按钮 | CHANGE-INTERACTION | 视频按钮跳转 `/aka-tools-video`；存储按钮 disabled | 存储长期 disabled 是"即将推出"，可能 6 个月内没落地 | disabled 卡不显示，或降级到设置页里的"敬请期待"文案 |
| 28 | `k-layout` header 面包屑 `aka-tools · 图像生成` | REFACTOR-MERGE | 静态文字 | 视频页同款 header 是"aka-tools · 视频生成" | 抽 `<AkaToolsHeader tab="image">` 复用 |
| 29 | `setupGuide` 字段 | DELETE | Config.setupGuide 保留初始化说明字符串，但面板未渲染；仅 Koishi 设置页只读只显 | 死配置，`Config` interface 挂在结构里但用户看不到 | 从 Config 中移除；帮助文档改进后放到 README |
| 30 | `pluginSchema.hidden().collapse()` 大量隐藏字段 | DELETE | 所有业务分组在 Koishi 侧全部 hidden，只是为了兼容持久化 | 长期看是死代码；面板真正管理 | 后续可清理 CONFIG_GROUPS，`Config` 只保留 runtime interface；schema 仅暴露 GlobalRuntimeSchema |

## 聊天命令（普通用户）

| # | 元素 | 分类 | 现状 | 理由 | 建议 |
|---|---|---|---|---|---|
| 31 | `文生图 [prompt:text]` 无 prompt 时静默 prompt 等待 | CHANGE-INTERACTION | `请发送画面描述；回复「取消」中止` | 提示未列可用参数 | 补一行"可加 -n / -1k / -16:9 / -模型后缀" |
| 32 | `图生图` / `合成图` 相同的等待反馈 | REFACTOR-MERGE | 三个命令的 collect* 函数结构相似 | orchestrator 内三段 collectXxxInput | 抽公用 waitFor 状态机（当前基本可复用） |
| 33 | `-add` 参数 | CHANGE-INTERACTION | 追加词以字符串拼接进 prompt | 参数说明只在 `图像参数` 命令能查到 | 命令 usage 里也提及 |
| 34 | `图像查询`（自查 vs @用户） | CHANGE-INTERACTION | 同名命令，管理员用 @user 走另一分支 | 权限校验放在 body 里，报错时体验割裂 | 拆两条命令：`图像查询`（自查） + `图像查询 @用户`（admin only），或用 `--user` option |
| 35 | `图像账单` `--all` 参数 | CHANGE-INTERACTION | 需要打 `--all` | 与"查我账单"混用 | 改为独立命令 `图像账单-全部` 或 tab 化 |
| 36 | `图像充值 @用户 100 [原因]` | CHANGE-INTERACTION | 输入是"人民币金额"，实际写入是"平台积分 = 人民币 × creditsPerCny" | 命令名叫"充值"但金额语义不清 | 命令帮助补一句："金额为人民币，实际积分按当前汇率折算" |
| 37 | `图像排行榜 -n <数量>` | CHANGE-INTERACTION | 无默认输出上限；`resolveRankingLimit` 处理 | 大群大量用户时输出可能溢出消息长度 | 硬限最多 20，多余给 tip |
| 38 | 快捷命令（Style 预设） | REFACTOR-MERGE | 用 `ctx.command(commandName)` 动态注册，未列在 `图像指令` 帮助 | 用户看不到有哪些预设可用 | `图像指令` 输出附带当前预设列表 |

## 隐藏字段 / Config interface

| # | 元素 | 分类 | 现状 | 理由 | 建议 |
|---|---|---|---|---|---|
| 39 | `Config.provider` (`@deprecated 0.5.9`) | DELETE | 只为反序列化保留 | 3 版本前的字段，migration 已处理 | 下一次 major bump 时移除 |
| 40 | `Config.defaultCreditCostPerImage` | DELETE | `@deprecated 0.9.0` | 同上 | 同上 |
| 41 | `Config.creditExchangeRate` / `Config.costMarkup` | DELETE | migration 会读一次，之后不再用 | 同上 | 同上 |
| 42 | `Config.yunwuGroupRatio` / `Config.yunwuGroup` / `Config.yunwuCreditToRmb` | DELETE | yunwu 时代字段，migration 已处理 | 同上 | 下一次 major bump 时移除 |
| 43 | `Config.supplierCreditToRmb` | DELETE | 1.1.2 起改用 `usdToRmb`；migration 已迁移 | 同上 | 下一次 major bump 时移除 |
| 44 | `Config.modelCostProbes` | DELETE | 类型是 `Record<string, never>`，永远为空 | 死字段 | 立刻可删 |
| 45 | `ModelMappingConfig.groupRatio` / `.creditCostPerImage` / `.supplier` / `.protocol` / `.provider` | DELETE | 多字段 `@deprecated`，migration 清理 | 同 39-42 | 下一次 major bump 时移除 |
| 46 | ~~`Config.probeApiBase` / `probeApiKey` / `probeRateLimit` / `probePrompt` / `probeReserveMargin`~~ | 已 DELETE（本次） | — | migration 会清理旧 settings.json | — |

## 用量统计 (`overview-stats.ts` 视图)

| # | 元素 | 分类 | 现状 | 理由 | 建议 |
|---|---|---|---|---|---|
| 47 | `overview.totals.successRate` | CHANGE-INTERACTION | 计算方式：`totalImages / (totalImages + totalFailed)` | 单一维度，且 failed 计数仅记内容审查/API 错误，未区分用户取消 | 拆"成功率（技术）"和"完成率（含用户取消）"两指标；或增加 tooltip 说明口径 |

## 分类统计（去除已实施项）

| 分类 | 待办数 |
|---|---|
| DELETE | 6（对应表 5、20、29、30、39-45 汇总一族） |
| CHANGE-INTERACTION | 20 |
| REFACTOR-MERGE | 8 |

## 建议的落地优先级

1. **P0（本次即可搭车）** — 无。本次仅移除探测；不引入 UX 变更。
2. **P1（下个迭代）** — 表 17（`quotaPerUnit`/`perTokenEstimateTokens` 折叠 + 弹窗确认，防误改缩放结算）；表 19（子开关联动 disable）；表 5（隐藏 disabled 供应商卡）；表 44（删除 `modelCostProbes` 死字段）。
3. **P2** — 表 21-24（运营页四大分区合并整理）；表 34-38（命令语义整理）；表 11-12（映射表交互升级）。
4. **P3（大 refactor）** — 表 30（清理 CONFIG_GROUPS）、表 39-45（下一次 major bump 时统一删除历史 deprecated 字段）。
