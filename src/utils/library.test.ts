import { describe, expect, it } from 'vitest'
import { groupInputBooks, makeSourceKey, naturalCompare, normalizeSourcePath } from './library'

function inputFile(path: string) {
  const file = new File(['page'], path.split('/').pop()!, { type: 'image/jpeg', lastModified: 10 })
  Object.defineProperty(file, 'webkitRelativePath', { value: path })
  return file
}

describe('library source helpers', () => {
  it('sorts page names naturally', () => {
    expect(['10.jpg', '2.jpg', '1.jpg'].sort(naturalCompare)).toEqual(['1.jpg', '2.jpg', '10.jpg'])
  })

  it('groups nested pages by the complete chapter parent path', () => {
    const books = groupInputBooks([
      inputFile('root/系列/第1话/2.jpg'),
      inputFile('root/系列/第2话/1.jpg'),
      inputFile('root/系列/第1话/1.jpg'),
    ])
    expect(books.map((book) => book.sourcePath)).toEqual(['系列/第1话', '系列/第2话'])
    expect(books[0].files.map((file) => file.name)).toEqual(['1.jpg', '2.jpg'])
  })

  it('normalizes paths and keeps same-name books at different locations distinct', () => {
    expect(normalizeSourcePath('E:\\Manga\\Book\\')).toBe('e:/manga/book')
    expect(makeSourceKey('E:/A/Book')).not.toBe(makeSourceKey('E:/B/Book'))
    expect(makeSourceKey('E:\\A\\Book')).toBe(makeSourceKey('e:/a/book'))
  })
})
