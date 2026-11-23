export const operationKeys = ["list", "content", "summary"] as const;
export type OperationCounts = Record<(typeof operationKeys)[number], number>;
export interface RequestHour {
  from: string;
  list?: number;
  content?: number;
  summary?: number;
}

export function operationCounts(
  value: Partial<OperationCounts> | undefined,
  rows: RequestHour[] | undefined,
): OperationCounts | null {
  if (value)
    return {
      list: value.list ?? 0,
      content: value.content ?? 0,
      summary: value.summary ?? 0,
    };
  if (!rows) return null;
  return rows.reduce(
    (sum, row) => ({
      list: sum.list + (row.list ?? 0),
      content: sum.content + (row.content ?? 0),
      summary: sum.summary + (row.summary ?? 0),
    }),
    { list: 0, content: 0, summary: 0 },
  );
}
export function requestHours(
  rows: RequestHour[] | undefined,
  from: string,
  to: string,
) {
  if (!rows?.length) return [];
  const hour = 3600000,
    start = Date.parse(from),
    end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return [];
  const byHour = new Map(
    rows.map((row) => [Math.floor(Date.parse(row.from) / hour) * hour, row]),
  );
  const output = [];
  for (let time = Math.floor(start / hour) * hour; time < end; time += hour) {
    const row = byHour.get(time);
    output.push({
      from: new Date(Math.max(start, time)).toISOString(),
      to: new Date(Math.min(end, time + hour)).toISOString(),
      values: operationKeys.map((key) => row?.[key] ?? 0),
    });
  }
  return output;
}
export function chartMaximum(values: (number | null)[], integer = true) {
  const largest = Math.max(
    1,
    ...values.filter((v): v is number => v != null && Number.isFinite(v)),
  );
  const step = Math.max(
    integer ? 1 : 0,
    10 ** Math.floor(Math.log10(largest / 4)),
  );
  return Math.max(integer ? 4 : step, Math.ceil(largest / step) * step);
}
