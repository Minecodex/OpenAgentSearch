import { ComboBox, Input, Label, ListBox } from "@heroui/react";
import { useMemo } from "react";
import { useApp } from "./state";
import { searchLanguageOptions } from "./search-languages";

export function LanguagePicker({
  label,
  value,
  change,
  extra = [],
  emptyLabel,
}: {
  label: string;
  value: string;
  change: (v: string) => void;
  extra?: string[];
  emptyLabel?: string;
}) {
  const { t, language } = useApp();
  const extras = Array.from(new Set([...extra, value].filter(Boolean)))
    .sort()
    .join(",");
  const options = useMemo(() => {
    const items = searchLanguageOptions(
      language,
      extras ? extras.split(",") : [],
    );
    return emptyLabel
      ? [
          {
            code: "",
            label: emptyLabel,
            search: emptyLabel.toLocaleLowerCase(language),
          },
          ...items,
        ]
      : items;
  }, [language, extras, emptyLabel]);
  const terms = useMemo(
    () => new Map(options.map((o) => [o.label, o.search])),
    [options],
  );
  return (
    <ComboBox
      className="field language-picker"
      value={"lang:" + value}
      onChange={(key) => {
        if (key != null) change(String(key).slice(5));
      }}
      defaultFilter={(text, query) =>
        (terms.get(text) || text).includes(
          query.trim().toLocaleLowerCase(language),
        )
      }
    >
      <Label>{label}</Label>
      <ComboBox.InputGroup className="language-input-group">
        <Input
          placeholder={t("按名称或语言代码查找", "Find a language or code")}
        />
        <ComboBox.Trigger aria-label={t("展开语言列表", "Show languages")} />
      </ComboBox.InputGroup>
      <ComboBox.Popover className="oas-select-popover language-popover">
        <ListBox>
          {options.map((o) => (
            <ListBox.Item
              key={o.code}
              id={"lang:" + o.code}
              textValue={o.label}
            >
              {o.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </ComboBox.Popover>
    </ComboBox>
  );
}
