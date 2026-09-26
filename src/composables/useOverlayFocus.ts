import { nextTick, watch, type Ref } from 'vue'
import { focusFirst, trapFocus } from '../utils/focus'

/**
 * 浮层焦点管理：打开时把焦点移入浮层首个可聚焦元素，关闭时回填到「打开浮层的那个元素」。
 *
 * 之前在 ReaderView 里 help / jump / bookmarks 各自散落一份 opener 变量 + watch + nextTick 逻辑，
 * 缩略图面板则完全漏了焦点回填与 Tab 陷阱。这里收敛成一处，`open()` 集中记录 opener，
 * 避免调用方忘记赋值。
 *
 * 用法：
 *   const panel = ref<HTMLElement>()
 *   const { open: openPanel, close, trap } = useOverlayFocus(openRef, panel)
 *   // 模板: @keydown="trap($event)"  ref="panel"
 *   // 打开: openPanel()  (不要直接写 visible = true, 否则 opener 不会被记录)
 */
export function useOverlayFocus(
  visible: Ref<boolean>,
  root: Ref<HTMLElement | undefined>,
  onAfterClose?: () => void,
) {
  let opener: HTMLElement | null = null

  watch(visible, async (isOpen) => {
    if (isOpen) {
      // 打开瞬间记录触发元素; 由快捷键等非指针方式打开时 activeElement 可能是 body, 回填时跳过
      const active = document.activeElement as HTMLElement | null
      opener = active && active !== document.body ? active : null
      await nextTick()
      focusFirst(root.value ?? null)
    } else {
      const target = opener
      opener = null
      await nextTick()
      if (target && target.isConnected) target.focus()
    }
  })

  /** 打开浮层：统一入口（集中记录 opener） */
  function open() {
    visible.value = true
  }

  /** 关闭浮层：可见性复位 + 可选收尾回调 */
  function close() {
    visible.value = false
    onAfterClose?.()
  }

  function trap(event: KeyboardEvent) {
    trapFocus(event, root.value ?? null)
  }

  return { open, close, trap }
}
