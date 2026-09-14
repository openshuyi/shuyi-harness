/**
 * 统一的前端 API 取数辅助：校验 HTTP 状态码，
 * 避免把错误响应（如代理/扩展拦截产生的 421 HTML 页）当作业务数据渲染。
 */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`请求失败：${res.status} ${res.statusText}（${url}）`);
  }
  return (await res.json()) as T;
}

/** 期望数组返回的接口：非数组（错误页/异常结构）视为取数失败 */
export async function fetchJsonArray<T>(url: string): Promise<T[]> {
  const data = await fetchJson<unknown>(url);
  if (!Array.isArray(data)) {
    throw new Error(`服务返回了非预期的数据格式（${url}）`);
  }
  return data as T[];
}
