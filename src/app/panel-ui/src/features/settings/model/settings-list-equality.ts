export function sameStringList(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
