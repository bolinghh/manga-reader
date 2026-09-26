export function abortError() { return new DOMException('已取消', 'AbortError') }

/** Limits active work and removes cancelled work before it starts. */
export function createTaskQueue(limit: number) {
  let active = 0
  const waiting: (() => void)[] = []
  function pump() { while (active < limit && waiting.length) waiting.shift()!() }
  return {
    run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
      return new Promise((resolve, reject) => {
        let started = false
        const abort = () => {
          if (started) return
          const index = waiting.indexOf(start)
          if (index >= 0) waiting.splice(index, 1)
          signal.removeEventListener('abort', abort)
          reject(abortError())
        }
        const start = () => {
          if (signal.aborted) { abort(); return }
          started = true
          active++
          signal.removeEventListener('abort', abort)
          Promise.resolve().then(task).then(resolve, reject).finally(() => { active--; pump() })
        }
        if (signal.aborted) { reject(abortError()); return }
        signal.addEventListener('abort', abort, { once: true })
        waiting.push(start)
        pump()
      })
    },
  }
}

export function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError())
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
