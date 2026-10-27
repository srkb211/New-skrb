/// <reference lib="webworker" />
import { TASKS, type TaskName } from './tasks';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (ev: MessageEvent<{ id: number; task: TaskName; input: unknown }>) => {
  const { id, task, input } = ev.data;
  try {
    const run = TASKS[task] as (i: unknown) => unknown;
    const output = run(input);
    self.postMessage({ id, output });
  } catch (e) {
    self.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
};
