// 把 pdfjs 解码所需的解码器(wasm)与字体映射(cmaps)从 node_modules 同步到 public_root/pdfjs/，
// 确保 vite dev / build 时这些静态资源随项目发布。
//
// 背景: pdfjs v6 的 JBIG2/OpenJPEG 解码依赖 jbig2.wasm / openjpeg.wasm, 不随主包打包,
// 必须作为静态资源提供; 漏拷会导致漫画 PDF(JBIG2 压缩)整页空白、EPUB/PDF 中文缺字。
// 升级 pdfjs-dist 后 node_modules 里的 wasm/cmaps 会变, 本脚本在 predev/prebuild 自动重拷, 防回归。
import { cp, mkdir, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const srcWasm = join(root, 'node_modules/pdfjs-dist/wasm')
const srcCmaps = join(root, 'node_modules/pdfjs-dist/cmaps')
const dst = join(root, 'public_root/pdfjs')

async function exists(p) {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function syncOne(name, src, dstDir) {
  if (!(await exists(src))) {
    console.warn(`[sync-pdfjs] 跳过 ${name}: 源目录不存在 (${src}) — 请先 npm install`)
    return false
  }
  await mkdir(dstDir, { recursive: true })
  await cp(src, dstDir, { recursive: true })
  console.log(`[sync-pdfjs] ${name} -> ${dstDir}`)
  return true
}

await syncOne('wasm', srcWasm, join(dst, 'wasm'))
await syncOne('cmaps', srcCmaps, join(dst, 'cmaps'))
