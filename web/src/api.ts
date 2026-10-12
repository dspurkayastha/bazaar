export class ApiError extends Error {
  status: number;
  code: string;
  /** Extra fields the server may attach (e.g. attempts left). */
  extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

/** Plain-words messages for statuses; the server's own message is used when it is more specific. */
export function friendlyMessage(status: number, serverMessage?: string): string {
  switch (status) {
    case 401:
      return 'Please sign in again.';
    case 403:
      return serverMessage || 'Only the household owner can do that.';
    case 404:
      return serverMessage || 'That no longer exists.';
    case 409:
      return serverMessage || 'That changed while you were looking. Refresh and try again.';
    case 423:
      return 'PIN approvals are locked for now after too many wrong tries. Try again in 15 minutes.';
    case 429:
      return 'Too many requests. Wait a moment and try again.';
    default:
      return status >= 500
        ? 'Bazaar had a problem on its side. Try again in a moment.'
        : serverMessage || 'That did not work. Check and try again.';
  }
}

export async function api<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  opts: { auth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['X-Bazaar'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'network', 'No connection to Bazaar. Check your network and try again.');
  }
  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } & Record<string, unknown> } | null)?.error;
    if (res.status === 401 && opts.auth !== false) onUnauthorized();
    const { code, message, ...extra } = err ?? {};
    throw new ApiError(res.status, code ?? `http_${res.status}`, friendlyMessage(res.status, message), extra);
  }
  return data as T;
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body?: unknown, opts?: { auth?: boolean }) =>
  api<T>('POST', path, body ?? {}, opts);
export const patch = <T>(path: string, body: unknown) => api<T>('PATCH', path, body);
