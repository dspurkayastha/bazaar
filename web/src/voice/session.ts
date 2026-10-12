import { SegmentPlayer } from './player';
import { Framer, Resampler, floatToInt16, int16ToLEBytes } from './resample';
import type { ServerMessage, VoiceAction } from './reducer';

export class MicError extends Error {
  kind: 'denied' | 'unavailable';
  constructor(kind: 'denied' | 'unavailable', message: string) {
    super(message);
    this.kind = kind;
  }
}

export function voiceUrl(loc: Pick<Location, 'protocol' | 'host'> = location): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/voice`;
}

type AC = typeof AudioContext;

/** One live voice session: mic -> /voice, and TTS audio back out. Create and start() inside a tap handler. */
export class VoiceSession {
  private ctx: AudioContext | null = null;
  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private player: SegmentPlayer | null = null;
  private closed = false;

  constructor(
    private readonly dispatch: (a: VoiceAction) => void,
    private readonly opts: { placeHint?: string } = {},
  ) {}

  async start(): Promise<void> {
    // The AudioContext must be created and resumed synchronously inside the user gesture on iOS.
    const Ctor: AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: AC }).webkitAudioContext;
    const ctx = new Ctor();
    this.ctx = ctx;
    void ctx.resume();
    this.dispatch({ type: 'local/connecting' });

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (e) {
      this.teardown();
      const name = (e as { name?: string })?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError')
        throw new MicError(
          'denied',
          'Bazaar needs the microphone. Allow it in Settings > Safari > Microphone, then try again.',
        );
      throw new MicError('unavailable', 'No microphone found on this device.');
    }
    if (this.closed) return this.teardown();

    this.player = new SegmentPlayer(ctx);
    await ctx.audioWorklet.addModule('/pcm-capture.js');
    if (this.closed) return this.teardown();
    const source = ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node).connect(mute).connect(ctx.destination);
    this.node = node;

    const resampler = new Resampler(ctx.sampleRate);
    const framer = new Framer();
    node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      for (const frame of framer.push(floatToInt16(resampler.push(ev.data)))) ws.send(int16ToLEBytes(frame));
    };

    const ws = new WebSocket(voiceUrl());
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.send({
        type: 'hello',
        appVersion: 'web-0.1.0',
        device: 'web',
        locale: navigator.language || 'en-IN',
        ...(this.opts.placeHint ? { placeHint: this.opts.placeHint } : {}),
      });
    };
    ws.onmessage = (ev) => this.onFrame(ev.data);
    ws.onclose = (ev) => {
      if (!this.closed) this.dispatch({ type: 'local/closed', code: ev.code, reason: ev.reason });
      this.teardown();
    };
    ws.onerror = () => {
      /* onclose follows with the code */
    };
  }

  private onFrame(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      this.player?.addFrame(data);
      return;
    }
    if (typeof data !== 'string') return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data) as ServerMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'audio_start':
        this.player?.startSegment();
        break;
      case 'audio_end':
        this.player?.endSegment();
        break;
      case 'stop_audio':
        this.player?.stop();
        break;
    }
    this.dispatch(msg);
  }

  send(obj: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  interrupt(): void {
    this.player?.stop();
    this.send({ type: 'interrupt' });
    this.dispatch({ type: 'local/interrupt' });
  }

  cancel(): void {
    this.send({ type: 'cancel' });
  }

  /** End the session: say bye, release the mic, close everything. Safe to call repeatedly. */
  stop(): void {
    if (this.closed) return;
    this.send({ type: 'bye' });
    this.closed = true;
    this.dispatch({ type: 'local/closed', code: 1000 });
    this.teardown();
  }

  private teardown(): void {
    this.closed = true;
    this.player?.stop();
    this.node?.port.close();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    try {
      if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close(1000);
    } catch {
      /* ignore */
    }
    void this.ctx?.close().catch(() => {});
    this.node = null;
    this.stream = null;
    this.ctx = null;
    this.player = null;
  }
}
