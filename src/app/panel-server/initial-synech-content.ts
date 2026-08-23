export const DEFAULT_SPACE_ID = "space-default" as const;

/** The clean Synech baseline starts with one empty user-owned Space. */
export const INITIAL_SYNECH_SPACES = [
  { id: DEFAULT_SPACE_ID, title: "我的空间" },
] as const;
