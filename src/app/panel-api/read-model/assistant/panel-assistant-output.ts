export function firstNonEmptyText(values: readonly (string | undefined)[]): string | undefined {
  return values.find(hasNonEmptyText);
}

export function hasNonEmptyText(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}
