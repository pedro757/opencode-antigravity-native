import { mkdir, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Context } from "@opencode/plugin"

type History = Awaited<ReturnType<Context["session"]["context"]>>
type User = Extract<History[number], { type: "user" }>
type Capabilities = { image?: boolean; audio?: boolean; embeddedContext?: boolean }

export async function attachmentBlocks(
  files: NonNullable<User["files"]>,
  caps: Capabilities | undefined,
  directory: string | undefined,
) {
  const blocks: object[] = []
  for (const [index, file] of files.entries()) {
    const name = basename(file.name ?? "attachment") || "attachment"
    const mimeType = file.mime.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream"
    if (!("data" in file)) throw new Error(`OpenCode did not resolve ${name}.`)
    if (mimeType.startsWith("image/") && caps?.image) {
      blocks.push({ type: "image", data: file.data, mimeType })
      continue
    }
    if (mimeType.startsWith("audio/") && caps?.audio) {
      blocks.push({ type: "audio", data: file.data, mimeType })
      continue
    }
    const bytes = Buffer.from(file.data, "base64")
    if (bytes.length <= 1024 * 1024 && (mimeType.startsWith("text/") || mimeType === "application/json")) {
      const content = bytes.toString("utf8")
      blocks.push(caps?.embeddedContext
        ? { type: "resource", resource: { uri: `opencode://attachments/${index}/${encodeURIComponent(name)}`, mimeType, text: content } }
        : { type: "text", text: `Attachment ${name}:\n${content}` })
      continue
    }
    if (!directory) throw new Error(`No attachment directory for ${name}.`)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, `${index}-${name}`)
    await writeFile(path, bytes, { mode: 0o600 })
    blocks.push({ type: "resource_link", uri: pathToFileURL(path).href, name, mimeType, size: bytes.length })
  }
  return blocks
}
