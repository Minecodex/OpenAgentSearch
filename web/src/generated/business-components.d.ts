import type { paths } from "./business-paths";
import type { webhooks } from "./business-webhooks";
import type { $defs } from "./business-$defs";
import type { operations } from "./business-operations";
export interface components {
    schemas: {
        Message: {
            /** @description 稳定的机器可读代码。 */
            code: string;
            /** @description 由 Accept-Language 选择的中英文说明。 */
            message: string;
            /** @description 字段、限额等公开细节，无额外信息时为 null。 */
            details: {
                [key: string]: unknown;
            } | null;
        };
        Failure: {
            /** @description 请求标识，可在请求记录中追踪。 */
            request_id: string;
            /**
             * @description success 完整成功，partial 有可用结果但存在损失，empty 合法空结果，error 失败。
             * @constant
             */
            status: "error";
            /** @description 本操作的结果，失败时为 null。 */
            data: null;
            /** @description 可处理的损失或截断提示，正常时为空数组。 */
            warnings: components["schemas"]["Message"][];
            /** @description 失败代码、说明和细节，成功时为 null。 */
            error: components["schemas"]["Message"];
        };
        ListInput: {
            /** @description 要检索的自然语言问题，1–2048 个 Unicode 字符，至少含一个非空白字符。保留明确的地点和时间。 */
            query: string;
            /** @description 业务语言标签，如 zh、en、ja、fr 或 zh-TW。决定语言优先路由的起始搜索池，并指导总结输出语言。省略时从第一池开始，总结使用问题语言。Accept-Language 单独控制错误文案。 */
            language?: string;
            /**
             * @description 结果发布时间筛选，以请求到达时刻为基准。day 最近 24 小时，month 最近 30 天，year 最近 365 天。省略时不限时间。只派发给支持该窗口的来源。current_time 单独作为问题改写参照。
             * @enum {string}
             */
            time_range?: "day" | "month" | "year";
            /** @description 最多返回的结果数，整数 1–10 且不得超过项目 search_limit。省略使用项目值，初始为 10。实际命中数可以更少。 */
            count?: number;
        };
        ContentInput: {
            /**
             * Format: uri
             * @description 要提取的单个公开 HTTP(S) 网页 URL。目标与重定向均须通过访问校验，禁止 URL 内凭据与内网地址。
             */
            url: string;
            /** @description 正文字符上限，正整数且不得超过项目 body_limit。省略使用项目值，初始为 40000。同时限制 Markdown 和纯文本并保留相同内容前缀，截断时附警告。 */
            max_chars?: number;
        };
        SummaryInput: {
            /** @description 要检索的自然语言问题，1–2048 个 Unicode 字符，至少含一个非空白字符。保留明确的地点和时间。 */
            query: string;
            /** @description 业务语言标签，如 zh、en、ja、fr 或 zh-TW。决定语言优先路由的起始搜索池，并指导总结输出语言。省略时从第一池开始，总结使用问题语言。Accept-Language 单独控制错误文案。 */
            language?: string;
            /**
             * @description 结果发布时间筛选，以请求到达时刻为基准。day 最近 24 小时，month 最近 30 天，year 最近 365 天。省略时不限时间。只派发给支持该窗口的来源。current_time 单独作为问题改写参照。
             * @enum {string}
             */
            time_range?: "day" | "month" | "year";
            /** @description 最多参与回答的去重来源数，整数 1–10 且不得超过项目 source_limit。省略使用项目值，初始为 4。先打分过滤再选择来源。 */
            source_count?: number;
            /** @description 整体回答 summary 的字符上限，正整数且不得超过项目 summary_limit。省略使用项目值，初始为 1200。原文材料长度由项目 body_limit 单独决定。 */
            max_chars?: number;
            /**
             * @description 调用方地区，如广州市天河区，1–128 个 Unicode 字符。用于补全附近、当地等指代。省略时不猜地点，仍执行启用的改写。问题中的明确地点优先。
             * @example 上海市浦东新区
             */
            region?: string;
            /**
             * Format: date-time
             * @description 带偏移的 RFC 3339 当地时间，如 2026-11-22T10:30:00+08:00。按其日期解释今天、昨天。省略使用服务本地时间，Helm 默认 Asia/Shanghai。问题中的明确日期优先。
             * @example 2026-05-01T00:30:00+08:00
             * @example 2026-04-30T16:30:00.123Z
             */
            current_time?: string;
        };
        SearchItem: {
            /**
             * Format: uri
             * @description 结果网页地址。
             */
            url: string;
            /** @description 网页标题，来源未提供时为空。 */
            title: string;
            /** @description 结果简介，来源未提供时为空。 */
            snippet: string;
        };
        SearchCard: {
            /** @enum {string} */
            engine: "google" | "baidu";
            /**
             * Format: uri
             * @description 实际取得卡片的搜索页地址。
             */
            url: string;
            title: string;
            /** @description 去除控件和普通链接结果后的语义文本，保留表格、数值和可读代码。一次调用的卡片内容总计不超过 8192 个字符。 */
            content: string;
        };
        EngineAnswer: {
            /**
             * @description 生成本卡片的搜索引擎。
             * @enum {string}
             */
            engine: "google" | "baidu";
            /** @description 本次搜索的已完成 AI 回答。需完成标记、有效引用及 200 毫秒稳定期；提交后最早 4 秒返回，等待受本次调用剩余预算及最多 7 秒限制。未就绪时省略整个 engine_answer。 */
            content: string;
            /** @description 引擎回答提供的 1–10 个来源。 */
            sources: {
                /** Format: uri */
                url: string;
                title: string;
            }[];
        };
        Length: {
            /** @description 截断前的字符数。 */
            original: number;
            /** @description 实际返回的字符数。 */
            retained: number;
        };
        Segment: {
            /** @description 来源内的段 ID，与引用对应。 */
            id: string;
            /** @description 该段有依据的摘要。 */
            summary: string;
        };
        Source: {
            /** @description 本请求内的来源 ID，与引用对应。 */
            id: string;
            /**
             * Format: uri
             * @description 来源网页地址。
             */
            url: string;
            /** @description 来源标题。 */
            title: string;
            /** @description 相关分数，整数 0–100。 */
            score: number;
            /**
             * @description body 为正文，snippet 为项目主动选择的搜索列表材料，或允许降级使用的检索简介。
             * @enum {string}
             */
            kind: "body" | "snippet";
            /** @description 保留的相关段摘要，引用通过段 ID 定位。 */
            segments: components["schemas"]["Segment"][];
        };
        Citation: {
            /** @description 必须存在于本响应 sources。 */
            source_id: string;
            /** @description 必须存在于对应来源的 segments。 */
            segment_id: string;
        };
        ListResponse: {
            /** @description 请求标识，可在请求记录中追踪。 */
            request_id: string;
            /**
             * @description success 完整成功，partial 有可用结果但存在损失，empty 合法空结果，error 失败。
             * @enum {string}
             */
            status: "success" | "partial" | "empty";
            /** @description 本操作的结果，失败时为 null。 */
            data: {
                /** @description 可选的普通搜索卡片材料（如天气、换算、表格），与 AI 回答分开，items 仍是链接结果。卡片 URL 指向实际搜索页。 */
                cards?: components["schemas"]["SearchCard"][];
                /** @description 可选的内置引擎 AI 回答，普通列表同时保留。 */
                engine_answer?: components["schemas"]["EngineAnswer"];
                /** @description URL 去重后保持检索顺序的结果列表。 */
                items: components["schemas"]["SearchItem"][];
            };
            /** @description 可处理的损失或截断提示，正常时为空数组。 */
            warnings: components["schemas"]["Message"][];
            /** @description 失败代码、说明和细节，成功时为 null。 */
            error: null;
        };
        ContentResponse: {
            /** @description 请求标识，可在请求记录中追踪。 */
            request_id: string;
            /**
             * @description success 完整成功，partial 有可用结果但存在损失，empty 合法空结果，error 失败。
             * @constant
             */
            status: "success";
            /** @description 本操作的结果，失败时为 null。 */
            data: {
                /**
                 * Format: uri
                 * @description 原样保留请求地址。
                 */
                url: string;
                /**
                 * Format: uri
                 * @description 确认的最终地址，无法确认时省略。
                 */
                final_url?: string;
                /** @description 提取到的网页标题。 */
                title: string;
                /** @description 保留段落、列表及表格结构的 Markdown 正文。 */
                markdown: string;
                /** @description 与 Markdown 对应的同一正文前缀的纯文本。 */
                text: string;
                /** @description 是否因 max_chars 截断。 */
                truncated: boolean;
                /** @description Markdown 和纯文本的原始与保留字符数。 */
                lengths: {
                    markdown: components["schemas"]["Length"];
                    text: components["schemas"]["Length"];
                };
            };
            /** @description 可处理的损失或截断提示，正常时为空数组。 */
            warnings: components["schemas"]["Message"][];
            /** @description 失败代码、说明和细节，成功时为 null。 */
            error: null;
        };
        SummaryResponse: {
            /** @description 请求标识，可在请求记录中追踪。 */
            request_id: string;
            /**
             * @description success 完整成功，partial 有可用结果但存在损失，empty 合法空结果，error 失败。
             * @enum {string}
             */
            status: "success" | "partial" | "empty";
            /** @description 本操作的结果，失败时为 null。 */
            data: {
                /** @description 根据入选证据生成的整体回答。 */
                summary: string;
                /** @description 实际参与的来源、评分和段摘要。 */
                sources: components["schemas"]["Source"][];
                /** @description 指向本响应实际段落的引用。 */
                citations: components["schemas"]["Citation"][];
            };
            /** @description 可处理的损失或截断提示，正常时为空数组。 */
            warnings: components["schemas"]["Message"][];
            /** @description 失败代码、说明和细节，成功时为 null。 */
            error: null;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
