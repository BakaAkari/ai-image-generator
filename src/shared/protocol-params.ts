/**
 * 协议参数定义 —— 单事实源，所有参数名称、标签、选项、默认值都由此驱动。
 * 向导界面 / 参数渲染 / 参数收集 全部引用此文件，不得硬编码。
 */
export interface ParamDef {
  /** 请求负载中的字段名（如 resolution、aspectRatio、ar） */
  key: string
  /** 面向用户的中文标签 */
  label: string
  type: 'enum' | 'number'
  /** 枚举可选值 */
  options?: string[]
  /** 枚举可选项中对应的中文显示（长度与 options 一致） */
  displayValues?: string[]
  /** 数字类型最小值 */
  min?: number
  /** 数字类型最大值 */
  max?: number
  /** 默认值 */
  default: string | number
  /** 若为 true，附加值到 prompt 字符串（MJ 风格）而非 JSON 负载 */
  promptAppend?: boolean
}

export interface ProtocolParams {
  /** 若设置，表示该协议为异步生成（如 Midjourney 30-120s） */
  async?: { minSec: number; maxSec: number }
  /** 参数定义列表 */
  params: ParamDef[]
}

/**
 * 单事实源：所有协议支持的参数。
 * key 与 catalog 中 route.protocol 对应。
 */
export const PROTOCOL_PARAMS: Record<string, ProtocolParams> = {
  openai: {
    params: [
      {
        key: 'resolution',
        label: '分辨率',
        type: 'enum',
        options: ['1k', '2k', '4k'],
        displayValues: ['标清 1K', '高清 2K', '超清 4K'],
        default: '1k',
      },
      {
        key: 'aspectRatio',
        label: '宽高比',
        type: 'enum',
        options: ['1:1', '16:9', '9:16', '4:3'],
        default: '1:1',
      },
      {
        key: 'n',
        label: '生成张数',
        type: 'number',
        min: 1,
        max: 4,
        default: 1,
      },
    ],
  },
  gemini: {
    params: [
      {
        key: 'imageSize',
        label: '分辨率',
        type: 'enum',
        options: ['1K', '2K', '4K'],
        displayValues: ['标清 1K', '高清 2K', '超清 4K'],
        default: '1K',
      },
      {
        key: 'aspectRatio',
        label: '宽高比',
        type: 'enum',
        options: ['1:1', '16:9', '9:16', '4:3'],
        default: '1:1',
      },
    ],
  },
  mj: {
    async: { minSec: 30, maxSec: 120 },
    params: [
      {
        key: 'ar',
        label: '宽高比',
        type: 'enum',
        promptAppend: true,
        options: ['1:1', '16:9', '9:16', '4:3'],
        default: '1:1',
      },
      {
        key: 'stylize',
        label: '风格化强度',
        type: 'number',
        promptAppend: true,
        min: 0,
        max: 1000,
        default: 100,
      },
    ],
  },
}

/** 获取协议参数定义，未找到时返回空列表 */
export function getProtocolParams(protocol: string): ProtocolParams | undefined {
  return PROTOCOL_PARAMS[protocol]
}

/** 检查协议是否支持参数配置 */
export function hasProtocolParams(protocol: string): boolean {
  return protocol in PROTOCOL_PARAMS
}
