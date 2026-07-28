/**
 * wizard-handler.ts —— 多步骤图像生成向导编排层。
 *
 * 向导驱动方式：命令触发 handleCommand 启动会话，中间件拦截后续消息，
 * 按 WizardSession.step 分派到对应处理器。全部文本/参数由 PROTOCOL_PARAMS
 * 和 catalog 驱动，无硬编码。
 *
 * 变更要点：
 * - param-select 改为一次性列出所有参数，逗号分隔输入
 * - 图生图支持分步输入（先图片后文字）
 * - session 清理延后到 handleConfirm 开始时释放（不阻塞新命令）
 * - 中间件只拦截有活跃会话的消息，无会话时完全放行
 * - 所有模型均显示，无额外过滤
 * - getProtocol → resolveProtocol 消除命名歧义
 */
import { h } from 'koishi'
import type { Argv, Context, Fragment, Session } from 'koishi'

import type { Config } from '../shared/config.js'
import { PROTOCOL_PARAMS } from '../shared/protocol-params.js'
import type { ProtocolParams, ParamDef } from '../shared/protocol-params.js'
import { estimatePreGenerationCost } from '../shared/billing.js'
import type { CatalogSnapshot, ImageModelInfo } from '../catalog/types.js'
import type { ImageGenerationHandlers } from '../orchestrators/ImageGenerationOrchestrator.js'
import type { AiImageGeneratorService } from '../service/AiImageGeneratorService.js'
import type { WizardSession, WizardSessionManager } from '../services/wizard-session.js'
import type { ImageGenerationModifiers, ModelMappingConfig } from '../shared/types.js'
import { parseMessageImagesAndText } from '../utils/input.js'
import { buildModelMappingIndex, parseStyleCommandModifiers } from '../utils/parser.js'

export interface CreateWizardHandlerParams {
  ctx: Context
  catalog: { current: CatalogSnapshot | null }
  service: AiImageGeneratorService
  handlers: ImageGenerationHandlers
  getConfig: () => Config
  wizardSessions: WizardSessionManager
}

export interface WizardHandler {
  /**
   * 从命令 action 调用，启动向导并返回首条提示。
   * argv/imgParam/prompt 若提供，会用于正确切分 flags 与 prompt 文本，
   * 避免向导把命令词或 `-16:9` 等参数 flag 塞进最终 prompt。
   */
  handleCommand(
    session: Session,
    commandName: string,
    argv?: Argv,
    imgParam?: unknown,
    prompt?: string,
  ): Promise<string | void>
  /** Koishi 中间件：处理活跃向导的后续消息 */
  getMiddleware(): (session: Session, next: () => Promise<void | Fragment>) => Promise<void | Fragment | string>
}

export function createWizardHandler(params: CreateWizardHandlerParams): WizardHandler {
  const { ctx, catalog, service, handlers, getConfig, wizardSessions } = params
  const logger = ctx.logger('wizard-handler')

  // ─── 工具函数 ──────────────────────────────────────────────────────────────

  function getModels(): ImageModelInfo[] {
    return catalog.current?.models ?? []
  }

  function getModel(id: string): ImageModelInfo | undefined {
    return getModels().find(m => m.id === id)
  }

  /** 从 route 解析协议，不再从名称猜测 */
  function resolveProtocol(modelId: string): string {
    return getModel(modelId)?.routes[0]?.protocol ?? 'openai'
  }

  function getModelLabel(id: string): string {
    return getModel(id)?.description ?? id
  }

  function estimateCost(modelId: string): number {
    try {
      return estimatePreGenerationCost(modelId, getConfig(), getModels()).totalCredits
    } catch {
      return 0
    }
  }

  /** 协议名 → 显示标签 */
  const PROTOCOL_LABELS: Record<string, string> = {
    openai: 'OPENAI',
    gemini: 'GEMINI',
    mj: 'MJ',
  }

  /** 通过 catalog modelId 反查用户配置的 ModelMappingConfig（restricted flag 只存在于映射上） */
  function findMappingByModelId(modelId: string): ModelMappingConfig | undefined {
    return (getConfig().modelMappings ?? []).find(m => m.modelId === modelId)
  }

  /** 校验用户是否可访问该模型（受限模型仅管理员/白名单）——wizard/style 都必须走这里 */
  function checkModelAccessByModelId(userId: string, modelId: string) {
    const mapping = findMappingByModelId(modelId)
    return service.checkModelAccess(userId, mapping ? { modelMapping: mapping } : {})
  }

  /** 命令行后缀展示：确保带前导 `-`（与 help.ts normalizeSuffixLabel 语义一致） */
  function normalizeMappingSuffixLabel(value: string): string {
    const trimmed = value.trim()
    if (!trimmed) return '-'
    return trimmed.startsWith('-') ? trimmed : `-${trimmed}`
  }

  /** 模型选择的唯一事实源：配置页 modelMappings，而非供应商刷新出来的全量 catalog 目录 */
  function getConfiguredMappings(): ModelMappingConfig[] {
    return getConfig().modelMappings ?? []
  }

  /** 用户可见的模型映射：受限模型（restricted）对非白名单/非管理员直接过滤掉，不列入选项 */
  function getVisibleMappings(userId: string): ModelMappingConfig[] {
    return getConfiguredMappings().filter(m => service.checkModelAccess(userId, { modelMapping: m }).allowed)
  }

  /** 模型展示名：优先用映射 suffix，映射缺失时回退 catalog 描述/modelId */
  function getModelDisplayLabel(modelId: string): string {
    const mapping = findMappingByModelId(modelId)
    return mapping ? normalizeMappingSuffixLabel(mapping.suffix) : getModelLabel(modelId)
  }

  // ─── 渲染函数（全部从 PROTOCOL_PARAMS 和 catalog 驱动） ───────────────────

  /**
   * 渲染模型列表：数据源是配置页 modelMappings（用户可选模型的唯一事实源），
   * 不是供应商刷新出来的全量目录。受限模型对非白名单/非管理员直接不列入。
   * 无介绍文字，直接是编号列表。免计费平台省略成本/异步标签，只显示协议+后缀。
   */
  function renderModelList(userId: string, platform?: string): string {
    const allMappings = getConfiguredMappings()
    if (!allMappings.length) return '模型映射为空，请管理员在配置页添加模型映射'

    const mappings = getVisibleMappings(userId)
    if (!mappings.length) return '当前无可用模型（受限模型仅管理员/白名单）'

    const freePlatform = service.isFreePlatform(platform)
    const lines: string[] = []
    for (let i = 0; i < mappings.length; i++) {
      const mapping = mappings[i]
      const proto = resolveProtocol(mapping.modelId)
      const providerLabel = PROTOCOL_LABELS[proto] ?? proto.toUpperCase()
      if (freePlatform) {
        lines.push(`${i + 1} · [${providerLabel}] ${normalizeMappingSuffixLabel(mapping.suffix)}`)
        continue
      }
      const cost = estimateCost(mapping.modelId)
      const costText = cost > 0 ? `~${service.formatCredits(cost)}` : '免费'
      const pp = PROTOCOL_PARAMS[proto]
      const asyncTag = pp?.async
        ? ` 异步 ${pp.async.minSec}-${pp.async.maxSec}s`
        : ''
      lines.push(`${i + 1} · [${providerLabel}] ${normalizeMappingSuffixLabel(mapping.suffix)}  ${costText}${asyncTag}`)
    }
    return lines.join('\n')
  }

  /** 一次性列出所有参数，用户以逗号分隔输入，不再逐项收集；每个参数的可选项各占一行，方便区分 */
  function renderParamList(protocol: string): string {
    const pp = PROTOCOL_PARAMS[protocol]
    if (!pp?.params.length) return '该模型无额外参数'

    const providerLabel = PROTOCOL_LABELS[protocol] ?? protocol.toUpperCase()
    const lines: string[] = [
      `${providerLabel} 参数设置`,
      `按「${pp.params.map(p => p.label).join(' → ')}」顺序逗号分隔输入，或回复「跳过」使用全部默认值`,
      '',
    ]

    pp.params.forEach((p, idx) => {
      if (idx > 0) lines.push('')
      if (p.type === 'enum') {
        lines.push(`${p.label}：`)
        const options = p.options ?? []
        options.forEach((opt, j) => {
          const display = p.displayValues?.[j] ?? opt
          const def = opt === p.default ? '【默认】' : ''
          lines.push(`${j + 1} · ${display}${def}`)
        })
      } else {
        const range = p.min != null && p.max != null ? `${p.min}-${p.max}` : ''
        lines.push(`${p.label}：输入 ${range}（默认 ${p.default}）`)
      }
    })

    // 生成示例（默认值）
    const exampleParts = pp.params.map((p) => {
      if (p.type === 'enum') {
        const defaultIdx = (p.options ?? []).indexOf(String(p.default))
        return String(defaultIdx >= 0 ? defaultIdx + 1 : 1)
      }
      return String(p.default)
    })

    lines.push('', `示例：${exampleParts.join(',')}（全部默认值）`)
    return lines.join('\n')
  }

  function renderConfirm(w: WizardSession): string {
    const lines: string[] = ['确认生成（回复「确认」或「取消」）：', '']

    lines.push(`模式 · ${w.mode === 'text-to-image' ? '文生图' : '图生图'}`)
    lines.push(`描述 · ${(w.prompt ?? '').slice(0, 200)}`)

    if (w.imageUrls?.length) lines.push(`图片 · ${w.imageUrls.length} 张`)

    if (w.modelId) {
      if (service.isFreePlatform(w.platform)) {
        lines.push(`模型 · ${getModelDisplayLabel(w.modelId)}`)
      } else {
        const cost = estimateCost(w.modelId)
        const costText = cost > 0 ? service.formatCredits(cost) : '免费'
        const pp = w.protocol ? PROTOCOL_PARAMS[w.protocol] : undefined
        const asyncTag = pp?.async ? ` [异步 ${pp.async.minSec}-${pp.async.maxSec}s]` : ''
        lines.push(`模型 · ${getModelDisplayLabel(w.modelId)}  ${costText}${asyncTag}`)
      }
    }

    if (w.protocol) {
      const pp = PROTOCOL_PARAMS[w.protocol]
      if (pp) {
        for (const param of pp.params) {
          const val = w.params[param.key]
          if (val !== undefined) {
            const display = param.type === 'enum' && param.displayValues
              ? param.displayValues[param.options!.indexOf(String(val))] ?? val
              : val
            lines.push(`${param.label} · ${display}`)
          }
        }
      }
    }

    lines.push('', '回复「确认」开始生成，回复「取消」放弃')
    return lines.join('\n')
  }

  function renderHelp(): string {
    const mappings = getConfiguredMappings()
    const styles = service.listStylePresets()
    const protocols = new Set(mappings.map(m => resolveProtocol(m.modelId)).filter(Boolean))

    const lines: string[] = [
      '图像生成 · 使用帮助',
      '',
      '文生图                 输入描述 → 选模型 → 选参数 → 生成',
      '图生图                 发图片 → 输入描述 → 选模型 → 选参数 → 生成',
      '',
      `当前可用模型：${mappings.length} 个，${protocols.size} 个协议`,
      '',
    ]

    if (styles.length) {
      lines.push('快捷命令：')
      for (const s of styles) {
        if (s.commandName && s.prompt) {
          lines.push(`${s.commandName}  ${s.description ?? s.prompt.slice(0, 30)}`)
        }
      }
      lines.push('')
    }

    lines.push(
      '向导内命令：',
      '取消         退出当前生成向导',
      '上一步       返回上一级',
      '?帮助        显示此帮助',
    )

    return lines.join('\n')
  }

  // ─── 步骤处理器 ────────────────────────────────────────────────────────────

  /**
   * await-prompt 步骤：保存 prompt，进入模型选择。
   * 图生图模式下分两步收集：先收图片，再收描述。
   */
  async function handleAwaitPrompt(
      w: WizardSession,
      _session: Session,
      text: string,
      images: string[],
  ): Promise<string | void> {
    // 图生图：分步收集 — 先图片，后描述
    if (w.mode === 'image-to-image') {
      // 1) 尚未收到图片：优先存图片
      if (!w.imageUrls?.length) {
        if (images.length > 0) {
          w.imageUrls = images.slice(0, 1)
        }
        // 仍无图片
        if (!w.imageUrls?.length) {
          // 用户只发了文字 — 暂存，但仍需要图片
          if (text) w.prompt = text
          return '请先发送 1 张图片'
        }
        // 现在有图片了，继续检查描述
      }

      // 2) 已有图片但尚无描述
      if (!w.prompt) {
        if (text) {
          w.prompt = text
          w.step = 'model-select'
          return renderModelList(w.userId, w.platform)
        }
        return '请输入修改描述'
      }

      // 3) 两者都已就绪
      w.step = 'model-select'
      return renderModelList(w.userId, w.platform)
    }

    // 文生图
    if (!text) return '请发送画面描述'
    w.prompt = text
    w.step = 'model-select'
    return renderModelList(w.userId, w.platform)
  }

  /** model-select 步骤：按编号选择模型（数据源为配置页 modelMappings），进入参数选择 */
  async function handleModelSelect(w: WizardSession, text: string): Promise<string | void> {
    const mappings = getVisibleMappings(w.userId)
    if (!mappings.length) return '模型映射为空或当前无可用模型，请管理员在配置页检查。回复「取消」退出向导'

    const num = parseInt(text, 10)
    if (isNaN(num) || num < 1 || num > mappings.length) {
      return `请输入 1-${mappings.length} 之间的数字`
    }

    const mapping = mappings[num - 1]

    // 二次校验：受限模型只对管理员/白名单开放（防止选择态与渲染态之间配置发生变化）
    const access = service.checkModelAccess(w.userId, { modelMapping: mapping })
    if (!access.allowed) {
      return access.message || ['模型受限', '', '- 要求｜管理员或模型白名单'].join('\n')
    }
    if (!service.isFreePlatform(w.platform)) {
      const freeTrialAccess = service.checkFreeTrialForModel(w.userId, mapping, w.platform)
      if (!freeTrialAccess.allowed) {
        return freeTrialAccess.message || ['模型不在免费列表', '', '- 说明丨此模型不开放每日免费'].join('\n')
      }
    }

    w.modelId = mapping.modelId
    w.protocol = resolveProtocol(mapping.modelId)
    w.params = {}
    w.step = 'param-select'

    const pp = PROTOCOL_PARAMS[w.protocol]
    if (!pp?.params.length) {
      // 无参数，直接跳到确认
      w.step = 'confirm'
      return renderConfirm(w)
    }
    return renderParamList(w.protocol)
  }

  /** param-select 步骤：一次性列出所有参数，逗号分隔输入 */
  async function handleParamSelect(w: WizardSession, text: string): Promise<string | void> {
    if (!w.protocol) { w.step = 'confirm'; return renderConfirm(w) }
    const pp = PROTOCOL_PARAMS[w.protocol]
    if (!pp?.params.length) { w.step = 'confirm'; return renderConfirm(w) }

    const params = pp.params

    // 「跳过」→ 全部使用默认值
    if (text === '跳过' || text === 'skip') {
      for (const p of params) {
        w.params[p.key] = p.default
      }
      w.step = 'confirm'
      return renderConfirm(w)
    }

    // 解析逗号分隔输入
    const parts = text.split(',').map(s => s.trim()).filter(Boolean)
    if (parts.length === 0) {
      return '请输入逗号分隔的参数值，或回复「跳过」使用全部默认值'
    }

    // 遍历参数列表，按顺序取对应位置的值；不足部分用默认值
    for (let i = 0; i < params.length; i++) {
      const p = params[i]
      if (i < parts.length && parts[i]) {
        const raw = parts[i]
        if (p.type === 'enum') {
          const optNum = parseInt(raw, 10)
          if (isNaN(optNum) || optNum < 1 || optNum > (p.options?.length ?? 0)) {
            return `"${p.label}" 请输入 1-${p.options?.length} 之间的编号`
          }
          w.params[p.key] = p.options![optNum - 1]
        } else {
          const val = parseFloat(raw)
          if (isNaN(val)) {
            const range = p.min != null && p.max != null ? `（${p.min}-${p.max}）` : ''
            return `"${p.label}" 请输入数字${range}`
          }
          if (p.min != null && val < p.min) return `"${p.label}" 最小值 ${p.min}`
          if (p.max != null && val > p.max) return `"${p.label}" 最大值 ${p.max}`
          w.params[p.key] = val
        }
      } else {
        // 未提供对应位置 → 使用默认值
        w.params[p.key] = p.default
      }
    }

    w.step = 'confirm'
    return renderConfirm(w)
  }

  /** confirm 步骤：确认 → 清理会话 → 生成；取消 → 退出 */
  async function handleConfirm(session: Session, w: WizardSession, text: string): Promise<string | void> {
    const t = text.trim().toLowerCase()
    if (t === '确认' || t === 'confirm' || t === 'y' || t === 'yes') {
      // 生成前二次校验受限模型（防止绕过 handleModelSelect）
      if (w.modelId) {
        const access = checkModelAccessByModelId(w.userId, w.modelId)
        if (!access.allowed) {
          wizardSessions.cancel(w.userId)
          return access.message || ['模型受限', '', '- 要求｜管理员或模型白名单'].join('\n')
        }
      }

      // 先清理向导会话，释放用户状态（用户可立刻发新命令）
      wizardSessions.cancel(w.userId)

      // 构造 prompt（拼接 MJ 风格后缀参数）
      let finalPrompt = w.prompt ?? ''
      if (w.protocol) {
        const pp = PROTOCOL_PARAMS[w.protocol]
        if (pp) {
          for (const param of pp.params) {
            if (!param.promptAppend) continue
            const val = w.params[param.key]
            if (val === undefined) continue
            if (param.key === 'ar') finalPrompt += ` --ar ${val}`
            else if (param.key === 'stylize') finalPrompt += ` --s ${val}`
          }
        }
      }

      // 构造请求上下文
      const requestContext: Record<string, unknown> = {}
      if (w.modelId) requestContext.modelId = w.modelId
      if (w.protocol) requestContext.provider = w.protocol

      // 非 prompt 追加参数放入上下文
      if (w.protocol) {
        const pp = PROTOCOL_PARAMS[w.protocol]
        if (pp) {
          for (const param of pp.params) {
            if (param.promptAppend) continue
            const val = w.params[param.key]
            if (val === undefined) continue
            if (param.key === 'resolution' || param.key === 'imageSize') {
              requestContext.resolution = val
            } else if (param.key === 'aspectRatio' || param.key === 'ar') {
              requestContext.aspectRatio = val
            } else if (param.key === 'n') {
              requestContext.numImages = Number(val)
            }
          }
        }
      }

      // 命令行 flag 已解析的参数覆盖：用户显式在命令里带了 -16:9/-1k 等就走这些值
      if (w.preResolution && requestContext.resolution === undefined) {
        requestContext.resolution = w.preResolution
      }
      if (w.preAspectRatio && requestContext.aspectRatio === undefined) {
        requestContext.aspectRatio = w.preAspectRatio
      }
      // -add 追加内容并入 prompt
      if (w.preCustomAdditions?.length) {
        finalPrompt = [finalPrompt, ...w.preCustomAdditions]
          .map(s => s.trim())
          .filter(Boolean)
          .join(' - ')
      }

      // 调用编排器（失败时 orchestrator 已有的错误处理会发消息给用户）
      if (w.mode === 'text-to-image') {
        return handlers.executeTextToImage(
          session,
          finalPrompt,
          requestContext as any,
          undefined,
          w.commandName ?? '文生图',
          w.commandName,
        )
      }
      return handlers.executeImageToImage(
        session,
        w.imageUrls?.[0],
        finalPrompt,
        requestContext as any,
        undefined,
        w.commandName ?? '图生图',
        w.commandName,
      )
    }

    if (t === '取消' || t === 'cancel') {
      wizardSessions.cancel(w.userId)
      return '已取消生成'
    }

    return '回复「确认」开始生成，或回复「取消」放弃'
  }

  // ─── 对外接口 ──────────────────────────────────────────────────────────────

  function handleCommand(
    session: Session,
    commandName: string,
    argv?: Argv,
    imgParam?: unknown,
    inlineText?: string,
  ): Promise<string | void> {
    const userId = session.userId
    if (!userId) return Promise.resolve('无法识别用户身份')
    const userName = session.username || session.author?.name || userId

    // 判断模式
    let mode: 'text-to-image' | 'image-to-image' = 'text-to-image'
    const style = service.getStylePreset(commandName)
    if (style) {
      mode = style.mode === 'text-to-image' ? 'text-to-image' : 'image-to-image'
    } else if (commandName === '图生图') {
      mode = 'image-to-image'
    }

    // 使用统一解析器提取 flags（-1k/-16:9/-add ...）与模型后缀，避免把命令词/flags
    // 塞进最终 prompt。argv 缺失时回退到原始 session.content 解析（保底不影响功能）。
    const config = getConfig()
    const modelIndex = buildModelMappingIndex(config.modelMappings)
    let preModifiers: ImageGenerationModifiers = { customAdditions: [] }
    if (argv) {
      preModifiers = parseStyleCommandModifiers(argv, imgParam, modelIndex)
    }

    // 提取图片：优先从 imgParam / quote 收集；仅在无 argv 时才回退到 raw content 解析
    let imageUrls: string[] = []
    if (imgParam && typeof imgParam === 'object' && (imgParam as any).attrs?.src) {
      imageUrls.push((imgParam as any).attrs.src)
    } else if (typeof imgParam === 'string' && (imgParam.startsWith('http') || imgParam.startsWith('data:'))) {
      imageUrls.push(imgParam)
    }
    if (session.quote?.elements) {
      const qImages = h.select(session.quote.elements, 'img')
      for (const img of qImages) {
        if (img.attrs.src) imageUrls.push(img.attrs.src)
      }
    }
    if (!argv) {
      // 回退：从原始 content 解析出图片（老路径）
      const parsedFallback = parseMessageImagesAndText(session.content ?? '')
      for (const img of parsedFallback.images) {
        if (img.attrs?.src) imageUrls.push(img.attrs.src)
      }
    } else {
      // 有 argv 时也再从 content 提图（Koishi argv 不总能拿到 <img>）
      const parsedContent = parseMessageImagesAndText(session.content ?? '')
      for (const img of parsedContent.images) {
        if (img.attrs?.src) imageUrls.push(img.attrs.src)
      }
    }

    // 干净的 prompt 文本：优先 argv 提供的 [prompt:text]（Koishi 已剥离 flags），
    // 无 argv 时回退到 content 中的纯文本
    let cleanInlinePrompt: string | undefined
    if (typeof inlineText === 'string' && inlineText.trim()) {
      cleanInlinePrompt = inlineText.trim()
    } else if (!argv) {
      const parsedFallback = parseMessageImagesAndText(session.content ?? '')
      cleanInlinePrompt = parsedFallback.text?.trim() || undefined
    }

    // 启动会话
    const result = wizardSessions.start(userId, userName, mode, {
      prompt: style?.prompt || undefined,
      mode: !!style?.prompt,
      commandName,
    })
    if ('conflict' in result) return Promise.resolve(result.message)
    const w = result

    // 记录命令行已解析的 flag 类参数
    if (preModifiers.resolution) w.preResolution = preModifiers.resolution
    if (preModifiers.aspectRatio) w.preAspectRatio = preModifiers.aspectRatio
    if (preModifiers.customAdditions?.length) w.preCustomAdditions = preModifiers.customAdditions

    // 记录会话所在平台，用于后续渲染步骤（免计费平台省略成本文案）
    if (session.platform) w.platform = session.platform

    // 图生图：保存图片
    if (mode === 'image-to-image' && imageUrls.length > 0) {
      w.imageUrls = imageUrls.slice(0, 1)
    }

    // 预设命令（带锁定 prompt）：直接进模型选择
    if (style?.prompt) {
      w.step = 'model-select'
      return Promise.resolve(renderModelList(userId, w.platform))
    }

    // 行内 prompt
    if (cleanInlinePrompt) {
      // 图生图但无图 → 仍需要图片
      if (mode === 'image-to-image' && !w.imageUrls?.length) {
        w.prompt = cleanInlinePrompt
        return Promise.resolve('请先发送 1 张图片')
      }
      w.prompt = cleanInlinePrompt
      w.step = 'model-select'
      return Promise.resolve(renderModelList(userId, w.platform))
    }

    // 图生图无图 → 提示发图
    if (mode === 'image-to-image' && !w.imageUrls?.length) {
      return Promise.resolve('请先发送 1 张图片')
    }

    return Promise.resolve('请发送画面描述')
  }

  function getMiddleware() {
    return async (session: Session, next: () => Promise<void | Fragment>): Promise<void | Fragment | string> => {
      const userId = session.userId
      if (!userId) return next()

      // 仅处理有活跃向导会话的消息；无会话则完全放行
      const w = wizardSessions.get(userId)
      if (!w) return next()
      if (w.step === 'generating') return next()

      const parsed = parseMessageImagesAndText(session.content ?? '')
      const text = (parsed.text ?? '').trim()
      const images = parsed.images.map(i => i.attrs?.src).filter(Boolean) as string[]

      // 收到向导相关消息即视为活动，刷新每步超时
      wizardSessions.touch(w)

      // 向导控制命令
      if (text === '取消' || text === 'cancel') {
        wizardSessions.cancel(userId)
        return '已退出生成向导'
      }
      if (text === '上一步' || text === 'back') {
        if (w.step === 'await-prompt') {
          if (w.mode === 'image-to-image' && w.imageUrls?.length && !w.prompt) {
            return '上一步：请重新发送 1 张图片'
          }
          return '已在第一步，无法返回'
        }
        if (w.step === 'model-select') {
          w.prompt = undefined
          w.step = 'await-prompt'
          return w.mode === 'image-to-image'
            ? (w.imageUrls?.length ? '请输入修改描述' : '请先发送 1 张图片')
            : '请重新发送画面描述'
        }
        if (w.step === 'param-select') {
          w.params = {}
          w.step = 'model-select'
          return renderModelList(userId, w.platform)
        }
        if (w.step === 'confirm') {
          w.params = {}
          w.step = 'param-select'
          return w.protocol ? renderParamList(w.protocol) : renderModelList(userId, w.platform)
        }
        return '已在第一步，无法返回'
      }
      if (text === '?帮助' || text === '？帮助' || text === 'help') {
        return renderHelp()
      }

      // 按步骤路由
      switch (w.step) {
        case 'await-prompt':
          return handleAwaitPrompt(w, session, text, images)
        case 'model-select':
          return handleModelSelect(w, text)
        case 'param-select':
          return handleParamSelect(w, text)
        case 'confirm':
          return handleConfirm(session, w, text)
        default:
          return next()
      }
    }
  }

  return { handleCommand, getMiddleware }
}
