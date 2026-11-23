import { useState, lazy, Suspense } from "react";
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import {
  BookOpen,
  ChartNoAxesCombined,
  ChevronRight,
  FlaskConical,
  Folder,
  Globe2,
  LayoutDashboard,
  List,
  Menu,
  LogOut,
  Network,
  PanelLeft,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { Dropdown, Label } from "@heroui/react";
import { api } from "./api";
import { useApp } from "./state";
import { Appearance } from "./appearance";
import { Brand, PRODUCT_NAME } from "./brand";
import { SignIn } from "./sign-in";
import { Btn, Dialog, Empty, Notice } from "./ui";

const Resources = lazy(() =>
  import("./resources").then((m) => ({ default: m.Resources })),
);
const LanguageRoutes = lazy(() =>
  import("./resources").then((m) => ({ default: m.LanguageRoutes })),
);
const Playground = lazy(() =>
  import("./search").then((m) => ({ default: m.Playground })),
);
const Records = lazy(() =>
  import("./records").then((m) => ({ default: m.Records })),
);
const Trace = lazy(() =>
  import("./records").then((m) => ({ default: m.Trace })),
);
const Dashboard = lazy(() =>
  import("./dashboard").then((m) => ({ default: m.Dashboard })),
);
const Observability = lazy(() =>
  import("./observability").then((m) => ({ default: m.Observability })),
);
const Reference = lazy(() =>
  import("./reference").then((m) => ({ default: m.Reference })),
);

type Page = readonly [string, LucideIcon, string, string];
const groups: readonly {
  label: readonly [string, string];
  pages: readonly Page[];
}[] = [
  {
    label: ["运行", "Operations"],
    pages: [
      ["/", LayoutDashboard, "运行总览", "Overview"],
      ["/playground", FlaskConical, "检索调试", "Playground"],
      ["/requests", List, "请求记录", "Requests"],
      ["/observability", ChartNoAxesCombined, "运行观测", "Observability"],
    ],
  },
  {
    label: ["资源配置", "Resources"],
    pages: [
      ["/projects", Folder, "项目", "Projects"],
      ["/endpoints", Waypoints, "接入点", "Endpoints"],
      ["/proxies", Network, "VPN 代理", "VPN proxies"],
      ["/language-routes", Globe2, "语言路由", "Language routes"],
    ],
  },
  {
    label: ["参考", "Reference"],
    pages: [["/api", BookOpen, "API 文档", "API reference"]],
  },
];
const pages = groups.flatMap((g) => g.pages);

export function Workspace() {
  const { t, session } = useApp();
  const location = useLocation();
  const [mobile, setMobile] = useState(false);
  const [logoutError, setLogoutError] = useState<unknown>();
  async function logout() {
    try {
      await api("/admin/v1/session", { method: "DELETE" });
      window.location.assign("/login");
    } catch (error) {
      setLogoutError(error);
    }
  }
  if (session.isPending)
    return (
      <div className="session-loading">
        <Brand />
        <Empty>{t("正在恢复会话…", "Restoring session…")}</Empty>
      </div>
    );
  if (!session.data) return <SignIn />;
  const matched = pages.find((p) => p[0] === location.pathname);
  const pageName =
    location.pathname === "/proxy-pools"
      ? t("代理池", "Proxy pools")
      : location.pathname.startsWith("/requests/")
        ? t("请求详情", "Request detail")
        : matched
          ? t(matched[2], matched[3])
          : t("工作空间", "Workspace");
  const navigation = (
    <nav className="nav" aria-label={t("主导航", "Main navigation")}>
      {groups.map((group) => (
        <div className="nav-group" key={group.label[1]}>
          <div className="nav-group-name">{t(...group.label)}</div>
          {group.pages.map(([url, Icon, zh, en]) => (
            <NavLink
              key={url}
              to={url}
              end={url === "/"}
              onClick={() => setMobile(false)}
              className={({ isActive }) =>
                "nav-item " +
                (isActive ||
                (url === "/proxies" && location.pathname === "/proxy-pools")
                  ? "active"
                  : "")
              }
              data-testid={"nav-" + (url === "/" ? "overview" : url.slice(1))}
            >
              <Icon size={18} />
              <span>{t(zh, en)}</span>
              <i className="nav-current" />
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
  return (
    <div className="app-shell skin-atlas">
      <aside className="side">
        <Link to="/" className="brand-home" aria-label={PRODUCT_NAME}>
          <Brand />
        </Link>
        {navigation}
      </aside>
      <section className="app-body">
        <header className="topbar">
          <Btn
            iconOnly
            className="mobile-menu quiet"
            aria-label={t("打开导航", "Open navigation")}
            onPress={() => setMobile(true)}
          >
            <Menu size={20} />
          </Btn>
          <div className="breadcrumbs">
            <PanelLeft size={17} />
            <span>Atlas</span>
            <ChevronRight size={13} />
            <strong>{pageName}</strong>
          </div>
          <div className="top-tools">
            <Appearance />
            <Dropdown>
              <Btn
                iconOnly
                className="avatar"
                aria-label={t("账户", "Account")}
              >
                {session.data.username.slice(0, 2).toUpperCase()}
              </Btn>
              <Dropdown.Popover
                placement="bottom end"
                offset={6}
                className="account-menu"
              >
                <Dropdown.Menu
                  aria-label={t("账户操作", "Account actions")}
                  onAction={() => void logout()}
                >
                  <Dropdown.Item
                    id="logout"
                    textValue={t("退出登录", "Sign out")}
                  >
                    <LogOut size={15} />
                    <Label>{t("退出登录", "Sign out")}</Label>
                  </Dropdown.Item>
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
          </div>
        </header>
        <main
          className="main"
          data-page={
            location.pathname === "/"
              ? "overview"
              : location.pathname.split("/")[1]
          }
        >
          <Notice error={logoutError} />
          <Suspense fallback={<Empty>{t("正在载入…", "Loading…")}</Empty>}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/login" element={<Navigate to="/" replace />} />
              <Route
                path="/projects"
                element={<Resources key="projects" kind="projects" />}
              />
              <Route
                path="/endpoints"
                element={<Resources key="endpoints" kind="endpoints" />}
              />
              <Route
                path="/proxies"
                element={<Resources key="proxies" kind="proxies" />}
              />
              <Route
                path="/proxy-pools"
                element={<Resources key="pools" kind="proxy-pools" />}
              />
              <Route path="/language-routes" element={<LanguageRoutes />} />
              <Route path="/playground" element={<Playground />} />
              <Route path="/requests" element={<Records />} />
              <Route path="/requests/:id" element={<Trace />} />
              <Route path="/observability" element={<Observability />} />
              <Route path="/api" element={<Reference />} />
              <Route
                path="*"
                element={
                  <Empty>
                    <Link to="/">
                      {t("回到工作空间", "Return to workspace")}
                    </Link>
                  </Empty>
                }
              />
            </Routes>
          </Suspense>
        </main>
      </section>
      {mobile && (
        <Dialog title={t("导航", "Navigation")} close={() => setMobile(false)}>
          {navigation}
        </Dialog>
      )}
    </div>
  );
}
