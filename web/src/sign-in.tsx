import { useState, type FormEvent } from "react";
import { ArrowRight } from "lucide-react";
import { BrandMark, PRODUCT_NAME } from "./brand";
import { write } from "./api";
import { useApp } from "./state";
import { Appearance } from "./appearance";
import { Btn, Field, Notice } from "./ui";

export function SignIn() {
  const { t, queryClient } = useApp();
  const [username, setUsername] = useState("admin"),
    [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await write("/admin/v1/session", { username, password });
      setPassword("");
      await queryClient.invalidateQueries({ queryKey: ["session"] });
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-page" data-testid="login-page">
      <section
        className="login-introduction"
        aria-label={PRODUCT_NAME}
        data-testid="login-brand"
      >
        <div className="login-introduction__content">
          <BrandMark />
          <h2>{PRODUCT_NAME}</h2>
          <p>
            {t(
              "在一个工作空间中连接网页搜索、正文阅读与有据可查的回答。",
              "One workspace for web search, page reading, and answers you can trace.",
            )}
          </p>
        </div>
      </section>
      <section
        className="login-content"
        aria-label={t("工作空间登录", "Workspace sign in")}
      >
        <header className="login-tools">
          <Appearance />
        </header>
        <form className="login-card" onSubmit={submit} aria-busy={busy}>
          <div className="login-heading">
            <h1>{t("登录工作空间", "Sign in to your workspace")}</h1>
            <p>
              {t(
                "使用工作空间的管理员账号登录。",
                "Sign in with your workspace administrator account.",
              )}
            </p>
          </div>
          <div className="login-fields">
            <Field
              label={t("用户名", "Username")}
              value={username}
              change={setUsername}
              required
              autoComplete="username"
            />
            <Field
              label={t("口令", "Password")}
              type="password"
              value={password}
              change={setPassword}
              required
              autoComplete="current-password"
            />
          </div>
          <Notice error={error} />
          <Btn
            primary
            type="submit"
            size="lg"
            className="login-submit"
            pending={busy}
            disabled={busy}
          >
            {busy ? t("正在登录…", "Signing in…") : t("登录", "Sign in")}
            <ArrowRight size={18} />
          </Btn>
        </form>
      </section>
    </main>
  );
}
