import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { App } from '../src/app';
import { api, ApiError, get, post } from '../src/api';
import { isSampleMode } from '../src/sample/mode';
import { onToast } from '../src/sample/toast';
import { createVoiceSession, SampleVoiceSession, SCRIPT } from '../src/sample/voice';
import { sampleLedger } from '../src/sample/fixtures';
import { initialVoiceState, voiceReducer, type VoiceAction } from '../src/voice/reducer';
import { VoiceSession } from '../src/voice/session';
import type { CartsResponse, HouseholdResponse, LedgerSummary, Me } from '../src/types';

const PREVIEW_HOST = 'feature-x-bazaar.dspurkayastha.workers.dev';

function at(hostname: string) {
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('location', { hostname, pathname: '/', hash: '', protocol: 'https:', host: hostname });
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('isSampleMode', () => {
  it.each([
    ['bazaar.sciscribesolutions.com', false],
    ['BAZAAR.sciscribesolutions.com', false],
    ['localhost', false],
    ['127.0.0.1', false],
    ['[::1]', false],
    [PREVIEW_HOST, true],
    ['bazaar.dspurkayastha.workers.dev', true],
    ['bazaar.sciscribesolutions.com.evil.test', true],
    ['bazaar-origin.sciscribesolutions.com', true],
    ['', true],
  ])('%s -> %s', (hostname, expected) => {
    expect(isSampleMode({ hostname })).toBe(expected);
  });

  it('jsdom runs on localhost, so the existing tests stay on the real API layer', () => {
    expect(isSampleMode()).toBe(false);
  });
});

describe('the api layer switch', () => {
  it('production and localhost call fetch', async () => {
    for (const host of ['bazaar.sciscribesolutions.com', 'localhost']) {
      at(host);
      fetchSpy.mockClear();
      await api('GET', '/api/me');
      expect(fetchSpy, host).toHaveBeenCalledTimes(1);
    }
  });

  it('a preview host answers from fixtures and never calls fetch', async () => {
    at(PREVIEW_HOST);
    const me = await get<Me>('/api/me');
    const carts = await get<CartsResponse>('/api/carts');
    const home = await get<HouseholdResponse>('/api/household');
    const ledger = await get<LedgerSummary>('/api/ledger?month=2026-09');
    await get('/api/household/supplier-addresses');
    expect(fetchSpy).not.toHaveBeenCalled();

    expect(me.member.role).toBe('owner');
    expect(carts.held).toHaveLength(2);
    const partner = carts.held.find((h) => h.member.name === 'Meera')!;
    expect(partner.total).toBeGreaterThan(50000);
    expect(partner.needsPin).toBe(true);
    expect(carts.recent.length).toBeGreaterThanOrEqual(3);
    expect(home.members).toHaveLength(4);
    expect(home.places).toHaveLength(5);
    expect(home.members.some((m) => m.defaultPlaceId === 'sp_guwahati')).toBe(true);
    expect(ledger.month).toBe('2026-09');
  });

  it('every held cart is internally consistent (lines + fees = total)', async () => {
    at(PREVIEW_HOST);
    const { held } = await get<CartsResponse>('/api/carts');
    for (const h of held) {
      const sum = h.lines.reduce((a, l) => a + l.lineTotal, 0) + h.fees.reduce((a, f) => a + f.amount, 0);
      expect(sum, h.quoteHash).toBe(h.total);
    }
  });

  it('the ledger sums agree with each other', () => {
    const l = sampleLedger('2026-10');
    const sum = (xs: { total: number }[]) => xs.reduce((a, x) => a + x.total, 0);
    expect(sum(l.byCategory)).toBe(l.itemTotal);
    expect(sum(l.byPlace)).toBe(l.total);
    expect(sum(l.byMember)).toBe(l.total);
    expect(l.itemTotal + l.fees.total).toBe(l.total);
    expect(sum(l.fees.byLabel)).toBe(l.fees.total);
    expect(l.byPlace.reduce((a, x) => a + x.count, 0)).toBe(l.orderCount);
  });

  it('writes show the toast and throw a Preview-only ApiError, with no fetch', async () => {
    at(PREVIEW_HOST);
    const seen: (string | null)[] = [];
    const off = onToast((t) => seen.push(t));
    const e = (await post('/api/carts/sample-held-2/approve', {}).catch((x) => x)) as ApiError;
    off();
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe('preview');
    expect(e.message).toBe('Preview only');
    expect(seen).toContain('Preview only');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('an unknown read is a 404, still no fetch', async () => {
    at(PREVIEW_HOST);
    const e = (await get('/api/nope').catch((x) => x)) as ApiError;
    expect(e.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('the app on a preview host', () => {
  it('shows the banner and sample carts without any fetch or sign-in, and actions toast "Preview only"', async () => {
    at(PREVIEW_HOST);
    render(<App />);
    expect(await screen.findByText('Preview — sample data')).toBeTruthy();
    expect(await screen.findByText(/Meera asked/)).toBeTruthy();
    expect(screen.queryByText(/sign in/i)).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: 'Approve ₹348' }));
    await waitFor(() => expect(screen.getAllByText('Preview only').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(await screen.findByText('Guwahati, Ma and Baba', { selector: '.row-title' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(screen.queryByText(/Opening Bazaar/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Ledger' }));
    expect(await screen.findByText(/14 orders/)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a /setup/<code> link does not start the passkey flow on a preview', async () => {
    vi.stubGlobal('location', {
      hostname: PREVIEW_HOST,
      pathname: '/setup/abc',
      hash: '',
      protocol: 'https:',
      host: PREVIEW_HOST,
    });
    render(<App />);
    expect(await screen.findByText('Preview — sample data')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Talk in sample mode', () => {
  it('createVoiceSession picks the scripted session on a preview host and the real one otherwise', () => {
    at(PREVIEW_HOST);
    expect(createVoiceSession(() => {})).toBeInstanceOf(SampleVoiceSession);
    at('bazaar.sciscribesolutions.com');
    expect(createVoiceSession(() => {})).toBeInstanceOf(VoiceSession);
  });

  it('plays the scripted captions through the real reducer, with no mic and no socket', async () => {
    vi.useFakeTimers();
    const ws = vi.fn();
    vi.stubGlobal('WebSocket', ws);
    let state = initialVoiceState;
    const orbs: string[] = [];
    const s = new SampleVoiceSession((a: VoiceAction) => {
      state = voiceReducer(state, a);
      orbs.push(state.orb);
    });
    await s.start();
    expect(state.orb).toBe('connecting');
    await vi.advanceTimersByTimeAsync(2000);
    expect(state.orb).toBe('listening');
    expect(state.heard?.text).toMatch(/Dudh/);
    await vi.advanceTimersByTimeAsync(2000);
    expect(state.orb).toBe('speaking');
    expect(state.say?.text).toMatch(/milk/);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.orb).toBe('listening');
    expect(state.cart?.quote.total).toBe(27800);
    expect(state.decision?.verdict).toBe('HOLD');
    expect(orbs).toContain('thinking');
    expect(ws).not.toHaveBeenCalled();
    s.stop();
    expect(state.orb).toBe('off');
    expect(SCRIPT.length).toBeGreaterThan(5);
  });

  it('stop() cancels the rest of the script', async () => {
    vi.useFakeTimers();
    let state = initialVoiceState;
    const s = new SampleVoiceSession((a) => (state = voiceReducer(state, a)));
    await s.start();
    await vi.advanceTimersByTimeAsync(1000);
    s.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state.orb).toBe('off');
    expect(state.cart).toBeNull();
  });

  it('the Talk tab shows the orb and starts the script without a microphone', async () => {
    at(PREVIEW_HOST);
    const getUserMedia = vi.fn();
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Talk' }));
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Tap to talk' }));
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByText(/Dudh aar dim/)).toBeTruthy();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    cleanup();
  });
});
