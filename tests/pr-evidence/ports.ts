export const prEvidenceDefaultPorts = Object.freeze({
  editor: 4337,
  preview: 4338,
  login: 4339,
})

export function readPrEvidencePort(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65_535) throw new Error(`Invalid ${name}.`)
  return value
}

export function prEvidenceUrl(name: string, fallback: number): string {
  return `http://127.0.0.1:${readPrEvidencePort(name, fallback)}/`
}
