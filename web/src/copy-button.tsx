import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Btn } from "./ui";
import { useApp } from "./state";

export function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useApp();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  const copied = t("已复制", "Copied");
  return (
    <span className="copy-action">
      <Btn
        small
        iconOnly
        aria-label={state === "copied" ? copied : label}
        onPress={() => void copy()}
      >
        {state === "copied" ? <Check size={15} /> : <Copy size={15} />}
      </Btn>
      <span
        role="status"
        className={state === "failed" ? "copy-error" : "visually-hidden"}
      >
        {state === "copied"
          ? copied
          : state === "failed"
            ? t("请选中文字手动复制", "Select the text to copy it manually")
            : ""}
      </span>
    </span>
  );
}
