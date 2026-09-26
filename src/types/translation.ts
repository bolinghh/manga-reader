export interface TranslationRect { x: number; y: number; width: number; height: number }

export interface TranslationBlock {
  id: string
  source: string
  translation: string
  rect: TranslationRect
  uncertain: boolean
}

export interface TranslationConfig {
  provider: 'mymemory' | 'tencent' | 'deepl' | 'libretranslate' | 'compatible'
  ocrEndpoint: string
  endpoint: string
  model: string
  apiKey: string
  jsonMode: boolean
  sourceLanguage: string
  targetLanguage: string
  readingDirection: 'ltr' | 'rtl'
  secretId?: string
  region?: string
  email?: string
}

export interface TranslationFrame { dataUrl: string; width: number; height: number }

export interface TranslationRecord {
  key: string
  comicId: string
  pageIndex: number
  blocks: TranslationBlock[]
  complete: boolean
  updatedAt: number
  recognitionKey?: string
}

export interface RecognitionRecord {
  key: string
  comicId: string
  pageIndex: number
  blocks: TranslationBlock[]
  complete: boolean
  updatedAt: number
}

export interface TranslationSelection { pageIndex: number; rect: TranslationRect }
export interface TranslationActivation { pageIndex: number; block: TranslationBlock; anchor: HTMLElement }

export interface TranslationLayerState {
  enabled: boolean
  selecting: boolean
  pages: Record<number, TranslationBlock[]>
  activeId: string | null
}
