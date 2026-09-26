import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

// 渲染 PDF 首页为封面缩略图(dataURL), 用于书架展示。
// 失败(损坏/不支持)返回 undefined, 不阻断导入流程。
// 与 PdfReader 一致提供 wasmUrl/cMapUrl, 确保 JBIG2 压缩首页也能正确解码。
export async function pdfCover(source: File | string, maxW = 480): Promise<string | undefined> {
  let doc: any = null
  try {
    const assetBase = import.meta.env.BASE_URL
    doc = await pdfjsLib.getDocument({
      ...(typeof source === 'string' ? { url: source } : { data: await source.arrayBuffer() }),
      wasmUrl: assetBase + 'pdfjs/wasm/',
      cMapUrl: assetBase + 'pdfjs/cmaps/',
      cMapPacked: true,
    }).promise
    const page = await doc.getPage(1)
    const base = page.getViewport({ scale: 1 })
    const scale = Math.min(1, maxW / base.width)
    const vp = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = vp.width
    canvas.height = vp.height
    const ctx = canvas.getContext('2d')!
    await page.render({ canvasContext: ctx, viewport: vp }).promise
    return canvas.toDataURL('image/jpeg', 0.7)
  } catch {
    return undefined
  } finally {
    try {
      doc?.destroy?.()
    } catch {
      /* ignore */
    }
  }
}
