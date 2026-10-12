import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { PinPad, type PinResult } from '../src/components/PinPad';
import { CartCard, fromHeld, MAX_LINES } from '../src/components/CartCard';
import { CartActions } from '../src/components/CartActions';
import { Carts } from '../src/screens/Carts';
import { MeContext } from '../src/me';
import type { CartsResponse, HeldCart, Me } from '../src/types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const line = (n: number) => ({ name: `Item ${n}`, label: '1 kg', qty: 1, lineTotal: 1000 * n });

const held: HeldCart = {
  quoteHash: 'abc123',
  member: { id: 'm2', name: 'Riya' },
  place: { id: 'p1', nickname: 'Guwahati flat' },
  supplier: 'instamart',
  lines: [1, 2, 3, 4, 5, 6, 7].map(line),
  fees: [
    { label: 'Handling', amount: 500 },
    { label: 'Delivery', amount: 3000 },
  ],
  total: 112300,
  etaMinutes: 16,
  createdAt: '2026-10-12T05:00:00.000Z',
  reasons: ['per_order_ceiling', 'role'],
  needsPin: true,
  approvable: true,
};

const owner: Me = {
  member: { id: 'm1', name: 'Dev', role: 'owner' },
  household: { id: 'h', name: 'Purkayastha' },
  pinSet: true,
  pinLocked: false,
};
const adder: Me = { ...owner, member: { id: 'm2', name: 'Riya', role: 'adder' } };

const asMe = (me: Me, ui: preact.ComponentChild) => <MeContext.Provider value={me}>{ui}</MeContext.Provider>;

describe('PinPad', () => {
  const setup = (
    onSubmit: (pin: string) => Promise<PinResult> = vi.fn(async (_pin: string) => ({ ok: true as const })),
  ) => {
    render(<PinPad title="Approve ₹1,123" submitLabel="Approve" onSubmit={onSubmit} onCancel={() => {}} />);
    return onSubmit;
  };
  const tap = (...keys: string[]) => keys.forEach((k) => fireEvent.click(screen.getByRole('button', { name: k })));

  it('needs at least 4 digits and accepts at most 6', () => {
    setup();
    const submit = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    tap('1', '2', '3');
    expect(submit.disabled).toBe(true);
    tap('4');
    expect(submit.disabled).toBe(false);
    tap('5', '6', '7', '8');
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('6 of 6 digits entered');
  });

  it('backspace removes a digit', () => {
    setup();
    tap('1', '2', '3', '4');
    fireEvent.click(screen.getByRole('button', { name: 'Delete last digit' }));
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('3 of 6 digits entered');
  });

  it('submits the digits', async () => {
    const onSubmit = setup();
    tap('2', '4', '6', '8');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('2468'));
  });

  it('shows remaining attempts after a wrong PIN and clears the entry', async () => {
    setup(vi.fn(async () => ({ ok: false as const, message: 'That PIN is not right.', attemptsLeft: 3 })));
    tap('1', '1', '1', '1');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('3 tries left'));
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('0 of 6 digits entered');
  });

  it('locks the keys when the server says locked', async () => {
    setup(vi.fn(async () => ({ ok: false as const, message: 'x', locked: true })));
    tap('1', '1', '1', '1');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/locked/));
    expect((screen.getByRole('button', { name: '5' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('CartCard from a HeldCart fixture', () => {
  it('shows who, where, five lines then "N more", fees, total and plain-word reasons', () => {
    render(<CartCard cart={fromHeld(held)} />);
    expect(screen.getByText('Guwahati flat')).toBeTruthy();
    expect(screen.getByText(/Riya asked/)).toBeTruthy();
    expect(screen.getAllByText(/^Item \d$/, { exact: false }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Item 6/)).toBeNull();
    expect(MAX_LINES).toBe(5);
    fireEvent.click(screen.getByRole('button', { name: '2 more' }));
    expect(screen.getByText(/Item 7/)).toBeTruthy();
    expect(screen.getByText('Handling')).toBeTruthy();
    expect(screen.getByText('Delivery').nextElementSibling?.textContent).toBe('₹30');
    expect(screen.getByText('Handling').nextElementSibling?.textContent).toBe('₹5');
    expect(screen.getByText('₹1,123')).toBeTruthy();
    expect(screen.getByText('This is over the limit for a single order.')).toBeTruthy();
    expect(screen.getByText('Only an owner can pay for this.')).toBeTruthy();
  });
});

describe('Carts screen', () => {
  const data: CartsResponse = {
    held: [held],
    recent: [
      {
        supplierOrderId: 'o1',
        placedAt: '2026-10-11T10:00:00.000Z',
        place: { id: 'p1', nickname: 'Guwahati flat' },
        total: 41200,
        status: 'delivered',
        member: { id: 'm1', name: 'Dev' },
      },
    ],
  };
  it('lists held carts first, then recent orders', () => {
    render(asMe(owner, <Carts data={data} error={null} loading={false} refresh={async () => {}} />));
    const text = document.body.textContent ?? '';
    expect(text.indexOf('₹1,123')).toBeGreaterThan(-1);
    expect(text.indexOf('Recent orders')).toBeGreaterThan(text.indexOf('₹1,123'));
    expect(screen.getByText('₹412')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Approve ₹1,123 with PIN/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
  });
  it('shows an empty state', () => {
    render(
      asMe(owner, <Carts data={{ held: [], recent: [] }} error={null} loading={false} refresh={async () => {}} />),
    );
    expect(screen.getByText('Nothing waiting for approval.')).toBeTruthy();
  });
});

describe('CartActions', () => {
  const json = (status: number, body: unknown) => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
  });

  it('non-owners cannot approve', () => {
    render(
      asMe(adder, <CartActions cart={fromHeld(held)} builderId="m2" onApproved={() => {}} onRejected={() => {}} />),
    );
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(screen.getByText('Waiting for an owner to approve.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
  });

  it('approve above the threshold opens the PIN pad without calling the server, then posts the PIN with X-Bazaar', async () => {
    const fetchMock = vi.fn(async () =>
      json(200, { decision: 'PAY', order: { supplierOrderId: 'o9', status: 'placed' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onApproved = vi.fn();
    render(asMe(owner, <CartActions cart={fromHeld(held)} onApproved={onApproved} onRejected={() => {}} />));
    fireEvent.click(screen.getByRole('button', { name: /Approve ₹1,123 with PIN/ }));
    expect(fetchMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    for (const k of ['1', '2', '3', '4']) fireEvent.click(screen.getByRole('button', { name: k }));
    fireEvent.click(dialog.querySelector('.btn.primary') as HTMLElement);
    await waitFor(() => expect(onApproved).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/carts/abc123/approve');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Bazaar']).toBe('1');
    expect(JSON.parse(init.body as string)).toEqual({ pin: '1234' });
  });

  it('423 shows the lockout state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(423, { error: { code: 'pin_locked', message: 'locked' } })),
    );
    render(asMe(owner, <CartActions cart={fromHeld(held)} onApproved={() => {}} onRejected={() => {}} />));
    fireEvent.click(screen.getByRole('button', { name: /with PIN/ }));
    for (const k of ['1', '2', '3', '4']) fireEvent.click(screen.getByRole('button', { name: k }));
    fireEvent.click(screen.getByRole('dialog').querySelector('.btn.primary') as HTMLElement);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/locked/));
  });

  it('a cart under the threshold approves in one tap (no optimistic removal)', async () => {
    const fetchMock = vi.fn(async () =>
      json(200, { decision: 'PAY', order: { supplierOrderId: 'o2', status: 'placed' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onApproved = vi.fn();
    const cheap = { ...fromHeld(held), needsPin: false, total: 41200 };
    render(asMe(owner, <CartActions cart={cheap} onApproved={onApproved} onRejected={() => {}} />));
    fireEvent.click(screen.getByRole('button', { name: 'Approve ₹412' }));
    expect(onApproved).not.toHaveBeenCalled();
    await waitFor(() => expect(onApproved).toHaveBeenCalledTimes(1));
  });
});
