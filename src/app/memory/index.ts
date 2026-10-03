/** Stable product-facing Memory contracts. Infrastructure is assembled via composition.ts. */
export { MEMORY_ERROR_CODES, MemoryError } from "./contracts.js";
export type * from "./contracts.js";
export type * from "./entry-contracts.js";
export type { MemoryFeature, MemoryFeatureCommands, MemoryFeatureQueries } from "./memory-feature.js";
export type { MemoryRuntime } from "./memory-runtime.js";
export { MEMORY_BACKGROUND_HEADER, renderMemoryBackgroundBlock } from "./context/render-background.js";
