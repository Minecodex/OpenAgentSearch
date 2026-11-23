import type { paths } from "./business-paths";
import type { webhooks } from "./business-webhooks";
import type { components } from "./business-components";
import type { $defs } from "./business-$defs";
export interface operations {
    searchList: {
        parameters: {
            query?: never;
            header?: {
                /** @description 错误和警告文案的语言，传 zh-CN 或 en。缺省为中文。 */
                "Accept-Language"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ListInput"];
            };
        };
        responses: {
            /** @description 搜索列表 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request_id": "example-list",
                     *       "status": "success",
                     *       "data": {
                     *         "items": [
                     *           {
                     *             "url": "https://example.org/rain",
                     *             "title": "雨量计",
                     *             "snippet": "以毫米记录降水。"
                     *           }
                     *         ]
                     *       },
                     *       "warnings": [],
                     *       "error": null
                     *     }
                     */
                    "application/json": components["schemas"]["ListResponse"];
                };
            };
            /** @description 参数或项目能力不满足 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request_id": "example-error",
                     *       "status": "error",
                     *       "data": null,
                     *       "warnings": [],
                     *       "error": {
                     *         "code": "INVALID_ARGUMENT",
                     *         "message": "参数或项目能力不满足",
                     *         "details": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["Failure"];
                };
            };
            /** @description 项目身份无效 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request_id": "example-error",
                     *       "status": "error",
                     *       "data": null,
                     *       "warnings": [],
                     *       "error": {
                     *         "code": "UNAUTHORIZED",
                     *         "message": "项目身份无效",
                     *         "details": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["Failure"];
                };
            };
            /** @description 输入字节超限 */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request_id": "example-error",
                     *       "status": "error",
                     *       "data": null,
                     *       "warnings": [],
                     *       "error": {
                     *         "code": "PAYLOAD_TOO_LARGE",
                     *         "message": "输入字节超限",
                     *         "details": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["Failure"];
                };
            };
            /** @description 速率或容量受限 */
            429: {
                headers: {
                    /** @description 有建议等待时间时返回秒数。 */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request_id": "example-error",
                     *       "status": "error",
                     *       "data": null,
                     *       "warnings": [],
                     *       "error": {
                     *         "code": "CAPACITY_EXHAUSTED",
                     *         "message": "速率或容量受限",
                     *         "details": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["Failure"];
                };
            };
            /** @description 内部错误 */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request_id": "example-error",
                     *       "status": "error",
                     *       "data": null,
                     *       "warnings": [],
                     *       "error": {
                     *         "code": "INTERNAL_ERROR",
                     *         "message": "内部错误",
                     *         "details": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["Failure"];
                };
            };
            /** @description 上游或输出协议失败 */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request_id": "example-error",
                     *       "status": "error",
                     *       "data": null,
                     *       "warnings": [],
                     *       "error": {
                     *         "code": "SEARCH_FAILED",
                     *         "message": "上游或输出协议失败",
                     *         "details": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["Failure"];
                };
            };
            /** @description 依赖或代理不可用 */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request_id": "example-error",
                     *       "status": "error",
                     *       "data": null,
                     *       "warnings": [],
                     *       "error": {
                     *         "code": "SERVICE_UNAVAILABLE",
                     *         "message": "依赖或代理不可用",
                     *         "details": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["Failure"];
                };
            };
            /** @description 超过总截止时间 */
            504: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request_id": "example-error",
                     *       "status": "error",
                     *       "data": null,
                     *       "warnings": [],
                     *       "error": {
                     *         "code": "DEADLINE_EXCEEDED",
                     *         "message": "超过总截止时间",
                     *         "details": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["Failure"];
                };
            };
        };
    };
    readContent: {
        parameters: {
            query?: never;
            header?: {
                /** @description 错误和警告文案的语言，传 zh-CN 或 en。缺省为中文。 */
                "Accept-Language"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ContentInput"];
            };
        };
        responses: {
            /** @description 单 URL 的 Markdown 和纯文本正文 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request_id": "example-content",
                     *       "status": "success",
                     *       "data": {
                     *         "url": "https://www.iana.org/help/example-domains",
                     *         "final_url": "https://www.iana.org/help/example-domains",
                     *         "title": "Example Domains",
                     *         "markdown": "IANA 保留示例域名。",
                     *         "text": "IANA 保留示例域名。",
                     *         "truncated": false,
                     *         "lengths": {
                     *           "markdown": {
                     *             "original": 12,
                     *             "retained": 12
                     *           },
                     *           "text": {
                     *             "original": 12,
                     *             "retained": 12
                     *           }
                     *         }
                     *       },
                     *       "warnings": [],
                     *       "error": null
                     *     }
                     */
                    "application/json": components["schemas"]["ContentResponse"];
                };
            };
            /** @description 参数或项目能力不满足 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request_id": "example-error",
                     *       "status": "error",
                     *       "data": null,
                     *       "warnings": [],
                     *       "error": {
                     *         "code": "INVALID_ARGUMENT",
                     *         "message": "参数或项目能力不满足",
                     *         "details": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["Failure"];
                };
            };
            /** @description 项目身份无效 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request_id": "example-error",
                     *       "status": "error",
                     *       "data": null,
                     *       "warnings": [],
                     *       "error": {
                     *         "code": "UNAUTHORIZED",
                     *         "message": "项目身份无效",
                     *         "details": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["Failure"];
                };
            };
            /** @description 输入字节超限 */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request_id": "example-error",
                     *       "status": "error",
                     *       "data": null,
                     *       "warnings": [],
                     *       "error": {
                     *         "code": "PAYLOAD_TOO_LARGE",
                     *         "message": "输入字节超限",
                     *         "details": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["Failure"];
                };
            };
            /** @description 速率或容量受限 */
            429: {
                headers: {
                    /** @description 有建议等待时间时返回秒数。 */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request_id": "example-error",
                     *       "status": "error",
                     *       "data": null,
                     *       "warnings": [],
                     *       "error": {
                     *         "code": "CAPACITY_EXHAUSTED",
                     *         "message": "速率或容量受限",
                     *         "details": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["Failure"];
                };
            };
            /** @description 内部错误 */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request_id": "example-error",
                     *       "status": "error",
                     *       "data": null,
                     *       "warnings": [],
                     *       "error": {
                     *         "code": "INTERNAL_ERROR",
                     *         "message": "内部错误",
                     *         "details": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["Failure"];
                };
            };
            /** @description 上游或输出协议失败 */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request_id": "example-error",
                     *       "status": "error",
                     *       "data": null,
                     *       "warnings": [],
                     *       "error": {
                     *         "code": "CONTENT_UNAVAILABLE",
                     *         "message": "上游或输出协议失败",
                     *         "details": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["Failure"];
                };
            };
            /** @description 依赖或代理不可用 */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request_id": "example-error",
                     *       "status": "error",
                     *       "data": null,
                     *       "warnings": [],
                     *       "error": {
                     *         "code": "SERVICE_UNAVAILABLE",
                     *         "message": "依赖或代理不可用",
                     *         "details": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["Failure"];
                };
            };
            /** @description 超过总截止时间 */
            504: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request_id": "example-error",
                     *       "status": "error",
                     *       "data": null,
                     *       "warnings": [],
                     *       "error": {
                     *         "code": "DEADLINE_EXCEEDED",
                     *         "message": "超过总截止时间",
                     *         "details": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["Failure"];
                };
            };
        };
    };
    summarizeSearch: {
        parameters: {
            query?: never;
            header?: {
                /** @description 错误和警告文案的语言，传 zh-CN 或 en。缺省为中文。 */
                "Accept-Language"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SummaryInput"];
            };
        };
        responses: {
            /** @description 检索、打分、分段摘要与整体总结 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request_id": "example-summary",
                     *       "status": "success",
                     *       "data": {
                     *         "summary": "雨量计以毫米记录累积降水。",
                     *         "sources": [
                     *           {
                     *             "id": "s1",
                     *             "url": "https://example.org/rain",
                     *             "title": "雨量计",
                     *             "score": 91,
                     *             "kind": "body",
                     *             "segments": [
                     *               {
                     *                 "id": "p1",
                     *                 "summary": "记录累积降水，单位为毫米。"
                     *               }
                     *             ]
                     *           }
                     *         ],
                     *         "citations": [
                     *           {
                     *             "source_id": "s1",
                     *             "segment_id": "p1"
                     *           }
                     *         ]
                     *       },
                     *       "warnings": [],
                     *       "error": null
                     *     }
                     */
                    "application/json": components["schemas"]["SummaryResponse"];
                };
            };
            /** @description 参数或项目能力不满足 */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request_id": "example-error",
                     *       "status": "error",
                     *       "data": null,
                     *       "warnings": [],
                     *       "error": {
                     *         "code": "INVALID_ARGUMENT",
                     *         "message": "参数或项目能力不满足",
                     *         "details": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["Failure"];
                };
            };
            /** @description 项目身份无效 */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request_id": "example-error",
                     *       "status": "error",
                     *       "data": null,
                     *       "warnings": [],
                     *       "error": {
                     *         "code": "UNAUTHORIZED",
                     *         "message": "项目身份无效",
                     *         "details": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["Failure"];
                };
            };
            /** @description 输入字节超限 */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request_id": "example-error",
                     *       "status": "error",
                     *       "data": null,
                     *       "warnings": [],
                     *       "error": {
                     *         "code": "PAYLOAD_TOO_LARGE",
                     *         "message": "输入字节超限",
                     *         "details": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["Failure"];
                };
            };
            /** @description 速率或容量受限 */
            429: {
                headers: {
                    /** @description 有建议等待时间时返回秒数。 */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request_id": "example-error",
                     *       "status": "error",
                     *       "data": null,
                     *       "warnings": [],
                     *       "error": {
                     *         "code": "CAPACITY_EXHAUSTED",
                     *         "message": "速率或容量受限",
                     *         "details": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["Failure"];
                };
            };
            /** @description 内部错误 */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request_id": "example-error",
                     *       "status": "error",
                     *       "data": null,
                     *       "warnings": [],
                     *       "error": {
                     *         "code": "INTERNAL_ERROR",
                     *         "message": "内部错误",
                     *         "details": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["Failure"];
                };
            };
            /** @description 上游或输出协议失败 */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request_id": "example-error",
                     *       "status": "error",
                     *       "data": null,
                     *       "warnings": [],
                     *       "error": {
                     *         "code": "MODEL_FAILED",
                     *         "message": "上游或输出协议失败",
                     *         "details": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["Failure"];
                };
            };
            /** @description 依赖或代理不可用 */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request_id": "example-error",
                     *       "status": "error",
                     *       "data": null,
                     *       "warnings": [],
                     *       "error": {
                     *         "code": "SERVICE_UNAVAILABLE",
                     *         "message": "依赖或代理不可用",
                     *         "details": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["Failure"];
                };
            };
            /** @description 超过总截止时间 */
            504: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "request_id": "example-error",
                     *       "status": "error",
                     *       "data": null,
                     *       "warnings": [],
                     *       "error": {
                     *         "code": "DEADLINE_EXCEEDED",
                     *         "message": "超过总截止时间",
                     *         "details": null
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["Failure"];
                };
            };
        };
    };
}
