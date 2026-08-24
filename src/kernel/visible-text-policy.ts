// The default Agent is a developer agent: model output,
// tool results, errors, files, stdout/stderr, and development context must
// remain model-visible and user-visible unless a caller is only doing explicit
// structural truncation. Do not reintroduce token/key masking here; command
// confirmation is the default runtime boundary.
export function preserveVisibleText(value: string): string {
  return value;
}
