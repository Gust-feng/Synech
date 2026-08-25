export type PersonalNoteSaveState =
  | { readonly status: "saved" }
  | { readonly status: "saving" }
  | { readonly status: "error"; readonly message: string }

export const SAVED_NOTE_SAVE_STATE: PersonalNoteSaveState = Object.freeze({ status: "saved" })
export const SAVING_NOTE_SAVE_STATE: PersonalNoteSaveState = Object.freeze({ status: "saving" })

export function createPersonalNoteSaveState(
  pendingCount: number,
  error: string | undefined,
): PersonalNoteSaveState {
  if (error !== undefined) return { status: "error", message: error }
  return pendingCount > 0 ? SAVING_NOTE_SAVE_STATE : SAVED_NOTE_SAVE_STATE
}
