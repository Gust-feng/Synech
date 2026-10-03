import type { SanitizedModelProviderConfig } from "../../domain/config/index.js";

/** A run freezes executable model settings; presentation assets belong to the UI. */
export function runModelConfiguration(config: SanitizedModelProviderConfig): SanitizedModelProviderConfig {
  const { logoDataUrl: _logo, modelSettings, ...runtime } = config;
  const selected = config.model === undefined || modelSettings === undefined || !Object.hasOwn(modelSettings, config.model)
    ? undefined : modelSettings[config.model];
  return {
    ...runtime,
    ...(selected === undefined ? {} : { modelSettings: { [config.model!]: structuredClone(selected) } }),
  };
}
