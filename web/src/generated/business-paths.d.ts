import type { webhooks } from "./business-webhooks";
import type { components } from "./business-components";
import type { $defs } from "./business-$defs";
import type { operations } from "./business-operations";
export interface paths {
    "/v1/search/list": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 搜索列表
         * @description 检索并去重，返回网页列表，可携带内置引擎 AI 卡。使用项目搜索池。同步请求总时限 15 秒。
         */
        post: operations["searchList"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/search/content": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 单 URL 的 Markdown 和纯文本正文
         * @description 读取单个网页，一次提取同时返回 Markdown 与纯文本。使用项目正文池。同步请求总时限 15 秒。
         */
        post: operations["readContent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/search/summary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 检索、打分、分段摘要与整体总结
         * @description 按项目配置改写、检索、去重、评分、取文并总结。按模型上下文选择一次生成或分批。需要配置模型。项目 search_original_query 默认开启；关闭后只检索改写查询，若无可用改写返回 QUERY_REWRITE_FAILED，原问题仍用于评分及总结。同步请求总时限 45 秒。
         */
        post: operations["summarizeSearch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
