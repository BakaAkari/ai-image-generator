/**
 * direct-intent —— 用户是否在本次消息里出现了「直接生成」命令语法。
 *
 * 判断依据（全部由 `parseStyleCommandModifiers` + `-n` 选项配置驱动，无模型硬编码）：
 *   - modelMapping：任一 `modelMappings.suffix` 被解析器成功命中（新增/删除 mapping 立即生效）
 *   - resolution：预设分辨率（如 -1k / -2k / -4k）或自定义分辨率（如 -1024x2048）
 *   - aspectRatio：任一比例后缀（如 -16:9 / -3:2 / -2:3 ...）
 *   - customAdditions：出现 `-add ...` 追加片段
 *   - numOption：`-n <num>` 是有效数字
 *
 * 使用位置：核心命令（文生图 / 图生图 / 合成图）与 style 快捷命令共用同一份判断，
 * 由入口层将「原始用户解析结果」传入，避免混入 mapping 兜底或 style 默认后缀。
 */
import type { ImageGenerationModifiers } from './types.js'

export function detectDirectIntent(
  parsedModifiers: ImageGenerationModifiers | undefined,
  numOption: number | undefined,
): boolean {
  if (typeof numOption === 'number' && Number.isFinite(numOption)) return true
  if (!parsedModifiers) return false
  if (parsedModifiers.modelMapping) return true
  if (parsedModifiers.resolution) return true
  if (parsedModifiers.aspectRatio) return true
  if (parsedModifiers.customAdditions && parsedModifiers.customAdditions.length > 0) return true
  return false
}
