import { Moon, Sun } from "lucide-react";
import { Btn } from "./ui";
import { useApp } from "./state";

export function Appearance() {
  const { t, theme, setTheme, language, setLanguage } = useApp();
  return (
    <div className="appearance-controls">
      <Btn
        iconOnly
        className="quiet"
        aria-label={t("切换配色", "Toggle theme")}
        onPress={() => setTheme(theme === "light" ? "dark" : "light")}
      >
        {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
      </Btn>
      <Btn
        className="locale-button quiet"
        onPress={() => setLanguage(language === "zh" ? "en" : "zh")}
      >
        {language === "zh" ? "EN" : "中"}
      </Btn>
    </div>
  );
}
