import {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  useMemo,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import {
  api,
  collect,
  configure,
  ApiError,
  type Entity,
  type Session,
} from "./api";
i18next.use(initReactI18next).init({
  lng: localStorage.getItem("oas-language") || "zh",
  fallbackLng: "zh",
  resources: { zh: { translation: {} }, en: { translation: {} } },
  interpolation: { escapeValue: false },
});
function useApplication() {
  const [language, setLanguage] = useState(i18next.language);
  const [theme, setTheme] = useState(
    localStorage.getItem("oas-theme") ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  );
  const [project, setProject] = useState("");
  const queryClient = useQueryClient();
  const lastDebug = useRef<{
    entry: string;
    project: string;
    op: string;
    input: Entity;
    defaults: Entity;
    result: import("./api").Envelope | null;
    error?: unknown;
    id: string;
    elapsed: number;
    http?: number;
    cancelled: boolean;
  } | null>(null);
  const pageHistory = useRef<Record<string, string[]>>({});
  const routeDraft = useRef<{ entries: Entity[]; version: number } | null>(
    null,
  );
  useEffect(() => {
    const expired = () => {
      lastDebug.current = null;
      queryClient.setQueryData(["session"], null);
    };
    window.addEventListener("oas-session-expired", expired);
    return () => window.removeEventListener("oas-session-expired", expired);
  }, [queryClient]);
  const session = useQuery<Session>({
    queryKey: ["session"],
    queryFn: () => api("/admin/v1/session"),
    retry: false,
  });
  configure(session.data, language);
  const resourceQuery = useQuery({
    queryKey: ["resources"],
    queryFn: async () =>
      Object.fromEntries(
        await Promise.all(
          ["projects", "endpoints", "proxies", "proxy-pools"].map(async (k) => [
            k,
            await collect(k),
          ]),
        ),
      ) as Record<string, Entity[]>,
    enabled: !!session.data,
  });
  const localized = useMemo<Record<string, Entity[]> | undefined>(
    () =>
      resourceQuery.data
        ? Object.fromEntries(
            Object.entries(resourceQuery.data).map(([kind, rows]) => [
              kind,
              rows.map(
                (e): Entity => ({ ...e, name: resourceLabel(e, language) }),
              ),
            ]),
          )
        : undefined,
    [resourceQuery.data, language],
  );
  const resources = { ...resourceQuery, data: localized };
  const projects = resources.data?.projects || [];
  useEffect(() => {
    if (!projects.some((p) => p.id === project))
      setProject(projects[0]?.id || "");
  }, [resources.data, project]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.skin = "atlas";
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.classList.toggle("light", theme === "light");
    localStorage.setItem("oas-theme", theme);
  }, [theme]);
  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    localStorage.setItem("oas-language", language);
    void i18next.changeLanguage(language);
  }, [language]);
  const t = (zh: string, en: string) => (language === "en" ? en : zh);
  return {
    pageHistory,
    routeDraft,
    lastDebug,
    t,
    language,
    setLanguage,
    theme,
    setTheme,
    session,
    resources,
    projects,
    project,
    setProject,
    queryClient,
    refresh: () => queryClient.invalidateQueries(),
    resourceName: (entity: Entity) => resourceLabel(entity, language),
    name: (id: string) =>
      Object.values(resources.data || {})
        .flat()
        .find((e) => e.id === id)?.name ||
      t("已移除的资源", "Removed resource"),
  };
}
type Store = ReturnType<typeof useApplication>;
const Context = createContext<Store | null>(null);
export const useApp = () => useContext(Context)!;
export function Provider({ children }: { children: ReactNode }) {
  const store = useApplication();
  return <Context.Provider value={store}>{children}</Context.Provider>;
}

function resourceLabel(entity: Entity, language: string): string {
  const id = entity.id || entity.endpoint_id;
  if (id === "00000000-0000-4000-8000-000000000001")
    return language === "en" ? "Built-in browser search" : "内置浏览器搜索";
  if (id === "00000000-0000-4000-8000-000000000002")
    return language === "en" ? "Built-in browser content" : "内置浏览器正文";
  return entity.name || entity.endpoint_name || entity.kind || "";
}
