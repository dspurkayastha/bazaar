import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { ApiError, post } from './api';

type Json = Record<string, unknown>;

/** Server returns the options object itself, possibly with extra `member`; some servers wrap it as {options}. */
function unwrapOptions(r: Json): Json {
  if (r.options && typeof r.options === 'object') return r.options as Json;
  const { member: _member, ...rest } = r;
  return rest;
}

export function describeWebAuthnError(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError') return 'Face ID was cancelled or timed out. Try again.';
  if (name === 'InvalidStateError') return 'This phone already has a passkey for Bazaar.';
  if (name === 'NotSupportedError' || name === 'SecurityError')
    return 'Passkeys are not available here. Open Bazaar from Safari on the https address.';
  return 'Could not use your passkey. Try again.';
}

export async function fetchSetupOptions(code: string): Promise<{ options: Json; name: string }> {
  const r = await post<Json>(`/api/setup/${encodeURIComponent(code)}/options`, {}, { auth: false });
  const name = (r.member as { name?: string } | undefined)?.name ?? '';
  return { options: unwrapOptions(r), name };
}

export async function finishSetup(code: string, options: Json): Promise<void> {
  const response = await startRegistration({ optionsJSON: options as never });
  await post(`/api/setup/${encodeURIComponent(code)}/verify`, response, { auth: false });
}

export async function fetchLoginOptions(): Promise<Json> {
  return unwrapOptions(await post<Json>('/api/login/options', {}, { auth: false }));
}

/** Call from a tap handler with options fetched earlier, so Safari still sees the user gesture. */
export async function assertWith(options: Json): Promise<unknown> {
  return startAuthentication({ optionsJSON: options as never });
}

export async function signIn(options: Json): Promise<void> {
  const assertion = await assertWith(options);
  await post('/api/login/verify', assertion, { auth: false });
}
