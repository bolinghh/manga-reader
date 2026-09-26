import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { extractArchiveImages } from './archiveCore'
describe('archive limits and ordering', () => {
  it('keeps natural page order across directories and ignores non-images', async () => {
    const zip = new JSZip(); zip.file('b/10.jpg', 'ten'); zip.file('b/2.jpg', 'two'); zip.file('a/1.png', 'one'); zip.file('notes.txt', 'ignored')
    const files = await extractArchiveImages(await zip.generateAsync({ type: 'arraybuffer' }), 'sample.cbz')
    expect(files.map(file => file.name)).toEqual(['1.png', '2.jpg', '10.jpg'])
    expect(files.map(file => file.type)).toEqual(['image/png', 'image/jpeg', 'image/jpeg'])
  })
  it('rejects oversized expanded ZIP entries before extracting their bytes', async () => {
    const zip = new JSZip(); zip.file('1.png', 'small')
    const data = await zip.generateAsync({ type: 'arraybuffer' })
    const bytes = new Uint8Array(data), view = new DataView(data)
    for (let index = 0; index < bytes.length - 30; index++) {
      if (view.getUint32(index, true) === 0x02014b50) { view.setUint32(index + 24, 129 * 1024 * 1024, true); break }
    }
    await expect(extractArchiveImages(data, 'large.cbz')).rejects.toThrow('解压后的图片过大')
  })
  it('streams pages without retaining all decoded File objects in the worker', async () => {
    const zip = new JSZip(); zip.file('10.jpg', 'ten'); zip.file('2.jpg', 'two')
    const seen: { index: number; name: string }[] = []
    const result = await extractArchiveImages(await zip.generateAsync({ type: 'arraybuffer' }), 'sample.cbz', async (file, index) => { seen.push({ index, name: file.name }) })
    expect(seen).toEqual([{ index: 0, name: '2.jpg' }, { index: 1, name: '10.jpg' }])
    expect(result).toEqual([])
  })
})
