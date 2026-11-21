import { createHmac } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import type { Outcome } from './diagnosis.js'

export interface Evidence {
  id: string
  sessionKey: string
  tool: string
  schemaHash: string | null
  definitionEpoch: string | null
  observedAtMs: number
  dispatchMs: number | null
  dispatchSeen: boolean
  status: Outcome
  diagnosisCode: string
  errorCode: string | null
  featureKey: string | null
  featureBucket: number | null
}

export interface HistoryQuery {
  sessionKey: string
  tool: string
  schemaHash: string | null
  definitionEpoch: string | null
  featureKey: string | null
  archived: boolean
  limit: number
}

export type StoreRequest =
  | { kind: 'write'; id: number; rows: Evidence[] }
  | ({ kind: 'history'; id: number } & HistoryQuery)
  | { kind: 'close' }

interface HistoryResult {
  rows: {
    id: string; schema_hash: string | null; definition_epoch: string | null; observed_at_ms: number
    dispatch_ms: number | null; dispatch_seen: number; host_status: Outcome; diagnosis_code: string
    error_code: string | null; feature_key: string | null; feature_bucket: number | null
  }[]
  counts: Partial<Record<Outcome, number>>
}

export class EvidenceStore {
  private readonly worker: Worker
  private readonly timer: ReturnType<typeof setInterval>
  private readonly queue: Evidence[] = []
  private readonly pending = new Map<number, (value: HistoryResult | undefined) => void>()
  private batch?: { id: number; rows: Evidence[] }
  private nextId = 0
  private failed = false
  private closing = false
  private salt?: string
  readonly recent = new Map<string, Evidence>()
  readonly ready: Promise<boolean>

  constructor(filename: string, private readonly retentionDays: number, maxEvents: number, onFailure: () => void) {
    this.worker = new Worker(new URL('./sqlite-worker.js', import.meta.url), {
      workerData: { filename, retentionDays, maxEvents },
    })
    this.ready = new Promise(resolve => {
      const fail = () => {
        if (this.failed || this.closing) return
        this.failed = true
        this.queue.length = 0
        this.batch = undefined
        this.recent.clear()
        for (const done of this.pending.values()) done(undefined)
        this.pending.clear()
        clearInterval(this.timer)
        onFailure()
        resolve(false)
      }
      this.worker.on('error', fail)
      this.worker.on('exit', fail)
      this.worker.on('message', message => {
        if (message.kind === 'ready') {
          this.salt = message.salt
          this.flush()
          resolve(true)
        } else if (message.kind === 'written' && this.batch?.id === message.id) {
          for (const row of this.batch!.rows) this.recent.set(row.id, row)
          for (const id of message.removed) this.recent.delete(id)
          const cutoff = Date.now() - this.retentionDays * 86_400_000
          for (const [id, row] of this.recent) {
            if (row.observedAtMs < cutoff) this.recent.delete(id)
          }
          this.batch = undefined
          this.flush()
        } else if (message.kind === 'history') {
          for (const id of message.removed) this.recent.delete(id)
          this.pending.get(message.id)?.(message)
          this.pending.delete(message.id)
        } else if (message.kind === 'error') fail()
      })
    })
    this.timer = setInterval(() => this.flush(), 50)
    this.timer.unref()
  }

  sessionKey(agentId: string): string | undefined {
    return this.salt && !this.failed ? createHmac('sha256', this.salt).update(agentId).digest('hex') : undefined
  }

  enqueue(evidence: Evidence): boolean {
    if (this.failed || this.closing || this.queue.length + (this.batch?.rows.length ?? 0) >= 1024) return false
    this.queue.push(evidence)
    if (this.queue.length >= 64) this.flush()
    return true
  }

  private flush(): void {
    if (this.failed || !this.salt || this.batch || !this.queue.length) return
    this.batch = { id: ++this.nextId, rows: this.queue.splice(0, 64) }
    this.worker.postMessage({ kind: 'write', ...this.batch } satisfies StoreRequest)
  }

  async history(query: HistoryQuery): Promise<HistoryResult | undefined> {
    const deadline = performance.now() + 250
    this.flush()
    while ((this.batch || this.queue.length) && !this.failed && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    if (this.failed || !this.salt || this.closing || performance.now() >= deadline) return undefined
    return new Promise(resolve => {
      const id = ++this.nextId
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(undefined)
      }, deadline - performance.now())
      this.pending.set(id, result => { clearTimeout(timer); resolve(result) })
      this.worker.postMessage({ kind: 'history', id, ...query } satisfies StoreRequest)
    })
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    clearInterval(this.timer)
    const deadline = performance.now() + 1000
    this.flush()
    while ((this.batch || this.queue.length) && !this.failed && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    for (const done of this.pending.values()) done(undefined)
    this.pending.clear()
    if (!this.failed && !this.batch && !this.queue.length) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, Math.max(0, deadline - performance.now()))
        this.worker.once('exit', () => { clearTimeout(timer); resolve() })
        this.worker.postMessage({ kind: 'close' } satisfies StoreRequest)
      })
    }
    await this.worker.terminate()
  }
}
