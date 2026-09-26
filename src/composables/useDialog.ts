import { reactive } from 'vue'

export interface DialogOptions {
  title?: string
  message: string
  confirmText?: string
  cancelText?: string
  /** 危险操作(删除等): 确认按钮用强调/危险色 */
  danger?: boolean
}

interface DialogState {
  kind: 'confirm' | 'alert'
  visible: boolean
  title: string
  message: string
  confirmText: string
  cancelText: string
  danger: boolean
  resolve: ((value: boolean) => void) | null
}

// 单例: 全应用共享一个对话框实例, 由 <AppDialog> 渲染。原生 confirm()/alert() 无法主题化且会阻塞,
// 这里用 Promise 化的应用内对话框替代, 支持亮/暗主题、焦点陷阱与 Esc 取消。
const state = reactive<DialogState>({
  kind: 'alert',
  visible: false,
  title: '',
  message: '',
  confirmText: '',
  cancelText: '',
  danger: false,
  resolve: null,
})

function open(kind: 'confirm' | 'alert', opts: DialogOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // 已有对话框未关闭时, 用带原因的方式结算它: 调用方能通过 lastDialogCloseReason() 区分
    // 「被新对话框顶替(preempted)」与「用户点了取消(cancel)」。返回值仍为 false,
    // 使 `if (await confirmDialog(...))` 这类常见写法不会把顶替误判成确认。
    if (state.resolve) settle(false, 'preempted')
    state.kind = kind
    state.title = opts.title || (kind === 'confirm' ? '请确认' : '提示')
    state.message = opts.message
    state.confirmText = opts.confirmText || (kind === 'confirm' ? '确定' : '好的')
    state.cancelText = opts.cancelText || '取消'
    state.danger = !!opts.danger
    state.resolve = resolve
    state.visible = true
  })
}

/** 结算当前对话框: 清空 resolver 后回调, 保证幂等(重复调用不会二次 resolve) */
function settle(value: boolean, reason: DialogCloseReason) {
  const resolver = state.resolve
  state.resolve = null
  state.visible = false
  lastCloseReason = reason
  resolver?.(value)
}

export function useDialogState() {
  return state
}

/** 替代 window.confirm —— 返回 Promise<boolean> */
export function confirmDialog(opts: DialogOptions | string): Promise<boolean> {
  return open('confirm', typeof opts === 'string' ? { message: opts } : opts)
}

/** 替代 window.alert —— 返回 Promise<void> */
export async function alertDialog(opts: DialogOptions | string): Promise<void> {
  await open('alert', typeof opts === 'string' ? { message: opts } : opts)
}

/** 对话框关闭原因: confirm/cancel 为用户操作, dismiss 为点击遮罩/Esc, preempted 为被新对话框顶替 */
export type DialogCloseReason = 'confirm' | 'cancel' | 'dismiss' | 'preempted'

let lastCloseReason: DialogCloseReason = 'cancel'

/** 最近一次对话框的关闭原因 (供需要区分「被顶替」与「用户取消」的调用方查询) */
export function lastDialogCloseReason(): DialogCloseReason {
  return lastCloseReason
}

/** 由 <AppDialog> 调用以结算当前对话框 */
export function resolveDialog(value: boolean) {
  settle(value, value ? 'confirm' : 'cancel')
}

/** 点击遮罩 / 按 Esc 关闭: 同「取消」结果, 但记录原因便于区分 */
export function dismissDialog() {
  settle(false, 'dismiss')
}
