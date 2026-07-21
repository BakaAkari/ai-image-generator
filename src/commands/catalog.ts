/**
 * 模型目录命令 —— 图像模型 / 图像额度
 *
 * 图像模型 [刷新]：展示动态获取的图像模型目录（含计价）
 * 图像额度：展示平台侧累计消耗与 key 限额（仅支持 new-api 系供应商）
 */
import type { Context } from 'koishi'

import type { ImageCatalogService } from '../catalog/image-catalog.js'
import type { ActiveSupplier, ImageModelInfo } from '../catalog/types.js'
import type { Config } from '../shared/config.js'
import type { UserManager } from '../services/UserManager.js'

export interface RegisterCatalogCommandsParams {
  ctx: Context
  catalog: ImageCatalogService
  userManager: UserManager
  getConfig: () => Config
  /** 解析激活供应商的凭证（来自 ProviderSettings / legacy 平铺字段） */
  resolveCredentials: (config: Config) => {
    supplier: ActiveSupplier
    apiBase: string
    apiKey: string
    timeoutSec: number
    refreshHours: number
    extraHeaders?: Record<string, string>
  } | null
}

function formatPrice(m: ImageModelInfo): string {
  const p = m.pricing
  if (p.type === 'per-call' && p.pricePerCall != null) return `$${p.pricePerCall.toFixed(4)}/次`
  if (p.type === 'per-token' && p.tokenRatio != null) return `token×${p.tokenRatio}`
  return '计价未知'
}

export function registerCatalogCommands(params: RegisterCatalogCommandsParams) {
  const { ctx, catalog, userManager, getConfig, resolveCredentials } = params

  ctx
    .command('图像模型 [refresh:text]', '查看图像模型目录（输入"图像模型 刷新"强制更新）')
    .action(async ({ session }, refresh) => {
      const config = getConfig()
      if (refresh && !userManager.isAdmin(session?.userId ?? '', config)) {
        return '只有管理员可以刷新模型目录'
      }
      if (refresh) {
        const cred = resolveCredentials(config)
        if (!cred) return '未配置激活供应商的凭证，无法刷新'
        await catalog.refresh(cred)
      }

      const snapshot = catalog.current
      if (!snapshot || !snapshot.models.length) {
        const cred = resolveCredentials(config)
        if (!cred) return '尚未配置供应商凭证。请先在插件设置中填写 API Key。'
        return '模型目录为空，正在后台拉取…稍后重试，或发送"图像模型 刷新"'
      }

      const lines: string[] = []
      const supplierName = { yunwu: '云雾', gptgod: 'GPTGod', 'openai-official': 'OpenAI 官方', 'gemini-official': 'Gemini 官方' }[snapshot.supplier]
      lines.push(`📋 图像模型目录（供应商：${supplierName}，共 ${snapshot.models.length} 个）`)
      const withPricing = snapshot.models.filter(m => m.pricing.type !== 'unknown')
      const unknown = snapshot.models.length - withPricing.length
      for (const m of snapshot.models) {
        const modes = m.modes.map(x => x === 'text-to-image' ? '文生图' : '图生图').join('/')
        lines.push(`  ${m.id} [${modes}] ${formatPrice(m)}`)
      }
      if (unknown > 0) lines.push(`（${unknown} 个模型未获取到计价信息）`)
      const age = Math.round((Date.now() - snapshot.fetchedAt) / 60000)
      lines.push(`目录更新于 ${age} 分钟前${snapshot.error ? `；上次刷新失败：${snapshot.error}` : ''}`)
      return lines.join('\n')
    })

  ctx
    .command('图像额度', '查看平台侧累计消耗与限额（new-api 系供应商）')
    .action(async () => {
      const billing = catalog.billingInfo
      if (!billing || billing.totalUsageUsd == null) {
        return '当前供应商不支持消耗查询，或尚未获取到数据（稍后重试）'
      }
      const lines = [`💰 平台消耗（key：${billing.tokenName ?? '未知'}）`]
      lines.push(`  累计消耗：$${billing.totalUsageUsd.toFixed(2)}`)
      if (billing.hardLimitUsd != null) {
        const pct = (billing.totalUsageUsd / billing.hardLimitUsd) * 100
        lines.push(`  限额：$${billing.hardLimitUsd.toFixed(2)}（已用 ${pct.toFixed(1)}%）`)
      }
      return lines.join('\n')
    })
}
