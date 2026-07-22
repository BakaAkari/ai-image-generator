export interface ProbeOptions {
  apiBase: string
  apiKey: string
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>
  baseline?: { models: string[]; pricing: string[] }
}
export function redactText(value: unknown): string
export function runProbe(options: ProbeOptions): Promise<any>
