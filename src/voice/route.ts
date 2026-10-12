/**
 * GET /voice (WebSocket, @fastify/websocket). docs/VOICE_PROTOCOL.md "Transport":
 *   - member token on the upgrade (`Authorization: Bearer mtk_...`, the same check as the HTTP routes); missing or
 *     invalid → the socket is accepted and closed with 4401,
 *   - one live session per member: a second connection closes the first with 4409,
 *   - without SARVAM_API_KEY: `error` { code: voice_unconfigured } and close 1011.
 * Messages are buffered from the first byte, so nothing the app sends while we authenticate is lost.
 */
import type { FastifyInstance } from 'fastify';
import type WebSocket from 'ws';
import { approveQuote } from '../api/routes/approve.js';
import { authenticateMember, authenticateSession, type AuthedMember } from '../api/auth.js';
import { webOf, type ApiDeps } from '../api/http.js';
import type { VoiceConfig } from './config.js';
import { VoiceConnection, type VoiceRuntime } from './connection.js';
import { sharedFillers, type FillerCache } from './fillers.js';
import type { KeypadSource } from './keypad.js';
import type { WebSocketFactory } from './sarvam.js';
import { SessionRegistry } from './session.js';

export interface VoiceOptions {
  config: VoiceConfig;
  /** Sarvam sockets (tests point this at fake servers). */
  wsFactory?: WebSocketFactory;
  fillers?: FillerCache;
  sessions?: SessionRegistry;
  /** Wall clock in ms (Date.now). */
  clock?: () => number;
  helloTimeoutMs?: number;
  /**
   * The phone keypad for this member's connection, if the session is a phone call (telephony adapter; provider not
   * chosen yet). Digits typed there approve a held quote above the PIN threshold (voice/keypad.ts).
   */
  keypadFor?: (who: AuthedMember) => KeypadSource | undefined;
}

export const CLOSE_UNAUTHORISED = 4401;
export const CLOSE_SUPERSEDED = 4409;
export const CLOSE_UNCONFIGURED = 1011;

export function registerVoiceRoute(app: FastifyInstance, deps: ApiDeps): void {
  const opts = deps.voice;
  const sessions = opts?.sessions ?? new SessionRegistry(opts?.config.sessionTtlMs ?? 10 * 60_000);
  const live = new Map<string, VoiceConnection>();

  app.get('/voice', { websocket: true, config: { auth: 'none' } }, async (socket: WebSocket, req) => {
    const early: [WebSocket.RawData, boolean][] = [];
    const buffer = (data: WebSocket.RawData, isBinary: boolean) => early.push([data, isBinary]);
    socket.on('message', buffer);

    // Member token (iPhone app, CLI), else the web app's session cookie — only from the web app's own origin.
    const who =
      (await authenticateMember(deps.store, req.headers.authorization)) ??
      (req.headers.origin === webOf(deps).origin
        ? await authenticateSession(deps, req.headers.cookie).then((s) => s?.who)
        : undefined);
    if (!who) {
      socket.close(CLOSE_UNAUTHORISED, 'unauthorised');
      return;
    }
    const sarvam = opts?.config.sarvam;
    if (!opts || !sarvam) {
      socket.send(
        JSON.stringify({
          type: 'error',
          code: 'voice_unconfigured',
          message: 'Voice is not configured on this server.',
        }),
      );
      socket.close(CLOSE_UNCONFIGURED, 'voice_unconfigured');
      return;
    }

    const previous = live.get(who.memberId);
    if (previous) previous.close(CLOSE_SUPERSEDED, 'superseded by a new connection');

    const runtime: VoiceRuntime = {
      api: deps,
      config: opts.config,
      sarvam,
      sessions,
      fillers: opts.fillers ?? sharedFillers,
      approve: (hash, member, factor) => approveQuote(deps, hash, member, factor),
      ...(opts.wsFactory ? { wsFactory: opts.wsFactory } : {}),
      ...(opts.clock ? { clock: opts.clock } : {}),
      ...(opts.helloTimeoutMs !== undefined ? { helloTimeoutMs: opts.helloTimeoutMs } : {}),
    };
    const conn = new VoiceConnection(socket, who, runtime, req.log);
    live.set(who.memberId, conn);
    const keypad = opts.keypadFor?.(who);
    if (keypad) conn.attachKeypad(keypad);
    socket.on('close', () => {
      if (live.get(who.memberId) === conn) live.delete(who.memberId);
    });
    socket.off('message', buffer);
    socket.on('message', (data, isBinary) => conn.handle(data, isBinary));
    for (const [data, isBinary] of early) conn.handle(data, isBinary);
  });
}
