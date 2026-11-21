import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Outcome } from './diagnosis.js'

export const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

export function isObservedTool(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_./:-]{0,127}$/.test(name) &&
    name !== 'tooldna_inspect' && name !== 'run_code' && !name.startsWith('mcp__tooldna__')
}

const shells = new Set(['Bash', 'PowerShell', 'bash', 'pwsh', 'exec_command'])
export interface ToolOutcome { outcome: Outcome; code: string; advice: string }
export const unknownOutcome: ToolOutcome = { outcome: 'uncertain', code: 'OUTCOME_UNKNOWN', advice: '' }
const success: ToolOutcome = { outcome: 'success', code: 'SUCCESS', advice: '' }
const failure: ToolOutcome = {
  outcome: 'error', code: 'UNCLASSIFIED_ERROR', advice: '当前错误原因未知，请检查工具状态及本次参数。',
}
export const interrupted: ToolOutcome = {
  outcome: 'uncertain', code: 'TRANSPORT_UNCERTAIN', advice: '执行结果未知，再次调用前请核实操作状态。',
}
const denied: ToolOutcome = { outcome: 'not_dispatched', code: 'NOT_DISPATCHED', advice: '' }

export function commandExit(status: number): ToolOutcome {
  return status === 0 ? success : {
    outcome: 'error', code: 'COMMAND_EXIT_NONZERO',
    advice: `命令退出码为 ${status}。检查原始错误和运行环境，再决定下一步。`,
  }
}

export function httpOutcome(status: number): ToolOutcome {
  if (status >= 200 && status < 300) {
    return { outcome: 'success', code: 'HTTP_SUCCESS', advice: 'HTTP 请求已成功返回。请按需检查响应内容。' }
  }
  const advice = status === 401 || status === 403 ? '检查当前身份及权限。'
    : status === 429 ? '检查限流和服务端提供的等待时间。'
    : status >= 500 ? '检查服务状态。若操作可能写入数据，重试前先核实是否已经生效。'
    : status >= 400 ? '核对 URL、请求参数和响应中的错误说明。'
    : '检查响应头，确认网络请求已达到预期状态。'
  return { outcome: status >= 400 ? 'error' : 'uncertain', code: `HTTP_${status}`, advice }
}

export function configuredOutcome(rule: unknown, result: unknown): ToolOutcome | undefined {
  if (!isObject(rule) || typeof rule.field !== 'string' || !/^[A-Za-z_][\w.-]{0,63}$/.test(rule.field)) return undefined
  if (!['httpStatus', 'exitCode', 'successFlag'].includes(String(rule.kind))) return undefined
  if (!isObject(result) || !Object.hasOwn(result, rule.field)) return unknownOutcome
  const value = result[rule.field]
  if (rule.kind === 'successFlag') return value === true ? success : value === false ? failure : unknownOutcome
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return unknownOutcome
  if (rule.kind === 'exitCode') return commandExit(value)
  if (value < 100 || value > 599) return unknownOutcome
  const outcome = httpOutcome(value)
  return outcome.outcome === 'success' ? { ...outcome, advice: '' } : outcome
}

export function dshShellOutcome(name: string, result: Readonly<ToolExecutionResult>): ToolOutcome | undefined {
  if (!shells.has(name) || result.isError || !isObject(result.value)) return undefined
  const value = result.value
  if (value.kind === 'background' || value.kind === 'promoted') {
    return { outcome: 'uncertain', code: 'COMMAND_PENDING', advice: '' }
  }
  if (value.kind !== 'foreground') return undefined
  if (value.timedOut === true || value.aborted === true || typeof value.signal === 'string') return interrupted
  return typeof value.exitCode === 'number' && Number.isSafeInteger(value.exitCode)
    ? commandExit(value.exitCode) : unknownOutcome
}

export function hookOutcome(host: string, name: string, event: Record<string, unknown>): ToolOutcome | undefined {
  const kind = event.hook_event_name
  if (host === 'claude' && kind === 'PermissionDenied') return denied
  if (kind !== 'PostToolUse' && !(host === 'claude' && kind === 'PostToolUseFailure')) return undefined
  if (event.is_interrupt === true) return interrupted
  const result = event.tool_response
  if (shells.has(name)) {
    if (host === 'claude' && kind === 'PostToolUseFailure' && typeof event.error === 'string') {
      const code = /^Exit code (-?\d{1,10})(?:\r?\n|$)/.exec(event.error)
      if (code && Number(code[1]) !== 0) return commandExit(Number(code[1]))
    }
    if (kind === 'PostToolUse' && isObject(result)) {
      if (result.timedOut === true || result.aborted === true) return interrupted
      if (typeof result.exitCode === 'number' && Number.isSafeInteger(result.exitCode)) return commandExit(result.exitCode)
      const id = result.sessionId ?? result.session_id
      if (id !== undefined) return { outcome: 'uncertain', code: 'COMMAND_PENDING', advice: '' }
    }
    if (host === 'codex' && typeof result === 'string') {
      // Only trust the host's execution envelope, never a line inside command output.
      const code = /^Chunk ID: [\w-]+\r?\nWall time: [\d.]+ seconds\r?\nProcess exited with code (-?\d{1,10})(?:\r?\n|$)/.exec(result)
      if (code) return commandExit(Number(code[1]))
    }
  }
  if (host === 'claude') return kind === 'PostToolUseFailure' ? failure : success
  if (name.startsWith('mcp__') && isObject(result)) {
    if (result.isError === true || result.is_error === true) return failure
    if (result.isError === false || result.is_error === false ||
        (result.isError === undefined && result.is_error === undefined && Array.isArray(result.content))) return success
  }
  return unknownOutcome
}
