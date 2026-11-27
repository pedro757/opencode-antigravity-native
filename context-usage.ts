export const contextUsageKey = "antigravity/contextUsage"

export function readContextUsage(value: unknown) {
  if (!value || typeof value !== "object" || !("used" in value) || !("size" in value)) return
  const { used, size } = value
  if (typeof used !== "number" || !Number.isSafeInteger(used) || used < 0) return
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) return
  return { used, size }
}

export type ContextUsage = NonNullable<ReturnType<typeof readContextUsage>>
