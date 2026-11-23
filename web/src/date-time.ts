export function localOffset() {
  const minutes = -new Date().getTimezoneOffset();
  return (minutes < 0 ? "-" : "+") + String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")
    + ":" + String(Math.abs(minutes) % 60).padStart(2, "0");
}
export function splitTimestamp(value: string) {
  const match = value.match(/^(.*)(Z|[+-]\d{2}:\d{2})$/);
  return { date: match?.[1] || "", offset: match?.[2] === "Z" ? "+00:00" : match?.[2] || localOffset() };
}

