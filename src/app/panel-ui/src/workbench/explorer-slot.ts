import { createContext } from "react";

/** The page owns its directory; the shell owns its stable placement beside both content surfaces. */
export const WorkbenchExplorerSlot = createContext<HTMLElement | null>(null);
