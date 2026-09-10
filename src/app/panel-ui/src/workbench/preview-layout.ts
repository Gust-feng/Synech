import { createContext } from "react";

/** Preview surfaces own availability; the workbench owns the one explicit layout command. */
export const PreviewLayoutContext = createContext<{
  readonly splitEnabled: boolean;
  readonly canSplit: boolean;
  readonly onToggleSplit: () => void;
} | null>(null);
