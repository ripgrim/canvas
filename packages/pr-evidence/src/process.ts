import { spawn } from "node:child_process"
import type { ProcessPort, ProcessResult } from "./media.js"

export function createProcessRunner(input: Readonly<{ timeoutMs?: number; maxOutputBytes?: number }> = {}): ProcessPort {
  const timeoutMs = input.timeoutMs ?? 60_000
  const maxOutputBytes = input.maxOutputBytes ?? 1024 * 1024
  return (executable, arguments_) => new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(executable, arguments_, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    const stdout: Uint8Array[] = []
    const stderr: Uint8Array[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    const stop = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill("SIGKILL")
      reject(error)
    }
    const append = (target: Uint8Array[], currentBytes: number, chunk: Uint8Array) => {
      if (currentBytes + chunk.byteLength > maxOutputBytes) {
        stop(new Error("Evidence tool output exceeded its limit."))
        return currentBytes
      }
      target.push(chunk)
      return currentBytes + chunk.byteLength
    }
    child.stdout.on("data", chunk => { stdoutBytes = append(stdout, stdoutBytes, Buffer.from(chunk)) })
    child.stderr.on("data", chunk => { stderrBytes = append(stderr, stderrBytes, Buffer.from(chunk)) })
    child.once("error", stop)
    child.once("close", code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(Object.freeze({ code: code ?? -1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }))
    })
    const timer = setTimeout(() => stop(new Error("Evidence tool timed out.")), timeoutMs)
    timer.unref()
  })
}
