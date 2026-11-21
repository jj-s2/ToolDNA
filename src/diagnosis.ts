import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Validation } from './preflight.js'

export type Outcome = 'success' | 'error' | 'not_dispatched' | 'uncertain'

const beforeDispatch = new Set([
  'ABORTED_BEFORE_DISPATCH', 'APPROVAL_REJECTED', 'APPROVAL_CANCELLED', 'APPROVAL_UNAVAILABLE',
])
const transport = new Set(['TOOL_TIMEOUT', 'ABORTED'])

export function diagnose(
  result: Readonly<ToolExecutionResult>,
  enteredDispatch: boolean,
  denied: boolean,
  validation?: Validation,
) {
  const errorCode = result.isError ? result.error.info?.code : undefined
  if (denied || (errorCode !== undefined && beforeDispatch.has(errorCode))) {
    return { outcome: 'not_dispatched' as Outcome, code: 'NOT_DISPATCHED', advice: '请检查 DSH 的审批、权限或取消状态。', errorCode: errorCode && beforeDispatch.has(errorCode) ? errorCode : undefined }
  }
  if (errorCode !== undefined && transport.has(errorCode)) {
    return { outcome: 'uncertain' as Outcome, code: 'TRANSPORT_UNCERTAIN', advice: '远端执行结果未知。再次调用前请核实业务状态。', errorCode }
  }
  const outcome: Outcome = !enteredDispatch ? 'uncertain' : result.isError ? 'error' : 'success'
  if (!result.isError) {
    return { outcome, code: outcome === 'success' ? 'SUCCESS' : 'UNCLASSIFIED_ERROR', advice: '' }
  }
  if (errorCode === 'INVALID_ARGS' || validation?.validation === 'invalid') {
    const issue = validation?.issues[0]
    const advice = issue
      ? `请检查字段 ${issue.field} 的 ${issue.keyword} 约束，再构造新调用。`
      : '请根据工具的输入 Schema 修正参数。'
    return { outcome, code: 'INVALID_INPUT', advice, errorCode: errorCode === 'INVALID_ARGS' ? errorCode : undefined }
  }
  return { outcome, code: 'UNCLASSIFIED_ERROR', advice: '当前错误原因未知，请检查工具状态及本次参数。' }
}
