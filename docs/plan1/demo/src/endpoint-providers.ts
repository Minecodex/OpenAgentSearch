import type { Adapter, EndpointProvider, Kind, Local } from './model';

export const providerNames: Record<EndpointProvider, Local> = {
  browser: ['内置浏览器', 'Built-in browser'],
  tavily: 'Tavily',
  searxng: 'SearXNG',
  anysearch: 'AnySearch',
  deepseek: 'DeepSeek',
  crawl4ai: 'Crawl4AI',
  openai_compatible: ['OpenAI 兼容', 'OpenAI compatible'],
};
type Choice = { provider: EndpointProvider; adapter: Adapter };
export const providerCatalog: Record<Kind, readonly Choice[]> = {
  search: [
    { provider: 'browser', adapter: 'browser_search' },
    { provider: 'tavily', adapter: 'http_search' },
    { provider: 'searxng', adapter: 'http_search' },
    { provider: 'anysearch', adapter: 'http_search' },
    { provider: 'deepseek', adapter: 'http_search' },
  ],
  reader: [
    { provider: 'browser', adapter: 'browser_reader' },
    { provider: 'tavily', adapter: 'http_reader' },
    { provider: 'anysearch', adapter: 'http_reader' },
    { provider: 'crawl4ai', adapter: 'http_reader' },
    { provider: 'deepseek', adapter: 'http_reader' },
  ],
  model: [{ provider: 'openai_compatible', adapter: 'chat_model' }],
};
export function acceptsProvider(kind: Kind, provider: EndpointProvider | null, adapter: Adapter) {
  const item = providerCatalog[kind].find((v) => v.provider === provider);
  return (
    !!item &&
    (item.adapter === adapter ||
      (item.adapter === 'http_search' && adapter === 'integrated_search' && provider !== 'searxng'))
  );
}
