import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"

type Response = { result?: unknown; error?: { code?: number; message?: string } }
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }

export class AcpError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message)
  }
}

export class Acp {
  #next = 0
  #pending = new Map<number, Pending>()
  #closed = false

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    private readonly handle: (method: string, params: any) => unknown,
    private readonly onClose: (error: Error) => void,
  ) {
    const reader = createInterface({ input: child.stdout })
    reader.on("line", (line) => this.#read(line))
    child.stderr.resume()
    const fail = (error: Error) => {
      this.#finish(error)
      child.kill()
    }
    child.on("error", fail)
    child.stdin.on("error", fail)
    child.stdout.on("error", fail)
    child.once("close", (code, signal) => {
      reader.close()
      this.#finish(new Error(`Antigravity exited (${signal ?? code ?? "unknown status"}).`))
    })
  }

  static launch(cwd: string, fullAccess: boolean, handle: (method: string, params: any) => unknown, onClose: (error: Error) => void) {
    const args = ["acp", fullAccess ? "--dangerously-skip-permissions" : "--sandbox"]
    return new Acp(
      spawn(process.env.OPENCODE_ANTIGRAVITY_PATH || "agy", args, { cwd, stdio: "pipe" }),
      handle,
      onClose,
    )
  }

  request<T>(method: string, params: object, timeout = 30_000): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Antigravity is disconnected."))
    const id = ++this.#next
    return new Promise<unknown>((resolve, reject) => {
      const timer = timeout > 0 ? setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`${method} timed out.`))
      }, timeout) : undefined
      this.#pending.set(id, { resolve, reject, timer })
      this.#write({ id, method, params })
    }) as Promise<T>
  }

  notify(method: string, params: object) {
    this.#write({ method, params })
  }

  close() {
    this.#finish(new Error("Antigravity session closed."))
    this.child.stdin.end()
    const child = this.child
    const timer = setTimeout(() => child.kill(), 1500)
    timer.unref()
    child.once("close", () => clearTimeout(timer))
  }

  #finish(error: Error) {
    if (this.#closed) return
    this.#closed = true
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
    this.onClose(error)
  }

  #write(message: object) {
    if (!this.#closed) this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n")
  }

  #read(line: string) {
    if (!line.trim()) return
    let message: Response & { jsonrpc?: string; id?: number | string | null; method?: string; params?: unknown }
    try {
      message = JSON.parse(line)
    } catch {
      this.#finish(new Error("Antigravity sent invalid JSON on its ACP connection."))
      this.child.kill()
      return
    }
    if (!message || message.jsonrpc !== "2.0") return
    if (typeof message.method === "string") {
      const { method, id, params } = message
      void Promise.resolve().then(() => this.handle(method, params)).then(
        (result) => { if (id != null) this.#write({ id, result: result ?? null }) },
        (error) => {
          if (id != null) this.#write({ id, error: {
            code: error instanceof AcpError ? error.code ?? -32603 : -32603,
            message: error instanceof Error ? error.message : "Client request failed.",
          } })
        },
      )
      return
    }
    if (typeof message.id !== "number") return
    const pending = this.#pending.get(message.id)
    if (!pending) return
    this.#pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) pending.reject(new AcpError(message.error.message || "ACP request failed.", message.error.code))
    else pending.resolve(message.result)
  }
}
