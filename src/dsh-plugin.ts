import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { Preflight } from './preflight.js'
import type { Validation } from './preflight.js'
import { diagnose } from './diagnosis.js'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { EvidenceStore } from './evidence-store.js'
import { conditionKey, conditionBucket, summarize } from './recovery.js'
import type { ConditionRule, AlternativeRule } from './recovery.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    tooldna: { kind: 'tooldna' }
  }
}

export const inject = ['tools']

export const Config: z<PluginOptions> = z.object({
  historyEnabled: z.boolean().default(true),
  retentionDays: z.natural().min(1).max(365).default(30),
  maxEvents: z.natural().min(1).max(10_000).default(10_000),
  conditionRules: z.array(z.object({
    tool: z.string().required(), numericField: z.string().required(),
    cutoffs: z.array(z.number()).min(1).max(4).required(),
  })).default([]),
  readOnlyAlternatives: z.array(z.object({
    from: z.string().required(), to: z.string().required(),
  })).default([]),
})

const isMcpName = (name: string | undefined): name is string =>
  typeof name === 'string' && /^mcp__[A-Za-z0-9_-]{1,123}$/.test(name)

interface PluginOptions {
  historyEnabled?: boolean
  retentionDays?: number
  maxEvents?: number
  conditionRules?: ConditionRule[]
  readOnlyAlternatives?: AlternativeRule[]
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0).map(([key, child]) => [key, canonical(child)]))
  }
  return value
}

export function apply(ctx: Context, config: PluginOptions = {}): void {
  const preflight = new Preflight()
  const retentionDays = config.retentionDays ?? 30
  const rules = new Map((config.conditionRules ?? [])
    .filter(rule => isMcpName(rule.tool) && /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(rule.numericField) &&
      rule.cutoffs.length >= 1 && rule.cutoffs.length <= 4 && rule.cutoffs.every((cutoff, index) =>
        Number.isFinite(cutoff) && (index === 0 || cutoff > rule.cutoffs[index - 1])))
    .map(rule => [rule.tool, rule]))
  const conditionKeys = new Map([...rules].map(([tool, rule]) => [tool, conditionKey(rule)]))
  const alternative = new Map((config.readOnlyAlternatives ?? []).map(rule => [rule.from, rule.to]))
  const versions = new WeakMap<object, { schemaHash: string; definitionEpoch: string }>()
  function identity(tool: { parameters: object }) {
    let version = versions.get(tool)
    if (!version) {
      version = {
        schemaHash: createHash('sha256').update(JSON.stringify(canonical(tool.parameters))).digest('hex'),
        definitionEpoch: randomUUID(),
      }
      versions.set(tool, version)
    }
    return version
  }
  const profile = ctx.get('profileContext') as { dir?: string } | undefined
  const dir = profile?.dir
  const store = config.historyEnabled !== false && dir && isAbsolute(dir)
    ? new EvidenceStore(join(dir, 'tooldna', 'evidence.sqlite3'), retentionDays,
      config.maxEvents ?? 10_000, () => ctx.logger.warn('TOOLDNA_EVIDENCE_UNAVAILABLE'))
    : undefined
  if (store) ctx.effect(() => () => store.close())
  const stages = new WeakMap<object, {
    validation?: Validation
    enteredDispatch: boolean
    denied: boolean
    version?: ReturnType<typeof identity>
    dispatchMs?: number
    featureKey?: string | null
    featureBucket?: number | null
  }>()
  const dropped = new WeakSet<object>()
  const feedback = new WeakMap<object, number[]>()
  function evidenceFor(toolName: string, input: unknown, exec: ToolExecution) {
    const sessionKey = exec.agent && store?.sessionKey(exec.agent.id)
    const tool = exec.agent && ctx.tools.get(toolName, exec.agent, exec.toolSet)
    const rule = rules.get(toolName)
    const featureKey = conditionKeys.get(toolName)
    const featureBucket = conditionBucket(rule, input)
    if (!store || !sessionKey || !tool || !featureKey || featureBucket === null) return undefined
    return summarize(store.recent.values(), {
      sessionKey, tool: toolName, ...identity(tool), featureKey, featureBucket,
      cutoff: Date.now() - retentionDays * 86_400_000,
    })
  }

  function candidateFor(toolName: string, input: unknown, exec: ToolExecution) {
    if (!exec.agent || !exec.toolSet) return null
    const name = alternative.get(toolName)
    if (!isMcpName(name) || name === toolName) return null
    const source = ctx.tools.get(toolName, exec.agent, exec.toolSet)
    const candidate = ctx.tools.get(name, exec.agent, exec.toolSet)
    if (!source || source !== ctx.tools.get(toolName) || !candidate || candidate !== ctx.tools.get(name)) return null
    const sourceRule = conditionKeys.get(toolName)
    if (!sourceRule || sourceRule !== conditionKeys.get(name)) return null
    if (preflight.check(candidate.parameters, input).validation !== 'valid') return null
    const evidence = evidenceFor(name, input, exec)
    if (!evidence?.evidenceId) return null
    return { tool: name, evidenceId: evidence.evidenceId, success: evidence.success, error: evidence.error }
  }
  ctx.tools.register(defineTool({
    name: 'tooldna_inspect',
    description: 'List visible MCP tools or check arguments against a visible MCP tool schema.',
    parameters: {
      op: { type: 'string', enum: ['list', 'check', 'history'], required: true },
      tool: { type: 'string' },
      argumentsJson: { type: 'string' },
      limit: { type: 'integer' },
      includeArchived: { type: 'boolean' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const result = value as { op: string; status: string }
        const actions: Record<string, string> = { list: '工具目录', check: '参数预检', history: '调用证据' }
        const statuses: Record<string, string> = {
          ok: '查询完成', no_observations: '暂无观测', degraded: '证据可能不完整',
          history_disabled: '本地历史已关闭', tool_unavailable: '当前步骤不可用', invalid_request: '请求格式无效',
        }
        return [{ type: 'text', text: JSON.stringify({
          ...result, summary: `${actions[result.op] ?? 'ToolDNA'} · ${statuses[result.status] ?? result.status}`,
        }) }]
      },
    },
    async execute(args, exec) {
      const base = { version: 1, op: args.op, truncated: false }
      if (!exec.agent) return { ...base, status: 'tool_unavailable' }
      const limit = args.limit ?? 10
      if (limit < 1 || limit > 25) return { ...base, status: 'invalid_request' }
      if (args.op === 'history') {
        if (!isMcpName(args.tool)) return { ...base, status: 'invalid_request' }
        const tool = ctx.tools.get(args.tool, exec.agent, exec.toolSet)
        if (!tool) return { ...base, status: 'tool_unavailable' }
        if (config.historyEnabled === false) return { ...base, status: 'history_disabled' }
        const sessionKey = store?.sessionKey(exec.agent.id)
        if (!store || !sessionKey) return { ...base, status: 'degraded' }
        const version = identity(tool)
        const featureKey = conditionKeys.get(args.tool) ?? null
        const history = await store.history({
          sessionKey, tool: args.tool, ...version, featureKey, archived: args.includeArchived === true, limit,
        })
        if (!history) return { ...base, status: 'degraded' }
        const rows = []
        let remainingBytes = 7168
        for (const row of history.rows) {
          const publicRow = {
            ...row,
            current: row.schema_hash === version.schemaHash && row.definition_epoch === version.definitionEpoch &&
              row.feature_key === featureKey,
          }
          remainingBytes -= Buffer.byteLength(JSON.stringify(publicRow)) + 1
          if (remainingBytes < 0) {
            rows.splice(3)
            break
          }
          rows.push(publicRow)
        }
        return {
          ...base,
          status: dropped.has(exec.agent) ? 'degraded' : rows.length ? 'ok' : 'no_observations',
          truncated: Object.values(history.counts).reduce((sum, count) => sum + count, 0) > rows.length,
          counts: history.counts,
          rows,
        }
      }
      if (args.op === 'check') {
        if (!isMcpName(args.tool) || args.argumentsJson === undefined ||
            Buffer.byteLength(args.argumentsJson) > 32 * 1024) {
          return { ...base, status: 'invalid_request' }
        }
        const tool = ctx.tools.get(args.tool, exec.agent, exec.toolSet)
        if (!tool) return { ...base, status: 'tool_unavailable' }
        let input: unknown
        try {
          input = JSON.parse(args.argumentsJson)
        } catch {
          return { ...base, status: 'invalid_request' }
        }
        if (input === null || typeof input !== 'object' || Array.isArray(input)) {
          return { ...base, status: 'invalid_request' }
        }
        const validation = preflight.check(tool.parameters, input)
        const evidence = evidenceFor(args.tool, input, exec)
        const failures = evidence ? [...evidence.failureGroups].filter(([, group]) => group.count >= 3) : []
        const candidate = validation.validation === 'valid' ? candidateFor(args.tool, input, exec) : null
        return {
          ...base, status: config.historyEnabled === false ? 'history_disabled' : (dropped.has(exec.agent) || !store?.sessionKey(exec.agent.id))
            ? 'degraded' : 'ok',
          tool: args.tool, ...validation, candidate,
          evidenceIds: [...failures.map(([, group]) => group.latest), ...(candidate ? [candidate.evidenceId] : [])],
          observed: evidence ? { success: evidence.success, error: evidence.error } : null,
          repeatedFailures: failures.map(([code, group]) => ({ code, count: group.count })),
        }
      }
      const tools = ctx.tools.definitions(exec.agent, exec.toolSet)
        .filter(tool => isMcpName(tool.name))
        .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
      const sessionKey = store?.sessionKey(exec.agent.id)
      const epochs = new Set<string>()
      const cutoff = Date.now() - retentionDays * 86_400_000
      if (store && sessionKey) {
        for (const row of store.recent.values()) {
          if (row.sessionKey === sessionKey && row.definitionEpoch && row.observedAtMs >= cutoff &&
              row.featureKey === (conditionKeys.get(row.tool) ?? null)) epochs.add(row.definitionEpoch)
        }
      }
      const evidenceStatus = config.historyEnabled === false ? 'history_disabled'
        : !sessionKey || dropped.has(exec.agent) ? 'degraded' : 'no_observations'
      return {
        ...base, status: 'ok', availability: exec.toolSet ? 'step' : 'registered',
        truncated: tools.length > limit,
        tools: tools.slice(0, limit).map(tool => {
          const version = identity(tool)
          return {
            name: tool.name, schemaHash: version.schemaHash,
            evidenceStatus: evidenceStatus === 'no_observations' && epochs.has(version.definitionEpoch) ? 'observed' : evidenceStatus,
          }
        }),
      }
    },
  }))

  ctx.on('tools/pre-execute', async (exec, next) => {
    const eligible = exec.agent && !exec.parent && isMcpName(exec.name)
    if (!eligible) return next()
    const stage: NonNullable<ReturnType<typeof stages.get>> = { enteredDispatch: false, denied: false }
    try {
      const tool = ctx.tools.get(exec.name, exec.agent, exec.toolSet)
      const condition = rules.get(exec.name)
      stage.validation = tool && preflight.check(tool.parameters, exec.arguments)
      stage.version = tool && store ? identity(tool) : undefined
      stage.featureKey = conditionKeys.get(exec.name)
      stage.featureBucket = conditionBucket(condition, exec.arguments)
    } catch {
      // The original DSH call still proceeds when its schema cannot be profiled.
    }
    stages.set(exec, stage)
    const decision = await next()
    stage.denied = decision.kind === 'deny' || decision.kind === 'cancel'
    return decision
  })
  ctx.on('tools/execute', async (exec, next) => {
    const stage = stages.get(exec)
    if (!stage) return next()
    stage.enteredDispatch = true
    const started = performance.now()
    try {
      return await next()
    } finally {
      stage.dispatchMs = Math.max(0, Math.round(performance.now() - started))
    }
  })

  ctx.on('tools/result', (exec, result) => {
    const stage = stages.get(exec)
    stages.delete(exec)
    if (!store || !exec.agent || exec.parent || !isMcpName(exec.name)) return undefined
    const sessionKey = store.sessionKey(exec.agent.id)
    const diagnosis = diagnose(result, stage?.enteredDispatch ?? false, stage?.denied ?? false, stage?.validation)
    if (!sessionKey || !store.enqueue({
      id: randomUUID(), sessionKey, tool: exec.name,
      schemaHash: stage?.version?.schemaHash ?? null, definitionEpoch: stage?.version?.definitionEpoch ?? null,
      observedAtMs: Date.now(), dispatchMs: stage?.dispatchMs ?? null, dispatchSeen: stage?.enteredDispatch ?? false,
      status: diagnosis.outcome, diagnosisCode: diagnosis.code, errorCode: diagnosis.errorCode ?? null,
      featureKey: stage?.featureKey ?? null, featureBucket: stage?.featureBucket ?? null,
    })) dropped.add(exec.agent)
    return undefined
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const stage = stages.get(exec)
    // In the pinned DSH pipeline, post-execute can also run after a guard denies a prepared call.
    if (stage && !stage.enteredDispatch && result.isError) stage.denied = true
    if (decision.kind !== 'accept' || !result.isError || !exec.agent ||
        exec.parent || exec.signal.aborted || !isMcpName(exec.name)) {
      return decision
    }
    const { advice, outcome, code } = diagnose(result, stage?.enteredDispatch ?? false, stage?.denied ?? false, stage?.validation)
    if (outcome === 'not_dispatched') return decision
    const now = performance.now()
    const recent = (feedback.get(exec.agent) ?? []).filter(time => now - time < 10_000)
    if (recent.length >= 3) return decision
    feedback.set(exec.agent, [...recent, now])
    let recommendation = ''
    try {
      const source = ctx.tools.get(exec.name, exec.agent, exec.toolSet)
      if (source && stage?.version && identity(source).definitionEpoch === stage.version.definitionEpoch) {
        const candidate = outcome === 'error' && code === 'UNCLASSIFIED_ERROR' &&
          stage.validation?.validation === 'valid' ? candidateFor(exec.name, exec.arguments, exec) : null
        const evidence = evidenceFor(exec.name, exec.arguments, exec)
        const repeated = evidence?.failureGroups.get(code)
        if (evidence && repeated && repeated.count >= 3) {
          recommendation = ` 相同条件已观察到多次同类失败（成功 ${evidence.success}，失败 ${evidence.error}，证据 ${repeated.latest}）。`
        }
        if (candidate) {
          recommendation += ` 可尝试同条件下已有成功记录的 ${candidate.tool}（成功 ${candidate.success}，失败 ${candidate.error}，证据 ${candidate.evidenceId}）。`
        } else if (code === 'UNCLASSIFIED_ERROR' && alternative.has(exec.name)) {
          recommendation += ' 暂无经过观测验证的替代工具。'
        }
      }
    } catch {
      // Keep the current-call diagnosis if historical evidence cannot be read.
    }
    const diagnostic = createUserMessage({
      source: { kind: 'tooldna' },
      content: [{ type: 'text', text: `[ToolDNA] MCP 调用失败。${advice}${recommendation}`.slice(0, 512) }],
    })
    return {
      ...decision,
      additionalContexts: [...decision.additionalContexts ?? [], diagnostic],
    }
  })
}
