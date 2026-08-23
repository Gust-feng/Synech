export type TextFragmentBoundaryMode = "exact" | "readable";
export type TextStreamFragmentSource = "live" | "replay" | "ordinary";

export type TextStreamAssembly = {
  readonly text: string;
  readonly replayCatchupText: string;
  readonly liveSourceObserved: boolean;
};

export function appendStreamTextFragment(
  current: string,
  next: string,
  options?: { readonly boundary?: TextFragmentBoundaryMode }
): string {
  if (next.length === 0) return current;
  if (current.length === 0) return next;
  if (next.length > current.length && next.startsWith(current)) return next;
  if (options?.boundary === "readable" && sameTextIgnoringInsertedBoundaries(current, next)) {
    return current;
  }
  return options?.boundary === "readable"
    ? appendWithReadableBoundary(current, next)
    : `${current}${next}`;
}

export function appendStreamTextEventFragment(
  current: string,
  next: string,
  eventId: string | undefined
): string {
  void eventId;
  return appendStreamTextFragment(current, next);
}

export function appendSnapshotTextFragment(current: string, next: string): string {
  if (next.length === 0) return current;
  if (current.length === 0) return next;
  if (next.length > current.length && next.startsWith(current)) return next;
  if (next.length >= 8 && current.startsWith(next)) return current;
  if (next.length < current.length && current.endsWith(next)) return current;
  const overlap = suffixPrefixOverlapLength(current, next);
  return `${current}${next.slice(overlap >= 8 ? overlap : 0)}`;
}

export function appendCatchupTextFragment(
  current: string,
  catchup: string,
  next: string,
  options?: { readonly boundary?: TextFragmentBoundaryMode }
): { readonly text: string; readonly catchup: string } {
  if (next.length === 0) return { text: current, catchup };
  const exactCatchup = appendStreamTextFragment(catchup, next, options);
  if (current.length === 0) return { text: exactCatchup, catchup: exactCatchup };
  if (current.startsWith(exactCatchup)) return { text: current, catchup: exactCatchup };
  if (exactCatchup.startsWith(current)) return { text: exactCatchup, catchup: exactCatchup };
  const compactCurrent = compactBoundaryText(current);
  const compactCatchup = compactBoundaryText(exactCatchup);
  if (
    compactCurrent.length > 0 &&
    compactCatchup.length > 0 &&
    (compactCurrent === compactCatchup || compactCurrent.startsWith(compactCatchup))
  ) {
    return { text: current, catchup: exactCatchup };
  }
  if (compactCurrent.length > 0 && compactCatchup.startsWith(compactCurrent)) {
    if (options?.boundary === "readable") {
      const remainder = compactCatchup.slice(compactCurrent.length);
      return {
        text: appendReadableTextFragment(current, remainder),
        catchup: exactCatchup,
      };
    }
    return { text: current, catchup: exactCatchup };
  }
  const merged = appendSnapshotTextFragment(current, next);
  return { text: merged, catchup: merged === current ? exactCatchup : merged };
}

export function emptyTextStreamAssembly(): TextStreamAssembly {
  return {
    text: "",
    replayCatchupText: "",
    liveSourceObserved: false,
  };
}

export function textStreamAssemblyFromText(
  text: string,
  source: TextStreamFragmentSource = "ordinary",
  options?: { readonly boundary?: TextFragmentBoundaryMode }
): TextStreamAssembly {
  return appendTextStreamAssembly(emptyTextStreamAssembly(), text, source, options);
}

export function appendTextStreamAssembly(
  current: TextStreamAssembly,
  next: string,
  source: TextStreamFragmentSource,
  options?: { readonly boundary?: TextFragmentBoundaryMode }
): TextStreamAssembly {
  if (source === "live") {
    return {
      text: appendStreamTextFragment(current.text, next, options),
      replayCatchupText: "",
      liveSourceObserved: true,
    };
  }
  if (source === "replay" && current.liveSourceObserved) {
    const merged = appendCatchupTextFragment(current.text, current.replayCatchupText, next, options);
    return {
      text: merged.text,
      replayCatchupText: merged.catchup,
      liveSourceObserved: true,
    };
  }
  return {
    text: appendStreamTextFragment(current.text, next, options),
    replayCatchupText: "",
    liveSourceObserved: current.liveSourceObserved,
  };
}

export function textStreamFragmentSourceFromEventId(eventId: string | undefined): TextStreamFragmentSource {
  if (eventId === undefined || eventId.length === 0) return "ordinary";
  if (eventId.includes(":live:")) return "live";
  if (eventId.includes(":event:") || eventId.includes(":restored:event:")) return "replay";
  return "ordinary";
}

export function accumulateStreamTextFragments(
  fragments: readonly string[],
  options?: { readonly boundary?: TextFragmentBoundaryMode }
): string {
  return fragments.reduce((current, fragment) => appendStreamTextFragment(current, fragment, options), "");
}

export function appendReadableTextFragment(current: string, next: string): string {
  if (current.length === 0) return next;
  if (next.length === 0) return current;
  return appendWithReadableBoundary(current, next);
}

function appendWithReadableBoundary(current: string, next: string): string {
  if (canAppendWithoutBoundary(current, next)) return `${current}${next}`;
  return `${current} ${next}`;
}

function sameTextIgnoringInsertedBoundaries(current: string, next: string): boolean {
  if (!/\s/u.test(current) && !/\s/u.test(next)) return false;
  const compactCurrent = compactBoundaryText(current);
  const compactNext = compactBoundaryText(next);
  return compactCurrent.length > 0 && compactCurrent === compactNext;
}

function compactBoundaryText(value: string): string {
  return value.replace(/\s+/g, "");
}

function suffixPrefixOverlapLength(current: string, next: string): number {
  const maxLength = Math.min(current.length, next.length);
  for (let length = maxLength; length > 0; length -= 1) {
    if (current.slice(-length) === next.slice(0, length)) {
      return length;
    }
  }
  return 0;
}

function canAppendWithoutBoundary(current: string, next: string): boolean {
  const left = current.at(-1) ?? "";
  const right = next.at(0) ?? "";
  if (/\s/u.test(left) || /\s/u.test(right)) return true;
  if (isCjk(left) || isCjk(right)) return true;
  if (isRightPunctuation(right)) return true;
  if (isLeftPunctuation(left)) return true;
  return !(isAsciiWord(left) && isAsciiWord(right));
}

function isAsciiWord(value: string): boolean {
  return /^[A-Za-z0-9]$/u.test(value);
}

function isCjk(value: string): boolean {
  return /^[\u3400-\u9fff]$/u.test(value);
}

function isRightPunctuation(value: string): boolean {
  return /^[.,!?;:%)\]}>"'”’、。！？；：，）】》]$/u.test(value);
}

function isLeftPunctuation(value: string): boolean {
  return /^[([{<"'“‘#/@\\-]$/u.test(value);
}
