export function isUtf16CodeUnitBoundary(value: string, offset: number): boolean {
  return offset <= 0 ||
    offset >= value.length ||
    !isHighSurrogate(value.charCodeAt(offset - 1)) ||
    !isLowSurrogate(value.charCodeAt(offset));
}

export function utf16SafeWindowEnd(value: string, start: number, maxCodeUnits: number): number {
  let end = Math.min(value.length, start + maxCodeUnits);
  if (!isUtf16CodeUnitBoundary(value, end)) {
    end -= 1;
  }
  return Math.max(start, end);
}

export function utf16SafePrefixLength(value: string, maxCodeUnits: number): number {
  return utf16SafeWindowEnd(value, 0, Math.max(0, maxCodeUnits));
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
