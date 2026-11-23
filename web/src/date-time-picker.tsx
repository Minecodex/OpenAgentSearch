import { I18nProvider } from "react-aria-components";
import { localOffset, splitTimestamp } from "./date-time";
import { useState } from "react";
import { Calendar, DateField, DatePicker, Label, TimeField, Description } from "@heroui/react";
import { parseDateTime } from "@internationalized/date";
import { X } from "lucide-react";
import { useApp } from "./state";
import { Select } from "./ui";

export function LocalDateTimePicker({value, change}: {value: string; change: (value: string) => void}) {
  const { t, language } = useApp();
  const parts = splitTimestamp(value);
  const [emptyOffset, setEmptyOffset] = useState(localOffset);
  const offset = value ? parts.offset : emptyOffset;
  const date = parts.date ? parseDateTime(parts.date) : null;
  const label = t("当地日期与时间", "Local date and time");
  const offsets = [...new Set([
    "-12:00","-11:00","-10:00","-09:30","-09:00","-08:00","-07:00","-06:00","-05:00","-04:00",
    "-03:30","-03:00","-02:00","-01:00","+00:00","+01:00","+02:00","+03:00","+03:30","+04:00",
    "+04:30","+05:00","+05:30","+05:45","+06:00","+06:30","+07:00","+08:00","+08:45","+09:00",
    "+09:30","+10:00","+10:30","+11:00","+12:00","+12:45","+13:00","+14:00",offset
  ])].sort();
  return (
    <I18nProvider locale={language === "zh" ? "zh-CN" : "en-US"}><div className="local-date-time">
      <DatePicker
        className="field oas-date-picker"
        value={date}
        onChange={(next) => change(next ? next.toString() + offset : "")}
        granularity="second"
        hourCycle={24}
        shouldForceLeadingZeros
      >
        <Label>{label}</Label>
        <DateField.Group fullWidth>
          <DateField.Input>{segment => <DateField.Segment segment={segment} />}</DateField.Input>
          <DateField.Suffix>
            {date && <button type="button" className="date-time-clear" aria-label={t("清除当地时间", "Clear local time")} onClick={() => change("")}><X size={14}/></button>}
            <DatePicker.Trigger aria-label={t("选择日期与时间", "Choose date and time")}><DatePicker.TriggerIndicator /></DatePicker.Trigger>
          </DateField.Suffix>
        </DateField.Group>
        <DatePicker.Popover className="oas-date-popover">
          <Calendar aria-label={t("选择日期", "Choose date")}>
            <Calendar.Header>
              <Calendar.YearPickerTrigger><Calendar.YearPickerTriggerHeading/><Calendar.YearPickerTriggerIndicator/></Calendar.YearPickerTrigger>
              <Calendar.NavButton slot="previous"/><Calendar.NavButton slot="next"/>
            </Calendar.Header>
            <Calendar.Grid>
              <Calendar.GridHeader>{day => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}</Calendar.GridHeader>
              <Calendar.GridBody>{day => <Calendar.Cell date={day}/>}</Calendar.GridBody>
            </Calendar.Grid>
            <Calendar.YearPickerGrid><Calendar.YearPickerGridBody>{({year}) => <Calendar.YearPickerCell year={year}/>}</Calendar.YearPickerGridBody></Calendar.YearPickerGrid>
          </Calendar>
          <TimeField className="field" value={date} onChange={next => {if(next && date) change(date.set(next).toString()+offset)}} granularity="second" hourCycle={24}>
            <Label>{t("时间", "Time")}</Label>
            <DateField.Group fullWidth><DateField.Input>{segment => <DateField.Segment segment={segment}/>}</DateField.Input></DateField.Group>
          </TimeField>
        </DatePicker.Popover>
        <Description>{t("留空使用服务本地时间", "Leave blank to use service-local time")}</Description>
      </DatePicker>
      <Select label={t("UTC 偏移", "UTC offset")} value={offset} change={next => {setEmptyOffset(next);if(date)change(date.toString()+next)}} options={offsets.map(value=>({value,label:"UTC"+value}))}/>
    </div></I18nProvider>
  );
}
