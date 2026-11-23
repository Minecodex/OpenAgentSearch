import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider } from "./state";
import { Workspace } from "./workspace";
import "./styles/entry.css";
const queries = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error: any) => error?.status !== 401 && count < 1,
      staleTime: 0,
      refetchOnWindowFocus: true,
    },
    mutations: { retry: false },
  },
});
createRoot(document.getElementById("app")!).render(
  <QueryClientProvider client={queries}>
    <BrowserRouter>
      <Provider>
        <Workspace />
      </Provider>
    </BrowserRouter>
  </QueryClientProvider>,
);
