import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, get, patch, post } from '../api';
import { PinPad } from '../components/PinPad';
import { Sheet } from '../components/Sheet';
import { useMe } from '../me';
import { assertWith, describeWebAuthnError, fetchLoginOptions } from '../passkeys';
import { parsePhones } from '../phone';
import type { HouseholdMember, HouseholdPlace, HouseholdResponse } from '../types';

const ROLES = ['owner', 'adder', 'dependant'] as const;

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Something went wrong. Try again.';
}

/* ---------- Member sheet ---------- */

function MemberForm({
  member,
  places,
  onClose,
  onSaved,
}: {
  member: HouseholdMember | null;
  places: HouseholdPlace[];
  onClose: () => void;
  onSaved: (setupLink?: { url: string; expiresAt?: string }) => void;
}) {
  const [name, setName] = useState(member?.name ?? '');
  const [role, setRole] = useState<string>(member?.role ?? 'adder');
  const [phones, setPhones] = useState((member?.phones ?? []).join(', '));
  const [placeId, setPlaceId] = useState(member?.defaultPlaceId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tidyPhones = () => {
    const { phones: ok, invalid } = parsePhones(phones);
    setPhones([...ok, ...invalid].join(', '));
  };

  const save = async (e: Event) => {
    e.preventDefault();
    const parsed = parsePhones(phones);
    if (!name.trim()) return setError('Add a name.');
    if (parsed.invalid.length) return setError(`These numbers do not look right: ${parsed.invalid.join(', ')}`);
    setBusy(true);
    setError(null);
    const body = { name: name.trim(), role, phones: parsed.phones, defaultPlaceId: placeId || undefined };
    try {
      if (member) await patch(`/api/household/members/${member.id}`, { ...body, defaultPlaceId: placeId || null });
      else await post('/api/household/members', body);
      onSaved();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={member ? 'Edit member' : 'Add member'} onClose={onClose}>
      <form class="form" onSubmit={(e) => void save(e)}>
        <h2>{member ? `Edit ${member.name}` : 'Add a member'}</h2>
        <label>
          Name
          <input value={name} onInput={(e) => setName(e.currentTarget.value)} autocomplete="off" required />
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.currentTarget.value)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r === 'owner' ? 'Owner (can approve)' : r === 'adder' ? 'Adder (can build carts)' : 'Dependant'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Phone numbers
          <input
            value={phones}
            inputMode="tel"
            placeholder="98765 43210, +91…"
            onInput={(e) => setPhones(e.currentTarget.value)}
            onBlur={tidyPhones}
          />
          <small>Bazaar adds +91 to 10-digit numbers. Separate several with commas.</small>
        </label>
        <label>
          Usual place
          <select value={placeId} onChange={(e) => setPlaceId(e.currentTarget.value)}>
            <option value="">None</option>
            {places.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nickname}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <p class="inline-note" role="alert">
            {error}
          </p>
        )}
        <div class="action-row">
          <button type="button" class="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" class="btn primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

/* ---------- Setup link ---------- */

function SetupLinkSheet({
  link,
  name,
  onClose,
}: {
  link: { url: string; expiresAt?: string };
  name: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const share = async () => {
    try {
      await navigator.share({ title: 'Bazaar', text: `Set up Bazaar, ${name}:`, url: link.url });
    } catch {
      /* cancelled */
    }
  };
  return (
    <Sheet title="Setup link" onClose={onClose}>
      <div class="form">
        <h2>Setup link for {name}</h2>
        <p class="muted">
          This link works once and is shown only now. {link.expiresAt ? 'It expires in 48 hours.' : ''}
        </p>
        <input
          class="mono-field"
          readOnly
          value={link.url}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Setup link"
        />
        <div class="action-row">
          <button type="button" class="btn ghost" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          {canShare && (
            <button type="button" class="btn primary" onClick={() => void share()}>
              Share
            </button>
          )}
        </div>
        <button type="button" class="btn ghost wide" onClick={onClose}>
          Done
        </button>
      </div>
    </Sheet>
  );
}

/* ---------- Place sheet ---------- */

function PlaceForm({
  place,
  onClose,
  onSaved,
}: {
  place: HouseholdPlace | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [nickname, setNickname] = useState(place?.nickname ?? '');
  const [aliases, setAliases] = useState((place?.aliases ?? []).join(', '));
  const [city, setCity] = useState(place?.city ?? '');
  const [trusted, setTrusted] = useState(place?.trusted ?? false);
  const [isDefault, setIsDefault] = useState(place?.isDefault ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: Event) => {
    e.preventDefault();
    if (!nickname.trim()) return setError('Give the place a nickname.');
    setBusy(true);
    setError(null);
    const body = {
      nickname: nickname.trim(),
      aliases: aliases
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      city: city.trim(),
      trusted,
      isDefault,
    };
    try {
      if (place) await patch(`/api/household/places/${place.id}`, body);
      else await post('/api/household/places', body);
      onSaved();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="Place" onClose={onClose}>
      <form class="form" onSubmit={(e) => void save(e)}>
        <h2>{place ? `Edit ${place.nickname}` : 'Add a place'}</h2>
        <label>
          Nickname
          <input value={nickname} onInput={(e) => setNickname(e.currentTarget.value)} autocomplete="off" required />
        </label>
        <label>
          Other names people say
          <input value={aliases} onInput={(e) => setAliases(e.currentTarget.value)} placeholder="ghar, home, বাড়ি" />
          <small>Separate with commas.</small>
        </label>
        <label>
          City
          <input value={city} onInput={(e) => setCity(e.currentTarget.value)} autocomplete="off" />
        </label>
        <label class="check">
          <input type="checkbox" checked={trusted} onChange={(e) => setTrusted(e.currentTarget.checked)} />
          <span>Trusted. Small orders here can go through without asking.</span>
        </label>
        <label class="check">
          <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.currentTarget.checked)} />
          <span>Default place for the household</span>
        </label>
        {error && (
          <p class="inline-note" role="alert">
            {error}
          </p>
        )}
        <div class="action-row">
          <button type="button" class="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" class="btn primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

/* ---------- Instamart import ---------- */

interface SupplierAddress {
  id: string;
  label: string;
  text: string;
  city: string;
}

/** The contract does not pin the shape of this list, so accept an array or {addresses: []} and common field names. */
export function normaliseAddresses(raw: unknown): SupplierAddress[] {
  const list = Array.isArray(raw) ? raw : ((raw as { addresses?: unknown[] } | null)?.addresses ?? []);
  const out: SupplierAddress[] = [];
  for (const a of list as Record<string, unknown>[]) {
    const id = String(a.id ?? a.addressId ?? '');
    if (!id) continue;
    const str = (...keys: string[]) => {
      for (const k of keys) if (typeof a[k] === 'string' && a[k]) return a[k] as string;
      return '';
    };
    out.push({
      id,
      label: str('nickname', 'label', 'tag', 'name', 'addressTag') || 'Saved address',
      text: str('address', 'addressLine', 'formattedAddress', 'line1', 'description'),
      city: str('city'),
    });
  }
  return out;
}

function ImportSheet({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [items, setItems] = useState<SupplierAddress[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    get<unknown>('/api/household/supplier-addresses')
      .then((r) => setItems(normaliseAddresses(r)))
      .catch((e) => setError(errText(e)));
  }, []);

  const add = async (a: SupplierAddress) => {
    setBusyId(a.id);
    setError(null);
    try {
      await post('/api/household/places', { nickname: a.label, aliases: [], city: a.city, instamartAddressId: a.id });
      setItems((cur) => (cur ?? []).filter((x) => x.id !== a.id));
      onImported();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Sheet title="Import from Instamart" onClose={onClose}>
      <div class="form">
        <h2>Import from Instamart</h2>
        {error && (
          <p class="inline-note" role="alert">
            {error}
          </p>
        )}
        {!items && !error && <p class="muted">Looking at your Instamart addresses…</p>}
        {items && items.length === 0 && <p class="muted">Every saved Instamart address is already a place.</p>}
        <ul class="plain-list">
          {(items ?? []).map((a) => (
            <li key={a.id} class="row">
              <div>
                <p class="row-title">{a.label}</p>
                {a.text && <p class="row-sub">{a.text}</p>}
              </div>
              <button type="button" class="btn small primary" disabled={busyId !== null} onClick={() => void add(a)}>
                {busyId === a.id ? 'Adding…' : 'Add'}
              </button>
            </li>
          ))}
        </ul>
        <button type="button" class="btn ghost wide" onClick={onClose}>
          Done
        </button>
      </div>
    </Sheet>
  );
}

/* ---------- PIN ---------- */

function PinSetup({ changing, onClose, onDone }: { changing: boolean; onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState<'enter' | 'confirm' | 'face'>('enter');
  const [first, setFirst] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opts = useRef<Record<string, unknown> | null>(null);
  const pin = useRef('');

  const prefetch = async () => {
    try {
      opts.current = await fetchLoginOptions();
    } catch (e) {
      opts.current = null;
      setError(errText(e));
    }
  };

  const confirmWithFace = async () => {
    if (!opts.current) {
      await prefetch();
      if (!opts.current) return;
    }
    setBusy(true);
    setError(null);
    const o = opts.current;
    opts.current = null;
    try {
      const assertion = await assertWith(o);
      await post('/api/pin', { pin: pin.current, assertion });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : describeWebAuthnError(e));
      void prefetch();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={changing ? 'Change PIN' : 'Set PIN'} onClose={onClose}>
      {step === 'enter' && (
        <PinPad
          key="enter"
          title={changing ? 'Choose a new PIN' : 'Choose a PIN'}
          hint={note ?? '4 to 6 digits. You will need it to approve carts over ₹500.'}
          submitLabel="Next"
          onCancel={onClose}
          onSubmit={async (p) => {
            setFirst(p);
            setNote(null);
            setStep('confirm');
            return { ok: true };
          }}
        />
      )}
      {step === 'confirm' && (
        <PinPad
          key="confirm"
          title="Enter it again"
          submitLabel="Confirm PIN"
          onCancel={onClose}
          onSubmit={async (p) => {
            if (p !== first) {
              setNote('The two PINs did not match. Start again.');
              setStep('enter');
              return { ok: true };
            }
            pin.current = p;
            void prefetch();
            setStep('face');
            return { ok: true };
          }}
        />
      )}
      {step === 'face' && (
        <div class="form">
          <h2>Confirm it is you</h2>
          <p class="muted">Bazaar asks for Face ID before it saves a PIN.</p>
          {error && (
            <p class="inline-note" role="alert">
              {error}
            </p>
          )}
          <button type="button" class="btn primary wide big" disabled={busy} onClick={() => void confirmWithFace()}>
            {busy ? 'Waiting for Face ID…' : 'Save PIN with Face ID'}
          </button>
          <button type="button" class="btn ghost wide" onClick={onClose}>
            Cancel
          </button>
        </div>
      )}
    </Sheet>
  );
}

/* ---------- Screen ---------- */

export function Household({ onSignOut, onMeChanged }: { onSignOut: () => void; onMeChanged: () => void }) {
  const me = useMe();
  const isOwner = me.member.role === 'owner';
  const [data, setData] = useState<HouseholdResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [memberSheet, setMemberSheet] = useState<HouseholdMember | 'new' | null>(null);
  const [placeSheet, setPlaceSheet] = useState<HouseholdPlace | 'new' | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [link, setLink] = useState<{ url: string; expiresAt?: string; name: string } | null>(null);
  const [linkBusy, setLinkBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = async () => {
    try {
      setData(await get<HouseholdResponse>('/api/household'));
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const makeLink = async (m: HouseholdMember) => {
    setLinkBusy(m.id);
    setError(null);
    try {
      const r = await post<{ url: string; expiresAt?: string }>(`/api/household/members/${m.id}/setup-link`);
      setLink({ ...r, name: m.name });
    } catch (e) {
      setError(errText(e));
    } finally {
      setLinkBusy(null);
    }
  };

  const placeName = (id?: string | null) => data?.places.find((p) => p.id === id)?.nickname;

  return (
    <section class="screen">
      <header class="screen-head">
        <h1>Home</h1>
        <button type="button" class="link-btn" onClick={onSignOut}>
          Sign out
        </button>
      </header>
      <p class="muted">
        {me.household.name}. You are {me.member.name}, {me.member.role}.
      </p>
      {!isOwner && <p class="inline-note">Only the owner can change members, places or the PIN.</p>}
      {error && (
        <p class="inline-note" role="alert">
          {error}
        </p>
      )}
      {note && (
        <p class="success-note" role="status">
          {note}
        </p>
      )}

      <h2 class="section-title">Members</h2>
      <ul class="plain-list">
        {(data?.members ?? []).map((m) => (
          <li key={m.id} class="row stack">
            <div class="row-main">
              <div>
                <p class="row-title">
                  {m.name} <span class="chip">{m.role}</span>
                </p>
                <p class="row-sub">
                  {isOwner && m.phones.length > 0 ? m.phones.join(', ') + ' · ' : ''}
                  {m.hasPasskey ? 'Face ID set up' : 'No passkey yet'}
                  {placeName(m.defaultPlaceId) ? ` · ${placeName(m.defaultPlaceId)}` : ''}
                </p>
              </div>
            </div>
            {isOwner && (
              <div class="row-actions">
                <button type="button" class="btn small ghost" onClick={() => setMemberSheet(m)}>
                  Edit
                </button>
                <button
                  type="button"
                  class="btn small ghost"
                  disabled={linkBusy !== null}
                  onClick={() => void makeLink(m)}
                >
                  {linkBusy === m.id ? 'Creating…' : 'Create setup link'}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {isOwner && (
        <button type="button" class="btn ghost wide" onClick={() => setMemberSheet('new')}>
          Add member
        </button>
      )}

      <h2 class="section-title">Places</h2>
      <ul class="plain-list">
        {(data?.places ?? []).map((p) => (
          <li key={p.id} class="row stack">
            <div class="row-main">
              <div>
                <p class="row-title">
                  {p.nickname}
                  {p.isDefault && <span class="chip">default</span>}
                  {p.trusted && <span class="chip ok">trusted</span>}
                </p>
                <p class="row-sub">
                  {[p.city, p.aliases.length ? `also: ${p.aliases.join(', ')}` : ''].filter(Boolean).join(' · ')}
                </p>
              </div>
            </div>
            {isOwner && (
              <div class="row-actions">
                <button type="button" class="btn small ghost" onClick={() => setPlaceSheet(p)}>
                  Edit
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {isOwner && (
        <div class="action-row">
          <button type="button" class="btn ghost" onClick={() => setPlaceSheet('new')}>
            Add place
          </button>
          <button type="button" class="btn ghost" onClick={() => setImportOpen(true)}>
            Import from Instamart
          </button>
        </div>
      )}

      {isOwner && (
        <>
          <h2 class="section-title">Security</h2>
          <div class="row stack">
            <div class="row-main">
              <div>
                <p class="row-title">Approval PIN</p>
                <p class="row-sub">
                  {me.pinLocked
                    ? 'Locked after wrong tries.'
                    : me.pinSet
                      ? 'Set. Asked for carts over ₹500.'
                      : 'Not set yet. Carts over ₹500 cannot be approved without it.'}
                </p>
              </div>
            </div>
            <div class="row-actions">
              <button type="button" class="btn small primary" onClick={() => setPinOpen(true)}>
                {me.pinSet ? 'Change PIN' : 'Set PIN'}
              </button>
            </div>
          </div>
        </>
      )}

      {memberSheet && (
        <MemberForm
          member={memberSheet === 'new' ? null : memberSheet}
          places={data?.places ?? []}
          onClose={() => setMemberSheet(null)}
          onSaved={() => {
            setMemberSheet(null);
            void load();
          }}
        />
      )}
      {placeSheet && (
        <PlaceForm
          place={placeSheet === 'new' ? null : placeSheet}
          onClose={() => setPlaceSheet(null)}
          onSaved={() => {
            setPlaceSheet(null);
            void load();
          }}
        />
      )}
      {importOpen && <ImportSheet onClose={() => setImportOpen(false)} onImported={() => void load()} />}
      {link && <SetupLinkSheet link={link} name={link.name} onClose={() => setLink(null)} />}
      {pinOpen && (
        <PinSetup
          changing={me.pinSet}
          onClose={() => setPinOpen(false)}
          onDone={() => {
            setPinOpen(false);
            setNote('PIN saved.');
            onMeChanged();
          }}
        />
      )}
    </section>
  );
}
