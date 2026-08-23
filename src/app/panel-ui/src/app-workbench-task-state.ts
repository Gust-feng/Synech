import { useState } from "react";
import type { ContextAttachment } from "./contracts/context";

export type AppWorkbenchTaskState = {
  readonly goal: string;
  readonly setGoal: React.Dispatch<React.SetStateAction<string>>;
  readonly attachments: readonly ContextAttachment[];
  readonly setAttachments: React.Dispatch<React.SetStateAction<readonly ContextAttachment[]>>;
};

export function useAppWorkbenchTaskState(): AppWorkbenchTaskState {
  const [goal, setGoal] = useState("");
  const [attachments, setAttachments] = useState<readonly ContextAttachment[]>([]);

  return {
    goal,
    setGoal,
    attachments,
    setAttachments,
  };
}