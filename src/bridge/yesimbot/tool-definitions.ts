/**
 * YesImBot 工具定义（AI SDK 格式）。
 *
 * 为每个工具提供 name、description、Zod schema builder、
 * promptSnippet 和 promptGuidelines，供 LLM 进行工具选择。
 */

export interface YesImBotToolDefinition {
  name: string
  description: string
  inputSchemaBuilder: (z: any) => any
  promptSnippet?: string
  promptGuidelines?: string[]
}

export const YESIMBOT_TOOL_DEFINITIONS: YesImBotToolDefinition[] = [
  {
    name: 'aigc_generate_image',
    description:
      '根据文字描述生成一张或多张 AI 图像。支持指定风格预设、图像数量、尺寸等参数。',
    inputSchemaBuilder: (z) =>
      z.object({
        prompt: z.string().describe('图像描述文字，详细描述想要生成的图像内容'),
        stylePreset: z.string().optional().describe('风格预设名称，如 "anime"、"realistic" 等'),
        numImages: z.number().int().min(1).max(4).optional().describe('生成图像数量，默认 1'),
        aspectRatio: z
          .string()
          .optional()
          .describe('宽高比，如 "1:1"、"16:9"、"9:16" 等'),
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
    inputSchemaBuilder: (z) =>
      z.object({
        referenceImageUrl: z.string().url().describe('参考图像的 URL'),
        prompt: z.string().describe('编辑指令或新的图像描述'),
        stylePreset: z.string().optional().describe('风格预设名称'),
        strength: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('编辑强度，0-1 之间，默认 0.5'),
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
    inputSchemaBuilder: (z) =>
      z.object({
        stylePreset: z.string().optional().describe('精确的风格预设名称（命令名）'),
        styleQuery: z
          .string()
          .optional()
          .describe('风格搜索关键词，用于模糊匹配风格预设'),
        referenceMode: z
          .string()
          .enum(['none', 'current_message', 'quoted_message', 'explicit', 'last_generated'])
          .optional()
          .describe('参考图片来源，默认 none'),
        imageUrls: z
          .array(z.string().url())
          .optional()
          .describe('显式参考图像 URL 列表，当 referenceMode 为 explicit 时使用'),
        promptAdditions: z.string().optional().describe('额外的文字描述补充'),
        numImages: z.number().int().min(1).max(4).optional().describe('生成图像数量'),
        aspectRatio: z
          .string()
          .optional()
          .describe('宽高比，如 "1:1"、"16:9"、"9:16"'),
        resolution: z.string().optional().describe('分辨率，如 "1k"、"2k"、"4k"'),
        modelSuffix: z.string().optional().describe('模型后缀'),
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
    inputSchemaBuilder: (z) => z.object({}),
    promptSnippet: '使用 aigc_get_quota 工具查询积分',
    promptGuidelines: [
      '当用户询问剩余配额、积分、余额、使用统计时使用此工具',
    ],
  },
  {
    name: 'aigc_list_styles',
    description: '列出所有可用的风格预设及其描述，支持关键词搜索过滤。',
    inputSchemaBuilder: (z) =>
      z.object({
        query: z.string().optional().describe('可选的搜索关键词，用于过滤风格'),
      }),
    promptSnippet: '使用 aigc_list_styles 工具列出风格',
    promptGuidelines: [
      '当用户询问有哪些风格、支持什么风格时使用此工具',
      '可以使用 query 参数搜索特定类型的风格',
    ],
  },
]
