export const API = "http://127.0.0.1:8787";
export const isExtension =
  typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
export async function api<T>(
  path: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(API + path, {
      method: body === undefined ? "GET" : method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error(
      "服务未启动。请双击项目文件夹中的「启动 Frame.cmd」，然后重试。",
    );
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}
export const assetUrl = (path: string | null) => (path ? API + path : "");
