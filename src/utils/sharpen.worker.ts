// 锐化计算 Worker: 在后台线程跑 unsharpMask, 避免大图在主线程卡顿。
// 仅接收 ImageData(像素) 与参数, 返回处理后的 ImageData(通过 transferable 零拷贝回传)。
import { unsharpMask, type SharpenOptions } from './sharpenCore'

interface Req {
  id: number
  buffer: ArrayBuffer
  width: number
  height: number
  opts: SharpenOptions
}

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, buffer, width, height, opts } = e.data
  const src = new ImageData(new Uint8ClampedArray(buffer), width, height)
  const out = unsharpMask(src, opts)
  ;(self as unknown as Worker).postMessage(
    { id, buffer: out.data.buffer, width: out.width, height: out.height },
    [out.data.buffer],
  )
}
