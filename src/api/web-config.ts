/**
 * Web app configuration from the environment (docs/WEB_API.md).
 *
 *   WEB_ORIGIN                 the web app's origin, e.g. https://bazaar.sciscribesolutions.com
 *                              (default http://localhost:<PORT>, for local development only)
 *   WEBAUTHN_RP_ID             passkey relying-party id, e.g. bazaar.sciscribesolutions.com (default: WEB_ORIGIN's host)
 *   PIN_REQUIRED_ABOVE_RUPEES  approving a held cart whose total is above this (whole rupees) needs the owner's PIN,
 *                              on every channel (default 500)
 *   WEB_DIST                   built web app to serve at / (default web/dist)
 */
import { rupees } from '../core/money.js';
import type { Paise } from '../core/types.js';

export const DEFAULT_PIN_REQUIRED_ABOVE_RUPEES = 500;

export interface WebConfig {
  origin: string;
  rpId: string;
  rpName?: string;
  /** Directory of the built web app (index.html + assets/). Absent or missing on disk → `/` explains how to build. */
  distDir?: string;
}

export function parsePinThreshold(raw: string | undefined): Paise {
  const v = raw?.trim();
  if (!v) return rupees(DEFAULT_PIN_REQUIRED_ABOVE_RUPEES);
  if (!/^\d+$/.test(v)) throw new Error('PIN_REQUIRED_ABOVE_RUPEES must be a whole number of rupees');
  return rupees(Number(v));
}

export function webConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const origin = (env.WEB_ORIGIN?.trim() || `http://localhost:${env.PORT ?? 8787}`).replace(/\/+$/, '');
  let host: string;
  try {
    const u = new URL(origin);
    if (u.pathname !== '/' || u.search || u.hash) throw new Error('path');
    host = u.hostname;
  } catch {
    throw new Error('WEB_ORIGIN must be an origin like https://bazaar.example.com (no path)');
  }
  const rpId = env.WEBAUTHN_RP_ID?.trim() || host;
  if (host !== rpId && !host.endsWith(`.${rpId}`))
    throw new Error('WEBAUTHN_RP_ID must be the host of WEB_ORIGIN or a parent domain of it');
  return { origin, rpId, rpName: 'Bazaar', distDir: env.WEB_DIST?.trim() || 'web/dist' };
}
