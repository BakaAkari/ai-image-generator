/**
 * 契约注册表 —— 供应商 + 协议 + 操作 + 模型 ID → 具体契约。
 *
 * 匹配规则：
 * 1. supplier + protocol + operation 必须完全一致；
 * 2. contract.modelIds='*' 匹配任何模型；否则要求 modelId ∈ modelIds；
 * 3. 更具体的模型清单优先于 '*'；
 * 4. 找不到匹配时返回 fail-closed reason，调用方必须阻止请求。
 */

import type {
  ContractOperation,
  ContractProtocol,
  ContractResolveInput,
  ContractResolveResult,
  ContractSupplier,
  ImageContract,
} from './types.js'

// ---------------------------------------------------------------------------
// 契约定义
// ---------------------------------------------------------------------------

/**
 * 云雾 GPT Image 2 文生图 —— 官方 Apifox 契约 5427167/447792717。
 *
 * 固定 size 与自定义 size 见 Apifox description，`n` 服务端上限为 10
 * （产品层面在协议层保留至 4）。响应形态 data[].url / data[].b64_json / usage，
 * Apifox 中的 chat completions schema 已确认为文档误填。
 */
const YUNWU_OPENAI_GPT_IMAGE_2_GENERATE: ImageContract = {
  id: 'yunwu.openai.gpt-image-2.generate',
  supplier: 'yunwu',
  protocol: 'openai',
  operation: 'text-to-image',
  endpoint: '/v1/images/generations',
  method: 'POST',
  modelIds: ['gpt-image-2'],
  label: 'yunwu GPT Image 2 generate',
  openai: {
    contentType: 'application/json',
    size: {
      fixedSizes: ['1024x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152', '3840x2160', '2160x3840', 'auto'],
      fixedByResolutionAndAspect: {
        '1k': { '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536' },
        '2k': { '1:1': '2048x2048', '16:9': '2048x1152' },
        '4k': { '16:9': '3840x2160', '9:16': '2160x3840' },
      },
      supportsAuto: true,
      customSizeLimits: {
        maxSide: 3840,
        step: 16,
        maxRatio: 3,
        minPixels: 655_360,
        maxPixels: 8_294_400,
      },
    },
    supportsN: true,
    maxN: 4,
    qualities: ['low', 'medium', 'high', 'auto'],
    formats: ['png', 'jpeg', 'webp'],
    backgrounds: ['opaque', 'auto', 'transparent'],
    moderations: ['low', 'auto'],
  },
}

/**
 * 云雾 gpt-image-2-c 目录描述“暂不支持 n 参数”，用独立契约表达 n=1 限制。
 */
const YUNWU_OPENAI_GPT_IMAGE_2_C_GENERATE: ImageContract = {
  ...YUNWU_OPENAI_GPT_IMAGE_2_GENERATE,
  id: 'yunwu.openai.gpt-image-2-c.generate',
  modelIds: ['gpt-image-2-c'],
  openai: {
    ...YUNWU_OPENAI_GPT_IMAGE_2_GENERATE.openai!,
    supportsN: false,
    maxN: 1,
  },
}

/**
 * 云雾 GPT Image 2 编辑 —— Apifox 5427167/446294920。
 * 页面 parameters 表明确 multipart，请求内容类型固定为 multipart/form-data。
 * Apifox JSON schema 把大量字段列为 required 属于文档内部矛盾，实施以页面 parameters 为准。
 * 固定 size 与生成一致；n 服务端上限 10，产品层最多 4。
 */
const YUNWU_OPENAI_GPT_IMAGE_2_EDIT: ImageContract = {
  id: 'yunwu.openai.gpt-image-2.edit',
  supplier: 'yunwu',
  protocol: 'openai',
  operation: 'image-edit',
  endpoint: '/v1/images/edits',
  method: 'POST',
  modelIds: ['gpt-image-2', 'gpt-image-2-c'],
  label: 'yunwu GPT Image 2 edit',
  openai: {
    contentType: 'multipart/form-data',
    size: {
      fixedSizes: ['1024x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152', '3840x2160', '2160x3840', 'auto'],
      fixedByResolutionAndAspect: {
        '1k': { '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536' },
        '2k': { '1:1': '2048x2048', '16:9': '2048x1152' },
        '4k': { '16:9': '3840x2160', '9:16': '2160x3840' },
      },
      supportsAuto: true,
      customSizeLimits: {
        maxSide: 3840,
        step: 16,
        maxRatio: 3,
        minPixels: 655_360,
        maxPixels: 8_294_400,
      },
    },
    supportsN: true,
    maxN: 4,
    qualities: ['low', 'medium', 'high', 'auto'],
    backgrounds: ['opaque', 'auto', 'transparent'],
    moderations: ['low', 'auto'],
    requiresReferenceImage: true,
  },
}

/**
 * 云雾 GPT Image 1 —— Apifox 5427167/290549047 页面 schema 仅列 256x256/512x512/1024x1024。
 * 但页面 example 却发送 model 字段与 1024x1536 尺寸，属于文档内部矛盾；保守取页面 schema。
 */
const YUNWU_OPENAI_GPT_IMAGE_1_GENERATE: ImageContract = {
  id: 'yunwu.openai.gpt-image-1.generate',
  supplier: 'yunwu',
  protocol: 'openai',
  operation: 'text-to-image',
  endpoint: '/v1/images/generations',
  method: 'POST',
  modelIds: ['gpt-image-1', 'gpt-image-1-all'],
  label: 'yunwu GPT Image 1 generate',
  openai: {
    contentType: 'application/json',
    size: {
      fixedSizes: ['256x256', '512x512', '1024x1024'],
      fixedByResolutionAndAspect: {
        '1k': { '1:1': '1024x1024' },
      },
    },
    supportsN: true,
    maxN: 4,
  },
}

/** OpenAI 官方 GPT Image 生成契约（gpt-image-1 官方能力）。 */
const OFFICIAL_OPENAI_GENERATE: ImageContract = {
  id: 'openai.official.images.generate',
  supplier: 'openai-official',
  protocol: 'openai',
  operation: 'text-to-image',
  endpoint: '/v1/images/generations',
  method: 'POST',
  modelIds: '*',
  label: 'OpenAI official images.generate',
  openai: {
    contentType: 'application/json',
    size: {
      fixedSizes: ['1024x1024', '1024x1536', '1536x1024', 'auto'],
      fixedByResolutionAndAspect: {
        '1k': { '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536' },
      },
      supportsAuto: true,
    },
    supportsN: true,
    maxN: 4,
    qualities: ['low', 'medium', 'high', 'auto'],
    backgrounds: ['opaque', 'auto', 'transparent'],
    moderations: ['low', 'auto'],
  },
}

const OFFICIAL_OPENAI_EDIT: ImageContract = {
  id: 'openai.official.images.edit',
  supplier: 'openai-official',
  protocol: 'openai',
  operation: 'image-edit',
  endpoint: '/v1/images/edits',
  method: 'POST',
  modelIds: '*',
  label: 'OpenAI official images.edit',
  openai: {
    contentType: 'multipart/form-data',
    size: {
      fixedSizes: ['1024x1024', '1024x1536', '1536x1024', 'auto'],
      fixedByResolutionAndAspect: {
        '1k': { '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536' },
      },
      supportsAuto: true,
    },
    supportsN: true,
    maxN: 4,
    qualities: ['low', 'medium', 'high', 'auto'],
    requiresReferenceImage: true,
  },
}

/**
 * 云雾 Gemini 2.5 Flash Image 生成 —— Apifox 5427167/358030171。
 * 结构化示例中 imageConfig 仅含 aspectRatio；imageSize 属云雾未声明字段。
 */
const YUNWU_GEMINI_2_5_GENERATE: ImageContract = {
  id: 'yunwu.gemini.2-5.generate',
  supplier: 'yunwu',
  protocol: 'gemini',
  operation: 'text-to-image',
  endpoint: '/v1beta/models/{modelId}:generateContent',
  method: 'POST',
  modelIds: ['gemini-2.5-flash-image'],
  label: 'yunwu Gemini 2.5 generate',
  gemini: {
    imageConfig: {
      enabled: true,
      aspectRatios: ['1:1', '4:3', '3:2', '16:9', '9:16', '2:3'],
      imageSizes: [],
      imageSizeOptional: true,
    },
    supportsYunwuResponseFormatUrl: true,
  },
}

/**
 * 云雾 Gemini 3 Pro Image 生成 —— Apifox 5427167/379838953。
 * 结构化示例 imageConfig 含 aspectRatio + 大写 imageSize (1K/2K/4K)。
 */
const YUNWU_GEMINI_3_PRO_GENERATE: ImageContract = {
  id: 'yunwu.gemini.3-pro.generate',
  supplier: 'yunwu',
  protocol: 'gemini',
  operation: 'text-to-image',
  endpoint: '/v1beta/models/{modelId}:generateContent',
  method: 'POST',
  modelIds: ['gemini-3-pro-image', 'gemini-3-pro-image-preview'],
  label: 'yunwu Gemini 3 Pro generate',
  gemini: {
    imageConfig: {
      enabled: true,
      aspectRatios: ['1:1', '4:3', '3:2', '16:9', '9:16', '2:3'],
      imageSizes: ['1K', '2K', '4K'],
      imageSizeOptional: false,
    },
    supportsYunwuResponseFormatUrl: true,
  },
}

/**
 * 云雾 Gemini 3 Pro 图片编辑 —— Apifox 5427167/305488471。
 * 编辑示例仅发送 responseModalities，未发送 imageConfig；能力独立于生成契约。
 */
const YUNWU_GEMINI_3_PRO_EDIT: ImageContract = {
  id: 'yunwu.gemini.3-pro.edit',
  supplier: 'yunwu',
  protocol: 'gemini',
  operation: 'image-edit',
  endpoint: '/v1beta/models/{modelId}:generateContent',
  method: 'POST',
  modelIds: ['gemini-3-pro-image', 'gemini-3-pro-image-preview'],
  label: 'yunwu Gemini 3 Pro edit',
  gemini: {
    imageConfig: { enabled: false },
    supportsYunwuResponseFormatUrl: true,
    requiresReferenceImage: true,
  },
}

/** Gemini 2.5 云雾同样能编辑（沿用编辑契约）。 */
const YUNWU_GEMINI_2_5_EDIT: ImageContract = {
  ...YUNWU_GEMINI_3_PRO_EDIT,
  id: 'yunwu.gemini.2-5.edit',
  modelIds: ['gemini-2.5-flash-image'],
  label: 'yunwu Gemini 2.5 edit',
}

/**
 * Gemini 官方 —— 采用官方 ai.google.dev 图片文档：imageConfig 大写 1K/2K/4K。
 * LOW/MEDIUM 未在当前官方文档确认，本次移除；仅在真实探针补充证据后可放行。
 */
const OFFICIAL_GEMINI_GENERATE: ImageContract = {
  id: 'gemini.official.generate',
  supplier: 'gemini-official',
  protocol: 'gemini',
  operation: 'text-to-image',
  endpoint: '/v1beta/models/{modelId}:generateContent',
  method: 'POST',
  modelIds: '*',
  label: 'Gemini official generate',
  gemini: {
    imageConfig: {
      enabled: true,
      aspectRatios: ['1:1', '4:3', '3:2', '16:9', '9:16', '2:3'],
      imageSizes: ['1K', '2K', '4K'],
      imageSizeOptional: true,
    },
    supportsYunwuResponseFormatUrl: false,
  },
}

const OFFICIAL_GEMINI_EDIT: ImageContract = {
  id: 'gemini.official.edit',
  supplier: 'gemini-official',
  protocol: 'gemini',
  operation: 'image-edit',
  endpoint: '/v1beta/models/{modelId}:generateContent',
  method: 'POST',
  modelIds: '*',
  label: 'Gemini official edit',
  gemini: {
    imageConfig: { enabled: false },
    supportsYunwuResponseFormatUrl: false,
    requiresReferenceImage: true,
  },
}

/**
 * 云雾 Midjourney Imagine —— Apifox 5427167/232421938。
 * 官方 Body：botType + prompt，可选 base64Array / notifyHook / state。
 * 参考图先按 Imagine 内嵌 base64Array 处理，避免额外强制先调 upload。
 */
const YUNWU_MJ_IMAGINE: ImageContract = {
  id: 'yunwu.mj.imagine',
  supplier: 'yunwu',
  protocol: 'mj',
  operation: 'text-to-image',
  endpoint: '/mj/submit/imagine',
  method: 'POST',
  modelIds: '*',
  label: 'yunwu MJ imagine',
  mj: {
    supportsAspectRatio: true,
    aspectRatios: ['1:1', '4:3', '3:2', '16:9', '9:16', '2:3'],
    supportsStylize: true,
    stylizeMin: 0,
    stylizeMax: 1000,
    botTypes: ['MID_JOURNEY'],
    supportsBase64ReferenceImages: true,
  },
}

/**
 * MJ 图生图（垫图）复用 Imagine + base64Array，实现层视作 text-to-image 分支处理；
 * 单独契约 id 便于 route 选择与日志。
 */
const YUNWU_MJ_IMAGINE_WITH_REFERENCE: ImageContract = {
  ...YUNWU_MJ_IMAGINE,
  id: 'yunwu.mj.imagine.reference',
  operation: 'image-to-image',
  label: 'yunwu MJ imagine (reference)',
  mj: {
    ...YUNWU_MJ_IMAGINE.mj!,
  },
}

const ALL_CONTRACTS: ImageContract[] = [
  YUNWU_OPENAI_GPT_IMAGE_2_GENERATE,
  YUNWU_OPENAI_GPT_IMAGE_2_C_GENERATE,
  YUNWU_OPENAI_GPT_IMAGE_2_EDIT,
  YUNWU_OPENAI_GPT_IMAGE_1_GENERATE,
  OFFICIAL_OPENAI_GENERATE,
  OFFICIAL_OPENAI_EDIT,
  YUNWU_GEMINI_2_5_GENERATE,
  YUNWU_GEMINI_2_5_EDIT,
  YUNWU_GEMINI_3_PRO_GENERATE,
  YUNWU_GEMINI_3_PRO_EDIT,
  OFFICIAL_GEMINI_GENERATE,
  OFFICIAL_GEMINI_EDIT,
  YUNWU_MJ_IMAGINE,
  YUNWU_MJ_IMAGINE_WITH_REFERENCE,
]

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/** 生成模式（图生/合成）需要视作与图生图同一契约。 */
function normalizeOperation(operation: ContractOperation): ContractOperation {
  if (operation === 'compose-image') return 'image-edit'
  if (operation === 'image-to-image') return 'image-edit'
  return operation
}

export function resolveContract(input: ContractResolveInput): ContractResolveResult {
  const target = normalizeOperation(input.operation)
  const candidates = ALL_CONTRACTS.filter(
    (c) => c.supplier === input.supplier
      && c.protocol === input.protocol
      && normalizeOperation(c.operation) === target,
  )
  if (candidates.length === 0) {
    return { ok: false, reason: `no contract registered for supplier=${input.supplier} protocol=${input.protocol} operation=${target}` }
  }
  // MJ Imagine 图生图 = 文生图 + base64Array，避免额外契约选择歧义
  if (input.protocol === 'mj' && target === 'image-edit') {
    const mjReference = candidates.find((c) => c.id === 'yunwu.mj.imagine.reference')
    if (mjReference) return { ok: true, contract: mjReference }
  }
  // 精确 modelIds 优先，然后 '*'
  const exact = candidates.find(
    (c) => Array.isArray(c.modelIds) && c.modelIds.includes(input.modelId),
  )
  if (exact) return { ok: true, contract: exact }
  const wildcard = candidates.find((c) => c.modelIds === '*')
  if (wildcard) return { ok: true, contract: wildcard }
  return {
    ok: false,
    reason: `no contract matches modelId=${input.modelId} supplier=${input.supplier} protocol=${input.protocol} operation=${target}`,
  }
}

export function listContracts(): ImageContract[] {
  return ALL_CONTRACTS.slice()
}

export function getContractById(id: string): ImageContract | undefined {
  return ALL_CONTRACTS.find((c) => c.id === id)
}

export type { ContractOperation, ContractProtocol, ContractSupplier, ImageContract }
