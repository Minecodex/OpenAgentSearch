import { hydrateConfig, primaryResources } from './configuration';
import { Article, Config, Log, Local, Op, Status } from './model';
export const articles: Article[] = [
  {
    id: 'marsh',
    ageDays: 0,
    name: ['潮汐湿地与波浪衰减', 'Tidal marshes and wave attenuation'],
    publisher: ['海岸观测手记', 'Coastal Field Notes'],
    url: 'https://shore.example.org/notes/tidal-marsh',
    words: [
      '海岸',
      '湿地',
      '波浪',
      '风暴潮',
      '潮滩',
      '植被',
      'wetland',
      'marsh',
      'waves',
      'coast',
      'storm',
      'tide',
    ],
    points: [
      [
        '盐沼植被增加水流阻力，使近岸波浪在穿过湿地时逐渐损失能量。',
        'Salt-marsh plants increase hydraulic drag and dissipate wave energy as water moves inland.',
      ],
      [
        '连续的湿地带使波浪通过更长的粗糙表面；实际衰减程度受潮位、地形和植被密度影响。',
        'A continuous marsh exposes waves to a longer rough surface. Tidal depth, terrain and plant density affect attenuation.',
      ],
    ],
  },
  {
    id: 'shore',
    ageDays: 11,
    name: ['潮沟、滩面与蓄水空间', 'Creeks, platforms and water storage'],
    publisher: ['河口研究档案', 'Estuary Archive'],
    url: 'https://estuary.example.org/field/storage',
    words: ['海岸', '湿地', '风暴潮', '蓄水', '潮滩', '潮沟', 'wetland', 'coast', 'storm', 'tide', 'creek'],
    points: [
      [
        '低洼滩面为潮水提供临时蓄水空间，潮沟调节水流进出湿地的路径。',
        'Low marsh platforms provide temporary storage while tidal creeks guide water into and out of the wetland.',
      ],
      [
        '解释局地水位变化时，需要同时考虑开阔水域与湿地之间的连通性。',
        'Local water levels depend in part on connectivity between the marsh and open water.',
      ],
    ],
  },
  {
    id: 'survey',
    ageDays: 81,
    name: ['湿地修复的观测边界', 'Measuring restoration outcomes'],
    publisher: ['环境测量札记', 'Environmental Methods'],
    url: 'https://methods.example.org/notes/marsh-survey',
    words: ['海岸', '湿地', '修复', '风暴潮', 'wetland', 'storm', 'coast', 'restor'],
    points: [
      [
        '比较修复前后的防护效果，需要在相近的潮位与风浪条件下布置成对观测点。',
        'Paired observations under comparable tides and wave conditions help evaluate restoration.',
      ],
      [
        '观测应同时记录水位、波高、植被与地形变化，扩大样本后再外推结论。',
        'Monitoring should record water level, wave height, vegetation and terrain before conclusions are generalized.',
      ],
    ],
  },
  {
    id: 'rain',
    ageDays: 5,
    name: ['翻斗式雨量计现场校准', 'Calibrating a tipping-bucket gauge'],
    publisher: ['环境测量札记', 'Environmental Methods'],
    url: 'https://methods.example.org/gauge',
    words: ['雨量计', '雨量', '降水', '翻斗', 'rain', 'gauge', 'precipitation'],
    points: [
      [
        '每次翻斗动作代表一个校准过的降水增量，仪器按时间累计动作次数。',
        'Each tip represents one calibrated increment of precipitation. The instrument counts tips over time.',
      ],
      [
        '水平放置并定期清除漏斗杂物，有助于降低测量误差。',
        'A level installation and a clear funnel reduce measurement errors.',
      ],
    ],
  },
  {
    id: 'route',
    ageDays: 0,
    sourceLanguage: 'en',
    name: ['浏览器任务的代理租约', 'Proxy leases for browser jobs'],
    publisher: ['系统工程手册', 'Systems Handbook'],
    url: 'https://docs.example.org/browser/proxy-leases',
    words: ['浏览器', '代理', '接入点', 'socks', 'https', 'proxy', 'browser', 'lease', 'endpoint'],
    points: [
      [
        '调度器为同一浏览器任务分配固定的代理出口。',
        'The scheduler assigns one proxy egress to a browser task.',
      ],
      [
        '上下文关闭后才释放代理和浏览器槽位，迟到回执需验证租约所有者。',
        'Proxy and browser slots are released after context cleanup, and late acknowledgements must match the lease owner.',
      ],
    ],
  },
  {
    id: 'rust',
    ageDays: 24,
    sourceLanguage: 'en',
    name: ['Rust 请求预算与取消', 'Request budgets and cancellation in Rust'],
    publisher: ['系统工程手册', 'Systems Handbook'],
    url: 'https://docs.example.org/rust/deadlines',
    words: ['rust', '预算', '取消', 'deadline', 'cancel', 'budget', 'tokio'],
    points: [
      [
        '请求从进入服务时开始使用同一个绝对截止时间。',
        'Requests use one absolute deadline from admission onward.',
      ],
      [
        '子任务共享取消信号，并在实际工作结束后归还资源。',
        'Child tasks share a cancellation signal and release resources when execution ends.',
      ],
    ],
  },
  {
    id: 'station-report',
    name: ['上海示例站 · 5 月 1 日降水观测', 'Shanghai sample station · May 1 rainfall'],
    publisher: ['示例测站', 'Sample station'],
    url: 'https://station.example.org/observations/2026-05-01',
    ageDays: 7,
    words: [
      '上海2026-05-01',
      '上海2026-05-01的降水观测',
      'shanghai on 2026-05-01',
      'rainfall observations in shanghai on 2026-05-01',
    ],
    points: [
      [
        '上海示例站在 5 月 1 日当地时间 00:20 的观测记录为 0.8 毫米降水。',
        'At 00:20 local time on May 1, the Shanghai sample station recorded 0.8 mm of rain.',
      ],
      [
        '这条演示记录使用 UTC+08:00，累计量对应之前的 20 分钟。',
        'This sample uses UTC+08:00 and covers the preceding 20 minutes.',
      ],
    ],
  },
  {
    id: 'missing',
    name: ['观测目录索引条目', 'Observation catalogue entry'],
    publisher: ['测站目录', 'Station catalogue'],
    url: 'https://catalog.example.org/missing-article',
    ageDays: 2,
    snippetOnly: true,
    words: ['档案缺页', 'missing article'],
    points: [
      [
        '目录记录了测站名称、采样日期与仪器类型。',
        'The catalogue lists the station name, sampling date and instrument type.',
      ],
    ],
  },
];
export const missingBodySample: [string, string] = [
  '档案缺页的观测索引',
  'Observation index with a missing article',
];
export const samples: [string, string][] = [
  ['海岸湿地如何缓冲风暴潮？', 'How do coastal wetlands buffer storm surges?'],
  ['翻斗式雨量计如何记录降水？', 'How does a tipping-bucket rain gauge record rainfall?'],
  ['浏览器任务如何分配代理？', 'How are proxies assigned to browser jobs?'],
  ['Rust 如何处理请求取消？', 'How does Rust handle request cancellation?'],
];
export function initialConfig(): Config {
  return hydrateConfig({
    endpoints: [
      {
        id: 'browser-s',
        provider: 'browser',
        name: ['内置浏览器搜索', 'Browser search'],
        kind: 'search',
        adapter: 'browser_search',
        builtin: true,
        limit: 8,
        rpm: 120,
        address: '',
      },
      {
        id: 'browser-r',
        provider: 'browser',
        name: ['内置浏览器正文', 'Browser reader'],
        kind: 'reader',
        adapter: 'browser_reader',
        builtin: true,
        limit: 8,
        rpm: 120,
        address: '',
      },
      {
        id: 'index',
        provider: 'tavily',
        name: ['文档索引', 'Document index'],
        kind: 'search',
        adapter: 'http_search',
        limit: 12,
        rpm: 240,
        address: 'https://index.example.org',
      },
      {
        id: 'reader',
        provider: 'anysearch',
        name: ['文档读取器', 'Document reader'],
        kind: 'reader',
        adapter: 'http_reader',
        limit: 8,
        rpm: 160,
        address: 'https://read.example.org',
      },
      {
        id: 'model',
        provider: 'openai_compatible',
        name: ['通用生成模型', 'General model'],
        kind: 'model',
        adapter: 'chat_model',
        limit: 4,
        rpm: 60,
        address: 'https://model.example.org',
      },
      {
        id: 'searxng',
        provider: 'searxng',
        name: 'SearXNG',
        kind: 'search',
        adapter: 'http_search',
        addon: 'searxng',
        limit: 6,
        rpm: 120,
        address: '',
      },
      {
        id: 'crawl4ai',
        provider: 'crawl4ai',
        name: 'Crawl4AI',
        kind: 'reader',
        adapter: 'http_reader',
        addon: 'crawl4ai',
        limit: 6,
        rpm: 90,
        address: '',
      },
    ],
    projects: [
      {
        id: 'coastal',
        name: ['海岸观测', 'Coastal research'],
        description: ['海岸湿地、潮汐与环境观测资料', 'Coastal wetlands, tides and field observations'],
        searchPools: [['browser-s'], ['index']],
        readerPools: [['browser-r'], ['reader']],
        model: 'model',
        pool: 'ocean',
        language: 'zh',
        limit: 4,
        version: 3,
      },
      {
        id: 'library',
        name: ['知识检索', 'Knowledge library'],
        description: ['文档索引与技术资料检索', 'Documentation and engineering references'],
        search: 'index',
        reader: 'reader',
        model: 'model',
        pool: '',
        language: 'zh',
        limit: 3,
        version: 2,
      },
      {
        id: 'field',
        name: ['水文手册', 'Hydrology handbook'],
        description: ['降水测量与野外采样方法', 'Field sampling and rainfall measurement'],
        search: 'index',
        reader: 'browser-r',
        model: 'model',
        pool: 'ocean',
        language: 'en',
        limit: 4,
        version: 1,
      },
    ],
    proxies: [
      {
        id: 'p1',
        name: ['观测出口 A', 'Research egress A'],
        scheme: 'socks5',
        host: 'egress-a.example.org',
        port: 1080,
        limit: 4,
        enabled: true,
        auth: true,
      },
      {
        id: 'p2',
        name: ['观测出口 B', 'Research egress B'],
        scheme: 'https',
        host: 'egress-b.example.org',
        port: 443,
        limit: 4,
        enabled: true,
        auth: false,
      },
    ],
    pools: [
      {
        id: 'ocean',
        name: ['观测代理池', 'Research pool'],
        members: [
          { id: 'p1', weight: 2 },
          { id: 'p2', weight: 1 },
        ],
      },
    ],
    addons: { searxng: false, crawl4ai: false },
    routes: { zh: ['browser-s'], en: ['index'] },
  });
}
export const anchorTime = Date.now();
export const DAY = 86400000;
function rng(seed: number) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
const fieldQueries: [string, string][][] = [
  [
    samples[0],
    ['海岸植被密度会怎样影响波浪衰减？', 'How does coastal vegetation density affect wave attenuation?'],
    ['潮滩与潮沟各提供哪些蓄水空间？', 'How do marsh platforms and tidal creeks store water?'],
  ],
  [
    samples[1],
    ['翻斗雨量计现场校准需要对照什么？', 'How is a tipping-bucket rain gauge calibrated in the field?'],
    ['降水观测中有哪些常见测量误差？', 'What introduces measurement errors in rainfall observations?'],
  ],
  [
    samples[2],
    ['同一浏览器任务怎样保持出口一致？', 'How does a browser job keep one egress address?'],
    ['HTTPS 代理的租约何时释放？', 'When is an HTTPS proxy lease released?'],
  ],
  [
    samples[3],
    ['Rust 中应如何分配各阶段的超时预算？', 'How should a Rust pipeline allocate its deadline?'],
    ['Tokio 工作线程退出时怎样释放资源？', 'How does a Tokio worker release resources on cancellation?'],
  ],
];
export function history(): Log[] {
  const rand = rng(269435);
  const events: Log[] = [];
  const week = [1384, 1612, 1536, 2077, 1832, 2256, 2149];
  for (let day = 29; day >= 0; day--) {
    const n = day <= 6 ? week[6 - day] : 1180 + Math.round(rand() * 720);
    for (let i = 0; i < n; i++) {
      const x = rand();
      const op: Op = x < 0.53 ? 'list' : x < 0.82 ? 'content' : 'summary';
      const idx = Math.floor(rand() * samples.length);
      const q: Local = op === 'content' ? articles[[0, 3, 4, 5][idx]].url : fieldQueries[idx][i % 3];
      const y = rand();
      const status: Status = y < 0.004 ? 'error' : y < 0.026 ? 'partial' : y < 0.039 ? 'empty' : 'success';
      const f = (i + 0.15 + rand() * 0.7) / n;
      const fraction =
        f + 0.06 * (Math.sin(2 * Math.PI * f - 0.45) + Math.sin(0.45)) + 0.017 * Math.sin(4 * Math.PI * f);
      const time = Math.floor(anchorTime - DAY * (day + 1) + DAY * fraction);
      events.push({
        id: 'req_' + (0x5a70a2 + events.length * 13).toString(16),
        op,
        project: ['coastal', 'library', 'field'][Math.floor(rand() * 3)],
        query: q,
        language: i % 5 === 0 ? 'en' : 'zh',
        origin: i % 59 === 0 ? 'endpoint_test' : i % 17 === 0 ? 'debug' : 'business',
        time,
        duration: Math.round(60 + rand() * (op === 'summary' ? 1950 : op === 'content' ? 590 : 320)),
        status: op === 'content' && (status === 'empty' || status === 'partial') ? 'success' : status,
      });
    }
  }
  const latest = events[events.length - 1];
  latest.op = 'summary';
  latest.origin = 'business';
  latest.language = 'zh';
  latest.project = 'coastal';
  latest.query = samples[0];
  latest.status = 'success';
  latest.duration = 1284;
  const lead = events.slice(-8).reverse();
  const picked: [Op, number, Status][] = [
    ['summary', 0, 'success'],
    ['content', 4, 'success'],
    ['list', 2, 'success'],
    ['summary', 1, 'partial'],
    ['content', 5, 'error'],
    ['list', 0, 'empty'],
    ['summary', 3, 'success'],
    ['list', 1, 'success'],
  ];
  lead.forEach((r, i) => {
    const [op, topic, status] = picked[i];
    r.op = op;
    r.query = op === 'content' ? articles[topic].url : fieldQueries[topic][i % 3];
    r.status = status;
    r.origin = i === 2 ? 'debug' : 'business';
  });
  const config = initialConfig();
  for (const r of events) {
    if (r.origin !== 'endpoint_test') continue;
    const owner = config.projects.find((p) => p.id === r.project)!;
    const kind = r.op === 'content' ? 'reader' : r.op === 'summary' ? 'model' : 'search';
    const resources = primaryResources(owner);
    const ep = config.endpoints.find((e) => e.id === resources[kind])!;
    r.testTarget = { id: ep.id, name: ep.name, kind };
    r.resources = resources;
    r.query = ep.name;
    r.project = '';
    r.status = r.status === 'error' ? 'error' : 'success';
  }
  return events.reverse();
}
