import { autoGeneratePolitical, type AutoPoliticalOptions, type AutoPoliticalResult, type TerrainHints } from '../core/autogen';
import { analyzeTerrain, generateTerrain, regeneratePartial, type PartialJob, type TerrainAnalysis, type TerrainJob } from '../core/generate';
import { encodeWorld } from '../core/serialize';
import type { GenParams, TerrainLayers, WorldState } from '../core/world';

/** ワーカーで実行する重い処理の一覧（ワーカーが使えない環境ではメインスレッドで直接呼ぶ） */
export interface TaskMap {
  generate: { input: TerrainJob; output: TerrainLayers };
  partial: { input: PartialJob; output: TerrainLayers };
  analyze: { input: { terrain: TerrainLayers; w: number; h: number; params: GenParams }; output: TerrainAnalysis };
  autoPolitical: {
    input: { land: Uint8Array; w: number; h: number; hints: TerrainHints; opts: AutoPoliticalOptions; startId: number };
    output: AutoPoliticalResult;
  };
  encode: { input: WorldState; output: Uint8Array };
}

export type TaskName = keyof TaskMap;

export const TASKS: { [K in TaskName]: (input: TaskMap[K]['input']) => TaskMap[K]['output'] } = {
  generate: (job) => generateTerrain(job),
  partial: (job) => regeneratePartial(job),
  analyze: ({ terrain, w, h, params }) => analyzeTerrain(terrain, w, h, params),
  autoPolitical: ({ land, w, h, hints, opts, startId }) => autoGeneratePolitical(land, w, h, hints, opts, startId),
  encode: (world) => encodeWorld(world),
};
