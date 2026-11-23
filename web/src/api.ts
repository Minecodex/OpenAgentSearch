import type { components } from "./generated/management";
export type Session = components["schemas"]["Session"];
export type Entity = Record<string, any>;
export interface Envelope<T = any> {
  request_id: string;
  status: string;
  data: T;
  warnings: Entity[];
  error: { code: string; message: string; details?: Entity } | null;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Entity,
  ) {
    super(message);
  }
}
let csrf = "",
  language = "zh";
export function configure(session?: Session, lang?: string) {
  csrf = session?.csrf_token || "";
  if (lang) language = lang;
}
export async function raw<T = any>(
  path: string,
  init: RequestInit = {},
  received?: (status: number) => void,
): Promise<Envelope<T>> {
  const headers = new Headers(init.headers);
  headers.set("Accept-Language", language);
  if (init.body) headers.set("Content-Type", "application/json");
  if (init.method && init.method !== "GET") headers.set("X-CSRF-Token", csrf);
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });
  received?.(response.status);
  const result: Envelope<T> = await response.json();
  if (!response.ok || result.error) {
    if(response.status===401)window.dispatchEvent(new Event('oas-session-expired'));
    const error = result.error;
    throw new ApiError(
      response.status,
      error?.code || "HTTP_ERROR",
      error?.message || response.statusText,
      error?.details,
    );
  }
  return result;
}
export async function api<T = any>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return (await raw<T>(path, init)).data;
}
export async function collect(kind: string): Promise<Entity[]> {
  return collectPath('/admin/v1/'+kind);
}
export async function collectPath(path:string):Promise<Entity[]>{
  const items: Entity[] = [];
  let cursor: string | null = null;
  const seen=new Set<string>();
  do {
    const url=new URL(path,location.origin);url.searchParams.set("limit","100");
    if(cursor)url.searchParams.set("cursor",cursor);
    const result:{items:Entity[];next_cursor:string|null}=await api(url.pathname+url.search);
    items.push(...result.items);
    cursor = result.next_cursor;
    if(cursor){if(seen.has(cursor))throw new ApiError(502,"PAGINATION_INVALID","Invalid page cursor");seen.add(cursor);}
  } while (cursor);
  return items;
}
export function write(path: string, body: Entity, method = "POST") {
  return api(path, { method, body: JSON.stringify(body) });
}
