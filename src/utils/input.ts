import { Session, h } from 'koishi'

/**
 * 图片 URL 协议白名单：与下载层 `downloadImageAsBase64()` 的能力对齐。
 * - http/https：标准网络图片
 * - data:：base64 内联图片（如 Lark incomingImageMode=data-url）
 * - internal:：Koishi/Satori 内部资源引用（如 internal:lark/...、internal:onebot/...）
 * - file: / base64://：OneBot 等适配器的本地文件与裸 base64 引用
 */
const IMAGE_URL_PREFIXES = ['http://', 'https://', 'data:', 'internal:', 'file:', 'base64://']

/** 判断字符串是否为可接受的图片 URL（用于区分 [img] 参数里的图片与普通文本） */
export function isSupportedImageUrl(value: unknown): boolean {
  return typeof value === 'string' && IMAGE_URL_PREFIXES.some(prefix => value.startsWith(prefix))
}

export function collectImagesFromParamAndQuote(session: Session, imgParam: any, includeQuote = true): string[] {
  const images: string[] = []

  if (imgParam) {
    if (typeof imgParam === 'object' && imgParam.attrs?.src) {
      images.push(imgParam.attrs.src)
    } else if (isSupportedImageUrl(imgParam)) {
      images.push(imgParam)
    }
  }

  if (includeQuote && session.quote?.elements) {
    const quoteImages = h.select(session.quote.elements, 'img')
    for (const img of quoteImages) {
      if (img.attrs.src && !images.includes(img.attrs.src)) images.push(img.attrs.src)
    }
  }

  // Feishu 等适配器会把图片放在 session.elements 中，而不是 imgParam 或 quote 里。
  // 这里作为兜底来源，去重后补充到结果中。
  if (session.elements?.length) {
    const elementImages = h.select(session.elements, 'img')
    for (const img of elementImages) {
      if (img.attrs.src && !images.includes(img.attrs.src)) images.push(img.attrs.src)
    }
  }

  return images
}

export function parseMessageImagesAndText(message: string) {
  const elements = h.parse(message)
  const images = h.select(elements, 'img')
  const text = h.select(elements, 'text').map((e: h) => e.attrs.content).join(' ').trim()
  return { images, text }
}
