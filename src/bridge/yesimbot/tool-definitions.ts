/**
 * YesImBot 工具定义（ToolService 格式）。
 *
 * 每个工具使用 Koishi Schema 定义 parameters（与 sticker-manager 一致），
 * 而非 AI SDK 的 Zod inputSchemaBuilder。
 */

import { Schema } from 'koishi'

export interface YesImBotToolDefinition {
  name: string
  description: string
  parameters: Schema // Koishi Schema 对象
  promptSnippet?: string
  promptGuidelines?: string[]
}

export const YESIMBOT_TOOL_DEFINITIONS: YesImBotToolDefinition[] = [
  {
    name: 'aigc_generate_image',
    description:
      '根据文字描述生成一张或多张 AI 图像。支持指定风格预设、图像数量、尺寸等参数。',
    parameters: Schema.object({
      prompt: Schema.string().required().description('图像描述文字，详细描述想要生成的图像内容'),
      stylePreset: Schema.string().description('风格预设名称，如 "anime"、"realistic" 等'),
      numImages: Schema.natural().min(1).max(4).default(1).description('生成图像数量'),
      aspectRatio: Schema.string().description('宽高比，如 "1:1"、"16:9"、"9:16" 等'),
    }),
    promptSnippet: '使用 aigc_generate_image 工具生成图像',
    promptGuidelines: [
      '当用户要求生成、画、创建图像时使用此工具',
      'prompt 参数应该详细描述图像内容，包括主体、风格、色彩、构图等',
      '如果用户提到特定风格（如动漫、写实、水彩等），使用 stylePreset 参数',
    ],
  },
  {
    name: 'aigc_edit_image',
    description: '基于参考图像和文字描述编辑或变换图像。',
    parameters: Schema.object({
      referenceImageUrl: Schema.string().required().description('参考图像的 URL'),
      prompt: Schema.string().required().description('编辑指令或新的图像描述'),
      stylePreset: Schema.string().description('风格预设名称'),
      strength: Schema.number().min(0).max(1).default(0.5).description('编辑强度，0-1 之间'),
    }),
    promptSnippet: '使用 aigc_edit_image 工具编辑图像',
    promptGuidelines: [
      '当用户要求修改、编辑、变换已有图像时使用此工具',
      '需要提供参考图像 URL（从上下文或用户消息中获取）',
      'strength 参数控制编辑强度：接近 0 保留更多原图，接近 1 变化更大',
    ],
  },
  {
    name: 'aigc_apply_style_preset',
    description: '将指定的风格预设应用到参考图像上，支持通过风格名称或关键词匹配。',
    parameters: Schema.object({
      stylePreset: Schema.string().description('精确的风格预设名称（命令名）'),
      styleQuery: Schema.string().description('风格搜索关键词，用于模糊匹配风格预设'),
      referenceMode: Schema.union([
        Schema.const('none').description('不参考任何图像'),
        Schema.const('current_message').description('参考当前消息中的图片'),
        Schema.const('quoted_message').description('参考引用的消息中的图片'),
        Schema.const('explicit').description('显式指定图片 URL'),
        Schema.const('last_generated').description('参考上一张生成的图像'),
      ]).default('none').description('参考图片来源'),
      imageUrls: Schema.array(Schema.string()).description('显式参考图像 URL 列表'),
      promptAdditions: Schema.string().description('额外的文字描述补充'),
      numImages: Schema.natural().min(1).max(4).default(1).description('生成图像数量'),
      aspectRatio: Schema.string().description('宽高比，如 "1:1"、"16:9"、"9:16"'),
      resolution: Schema.string().description('分辨率，如 "1k"、"2k"、"4k"'),
      modelSuffix: Schema.string().description('模型后缀'),
    }),
    promptSnippet: '使用 aigc_apply_style_preset 工具应用风格',
    promptGuidelines: [
      '当用户要求将某种风格应用到图像时使用此工具',
      '先用 aigc_list_styles 查询可用风格，再用此工具生成',
      'stylePreset 使用精确名称，styleQuery 用于模糊搜索',
    ],
  },
  {
    name: 'aigc_get_quota',
    description: '查询当前用户的图像生成积分余额和使用统计。',
    parameters: Schema.object({}),
    promptSnippet: '使用 aigc_get_quota 工具查询积分',
    promptGuidelines: [
      '当用户询问剩余配额、积分、余额、使用统计时使用此工具',
    ],
  },
  {
    name: 'aigc_list_styles',
    description: '列出所有可用的风格预设及其描述，支持关键词搜索过滤。',
    parameters: Schema.object({
      query: Schema.string().description('可选的搜索关键词，用于过滤风格'),
    }),
    promptSnippet: '使用 aigc_list_styles 工具列出风格',
    promptGuidelines: [
      '当用户询问有哪些风格、支持什么风格时使用此工具',
      '可以使用 query 参数搜索特定类型的风格',
    ],
  },
]
