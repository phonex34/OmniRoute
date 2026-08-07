import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { CompressionResult } from "./types.ts";
import type { StackedCompressionStep } from "./strategySelector.ts";
import type {
  CompressionWorkerJob,
  CompressionWorkerMessage,
  CompressionWorkerOptions,
} from "./compressionWorkerProtocol.ts";

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
/**
 * Resolve the worker entry across dev/prod WITHOUT `new URL(x, import.meta.url)`: webpack
 * treats that form as a static build-time dependency and fails the build outright
 * ("Can't resolve 'compressionWorker.js'") because only the .ts source exists at build
 * time — the .js is esbuild'd later (colocate-standalone.mjs / prepublish.ts). Same
 * constraint as engines/llmlingua/worker.ts: import.meta.url is frozen to the build
 * machine in the standalone bundle, so probe plain-string paths from runtime anchors.
 * Exported for tests.
 */
export function resolveCompressionWorkerFile(): {
  workerFile: string;
  execArgv: string[];
} {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const argvDir =
    typeof process.argv[1] === "string" && process.argv[1] ? dirname(process.argv[1]) : null;
  const workerRel = join("open-sse", "services", "compression", "compressionWorker.js");

  // Prod (.js runs natively): esbuild'd worker colocated at <installRoot>/open-sse/
  // services/compression/compressionWorker.js — adjacent to the bundled module (npm dist),
  // or under the install root reached from cwd / the entry-script dir (Next standalone,
  // Electron standalone).
  const jsCandidates = [
    join(moduleDir, "compressionWorker.js"),
    join(process.cwd(), workerRel),
    ...(argvDir ? [join(argvDir, workerRel)] : []),
  ];
  for (const candidate of jsCandidates) {
    if (existsSync(candidate)) return { workerFile: candidate, execArgv: [] };
  }

  // Dev (tsx): the .ts source beside this module, then under cwd; needs the tsx loader.
  for (const candidate of [
    join(moduleDir, "compressionWorker.ts"),
    join(process.cwd(), "open-sse", "services", "compression", "compressionWorker.ts"),
  ]) {
    if (existsSync(candidate)) return { workerFile: candidate, execArgv: ["--import", "tsx/esm"] };
  }

  // Nothing found — return the adjacent .js path; the spawn fails open (pool resolves
  // the job with the unchanged body).
  return { workerFile: jsCandidates[0], execArgv: [] };
}
function unchanged(body: Record<string, unknown>): CompressionResult {
  return { body, compressed: false, stats: null };
}
interface PendingJob extends CompressionWorkerJob {
  originalBody: Record<string, unknown>;
  resolve: (result: CompressionResult) => void;
  onEngineStep?: (step: StackedCompressionStep) => void;
}
interface PoolWorker {
  worker: Worker;
  job: PendingJob | null;
  timeout: NodeJS.Timeout | null;
  idle: NodeJS.Timeout | null;
}

export class CompressionWorkerPool {
  private readonly queue: PendingJob[] = [];
  private readonly workers = new Set<PoolWorker>();
  private nextId = 1;
  private readonly size: number;
  private readonly timeoutMs: number;
  private readonly idleMs: number;

  constructor({
    size = positiveInteger(process.env.OMNI_COMPRESSION_WORKERS, 2),
    timeoutMs = positiveInteger(process.env.OMNI_COMPRESSION_WORKER_TIMEOUT_MS, 120_000),
    idleMs = positiveInteger(process.env.OMNI_COMPRESSION_WORKER_IDLE_MS, 60_000),
  }: { size?: number; timeoutMs?: number; idleMs?: number } = {}) {
    this.size = Math.max(1, Math.floor(size));
    this.timeoutMs = Math.max(1, Math.floor(timeoutMs));
    this.idleMs = Math.max(1, Math.floor(idleMs));
  }

  run(
    body: Record<string, unknown>,
    mode: CompressionWorkerJob["mode"],
    options?: CompressionWorkerOptions,
    onEngineStep?: (step: StackedCompressionStep) => void
  ): Promise<CompressionResult> {
    return new Promise((resolve) => {
      this.queue.push({
        id: this.nextId++,
        body,
        mode,
        options,
        originalBody: body,
        resolve,
        onEngineStep,
      });
      this.dispatch();
    });
  }
  async close(): Promise<void> {
    for (const job of this.queue.splice(0)) job.resolve(unchanged(job.originalBody));
    await Promise.all([...this.workers].map((slot) => this.remove(slot, true)));
  }
  private spawn(): PoolWorker {
    const { workerFile, execArgv } = resolveCompressionWorkerFile();
    const slot: PoolWorker = {
      worker: new Worker(pathToFileURL(workerFile), { execArgv }),
      job: null,
      timeout: null,
      idle: null,
    };
    this.workers.add(slot);
    slot.worker.on("message", (message: CompressionWorkerMessage) =>
      this.handleMessage(slot, message)
    );
    slot.worker.on("error", () => this.fail(slot));
    slot.worker.on("exit", () => {
      if (this.workers.has(slot)) this.fail(slot);
    });
    return slot;
  }
  private dispatch(): void {
    while (this.queue.length) {
      let slot = [...this.workers].find((candidate) => !candidate.job);
      if (!slot && this.workers.size < this.size) slot = this.spawn();
      if (!slot) return;
      if (slot.idle) clearTimeout(slot.idle);
      const job = this.queue.shift();
      if (!job) return;
      slot.job = job;
      slot.timeout = setTimeout(() => this.fail(slot!), this.timeoutMs);
      slot.timeout.unref();
      const { originalBody: _body, resolve: _resolve, onEngineStep: _step, ...wireJob } = job;
      slot.worker.postMessage(wireJob);
    }
  }
  private handleMessage(slot: PoolWorker, message: CompressionWorkerMessage): void {
    const job = slot.job;
    if (!job || job.id !== message.id) return;
    if (message.type === "step") {
      try {
        job.onEngineStep?.(message.step);
      } catch {
        // Telemetry is best-effort.
      }
      return;
    }
    this.finish(slot, message.type === "result" ? message.result : unchanged(job.originalBody));
  }
  private finish(slot: PoolWorker, result: CompressionResult): void {
    const job = slot.job;
    if (!job) return;
    if (slot.timeout) clearTimeout(slot.timeout);
    slot.timeout = null;
    slot.job = null;
    job.resolve(result);
    slot.idle = setTimeout(() => void this.remove(slot, false), this.idleMs);
    slot.idle.unref();
    this.dispatch();
  }
  private fail(slot: PoolWorker): void {
    const job = slot.job;
    if (job) job.resolve(unchanged(job.originalBody));
    slot.job = null;
    void this.remove(slot, true).finally(() => this.dispatch());
  }
  private async remove(slot: PoolWorker, terminate: boolean): Promise<void> {
    if (!this.workers.delete(slot)) return;
    if (slot.timeout) clearTimeout(slot.timeout);
    if (slot.idle) clearTimeout(slot.idle);
    if (terminate) await slot.worker.terminate().catch(() => undefined);
  }
}

let pool: CompressionWorkerPool | null = null;
export function runCompressionInWorker(
  body: Record<string, unknown>,
  mode: CompressionWorkerJob["mode"],
  options?: CompressionWorkerOptions,
  onEngineStep?: (step: StackedCompressionStep) => void
): Promise<CompressionResult> {
  pool ??= new CompressionWorkerPool();
  return pool.run(body, mode, options, onEngineStep);
}
export async function closeCompressionWorkerPoolForTests(): Promise<void> {
  const active = pool;
  pool = null;
  await active?.close();
}
