// 锐化的主线程入口:
//   - sharpenImageData(): 在 Worker 中跑 USM(零拷贝 transfer), 失败则主线程同步兜底
//   - sharpenFileToUrl(): 解码文件 -> USM -> 返回 blob URL(调用方负责 revoke)
//
// 性能说明见 sharpenCore.ts。Worker 化后, 大图/高 dpr PDF 的锐化计算不再阻塞主线程,
// 翻页与滚动更顺滑; 若运行环境不支持 Worker(极老 WebView), 自动回退到主线程同步计算。

import { unsharpMask, type SharpenOptions } from './sharpenCore'

let worker: Worker | null = null
let workerOk = true
let seq = 0
const pending = new Map<number, { resolve: (d: ImageData) => void; reject: (e: unknown) => void }>()

function getWorker(): Worker | null {
  if (!workerOk) return null
  if (worker) return worker
  if (typeof Worker === 'undefined') {
    workerOk = false
    return null
  }
  try {
    worker = new Worker(new URL('./sharpen.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ id: number; buffer: ArrayBuffer; width: number; height: number }>) => {
      const p = pending.get(e.data.id)
      if (!p) return
      pending.delete(e.data.id)
      p.resolve(new ImageData(new Uint8ClampedArray(e.data.buffer), e.data.width, e.data.height))
    }
    worker.onerror = () => {
      // Worker 不可用 -> 标记失败, 后续回退主线程; 已派发的任务按失败处理(调用方兜底用原图)
      workerOk = false
      worker = null
      pending.forEach((p) => p.reject(new Error('sharpen worker error')))
      pending.clear()
    }
  } catch {
    workerOk = false
    worker = null
  }
  return worker
}

/**
 * 对 ImageData 做 USM。优先走 Worker; Worker 不可用时在主线程同步算。
 * 注意: 走 Worker 时入参的像素 buffer 会被 transfer 走(主线程侧 detached),
 *      因此调用方在 await 之后不应再使用传入的 ImageData。
 */
export async function sharpenImageData(data: ImageData, opts: SharpenOptions): Promise<ImageData> {
  const w = getWorker()
  if (!w) return unsharpMask(data, opts) // 同步兜底
  return new Promise<ImageData>((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    try {
      w.postMessage(
        { id, buffer: data.data.buffer, width: data.width, height: data.height, opts },
        [data.data.buffer],
      )
    } catch {
      pending.delete(id)
      // transfer 失败(理论上不会) -> 主线程兜底
      resolve(unsharpMask(data, opts))
    }
  }).catch(() => unsharpMask(data, opts)) // Worker 出错 -> 主线程兜底
}

/** 从文件解码 -> USM -> 返回 blob URL (调用方负责 revoke) */
export async function sharpenFileToUrl(file: File, opts: SharpenOptions): Promise<string> {
  const bmp = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = bmp.width
  canvas.height = bmp.height
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bmp, 0, 0)
  const src = ctx.getImageData(0, 0, bmp.width, bmp.height)
  const dst = await sharpenImageData(src, opts)
  ctx.putImageData(dst, 0, 0)
  bmp.close()
  return await new Promise<string>((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(URL.createObjectURL(b))
      else reject(new Error('sharpen: toBlob failed'))
    }, 'image/png')
  })
}
