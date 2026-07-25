/**
 * wizard-handler.ts —— 多步骤图像生成向导编排层。
 *
 * 向导驱动方式：命令触发 handleCommand 启动会话，中间件拦截后续消息，
 * 按 WizardSession.step 分派到对应处理器。全部文本/参数由 PROTOCOL_PARAMS
 * 和 catalog 驱动，无硬编码。
 */
import { h } from 'koishi'
import type { Context, Fragment, Session } from 'koishi'

import type { Config } from '../shared/config.js'
import { PROTOCOL_PARAMS } from '../shared/protocol-params.js'
import type { ProtocolParams, ParamDef } from '../shared/protocol-params.js'
import { estimatePreGenerationCost } from '../shared/billing.js'
import type { CatalogSnapshot, ImageModelInfo } from '../catalog/types.js'
import type { ImageGenerationHandlers } from '../orchestrators/ImageGenerationOrchestrator.js'
import type { AiImageGeneratorService } from '../service/AiImageGeneratorService.js'
import type { WizardSession, WizardSessionManager } from '../services/wizard-session.js'
import { parseMessageImagesAndText } from '../utils/input.js'

export interface CreateWizardHandlerParams {
  ctx: Context
  catalog: { current: CatalogSnapshot | null }
  service: AiImageGeneratorService
  handlers: ImageGenerationHandlers
  getConfig: () => Config
  wizardSessions: WizardSessionManager
}

export interface WizardHandler {
  /** 从命令 action 调用，启动向导并返回首条提示 */
  handleCommand(session: Session, commandName: string): Promise<string | void>
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

  function getProtocol(modelId: string): string {
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

  // ─── 渲染函数（全部从 PROTOCOL_PARAMS 和 catalog 驱动） ───────────────────

  function renderModelList(): string {
    const models = getModels()
    if (!models.length) return '模型目录加载中，请 10 秒后重试'

    const lines: string[] = ['选择模型（回复数字）：', '']
    for (let i = 0; i < models.length; i++) {
      const m = models[i]
      const proto = m.routes[0]?.protocol ?? 'openai'
      const cost = estimateCost(m.id)
      const costText = cost > 0 ? `~${service.formatCredits(cost)}` : '免费'
      const pp = PROTOCOL_PARAMS[proto]
      const asyncTag = pp?.async
        ? ` 异步 ${pp.async.minSec}-${pp.async.maxSec}s`
        : ''
      lines.push(`${i + 1} · ${getModelLabel(m.id)}  ${costText}${asyncTag}`)
    }
    return lines.join('\n')
  }

  function renderParamList(protocol: string): string {
    const pp = PROTOCOL_PARAMS[protocol]
    if (!pp?.params.length) return '该模型无额外参数'

    // Build flat option list: enum entries each get their own line
    const flat = buildFlatParamOptions(pp)
    if (!flat.length) return '该模型无额外参数'

    const lines: string[] = [
      `${protocol} · 可选参数（回复数字选择，或回复「跳过」）：`,
      '',
    ]
    for (let i = 0; i < flat.length; i++) {
      const { param, optIdx } = flat[i]
      if (param.type === 'enum') {
        const opt = param.options![optIdx!]
        const display = param.displayValues?.[optIdx!] ?? opt
        const def = opt === param.default ? '  [默认]' : ''
        lines.push(`${i + 1} · ${param.label} ${display}${def}`)
      } else {
        const range = param.min != null && param.max != null
          ? `输入 ${param.min}-${param.max}`
          : ''
        lines.push(`${i + 1} · ${param.label} ${param.default}  ${range}`)
      }
    }
    return lines.join('\n')
  }

  function buildFlatParamOptions(pp: ProtocolParams): Array<{ param: ParamDef; optIdx?: number }> {
    const flat: Array<{ param: ParamDef; optIdx?: number }> = []
    for (const p of pp.params) {
      if (p.type === 'enum') {
        for (let i = 0; i < (p.options?.length ?? 0); i++) flat.push({ param: p, optIdx: i })
      } else {
        flat.push({ param: p })
      }
    }
    return flat
  }

  function renderConfirm(w: WizardSession): string {
    const lines: string[] = ['确认生成（回复「确认」或「取消」）：', '']

    lines.push(`模式 · ${w.mode === 'text-to-image' ? '文生图' : '图生图'}`)
    lines.push(`描述 · ${(w.prompt ?? '').slice(0, 200)}`)

    if (w.imageUrls?.length) lines.push(`图片 · ${w.imageUrls.length} 张`)

    if (w.modelId) {
      const cost = estimateCost(w.modelId)
      const costText = cost > 0 ? service.formatCredits(cost) : '免费'
      const pp = w.protocol ? PROTOCOL_PARAMS[w.protocol] : undefined
      const asyncTag = pp?.async ? ` [异步 ${pp.async.minSec}-${pp.async.maxSec}s]` : ''
      lines.push(`模型 · ${getModelLabel(w.modelId)}  ${costText}${asyncTag}`)
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
    const models = getModels()
    const styles = service.listStylePresets()
    const protocols = new Set(models.map(m => m.routes[0]?.protocol ?? 'openai').filter(Boolean))

    const lines: string[] = [
      '图像生成 · 使用帮助',
      '',
      '文生图                 输入描述 → 选模型 → 选参数 → 生成',
      '图生图                 发图片 → 输入描述 → 选模型 → 选参数 → 生成',
      '',
      `当前可用模型：${models.length} 个，${protocols.size} 个协议`,
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
   * 对图生图模式，同时从消息中提取图片。
   */
  async function handleAwaitPrompt(
      w: WizardSession,
      _session: Session,
      text: string,
      images: string[],
  ): Promise<string | void> {
    // 图生图：如果用户发了图片，存下来
    if (w.mode === 'image-to-image' && images.length > 0) {
      w.imageUrls = images.slice(0, 1)
    }

    // 图生图但尚无图片：提示发图
    if (w.mode === 'image-to-image' && !w.imageUrls?.length) {
      if (text) {
        // 用户只发了文字没发图片 — 存文字，但需要图片
        w.prompt = text
        return '请同时发送 1 张图片'
      }
      return '请发送 1 张图片和修改描述'
    }

    if (!text) return '请发送画面描述'

    w.prompt = text
    w.step = 'model-select'
    return renderModelList()
  }

  /** model-select 步骤：按编号选择模型，进入参数选择 */
  async function handleModelSelect(w: WizardSession, text: string): Promise<string | void> {
    const models = getModels()
    if (!models.length) return '模型目录尚未加载，请稍后重试。回复「取消」退出向导'

    const num = parseInt(text, 10)
    if (isNaN(num) || num < 1 || num > models.length) {
      return `请输入 1-${models.length} 之间的数字`
    }

    const model = models[num - 1]
    w.modelId = model.id
    w.protocol = getProtocol(model.id)
    w.params = {}
    w.currentParamIndex = 0
    w.step = 'param-select'

    const pp = PROTOCOL_PARAMS[w.protocol]
    if (!pp?.params.length) {
      // 无参数，直接跳到确认
      w.step = 'confirm'
      return renderConfirm(w)
    }
    return renderParamList(w.protocol)
  }

  /** param-select 步骤：逐项收集参数 */
  async function handleParamSelect(w: WizardSession, text: string): Promise<string | void> {
    if (!w.protocol) { w.step = 'confirm'; return renderConfirm(w) }
    const pp = PROTOCOL_PARAMS[w.protocol]
    if (!pp?.params.length) { w.step = 'confirm'; return renderConfirm(w) }

    const flat = buildFlatParamOptions(pp)
    if (!flat.length) { w.step = 'confirm'; return renderConfirm(w) }

    // 跳过 → 用默认值填所有未收集参数
    if (text === '跳过' || text === 'skip') {
      for (const f of flat) {
        if (!(f.param.key in w.params)) {
          w.params[f.param.key] = f.param.default
        }
      }
      w.step = 'confirm'
      return renderConfirm(w)
    }

    const idx = w.currentParamIndex ?? 0

    // 如果这是第一轮且用户输入了数字 → 直接选择对应选项
    if (idx === 0) {
      const optionNum = parseInt(text, 10)
      if (!isNaN(optionNum) && optionNum >= 1 && optionNum <= flat.length) {
        const picked = flat[optionNum - 1]
        setParamValue(w, picked, picked.param.default)
        w.currentParamIndex = optionNum // 已处理前 optionNum 个
        // 检查是否还有更多参数
        if (w.currentParamIndex >= flat.length) {
          // 填充剩余默认值
          for (let i = w.currentParamIndex; i < flat.length; i++) {
            const f = flat[i]
            if (!(f.param.key in w.params)) {
              setParamValue(w, f, f.param.default)
            }
          }
          w.step = 'confirm'
          return renderConfirm(w)
        }
        // 提示下一个
        return promptNextParam(flat, w.currentParamIndex)
      }
    }

    // 逐参数收集模式
    const current = flat[idx]
    if (!current) { w.step = 'confirm'; return renderConfirm(w) }

    if (current.param.type === 'enum') {
      // 应该选枚举值
      const optNum = parseInt(text, 10)
      if (isNaN(optNum) || optNum < 1 || optNum > flat.length) {
        return `请输入 1-${flat.length} 之间的数字`
      }
      const picked = flat[optNum - 1]
      if (!picked || picked.param.key !== current.param.key || picked.optIdx !== current.optIdx) {
        return `请输入对应编号（当前参数：${current.param.label}）`
      }
      setParamValue(w, current, current.param.options![current.optIdx!])
    } else {
      const val = parseFloat(text)
      if (isNaN(val)) {
        const r = current.param.min != null && current.param.max != null
          ? `请输入 ${current.param.min}-${current.param.max} 的数字`
          : '请输入数字'
        return r
      }
      if (current.param.min != null && val < current.param.min) return `最小值 ${current.param.min}，请重输`
      if (current.param.max != null && val > current.param.max) return `最大值 ${current.param.max}，请重输`
      setParamValue(w, current, val)
    }

    w.currentParamIndex = idx + 1

    // 检查是否收集完毕
    if ((w.currentParamIndex ?? 0) >= flat.length) {
      w.step = 'confirm'
      return renderConfirm(w)
    }

    return promptNextParam(flat, w.currentParamIndex ?? 0)
  }

  function setParamValue(w: WizardSession, f: { param: ParamDef; optIdx?: number }, value: string | number): void {
    w.params[f.param.key] = value
  }

  function promptNextParam(flat: Array<{ param: ParamDef; optIdx?: number }>, idx: number): string {
    const next = flat[idx]
    if (next.param.type === 'enum') {
      const opt = next.param.options![next.optIdx!]
      const display = next.param.displayValues?.[next.optIdx!] ?? opt
      const def = opt === next.param.default ? '  [默认]' : ''
      return `${next.param.label} ${display}${def}`
    }
    const r = next.param.min != null && next.param.max != null ? `（${next.param.min}-${next.param.max}）` : ''
    return `${next.param.label} · 输入数值${r}，默认 ${next.param.default}`
  }

  /** confirm 步骤：确认 → 生成；取消 → 退出 */
  async function handleConfirm(session: Session, w: WizardSession, text: string): Promise<string | void> {
    const t = text.trim().toLowerCase()
    if (t === '确认' || t === 'confirm' || t === 'y' || t === 'yes') {
      w.step = 'generating'

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
      if (w.imageUrls?.length && w.mode === 'image-to-image') {
        // no extra context needed
      }

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

      // 清理向导会话
      wizardSessions.cancel(w.userId)

      // 调用编排器
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

  function handleCommand(session: Session, commandName: string): Promise<string | void> {
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

    // 从消息上下文提取图片
    let imageUrls: string[] = []
    if (session.quote?.elements) {
      const qImages = h.select(session.quote.elements, 'img')
      for (const img of qImages) {
        if (img.attrs.src) imageUrls.push(img.attrs.src)
      }
    }
    const parsed = parseMessageImagesAndText(session.content ?? '')
    for (const img of parsed.images) {
      if (img.attrs?.src) imageUrls.push(img.attrs.src)
    }

    // 启动会话
    const result = wizardSessions.start(userId, userName, mode, {
      prompt: style?.prompt || undefined,
      mode: !!style?.prompt,
      commandName,
    })
    if ('conflict' in result) return Promise.resolve(result.message)
    const w = result

    // 图生图：保存图片
    if (mode === 'image-to-image' && imageUrls.length > 0) {
      w.imageUrls = imageUrls.slice(0, 1)
    }

    // 预设命令（带锁定 prompt）：直接进模型选择
    if (style?.prompt) {
      w.step = 'model-select'
      return Promise.resolve(renderModelList())
    }

    // 行内 prompt
    const inlinePrompt = parsed.text?.trim()
    if (inlinePrompt) {
      // 图生图但无图 → 仍需要图片
      if (mode === 'image-to-image' && !w.imageUrls?.length) {
        w.prompt = inlinePrompt
        return Promise.resolve('请发送 1 张图片')
      }
      w.prompt = inlinePrompt
      w.step = 'model-select'
      return Promise.resolve(renderModelList())
    }

    // 图生图无图 → 提示发图
    if (mode === 'image-to-image' && !w.imageUrls?.length) {
      return Promise.resolve('请发送 1 张图片和修改描述')
    }

    return Promise.resolve('请发送画面描述')
  }

  function getMiddleware() {
    return async (session: Session, next: () => Promise<void | Fragment>): Promise<void | Fragment | string> => {
      const userId = session.userId
      if (!userId) return next()

      const w = wizardSessions.get(userId)
      if (!w || w.step === 'generating') return next()

      const parsed = parseMessageImagesAndText(session.content ?? '')
      const text = (parsed.text ?? '').trim()
      const images = parsed.images.map(i => i.attrs?.src).filter(Boolean) as string[]

      // 向导控制命令
      if (text === '取消' || text === 'cancel') {
        wizardSessions.cancel(userId)
        return '已退出生成向导'
      }
      if (text === '上一步' || text === 'back') {
        if (w.step === 'model-select') {
          w.step = 'await-prompt'
          return '请重新发送画面描述'
        }
        if (w.step === 'param-select') {
          w.currentParamIndex = 0
          w.params = {}
          w.step = 'model-select'
          return renderModelList()
        }
        if (w.step === 'confirm') {
          w.currentParamIndex = 0
          w.params = {}
          w.step = 'param-select'
          return w.protocol ? renderParamList(w.protocol) : renderModelList()
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
