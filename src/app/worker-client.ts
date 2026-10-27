import { TASKS, type TaskMap, type TaskName } from '../worker/tasks';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** 生成処理をワーカーで実行する。ワーカーを作れない場合は同期実行にフォールバック。 */
export class WorkerClient {
  private worker: Worker | null = null;
  private seq = 1;
  private pending = new Map<number, Pending>();

  constructor() {
    try {
      this.worker = new Worker(new URL('../worker/gen.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (ev: MessageEvent<{ id: number; output?: unknown; error?: string }>) => {
        const p = this.pending.get(ev.data.id);
        if (!p) return;
        this.pending.delete(ev.data.id);
        if (ev.data.error) p.reject(new Error(ev.data.error));
        else p.resolve(ev.data.output);
      };
      this.worker.onerror = (ev) => {
        console.warn('worker error, falling back to main thread', ev.message);
        this.worker = null;
        for (const [, p] of this.pending) p.reject(new Error('ワーカーでエラーが発生しました'));
        this.pending.clear();
      };
    } catch {
      this.worker = null;
    }
  }

  run<K extends TaskName>(task: K, input: TaskMap[K]['input']): Promise<TaskMap[K]['output']> {
    if (!this.worker) {
      return new Promise((resolve, reject) => {
        // 描画を一度挟んでから重い処理に入る
        setTimeout(() => {
          try {
            resolve(TASKS[task](input));
          } catch (e) {
            reject(e);
          }
        }, 30);
      });
    }
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker!.postMessage({ id, task, input });
    });
  }
}
