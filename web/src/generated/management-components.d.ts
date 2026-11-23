import type { paths } from "./management-paths";
import type { webhooks } from "./management-webhooks";
import type { $defs } from "./management-$defs";
import type { operations } from "./management-operations";
export interface components {
    schemas: {
        RetentionView: {
            /** @default 7 */
            retention_days: number;
            version: number;
        };
        RetentionWrite: {
            retention_days: number;
            expected_version: number;
        };
        /** @description 初始管理员在安装时配置，默认 admin / admin123；登录不会重新初始化账号。 */
        Login: {
            username: string;
            password: string;
        };
        Session: {
            /** @description 管理界面的显示语言。 */
            supported_languages?: string[];
            username: string;
            /** Format: date-time */
            expires_at: string;
            csrf_token: string;
        };
        Version: {
            expected_version: number;
        };
        KeyUpdate: {
            api_key: string;
            version: number;
        };
        Deleted: {
            /** Format: uuid */
            id: string;
        };
        TestResult: {
            diagnostics?: components["schemas"]["proxy-test.schema"];
            /**
             * Format: date-time
             * @description 测试发起时间，同版本的迟到回执按它判断先后。
             */
            started_at?: string;
            resource_version: number;
            /** @description 关联的管理测试记录 ID。 */
            trace_request_id?: string;
            /** @description 内置搜索测试中已发送的引擎尝试，按派发顺序列出。 */
            search_attempts?: {
                /** @enum {unknown} */
                engine: "google" | "baidu";
                /** @enum {unknown} */
                status: "success" | "empty" | "partial" | "error" | "cancelled";
                reason: string | null;
                /** Format: uuid */
                call_id: string;
            }[];
            /** @enum {string} */
            status: "success" | "error";
            /** Format: date-time */
            tested_at: string;
            elapsed_ms: number;
            reason: string | null;
        };
        ProxyCreate: {
            name: string;
            /** @enum {string} */
            scheme: "socks5" | "https";
            host: string;
            port: number;
            /** @enum {string} */
            auth_mode: "none" | "password";
            max_concurrency: number;
            enabled: boolean;
            secret?: {
                username: string;
                password: string;
            };
        };
        ProxyUpdate: {
            name: string;
            /** @enum {string} */
            scheme: "socks5" | "https";
            host: string;
            port: number;
            /** @enum {string} */
            auth_mode: "none" | "password";
            max_concurrency: number;
            enabled: boolean;
            expected_version: number;
            /** @enum {string} */
            secret_action: "keep" | "replace" | "clear";
            secret?: {
                username: string;
                password: string;
            };
        } & (unknown & unknown);
        ProxyView: {
            google_probe: components["schemas"]["google-reachability.schema"];
            name: string;
            /** @enum {string} */
            scheme: "socks5" | "https";
            host: string;
            port: number;
            /** @enum {string} */
            auth_mode: "none" | "password";
            max_concurrency: number;
            enabled: boolean;
            /** Format: uuid */
            id: string;
            version: number;
            has_secret: boolean;
            /** @enum {string} */
            health: "unknown" | "healthy" | "degraded" | "cooling" | "probing" | "disabled";
            failure_count?: number;
            health_backoff?: number;
            health_revision?: number;
            /** Format: date-time */
            cooldown_until?: string | null;
            /** Format: date-time */
            last_health_check?: string | null;
            health_reason?: string | null;
            active_leases: number;
            last_test: components["schemas"]["TestResult"] | null;
        };
        PoolCreate: {
            name: string;
            members: {
                /** Format: uuid */
                proxy_id: string;
                weight: number;
            }[];
        };
        PoolUpdate: {
            name: string;
            members: {
                /** Format: uuid */
                proxy_id: string;
                weight: number;
            }[];
            expected_version: number;
        };
        PoolView: {
            name: string;
            members: {
                /** Format: uuid */
                proxy_id: string;
                weight: number;
            }[];
            /** Format: uuid */
            id: string;
            version: number;
        };
        /** @enum {string} */
        EndpointProvider: "browser" | "tavily" | "searxng" | "anysearch" | "deepseek" | "crawl4ai" | "openai_compatible";
        EndpointAdapterRules: components["schemas"]["endpoint-provider.schema"] & unknown & unknown & unknown & unknown & unknown & unknown & unknown & unknown & unknown & unknown;
        EndpointCreate: {
            name: string;
            /** @enum {string} */
            kind: "search" | "reader" | "model";
            provider: components["schemas"]["EndpointProvider"];
            /** @enum {string} */
            adapter: "http_search" | "integrated_search" | "browser_search" | "http_reader" | "browser_reader" | "chat_model";
            base_url?: string | null;
            timeout_ms: number;
            max_concurrency: number;
            rpm: number;
            options: {
                [key: string]: unknown;
            };
            secret?: {
                api_key: string;
            };
        } & components["schemas"]["EndpointAdapterRules"];
        EndpointUpdate: {
            name: string;
            /** @enum {string} */
            kind: "search" | "reader" | "model";
            provider: components["schemas"]["EndpointProvider"];
            /** @enum {string} */
            adapter: "http_search" | "integrated_search" | "browser_search" | "http_reader" | "browser_reader" | "chat_model";
            base_url?: string | null;
            timeout_ms: number;
            max_concurrency: number;
            rpm: number;
            options: {
                [key: string]: unknown;
            };
            expected_version: number;
            /** @enum {string} */
            secret_action: "keep" | "replace" | "clear";
            secret?: {
                api_key: string;
            };
        } & (components["schemas"]["EndpointAdapterRules"] & unknown);
        EndpointView: {
            /**
             * @description 内置 Firefox 能力、随 Helm 管理的可选组件或手工配置的原生接入点。
             * @enum {unknown}
             */
            managed_by: "system" | "helm" | "administrator";
            /**
             * @description 部署可用性。调度器还要检查当前容量、接入点风控和内置搜索所选出口的首测结果。
             * @enum {unknown}
             */
            availability: "available" | "no_ready_pods" | "component_disabled" | "component_unready";
            /** @description 当前能承接该内置能力的就绪 Firefox Pod 数。为零时保留能力 ID。 */
            ready_pods?: number;
            /** @description 所有 Firefox Pod 的默认网络共享的当前结果。 */
            default_network_google_probe?: components["schemas"]["sharedDefault"];
            name: string;
            /** @enum {string} */
            kind: "search" | "reader" | "model";
            provider: components["schemas"]["EndpointProvider"];
            /** @enum {string} */
            adapter: "http_search" | "integrated_search" | "browser_search" | "http_reader" | "browser_reader" | "chat_model";
            base_url?: string | null;
            timeout_ms: number;
            max_concurrency: number;
            rpm: number;
            options: {
                [key: string]: unknown;
            };
            /** Format: uuid */
            id: string;
            version: number;
            has_secret: boolean;
            last_test: components["schemas"]["TestResult"] | null;
        } & (components["schemas"]["EndpointAdapterRules"] & unknown & unknown & unknown & unknown);
        /** @description 绑定的代理池 ID。为 null 时 Firefox 使用该 Pod 的默认网络。 */
        BrowserProxyPoolRef: string | null;
        ProjectCreate: {
            name: string;
            search_pools: string[][];
            reader_pools: string[][];
            model_endpoint_id?: string | null;
            browser_proxy_pool_id?: components["schemas"]["BrowserProxyPoolRef"];
            search_limit?: number;
            source_limit?: number;
            body_limit?: number;
            summary_limit?: number;
            rewrite_count?: number;
            /**
             * @description 综合总结是否搜索原问题。关闭时 rewrite_count 至少为 1；原问题仍用于评分和总结，普通列表不受影响。
             * @default true
             */
            search_original_query: boolean;
            /**
             * @description 综合总结是否直接使用搜索列表标题和简介。开启后跳过正文获取和搜索随附正文，仍评分、按模型上下文总结并保留引用。reader_pools 可为空，单 URL 正文接口仍使用正文池。
             * @default false
             */
            summary_snippets_only: boolean;
            allow_snippets?: boolean;
        } & unknown;
        ProjectUpdate: {
            name: string;
            search_pools: string[][];
            reader_pools: string[][];
            model_endpoint_id: string | null;
            browser_proxy_pool_id: components["schemas"]["BrowserProxyPoolRef"];
            search_limit: number;
            source_limit: number;
            body_limit: number;
            summary_limit: number;
            rewrite_count: number;
            /**
             * @description 综合总结是否搜索原问题。关闭时 rewrite_count 至少为 1；原问题仍用于评分和总结，普通列表不受影响。
             * @default true
             */
            search_original_query: boolean;
            /**
             * @description 综合总结是否直接使用搜索列表标题和简介。开启后跳过正文获取和搜索随附正文，仍评分、按模型上下文总结并保留引用。reader_pools 可为空，单 URL 正文接口仍使用正文池。
             * @default false
             */
            summary_snippets_only: boolean;
            allow_snippets: boolean;
            expected_version: number;
        } & unknown;
        ProjectFields: {
            name: string;
            search_pools: string[][];
            reader_pools: string[][];
            model_endpoint_id: string | null;
            browser_proxy_pool_id: components["schemas"]["BrowserProxyPoolRef"];
            search_limit: number;
            source_limit: number;
            body_limit: number;
            summary_limit: number;
            rewrite_count: number;
            /**
             * @description 综合总结是否搜索原问题，省略时为 true。关闭时只检索 Q1 起的改写查询，原问题仍作为评分及总结依据。
             * @default true
             */
            search_original_query: boolean;
            /**
             * @description 综合总结是否直接使用搜索列表标题和简介。开启后跳过正文获取和搜索随附正文，仍评分、按模型上下文总结并保留引用。reader_pools 可为空，单 URL 正文接口仍使用正文池。
             * @default false
             */
            summary_snippets_only: boolean;
            allow_snippets: boolean;
            /** Format: uuid */
            id: string;
            version: number;
        } & unknown;
        ProjectView: components["schemas"]["ProjectFields"];
        /** @description 执行时保存的项目，历史快照可以包含当时的语言设置。 */
        RecordedProject: {
            default_language?: string;
            languages?: string[];
        } & components["schemas"]["ProjectFields"];
        ProjectCreated: {
            project: components["schemas"]["ProjectView"];
            api_key: string;
        };
        /** @description 业务语言支持标准语言标签，匹配时从完整标签逐级查找，缺省从第一池开始。首个命中池作为起始池，池内可用成员等权轮询，整池不可用时沿项目顺序向后尝试。 */
        LanguageRoutes: {
            version: number;
            entries: {
                language: string;
                endpoint_ids: string[];
            }[];
        };
        /** @description 每种语言的 endpoint_ids 是集合。成员所在的项目池顺序决定起始池。 */
        LanguageWrite: {
            expected_version: number;
            entries: {
                language: string;
                endpoint_ids: string[];
            }[];
        };
        RequestRecord: {
            /** @description 创建记录时生效的全局保留天数。 */
            retention_days: number;
            /** @description 创建记录时采用的全局保留设置版本。 */
            retention_version: number;
            /**
             * Format: date-time
             * @description 由 UTC 开始时间和创建时保留天数计算的固定截止时刻。
             */
            expires_at: string;
            request_id: string;
            project_id: string | null;
            operation: string;
            /** @enum {string} */
            status: "running" | "success" | "partial" | "empty" | "error" | "cancelled";
            /** Format: date-time */
            started_at: string;
            duration_ms: number;
            upstream_calls: number;
            model_calls: number;
            incomplete: boolean;
            /** @enum {unknown} */
            origin: "business" | "debug" | "endpoint_test" | "proxy_test";
            project_name: string | null;
            language: string | null;
            /** @description 问题或 URL。独立测试显示当时记录的资源名称。 */
            query_preview: string | null;
            /** @description 回答或正文摘要。独立测试返回回执原因码或测试状态。 */
            response_preview: string | null;
        };
        Span: {
            span_id: string;
            parent_id: string | null;
            stage: string;
            status: string;
            start_offset_ms: number;
            duration_ms: number;
        };
        RequestDetail: {
            execution_summary: components["schemas"]["request-execution.schema"];
            snapshot: components["schemas"]["TraceSnapshot"] | null;
            /** @description 授权范围内的脱敏输入。 */
            request_payload: Record<string, never> | null;
            /** @description 授权范围内的业务或测试响应。 */
            response_payload: Record<string, never> | null;
            metadata: components["schemas"]["RequestRecord"];
            spans: components["schemas"]["Span"][];
            config_version: number | null;
            incomplete_reasons: string[];
        };
        RewriteDiagnostics: {
            requested: number;
            used: number;
            /** @enum {unknown} */
            state: "used" | "fallback" | "failed";
            fallback_reason: string | null;
            search_original_query: boolean;
            entries: {
                query: string;
                /** @enum {unknown} */
                state: "used" | "duplicate_original" | "duplicate_rewrite" | "invalid" | "over_limit";
                variant_id?: string;
            }[];
        };
        SpanDetail: {
            span: components["schemas"]["Span"];
            input: unknown;
            output: unknown;
            diagnostics: {
                rewrite?: components["schemas"]["RewriteDiagnostics"];
            } & {
                [key: string]: unknown;
            };
            /** @description 按本阶段实际调用顺序返回获准查看的历史材料。没有相应调用时为空数组，缺失或过期的材料保留状态。 */
            replay: components["schemas"]["replay-material.schema"][];
        };
        ReplayMaterial: components["schemas"]["replay-material.schema"];
        TraceSnapshot: {
            project: components["schemas"]["RecordedProject"];
            routes_version: number;
            endpoints: {
                /** Format: uuid */
                id: string;
                name: string;
                version: number;
                /** @enum {unknown} */
                kind: "search" | "reader" | "model";
                adapter: string;
                provider?: components["schemas"]["EndpointProvider"] | null;
                timeout_ms: number;
                max_concurrency: number;
                rpm: number;
            }[];
        };
        TraceCandidate: {
            candidate_id: string;
            /** Format: uri */
            url: string;
            title: string;
            snippet_preview?: string | null;
            hits: {
                variant_id: string;
                call_id: string;
                /** Format: uri */
                url: string;
                rank: number;
            }[];
            relevant: boolean | null;
            score: number | null;
            score_batch_id?: string | null;
            score_call_id?: string | null;
            selected: boolean | null;
            selection_reason?: string | null;
            source_id: string | null;
            material_reason?: string;
            /** @enum {unknown} */
            material: "reader_body" | "inline_body" | "search_snippet" | "snippet" | null;
            reader_call_ids?: string[];
            article_preview?: string | null;
            lengths?: {
                text: components["schemas"]["Length"];
                markdown: components["schemas"]["Length"];
            };
        };
        Evidence: {
            variants: components["schemas"]["search-variant.schema"][];
            candidates: components["schemas"]["TraceCandidate"][];
            sources: {
                source_id: string;
                url: string;
                title: string;
                ranks: number[];
                variant_ids: string[];
                score: number | null;
            }[];
            segments: {
                source_id: string;
                segment_id: string;
                start_char: number;
                end_char: number;
                summary: string;
                cited: boolean;
                text_preview?: string | null;
            }[];
        };
        Export: {
            request: components["schemas"]["RequestDetail"];
            calls: components["schemas"]["endpoint-call.schema"][];
            evidence: components["schemas"]["Evidence"];
            payloads: components["schemas"]["SpanDetail"][];
        };
        Call: components["schemas"]["endpoint-call.schema"];
        Aggregates: components["schemas"]["request-aggregates.schema"];
        Metrics: {
            calls: number;
            successes: number;
            queue_ms: number;
            execution_ms: number;
            speed_samples: number;
            speed_ms: number;
            quality_numerator: number;
            quality_denominator: number;
            input_tokens?: number;
            output_tokens?: number;
            usage_samples?: number;
            p95_ms: number | null;
        };
        Statistics: components["schemas"]["statistics.schema"];
        Live: {
            /** @constant */
            status: "ok";
        };
        Ready: {
            /** @enum {string} */
            status: "ready" | "not_ready";
            components: {
                [key: string]: "ok" | "disabled" | "degraded" | "unavailable";
            };
        };
        AdminEnvelope: {
            request_id: string;
            /** @constant */
            status: "success";
            data: unknown;
            warnings: components["schemas"]["Message"][];
            error: null;
        };
        /** RuntimeDiagnosticsResponse */
        "runtime-diagnostics.schema": {
            request_id: string;
            /** @constant */
            status: "success";
            warnings: unknown[];
            error: null;
            data: {
                ready: boolean;
                schema_version: number | null;
                scheduler: {
                    stopping: boolean;
                    active_requests: number;
                    ready_workers: number;
                    recovering_workers: number;
                    active_leases: {
                        [key: string]: number;
                    };
                    reserved_rpm: {
                        [key: string]: number;
                    };
                };
                components: {
                    /** @enum {unknown} */
                    name: "searxng" | "crawl4ai";
                    /** @enum {unknown} */
                    availability: "available" | "component_unready" | "component_disabled";
                }[];
                diagnostics: {
                    dropped: number;
                    failed: number;
                    stored: number;
                    queue_remaining: number;
                };
            };
        };
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
        /** EndpointProviderBinding */
        "endpoint-provider.schema": {
            /** @constant */
            kind?: "search";
            /** @constant */
            provider?: "browser";
            /** @constant */
            adapter?: "browser_search";
        } | {
            /** @constant */
            kind?: "search";
            /** @enum {unknown} */
            provider?: "tavily" | "anysearch" | "deepseek";
            /** @enum {unknown} */
            adapter?: "http_search" | "integrated_search";
        } | {
            /** @constant */
            kind?: "search";
            /** @constant */
            provider?: "searxng";
            /** @constant */
            adapter?: "http_search";
        } | {
            /** @constant */
            kind?: "reader";
            /** @constant */
            provider?: "browser";
            /** @constant */
            adapter?: "browser_reader";
        } | {
            /** @constant */
            kind?: "reader";
            /** @enum {unknown} */
            provider?: "tavily" | "anysearch" | "crawl4ai" | "deepseek";
            /** @constant */
            adapter?: "http_reader";
        } | {
            /** @constant */
            kind?: "model";
            /** @constant */
            provider?: "openai_compatible";
            /** @constant */
            adapter?: "chat_model";
        };
        /**
         * GoogleReachability
         * @description 后台每 30 分钟检测一次。每条启用的 VPN 有独立样本，同一套部署的默认网络共用一份样本。时间为完成检测的 UTC 时刻。
         */
        "google-reachability.schema": {
            /** @description true 首选 Google，实际搜索遇到引擎故障时可切到百度。false 直接使用百度。null 表示待检测，暂不派发内置搜索。 */
            reachable: boolean | null;
            /** Format: date-time */
            checked_at: string | null;
            /** @description 产生这次已完成样本的 Pod UID。默认网络用它标识代表 Pod。 */
            probe_pod_uid?: string;
            $defs: {
                sharedDefault: components["schemas"]["google-reachability.schema"] & unknown;
            };
        };
        sharedDefault: components["schemas"]["google-reachability.schema"] & unknown;
        /** DiagnosticPhase */
        "phase.schema": {
            /** @enum {unknown} */
            stage: "allocate" | "context" | "execute" | "validate" | "navigate" | "extract" | "archive" | "cleanup" | "connect" | "handshake" | "response";
            /** @description 浏览器阶段按请求开始计偏移；代理测试按检测开始计偏移。worker 子阶段以 execute 开始对齐，存在单程通信误差。 */
            start_offset_ms: number;
            /** @description 由 source 指定的同一单调时钟测量。execute 是父阶段，不能与子阶段相加。 */
            duration_ms: number;
            /** @enum {unknown} */
            status: "success" | "error" | "cancelled";
            /** @enum {unknown} */
            source: "api" | "worker";
            /** @enum {unknown} */
            scope: "job" | "call";
            /** @constant */
            parent_stage?: "execute";
        };
        /** ProxyTestDiagnostics */
        "proxy-test.schema": {
            /** @description 已收到目标 HTTP 响应头且通过相应 TLS 校验，与是否符合预期响应分开。 */
            reachable: boolean;
            /** @description curl 正常完成，目标状态符合配置且可选正文标记匹配。 */
            passed: boolean;
            /** @description 有明确通道证据时给出代理自身健康；目标拒绝不等同代理故障。 */
            proxy_healthy: boolean | null;
            expected_status: number;
            http_status: number | null;
            /** @description 未配置正文标记时为 null，不返回标记文本或目标正文。 */
            body_matches: boolean | null;
            /** @enum {unknown} */
            failure_kind: "proxy_auth" | "proxy_tls" | "proxy_refused" | "proxy_dns" | "proxy_connect" | "proxy_protocol" | "target_connect" | "target_dns" | "target_tls" | "timeout" | "target_response" | "target_body" | "body_limit" | "response_incomplete" | null;
            total_ms: number;
            first_byte_ms: number | null;
            phases: components["schemas"]["phase.schema"][];
            /** Format: date-time */
            checked_at: string;
            probe_pod_uid: string;
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
        ContentInput: {
            /**
             * Format: uri
             * @description 要提取的单个公开 HTTP(S) 网页 URL。目标与重定向均须通过访问校验，禁止 URL 内凭据与内网地址。
             */
            url: string;
            /** @description 正文字符上限，正整数且不得超过项目 body_limit。省略使用项目值，初始为 40000。同时限制 Markdown 和纯文本并保留相同内容前缀，截断时附警告。 */
            max_chars?: number;
        };
        Length: {
            /** @description 截断前的字符数。 */
            original: number;
            /** @description 实际返回的字符数。 */
            retained: number;
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
        /** RequestAggregates */
        "request-aggregates.schema": {
            operations?: {
                list?: number;
                content?: number;
                summary?: number;
            };
            series?: {
                /** Format: date-time */
                from: string;
                list: number;
                content: number;
                summary: number;
            }[];
            /** Format: date-time */
            from: string;
            /** Format: date-time */
            to: string;
            requests: number;
            /** @description 已进入终态的请求数。 */
            completed: number;
            /** @description 返回 success、partial 或 empty 的已完成请求数。 */
            successful: number;
            /** @description 当前筛选窗口内来源为 business 的请求数。 */
            business_requests: number;
            partial: number;
            errors: number;
            average_duration_ms: number | null;
            upstream_calls: number;
            model_calls: number;
        };
        count: number | null;
        /** @description 仅含已发送的调用，按实际端点 ID 去重，保留首次派发顺序和当时名称。空数组表示未调用，null 表示调用归属缺失。 */
        usedEndpoints: {
            /** Format: uuid */
            endpoint_id: string;
            endpoint_name: string | null;
        }[] | null;
        /**
         * RequestExecutionSummary
         * @description 本次请求实际执行的检索、评分、材料与接入点摘要。
         */
        "request-execution.schema": {
            /** @description 列表和总结按实际发出的查询变体计数，原问题仅在参与搜索时计入。其他操作为 null。单项未知为 null，确知无命中为 0。 */
            retrieval: {
                variant_count: components["schemas"]["count"];
                completed_variants: number;
                incomplete_variants: number;
                /** @description 已完成分支的已知命中下界。 */
                known_raw_candidates: number;
                /** @description 已完成分支的已知去重下界。 */
                known_unique_candidates: number;
                raw_candidates: components["schemas"]["count"];
                unique_candidates: components["schemas"]["count"];
            } | null;
            /** @description 按首次派发顺序列逻辑评分批次。同批重试只计一次。已知未评分的总结返回空数组，不适用或批次未知返回 null。 */
            score_batches: {
                batch_id: string;
                candidate_count: components["schemas"]["count"];
            }[] | null;
            /**
             * @description 总结以最终引用的段判断正文、简介或混合。单 URL 正文用 body，成功的列表用 search_results。无结果用 none，测试或来源未知为 null。
             * @enum {unknown}
             */
            answer_source: "body" | "snippet" | "mixed" | "search_results" | "none" | null;
            endpoints: {
                search: components["schemas"]["usedEndpoints"];
                reader: components["schemas"]["usedEndpoints"];
                model: components["schemas"]["usedEndpoints"];
            };
            $defs: {
                count: number | null;
                /** @description 仅含已发送的调用，按实际端点 ID 去重，保留首次派发顺序和当时名称。空数组表示未调用，null 表示调用归属缺失。 */
                usedEndpoints: {
                    /** Format: uuid */
                    endpoint_id: string;
                    endpoint_name: string | null;
                }[] | null;
            };
        };
        /** SearchVariantEvidence */
        "search-variant.schema": {
            variant_id: string;
            query: string;
            /** @enum {unknown} */
            status: "pending" | "running" | "success" | "partial" | "error" | "cancelled";
            /** @description 已发送的该变体搜索尝试，按实际派发顺序。 */
            call_ids: string[];
            /** @description 交付本变体命中的调用，未知或未取得结果时为 null。 */
            result_call_id: string | null;
            /** @description 已完成分支即时保存。null 表示结果未知，空数组表示确知无命中。 */
            hits: {
                /** Format: uri */
                url: string;
                title: string;
                snippet: string;
                rank: number;
                call_id: string;
            }[] | null;
        };
        "character-lengths.schema": {
            text: components["schemas"]["Length"];
            markdown: components["schemas"]["Length"];
        };
        /**
         * ReplayMaterial
         * @description 同一请求内的执行快照，网页按实际取得的源格式保存，模型按实际发送与收到的 JSON 保存。认证信息在入库前剔除。
         */
        "replay-material.schema": {
            /** @description 请求内稳定且唯一的材料标识，同一个 call_id 可对应多篇网页。 */
            material_id: string;
            call_id: string;
            /** @description 已登记为本次请求来源时给出。 */
            source_id?: string;
            /** @enum {unknown} */
            kind: "webpage" | "model";
            /** @enum {unknown} */
            state: "complete" | "incomplete" | "expired";
            reason?: string;
            /** Format: uri */
            url?: string;
            /** Format: uri */
            final_url?: string;
            /** @description 归档材料的媒体类型，类型和子类型统一使用小写。 */
            media_type?: string;
            body?: string;
            /** @description 提取后完整规范文本，原文范围的 Unicode 标量坐标基准。 */
            text?: string;
            /** @description 同一文档树渲染的完整 Markdown。 */
            markdown?: string;
            lengths?: components["schemas"]["character-lengths.schema"];
            truncated?: boolean;
            segment_version?: string;
            /**
             * @description HTML 布局快照状态，与原始材料的 state 分开。
             * @enum {unknown}
             */
            layout_state?: "complete" | "partial" | "unavailable";
            model_input?: Record<string, never>;
            model_output?: Record<string, never>;
            /** @enum {unknown} */
            task?: "rewrite" | "score" | "segments" | "compress" | "synthesis";
            /** @description 模型消息版本；版本 4 起使用自然语言任务及参考材料块，用户消息保留原问题。 */
            prompt_version?: string;
            tokenizer?: string;
        } & (unknown & unknown & unknown & unknown & unknown & unknown & unknown);
        /**
         * ReplayLayout
         * @description 为一份归档 HTML 材料生成的静态预览。srcdoc 已净化，样式和可用资源均内嵌，只供隔离 iframe 显示。
         */
        "replay-layout.schema": {
            material_id: string;
            /** @enum {unknown} */
            state: "complete" | "partial";
            srcdoc: string;
            missing_resource_count: number;
            /** @description 部分布局未能归档的原因。 */
            reason?: string;
            /** @description 当时已知的浏览器视口，以 CSS 像素计。 */
            viewport?: {
                width: number;
                height: number;
            };
        };
        /** BrowserJob */
        "browser-job.schema": {
            job_id: string;
            pod_name: string;
            /** @description 实际执行本作业的 Pod UID。 */
            pod_uid: string;
            /** @enum {unknown} */
            egress_mode: "default_network" | "proxy";
            /** @description 本次派发已采用的有效样本，可达与已测不可达均有检测完成时间。 */
            google_probe?: components["schemas"]["google-reachability.schema"] & {
                reachable?: boolean;
            };
            /**
             * @description 本条已派发调用使用的引擎。
             * @enum {unknown}
             */
            search_engine?: "google" | "baidu";
            engine_selection?: {
                /** @constant */
                reason: "google_cooldown";
                /** @enum {unknown} */
                failure_code: "ENDPOINT_RISK_CONTROL" | "SEARCH_ENGINE_UNAVAILABLE" | "SEARCH_RESULTS_UNAVAILABLE" | "UPSTREAM_TIMEOUT";
                /** Format: date-time */
                retry_at: string;
            };
            /** @description 本作业从 Google 切到百度的依据。call_id 指向同一作业触发切换的 Google 调用。 */
            engine_fallback?: {
                /** @constant */
                from: "google";
                /** @enum {unknown} */
                reason: "ENDPOINT_RISK_CONTROL" | "SEARCH_ENGINE_UNAVAILABLE" | "SEARCH_RESULTS_UNAVAILABLE" | "UPSTREAM_TIMEOUT";
                /** Format: uuid */
                call_id: string;
            };
            /** Format: uuid */
            pool_id?: string;
            pool_name?: string;
            /** Format: uuid */
            proxy_id?: string;
            proxy_version?: number;
            proxy_name?: string;
            /** @enum {unknown} */
            scheme?: "socks5" | "https";
            /** @description 是否在同一逻辑调用的后续尝试中复用浏览器作业；不同查询和网页分别持有独立作业。 */
            reused_context: boolean;
            phases: components["schemas"]["phase.schema"][];
        } & (unknown & unknown & unknown & unknown);
        /** EndpointCall */
        "endpoint-call.schema": {
            stage?: string;
            /** @description 发送前对完整提示词的计数。 */
            estimated_input_tokens?: number;
            /** @description 上游确认的实际输入 Token；未提供时省略。 */
            input_tokens?: number;
            /** @description 上游确认的实际输出 Token；未提供时省略。 */
            output_tokens?: number;
            browser_job?: components["schemas"]["browser-job.schema"];
            call_id: string;
            candidate_id?: string;
            source_id?: string;
            /** @description 执行或结果验证失败原因；不与路由 reason 混用。 */
            error_code?: string;
            span_id?: string | null;
            /** @description 本次检索尝试所属的查询变体。 */
            variant_id?: string;
            /** @description 本次评分尝试所属的逻辑批次，重试沿用同一 ID。 */
            score_batch_id?: string;
            /** Format: uuid */
            project_id?: string | null;
            endpoint_name?: string | null;
            /** @enum {unknown} */
            kind?: "search" | "reader" | "model";
            language?: string | null;
            /** Format: date-time */
            started_at?: string;
            /** Format: date-time */
            finished_at?: string;
            input_preview?: string | null;
            /** @enum {unknown} */
            evaluation?: "complete" | "incomplete" | "unscored" | "no_candidates" | "received" | "missing" | "model";
            candidates?: number | null;
            evaluated?: number | null;
            relevant?: number | null;
            retained_chars?: number | null;
            request_id: string;
            endpoint_id: string | null;
            endpoint_version: number | null;
            operation: string;
            /** @enum {string} */
            origin: "business" | "debug" | "endpoint_test" | "proxy_test";
            queue_ms: number;
            execution_ms: number;
            sent: boolean;
            status: string;
            /** @description 本次派发的选择原因。primary 表示项目首池，language 表示语言命中池，fallback 表示后续池，direct 表示直接指定接入点。 */
            reason: string | null;
            /** @description 本次派发所在的项目池序号，从 1 开始。 */
            pool_priority?: number;
            /**
             * @description 接入点级风控或暂时不可用，仅在实际发生时记录。
             * @enum {string}
             */
            endpoint_failure?: "risk" | "unavailable";
            proxy_id?: string | null;
            proxy_version?: number | null;
        } & (unknown & unknown & unknown & unknown);
        /** Statistics */
        "statistics.schema": {
            /** Format: date-time */
            from: string;
            /** Format: date-time */
            to: string;
            timezone: string;
            overview: components["schemas"]["Metrics"];
            series: {
                /** Format: date-time */
                from: string;
                /** Format: date-time */
                to: string;
                metrics: components["schemas"]["Metrics"];
            }[];
            endpoints: {
                /** Format: uuid */
                endpoint_id: string;
                version: number;
                metrics: components["schemas"]["Metrics"];
                name?: string;
            }[];
            $defs: {
                Metrics: {
                    calls: number;
                    successes: number;
                    queue_ms: number;
                    execution_ms: number;
                    speed_samples: number;
                    speed_ms: number;
                    quality_numerator: number;
                    quality_denominator: number;
                    input_tokens?: number;
                    output_tokens?: number;
                    usage_samples?: number;
                    p95_ms: number | null;
                };
            };
        };
    };
    responses: {
        /** @description 全局唯一的保留设置，应用于随后新建的请求、所属材料及统计贡献，既有记录按创建时固定的到期时间处理。 */
        HistoryRetention: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["AdminEnvelope"] & {
                    data?: components["schemas"]["RetentionView"];
                };
            };
        };
        /** @description 分类错误及本地化文案。 */
        Failure: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Failure"];
            };
        };
    };
    parameters: {
        SameOriginHeader: string;
        Limit: number;
        Cursor: string;
        ConfigId: string;
        ExpectedVersion: number;
        From: string;
        To: string;
        ProjectId: string;
        Operation: string;
        Status: "running" | "success" | "partial" | "empty" | "error" | "cancelled";
        Q: string;
        RecordId: string;
        CallOrigin: "business" | "debug" | "endpoint_test" | "proxy_test";
        Capability: "search" | "reader" | "model";
        BusinessLanguage: string;
        CallStatus: "success" | "partial" | "empty" | "error" | "cancelled";
        Evaluation: "complete" | "incomplete" | "unscored" | "no_candidates" | "received" | "missing" | "model";
        EndpointId: string;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
