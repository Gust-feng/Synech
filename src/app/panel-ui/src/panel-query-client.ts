import { QueryClient } from "@tanstack/react-query";

export const panelQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
    },
  },
});