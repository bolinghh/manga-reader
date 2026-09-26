import Dexie from 'dexie'

interface CachedPage {
  comicId: string
  index: number
  name: string
  type: string
  data: ArrayBuffer
}

const cache = new Dexie('lumina-pages')
cache.version(1).stores({ pages: '[comicId+index], comicId' })
const pages = cache.table<CachedPage, [string, number]>('pages')

/** Save one page at a time, so importing a large folder never buffers the whole book. */
export async function saveBrowserPages(comicId: string, files: File[]): Promise<void> {
  await deleteBrowserPages(comicId)
  try {
    for (let index = 0; index < files.length; index++) {
      const file = files[index]
      await pages.put({ comicId, index, name: file.name, type: file.type, data: await file.arrayBuffer() })
    }
  } catch (error) {
    await deleteBrowserPages(comicId).catch(() => undefined)
    throw error
  }
}

export async function readBrowserPage(comicId: string, index: number): Promise<File> {
  const page = await pages.get([comicId, index])
  if (!page) throw new Error('此页的浏览器缓存已失效，请重新导入原漫画。')
  return new File([page.data], page.name, { type: page.type })
}

export async function deleteBrowserPages(comicId: string): Promise<void> {
  await pages.where('comicId').equals(comicId).delete()
}

export async function clearBrowserPages(): Promise<void> {
  await pages.clear()
}
