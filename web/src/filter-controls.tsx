import { useState } from "react";
import { CalendarDays, Search } from "lucide-react";
import { Input, Label, TextField } from "@heroui/react";
import { useApp } from "./state";
import { Btn, Dialog, Field } from "./ui";

export function SearchBox({
  label,
  value,
  change,
}: {
  label: string;
  value: string;
  change: (value: string) => void;
}) {
  return (
    <TextField className="atlas-search-box" value={value} onChange={change}>
      <Label className="visually-hidden">{label}</Label>
      <Search size={16} aria-hidden="true" />
      <Input type="search" placeholder={label} />
    </TextField>
  );
}

type TimeRange = { from: string; to: string };

function localTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Date(date.getTime() - date.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16)
    : "";
}

export function TimeWindow({
  range,
  change,
}: {
  range: TimeRange;
  change: (range: TimeRange) => void;
}) {
  const { t } = useApp();
  const [draft, setDraft] = useState<TimeRange | null>(null);
  const valid =
    !!draft &&
    Number.isFinite(Date.parse(draft.from)) &&
    Date.parse(draft.from) < Date.parse(draft.to);
  const duration = Date.parse(range.to) - Date.parse(range.from);
  return (
    <>
      <div
        className="time-window"
        role="group"
        aria-label={t("时间范围", "Time range")}
      >
        <CalendarDays size={15} aria-hidden="true" />
        {[1, 24, 168].map((hours) => (
          <button
            key={hours}
            aria-pressed={Math.abs(duration - hours * 3600000) < 1000}
            onClick={() => {
              const now = Date.now();
              change({
                from: new Date(now - hours * 3600000).toISOString(),
                to: new Date(now).toISOString(),
              });
            }}
          >
            {hours === 168 ? "7d" : `${hours}h`}
          </button>
        ))}
        <button
          onClick={() =>
            setDraft({ from: localTime(range.from), to: localTime(range.to) })
          }
        >
          {t("自定义", "Custom")}
        </button>
      </div>
      {draft && (
        <Dialog
          title={t("自定义时间范围", "Custom time window")}
          close={() => setDraft(null)}
        >
          <div className="form-grid">
            <Field
              label={t("起点（本机时间）", "Start (local time)")}
              type="datetime-local"
              value={draft.from}
              change={(from) => setDraft({ ...draft, from })}
            />
            <Field
              label={t("终点（本机时间）", "End (local time)")}
              type="datetime-local"
              value={draft.to}
              change={(to) => setDraft({ ...draft, to })}
            />
          </div>
          <div className="form-actions">
            <Btn
              primary
              disabled={!valid}
              onPress={() => {
                if (valid) {
                  change({
                    from: new Date(draft.from).toISOString(),
                    to: new Date(draft.to).toISOString(),
                  });
                  setDraft(null);
                }
              }}
            >
              {t("应用时间范围", "Apply time window")}
            </Btn>
          </div>
        </Dialog>
      )}
    </>
  );
}
