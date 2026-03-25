const listeners = new Set<() => void>()

export function notifyAuthRequired() {
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeAuthRequired(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
