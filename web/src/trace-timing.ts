export function stageTiming(
  offset: number,
  duration: number,
  requestDuration: number,
) {
  if (requestDuration <= 0) return { left: 0, width: 0 };
  const left = Math.min(100, Math.max(0, (100 * offset) / requestDuration));
  return {
    left,
    width: Math.min(
      100 - left,
      Math.max(0, (100 * duration) / requestDuration),
    ),
  };
}

export function stageWindow(
  spans: { start_offset_ms: number; duration_ms: number }[],
) {
  if (!spans.length) return 0;
  const start = Math.min(...spans.map((s) => s.start_offset_ms));
  const end = Math.max(...spans.map((s) => s.start_offset_ms + s.duration_ms));
  return end - start;
}
