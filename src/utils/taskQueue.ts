/**
 * In-memory async task queue for long-running endpoint executions.
 *
 * Allows callers to submit a task, poll for status, and optionally receive
 * results via webhook POST when the task completes.
 */

export interface TaskStatus {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  endpoint: string;
  createdAt: number;
  completedAt?: number;
  result?: unknown;
  error?: string;
  webhookUrl?: string;
}

type TaskExecutor = (
  endpoint: string,
  params: Record<string, unknown>
) => Promise<unknown>;

export class TaskQueue {
  private tasks = new Map<string, TaskStatus>();
  private executor: TaskExecutor | null = null;

  /** Maximum number of tasks to retain in memory. Oldest completed tasks are pruned first. */
  private maxTasks = 10_000;

  /**
   * Register the function that actually executes tasks.
   * Called by the route layer so the queue itself stays transport-agnostic.
   */
  setExecutor(fn: TaskExecutor): void {
    this.executor = fn;
  }

  /**
   * Submit a task for async execution.
   * Returns the generated task ID immediately.
   */
  submit(
    endpoint: string,
    params: Record<string, unknown>,
    webhookUrl?: string
  ): string {
    const id = crypto.randomUUID();
    const task: TaskStatus = {
      id,
      status: "pending",
      endpoint,
      createdAt: Date.now(),
      webhookUrl,
    };
    this.tasks.set(id, task);
    this.prune();

    // Fire-and-forget execution
    this.execute(id, endpoint, params);

    return id;
  }

  /**
   * Get the current status of a task (or null if not found).
   */
  getStatus(taskId: string): TaskStatus | null {
    return this.tasks.get(taskId) ?? null;
  }

  /**
   * Mark a task as completed with the given result.
   * If the task has a webhookUrl, POST the result there.
   */
  onComplete(taskId: string, result: unknown): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = "completed";
    task.completedAt = Date.now();
    task.result = result;
    this.deliverWebhook(task);
  }

  /**
   * Mark a task as failed with the given error message.
   * If the task has a webhookUrl, POST the error there.
   */
  onError(taskId: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = "failed";
    task.completedAt = Date.now();
    task.error = error;
    this.deliverWebhook(task);
  }

  // ── Internal helpers ──────────────────────────────────────────────

  private async execute(
    taskId: string,
    endpoint: string,
    params: Record<string, unknown>
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = "running";

    try {
      if (!this.executor) {
        throw new Error("No task executor registered");
      }
      const result = await this.executor(endpoint, params);
      this.onComplete(taskId, result);
    } catch (err) {
      this.onError(
        taskId,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private async deliverWebhook(task: TaskStatus): Promise<void> {
    if (!task.webhookUrl) return;

    try {
      await fetch(task.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: task.id,
          status: task.status,
          endpoint: task.endpoint,
          completedAt: task.completedAt,
          result: task.result,
          error: task.error,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Webhook delivery is best-effort — never block or throw
    }
  }

  private prune(): void {
    if (this.tasks.size <= this.maxTasks) return;

    // Remove oldest completed/failed tasks first
    const sorted = [...this.tasks.values()]
      .filter((t) => t.status === "completed" || t.status === "failed")
      .sort((a, b) => (a.completedAt ?? a.createdAt) - (b.completedAt ?? b.createdAt));

    const toRemove = this.tasks.size - this.maxTasks;
    for (let i = 0; i < toRemove && i < sorted.length; i++) {
      this.tasks.delete(sorted[i].id);
    }
  }
}

/** Singleton task queue instance. */
export const taskQueue = new TaskQueue();
