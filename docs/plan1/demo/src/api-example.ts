import { articles, samples } from './fixtures';
import { local, type Lang, type Op } from './model';
import type { Command } from './engine';
export function apiExample(op: Op, language: Lang): Command {
  if (op === 'content') return { url: articles[0].url };
  const query = local(samples[0], language);
  return op === 'list'
    ? { query, language, count: 3 }
    : {
        query,
        language,
        source_count: 2,
        max_chars: 300,
        region: language === 'zh' ? '上海' : 'Shanghai',
        current_time: '2026-05-01T00:30:00+08:00',
      };
}
