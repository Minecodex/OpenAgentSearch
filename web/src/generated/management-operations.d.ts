import type { paths } from "./management-paths";
import type { webhooks } from "./management-webhooks";
import type { components } from "./management-components";
import type { $defs } from "./management-$defs";
export interface operations {
    runtimeDiagnostics: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 调度、组件健康与进程内计数；不参与业务路由。 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["runtime-diagnostics.schema"];
                };
            };
        };
    };
    getSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 恢复会话 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["Session"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    login: {
        parameters: {
            query?: never;
            header: {
                Origin: components["parameters"]["SameOriginHeader"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Login"];
            };
        };
        responses: {
            /** @description 登录 */
            200: {
                headers: {
                    /** @description 设置或清除 HttpOnly 管理会话。 */
                    "Set-Cookie"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["Session"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    logout: {
        parameters: {
            query?: never;
            header: {
                Origin: components["parameters"]["SameOriginHeader"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 注销 */
            200: {
                headers: {
                    /** @description 设置或清除 HttpOnly 管理会话。 */
                    "Set-Cookie"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: null;
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    getHistoryRetention: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["HistoryRetention"];
            default: components["responses"]["Failure"];
        };
    };
    updateHistoryRetention: {
        parameters: {
            query?: never;
            header: {
                Origin: components["parameters"]["SameOriginHeader"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RetentionWrite"];
            };
        };
        responses: {
            200: components["responses"]["HistoryRetention"];
            /** @description expected_version 与当前设置版本不匹配。 */
            409: components["responses"]["Failure"];
            default: components["responses"]["Failure"];
        };
    };
    listProject: {
        parameters: {
            query?: {
                limit?: components["parameters"]["Limit"];
                cursor?: components["parameters"]["Cursor"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 分页查询项目 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: {
                            items: components["schemas"]["ProjectView"][];
                            next_cursor: string | null;
                        };
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    createProject: {
        parameters: {
            query?: never;
            header: {
                Origin: components["parameters"]["SameOriginHeader"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProjectCreate"];
            };
        };
        responses: {
            /** @description 创建项目 */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["ProjectCreated"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    getProject: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["ConfigId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 读取项目 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["ProjectView"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    updateProject: {
        parameters: {
            query?: never;
            header: {
                Origin: components["parameters"]["SameOriginHeader"];
            };
            path: {
                id: components["parameters"]["ConfigId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProjectUpdate"];
            };
        };
        responses: {
            /** @description 更新项目 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["ProjectView"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    listEndpoint: {
        parameters: {
            query?: {
                limit?: components["parameters"]["Limit"];
                cursor?: components["parameters"]["Cursor"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 分页查询接入点 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: {
                            items: components["schemas"]["EndpointView"][];
                            next_cursor: string | null;
                        };
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    createEndpoint: {
        parameters: {
            query?: never;
            header: {
                Origin: components["parameters"]["SameOriginHeader"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EndpointCreate"];
            };
        };
        responses: {
            /** @description 创建接入点 */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["EndpointView"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    getEndpoint: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["ConfigId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 读取接入点 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["EndpointView"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    updateEndpoint: {
        parameters: {
            query?: never;
            header: {
                Origin: components["parameters"]["SameOriginHeader"];
            };
            path: {
                id: components["parameters"]["ConfigId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EndpointUpdate"];
            };
        };
        responses: {
            /** @description 更新接入点 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["EndpointView"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    deleteEndpoint: {
        parameters: {
            query: {
                expected_version: components["parameters"]["ExpectedVersion"];
            };
            header: {
                Origin: components["parameters"]["SameOriginHeader"];
            };
            path: {
                id: components["parameters"]["ConfigId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 检查引用并归档接入点 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["Deleted"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    testEndpoint: {
        parameters: {
            query?: never;
            header: {
                Origin: components["parameters"]["SameOriginHeader"];
            };
            path: {
                id: components["parameters"]["ConfigId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 测试已保存的接入点 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["TestResult"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    listProxy: {
        parameters: {
            query?: {
                limit?: components["parameters"]["Limit"];
                cursor?: components["parameters"]["Cursor"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 分页查询VPN 代理 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: {
                            items: components["schemas"]["ProxyView"][];
                            next_cursor: string | null;
                        };
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    createProxy: {
        parameters: {
            query?: never;
            header: {
                Origin: components["parameters"]["SameOriginHeader"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProxyCreate"];
            };
        };
        responses: {
            /** @description 创建VPN 代理 */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["ProxyView"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    getProxy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["ConfigId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 读取VPN 代理 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["ProxyView"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    updateProxy: {
        parameters: {
            query?: never;
            header: {
                Origin: components["parameters"]["SameOriginHeader"];
            };
            path: {
                id: components["parameters"]["ConfigId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProxyUpdate"];
            };
        };
        responses: {
            /** @description 更新VPN 代理 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["ProxyView"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    deleteProxy: {
        parameters: {
            query: {
                expected_version: components["parameters"]["ExpectedVersion"];
            };
            header: {
                Origin: components["parameters"]["SameOriginHeader"];
            };
            path: {
                id: components["parameters"]["ConfigId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 检查引用并归档VPN 代理 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["Deleted"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    testProxy: {
        parameters: {
            query?: never;
            header: {
                Origin: components["parameters"]["SameOriginHeader"];
            };
            path: {
                id: components["parameters"]["ConfigId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 测试已保存的VPN 代理 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["TestResult"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    listPool: {
        parameters: {
            query?: {
                limit?: components["parameters"]["Limit"];
                cursor?: components["parameters"]["Cursor"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 分页查询代理池 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: {
                            items: components["schemas"]["PoolView"][];
                            next_cursor: string | null;
                        };
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    createPool: {
        parameters: {
            query?: never;
            header: {
                Origin: components["parameters"]["SameOriginHeader"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PoolCreate"];
            };
        };
        responses: {
            /** @description 创建代理池 */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["PoolView"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    getPool: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["ConfigId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 读取代理池 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["PoolView"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    updatePool: {
        parameters: {
            query?: never;
            header: {
                Origin: components["parameters"]["SameOriginHeader"];
            };
            path: {
                id: components["parameters"]["ConfigId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PoolUpdate"];
            };
        };
        responses: {
            /** @description 更新代理池 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["PoolView"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    deletePool: {
        parameters: {
            query: {
                expected_version: components["parameters"]["ExpectedVersion"];
            };
            header: {
                Origin: components["parameters"]["SameOriginHeader"];
            };
            path: {
                id: components["parameters"]["ConfigId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 检查引用并归档代理池 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["Deleted"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    rotateProjectKey: {
        parameters: {
            query?: never;
            header: {
                Origin: components["parameters"]["SameOriginHeader"];
            };
            path: {
                id: components["parameters"]["ConfigId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Version"];
            };
        };
        responses: {
            /** @description 轮换项目 Key */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["KeyUpdate"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    getLanguageRoutes: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 读取语言优先映射 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["LanguageRoutes"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    putLanguageRoutes: {
        parameters: {
            query?: never;
            header: {
                Origin: components["parameters"]["SameOriginHeader"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LanguageWrite"];
            };
        };
        responses: {
            /** @description 替换语言优先映射 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["LanguageRoutes"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    debugList: {
        parameters: {
            query?: never;
            header: {
                Origin: components["parameters"]["SameOriginHeader"];
            };
            path: {
                id: components["parameters"]["ConfigId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ListInput"];
            };
        };
        responses: {
            /** @description 按项目调试 List */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ListResponse"];
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    debugContent: {
        parameters: {
            query?: never;
            header: {
                Origin: components["parameters"]["SameOriginHeader"];
            };
            path: {
                id: components["parameters"]["ConfigId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ContentInput"];
            };
        };
        responses: {
            /** @description 按项目调试 Content */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ContentResponse"];
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    debugSummary: {
        parameters: {
            query?: never;
            header: {
                Origin: components["parameters"]["SameOriginHeader"];
            };
            path: {
                id: components["parameters"]["ConfigId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SummaryInput"];
            };
        };
        responses: {
            /** @description 按项目调试 Summary */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SummaryResponse"];
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    listRequests: {
        parameters: {
            query?: {
                limit?: components["parameters"]["Limit"];
                cursor?: components["parameters"]["Cursor"];
                from?: components["parameters"]["From"];
                to?: components["parameters"]["To"];
                project_id?: components["parameters"]["ProjectId"];
                origin?: components["parameters"]["CallOrigin"];
                operation?: components["parameters"]["Operation"];
                status?: components["parameters"]["Status"];
                q?: components["parameters"]["Q"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 查询请求记录 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: {
                            items: components["schemas"]["RequestRecord"][];
                            next_cursor: string | null;
                        };
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    aggregateRequests: {
        parameters: {
            query?: {
                from?: components["parameters"]["From"];
                to?: components["parameters"]["To"];
                project_id?: components["parameters"]["ProjectId"];
                origin?: components["parameters"]["CallOrigin"];
                operation?: components["parameters"]["Operation"];
                status?: components["parameters"]["Status"];
                q?: components["parameters"]["Q"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 全窗请求汇总 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["request-aggregates.schema"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    getRequestDetail: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["RecordId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 请求概况 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["RequestDetail"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    cancelRequest: {
        parameters: {
            query?: never;
            header: {
                Origin: components["parameters"]["SameOriginHeader"];
            };
            path: {
                id: components["parameters"]["RecordId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 已通知在途执行取消，cancelled 为 false 表示请求已结束。 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: {
                            cancelled: boolean;
                        };
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    getEvidence: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["RecordId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 请求来源与分段 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["Evidence"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    getSpanDetail: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["RecordId"];
                span_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 请求单步载荷 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["SpanDetail"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    getReplayLayout: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["RecordId"];
                material_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 归档的静态布局，包含可用的样式和资源。 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["replay-layout.schema"];
                    };
                };
            };
            /** @description 请求或材料不可见，或该材料没有可读布局。 */
            404: components["responses"]["Failure"];
            /** @description 已核验归属并确认请求及布局均已达到创建时固定的到期时刻。 */
            410: components["responses"]["Failure"];
            default: components["responses"]["Failure"];
        };
    };
    getExport: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["RecordId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 请求脱敏导出 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["Export"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    listCalls: {
        parameters: {
            query?: {
                limit?: components["parameters"]["Limit"];
                cursor?: components["parameters"]["Cursor"];
                from?: components["parameters"]["From"];
                to?: components["parameters"]["To"];
                project_id?: components["parameters"]["ProjectId"];
                kind?: components["parameters"]["Capability"];
                language?: components["parameters"]["BusinessLanguage"];
                status?: components["parameters"]["CallStatus"];
                evaluation?: components["parameters"]["Evaluation"];
                q?: components["parameters"]["Q"];
                operation?: components["parameters"]["Operation"];
                origin?: components["parameters"]["CallOrigin"];
                endpoint_id?: components["parameters"]["EndpointId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 查询上游尝试 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: {
                            items: components["schemas"]["endpoint-call.schema"][];
                            next_cursor: string | null;
                        };
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    getCall: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["RecordId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 调用详情 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["endpoint-call.schema"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    getStatistics: {
        parameters: {
            query?: {
                from?: components["parameters"]["From"];
                to?: components["parameters"]["To"];
                project_id?: components["parameters"]["ProjectId"];
                kind?: components["parameters"]["Capability"];
                language?: components["parameters"]["BusinessLanguage"];
                operation?: components["parameters"]["Operation"];
                origin?: components["parameters"]["CallOrigin"];
                endpoint_id?: components["parameters"]["EndpointId"];
                timezone?: string;
                granularity?: "hour" | "day" | "week" | "month";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 按窗口聚合 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["statistics.schema"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    healthLive: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 探针状态 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Live"];
                };
            };
        };
    };
    healthReady: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 探针状态 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Ready"];
                };
            };
            /** @description 尚未就绪 */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Ready"];
                };
            };
        };
    };
    cacheOverview: {
        parameters: {
            query?: {
                project?: string;
                origin?: string;
                operation?: string;
                since?: number;
                until?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 缓存管理结果。 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["CacheOverview"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    cacheTasks: {
        parameters: {
            query?: {
                project?: string;
                origin?: string;
                operation?: string;
                since?: number;
                until?: number;
                state?: string;
                kind?: string;
                cursor?: number;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 缓存管理结果。 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["CacheTasks"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    cacheTask: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 缓存管理结果。 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["CacheTask"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    getCacheConcurrency: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 缓存管理结果。 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["CacheConcurrencyView"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    putCacheConcurrency: {
        parameters: {
            query?: never;
            header: {
                Origin: components["parameters"]["SameOriginHeader"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CacheConcurrencyWrite"];
            };
        };
        responses: {
            /** @description 缓存管理结果。 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["CacheConcurrencyView"];
                    };
                };
            };
            409: components["responses"]["Failure"];
            default: components["responses"]["Failure"];
        };
    };
    getCachePolicy: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 缓存管理结果。 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["CachePolicyView"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    putCachePolicy: {
        parameters: {
            query?: never;
            header: {
                Origin: components["parameters"]["SameOriginHeader"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CachePolicyWrite"];
            };
        };
        responses: {
            /** @description 缓存管理结果。 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["CachePolicyView"];
                    };
                };
            };
            409: components["responses"]["Failure"];
            default: components["responses"]["Failure"];
        };
    };
    getCacheModelBudget: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 缓存管理结果。 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["CacheModelBudgetView"];
                    };
                };
            };
            default: components["responses"]["Failure"];
        };
    };
    putCacheModelBudget: {
        parameters: {
            query?: never;
            header: {
                Origin: components["parameters"]["SameOriginHeader"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CacheModelBudgetWrite"];
            };
        };
        responses: {
            /** @description 缓存管理结果。 */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminEnvelope"] & {
                        data?: components["schemas"]["CacheModelBudgetView"];
                    };
                };
            };
            409: components["responses"]["Failure"];
            default: components["responses"]["Failure"];
        };
    };
}
