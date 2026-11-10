/**
 * hosfera — cliente da API (redesign).
 *
 * Sem framework de propósito: o app é servido estático, sem build. Toda
 * autorização vem do servidor; aqui só escondemos o que o papel não pode fazer.
 */

const $ = (sel) => document.querySelector(sel);
const el = (html) => {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
};

const state = {
  token: localStorage.getItem('hosfera.token') ?? '',
  me: null,
  tab: 'dashboard',
  properties: [],
  units: [],
  unit: null,
  availability: [],
  calStart: '',
  summary: null,
  reservations: [],
  tasks: [],
  channels: [],
  connections: [],
  listings: [],
  amenities: [],
  icalSources: [],
};

// ───────────────────────────── helpers ─────────────────────────────

const iso = (date) => {
  const d = new Date(date);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const addDays = (date, days) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const fmtDate = (date) => {
  if (!date) return '—';
  const [, m, d] = date.split('-');
  return `${d}/${m}`;
};
const fmtFull = (date) => {
  if (!date) return '—';
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
};
const brl = (cents) =>
  (Number(cents ?? 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const brlExact = (cents) =>
  (Number(cents ?? 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2 });
const nights = (checkin, checkout) =>
  Math.max(1, Math.round((Date.parse(`${checkout}T00:00:00Z`) - Date.parse(`${checkin}T00:00:00Z`)) / 86400000));

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

const PT = {
  pending: 'pendente',
  confirmed: 'confirmada',
  checked_in: 'hospedado',
  checked_out: 'finalizada',
  cancelled: 'cancelada',
  no_show: 'no-show',
  draft: 'rascunho',
  published: 'publicado',
  active: 'ativo',
  inactive: 'inativo',
  paused: 'pausado',
  disabled: 'desativado',
  checkin: 'check-in',
  checkout: 'check-out',
  cleaning: 'limpeza',
  maintenance: 'manutenção',
  ok: 'ok',
  error: 'erro',
  critical: 'crítico',
  warning: 'aviso',
};
const pt = (value) => PT[value] ?? String(value ?? '').replace(/_/g, ' ');

const plural = (n, one, many) => `${n} ${Number(n) === 1 ? one : many}`;

/** Nome de marca, não slug da API. */
const CHANNEL_LABELS = {
  booking: 'Booking.com',
  airbnb: 'Airbnb',
  decolar: 'Decolar',
  expedia: 'Expedia',
  vrbo: 'Vrbo',
  google: 'Google',
  mock: 'Simulador',
};
const channelLabel = (channel) => CHANNEL_LABELS[channel] ?? channel ?? '—';

const initials = (name) =>
  (name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(data?.message ?? `falha ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const can = (action) => (state.me?.permissions ?? []).includes(action);

let toastTimer = null;
function toast(message, isError = false) {
  let node = $('.toast');
  if (!node) {
    node = el('<div class="toast"><span class="dot"></span><span class="msg"></span></div>');
    document.body.appendChild(node);
  }
  node.querySelector('.msg').textContent = message;
  node.classList.toggle('error', Boolean(isError));
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 4200);
}

const ICONS = {
  dashboard: '<path d="M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z"/>',
  calendar: '<path d="M4 6h16v15H4zM8 3v4M16 3v4M4 11h16"/>',
  book: '<path d="M4 4h11a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3zM8 8h7M8 12h7"/>',
  tasks: '<path d="M4 5h4v4H4zM4 15h4v4H4zM11 7h9M11 17h9"/>',
  plug: '<path d="M9 3v6M15 3v6M6 9h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6zM12 18v3"/>',
  home: '<path d="M4 11l8-7 8 7M6 10v10h12V10"/>',
  wallet: '<path d="M3 7h15a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7V6a2 2 0 0 1 2-2h11M16 13h2"/>',
  logout: '<path d="M10 5H5v14h5M15 8l4 4-4 4M9 12h10"/>',
  refresh: '<path d="M4 12a8 8 0 0 1 14-5M20 12a8 8 0 0 1-14 5M18 4v4h-4M6 20v-4h4"/>',
  link: '<path d="M10 13a4 4 0 0 0 6 0l2-2a4 4 0 0 0-6-6l-1 1M14 11a4 4 0 0 0-6 0l-2 2a4 4 0 0 0 6 6l1-1"/>',
  alert: '<path d="M12 3l9 17H3zM12 9v5M12 17h.01"/>',
};

const icon = (name, size = 16) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ''}</svg>`;

function empty(title, hint) {
  return `<div class="empty">
    <div class="ico">${icon('alert', 18)}</div>
    <div class="t">${title}</div>
    <div class="h">${hint ?? ''}</div>
  </div>`;
}

// ───────────────────────────── autenticação ─────────────────────────────

function renderAuth(message = '') {
  document.body.replaceChildren(
    el(`<div class="auth">
      <section class="auth-brand">
        <div class="brand">
          <div class="brand-mark"></div>
          <div>
            <div class="brand-name">hosfera</div>
            <div class="brand-sub">PMS · channel manager</div>
          </div>
        </div>
        <div class="auth-pitch">
          <h2>Uma agenda só. Nenhuma noite vendida duas vezes.</h2>
          <p>Disponibilidade derivada, tarifas por data, repasse ao proprietário e
             sincronização de calendário com os canais.</p>
          <div class="auth-points">
            <div class="auth-point"><span class="tick">1</span><span>Calendário canônico com preço, mínimo de noites e bloqueios.</span></div>
            <div class="auth-point"><span class="tick">2</span><span>Outbox por canal: cada evento com retry e registro do que falhou.</span></div>
            <div class="auth-point"><span class="tick">3</span><span>iCal de entrada e saída funcionando hoje, sem depender de homologação.</span></div>
          </div>
        </div>
        <div class="hint" style="color:#8b8880">Ambiente local · dados de demonstração</div>
      </section>
      <section class="auth-form">
        <div class="auth-card">
          <h1>Acessar a operação</h1>
          <p class="lede">Cole o token da sua organização. Ele carrega organização e papel.</p>
          <div class="field">
            <label for="token">Token de acesso</label>
            <input id="token" type="password" placeholder="hsk_..." autocomplete="off" spellcheck="false" />
          </div>
          <button class="btn btn-primary btn-block" id="enter">Entrar</button>
          <div class="error" id="err">${message}</div>
          <hr class="divider" />
          <details>
            <summary class="hint" style="cursor:pointer;font-size:12px">Criar organização de demonstração</summary>
            <div class="stack" style="margin-top:12px">
              <div class="field" style="margin:0"><label for="orgName">Administradora</label><input id="orgName" value="Administradora Demo" /></div>
              <div class="field" style="margin:0"><label for="userName">Seu nome</label><input id="userName" value="Operador" /></div>
              <div class="field" style="margin:0"><label for="bootKey">Chave de bootstrap</label><input id="bootKey" placeholder="HOSFERA_BOOTSTRAP" /></div>
              <button class="btn btn-gold btn-block" id="bootstrap">Criar e entrar</button>
              <div class="hint">Só funciona com a chave do servidor. Em produção este caminho fica desligado.</div>
            </div>
          </details>
        </div>
      </section>
    </div>`),
  );

  const submit = async () => {
    const token = $('#token').value.trim();
    if (!token) return;
    state.token = token;
    localStorage.setItem('hosfera.token', token);
    try {
      await boot();
    } catch (error) {
      state.token = '';
      localStorage.removeItem('hosfera.token');
      $('#err').textContent = error.message;
    }
  };
  $('#enter').addEventListener('click', submit);
  $('#token').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });
  $('#bootstrap').addEventListener('click', async () => {
    try {
      const response = await fetch('/v1/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bootstrap-key': $('#bootKey').value.trim() },
        body: JSON.stringify({ orgName: $('#orgName').value, userName: $('#userName').value }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? 'falha ao criar');
      state.token = data.token;
      localStorage.setItem('hosfera.token', data.token);
      await boot();
      toast('Organização criada');
    } catch (error) {
      $('#err').textContent = error.message;
    }
  });
}

function logout() {
  state.token = '';
  localStorage.removeItem('hosfera.token');
  renderAuth();
}

// ───────────────────────────── shell ─────────────────────────────

const VIEWS = {
  dashboard: { title: 'Visão geral', crumb: 'Operação', icon: 'dashboard' },
  calendar: { title: 'Calendário', crumb: 'Operação', icon: 'calendar' },
  reservations: { title: 'Reservas', crumb: 'Operação', icon: 'book' },
  tasks: { title: 'Tarefas', crumb: 'Operação', icon: 'tasks' },
  channels: { title: 'Canais', crumb: 'Distribuição', icon: 'plug' },
  properties: { title: 'Imóveis', crumb: 'Cadastro', icon: 'home' },
  finance: { title: 'Financeiro', crumb: 'Gestão', icon: 'wallet' },
};

function renderShell() {
  const navGroups = [
    { label: 'Operação', items: ['dashboard', 'calendar', 'reservations', 'tasks'] },
    { label: 'Distribuição', items: ['channels', 'properties'] },
    { label: 'Gestão', items: ['finance'] },
  ];

  document.body.replaceChildren(
    el(`<div class="shell">
      <aside class="side">
        <div class="brand">
          <div class="brand-mark"></div>
          <div>
            <div class="brand-name">hosfera</div>
            <div class="brand-sub">PMS · channel manager</div>
          </div>
        </div>

        <div class="org-card">
          <div class="org-avatar">${initials(state.me?.organization?.name)}</div>
          <div style="min-width:0">
            <div class="name">${state.me?.organization?.name ?? 'Organização'}</div>
            <div class="role">${state.me?.user ?? ''} · ${state.me?.role ?? ''}</div>
          </div>
        </div>

        ${navGroups
          .map(
            (group) => `<div class="nav-group">
              <div class="nav-label">${group.label}</div>
              ${group.items
                .map(
                  (key) => `<button class="nav-item${state.tab === key ? ' active' : ''}" data-tab="${key}">
                    ${icon(VIEWS[key].icon)}<span>${VIEWS[key].title}</span>
                    ${key === 'tasks' && state.tasks.length ? `<span class="badge-count">${state.tasks.length}</span>` : ''}
                  </button>`,
                )
                .join('')}
            </div>`,
          )
          .join('')}

        <div class="side-sep"></div>
        <div class="units-nav" id="unitsNav"></div>
        <div class="side-foot">
          <button class="btn" id="logout">${icon('logout', 15)}<span>Sair</span></button>
        </div>
      </aside>

      <div class="main">
        <header class="head">
          <div>
            <div class="crumbs">${VIEWS[state.tab].crumb} · <b id="crumbUnit"></b></div>
            <h1 id="viewTitle">${VIEWS[state.tab].title}</h1>
          </div>
          <div class="head-actions" id="headActions"></div>
        </header>
        <main class="content" id="content"></main>
      </div>

      <div class="backdrop" id="backdrop"></div>
      <aside class="drawer" id="drawer"></aside>
    </div>`),
  );

  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', async () => {
      state.tab = button.dataset.tab;
      document.querySelectorAll('[data-tab]').forEach((node) => node.classList.toggle('active', node === button));
      $('#viewTitle').textContent = VIEWS[state.tab].title;
      $('.crumbs').innerHTML = `${VIEWS[state.tab].crumb} · <b id="crumbUnit"></b>`;
      renderUnitsNav();
      await renderContent();
    });
  });

  $('#logout').addEventListener('click', logout);
  $('#backdrop').addEventListener('click', closeDrawer);
  renderUnitsNav();
}

function renderUnitsNav() {
  const nav = $('#unitsNav');
  if (!nav) return;
  const crumb = $('#crumbUnit');
  if (crumb) crumb.textContent = state.unit ? state.unit.name : 'sem unidade';

  if (state.properties.length === 0) {
    nav.innerHTML = '<div class="nav-label">Unidades</div><div class="hint" style="padding:0 8px;color:#767d84">Nenhum imóvel</div>';
    return;
  }

  nav.innerHTML = state.properties
    .map((property) => {
      const units = state.units.filter((unit) => unit.propertyId === property.id);
      return `<div class="prop-name">${property.name}</div>
        ${units
          .map(
            (unit) => `<div class="unit-row${state.unit?.id === unit.id ? ' active' : ''}" data-unit="${unit.id}">
              <span>${unit.name}</span><span class="inv">${unit.inventory}</span>
            </div>`,
          )
          .join('')}`;
    })
    .join('');

  nav.querySelectorAll('[data-unit]').forEach((node) => {
    node.addEventListener('click', async () => {
      state.unit = state.units.find((unit) => unit.id === node.dataset.unit) ?? null;
      state.availability = [];
      state.icalSources = [];
      renderUnitsNav();
      await renderContent();
    });
  });
}

function setActions(html, bindings = {}) {
  const slot = $('#headActions');
  slot.innerHTML = html;
  for (const [id, handler] of Object.entries(bindings)) {
    slot.querySelector(`#${id}`)?.addEventListener('click', handler);
  }
}

// ───────────────────────────── dados ─────────────────────────────

async function loadWorkspace() {
  const [summary, channels, connections, reservations, tasks, listings] = await Promise.all([
    api('/v1/summary'),
    api('/v1/channels'),
    api('/v1/connections'),
    api('/v1/reservations?limit=100'),
    api('/v1/tasks'),
    api('/v1/listings'),
  ]);
  state.summary = summary;
  state.channels = channels;
  state.connections = connections;
  state.reservations = reservations;
  state.tasks = tasks;
  state.listings = listings.map((listing) => ({
    ...listing,
    unitName: state.units.find((unit) => unit.id === listing.unitId)?.name,
    channel: connections.find((connection) => connection.id === listing.connectionId)?.channel ?? '—',
  }));
}

let reservationsCache = [];

async function loadStructure() {
  state.me = await api('/v1/me');
  state.properties = await api('/v1/properties');
  const units = await Promise.all(state.properties.map((property) => api(`/v1/properties/${property.id}/units`)));
  state.units = units.flat();
  // Abrir na unidade com chegada mais próxima evita abrir numa agenda vazia
  // quando a venda está em outra unidade.
  const upcoming = [...reservationsCache]
    .filter((reservation) => ['pending', 'confirmed', 'checked_in'].includes(reservation.status))
    .sort((a, b) => a.checkin.localeCompare(b.checkin))[0];
  state.unit =
    state.units.find((unit) => unit.id === state.unit?.id) ??
    state.units.find((unit) => unit.id === upcoming?.unitId) ??
    state.units[0] ??
    null;
}

async function loadAvailability() {
  if (!state.unit) return;
  const from = state.calStart || iso(new Date());
  state.availability = await api(`/v1/units/${state.unit.id}/availability?from=${from}&to=${addDays(from, 56)}`);
}

async function loadIcalSources() {
  if (!state.unit) {
    state.icalSources = [];
    return;
  }
  state.icalSources = await api(`/v1/units/${state.unit.id}/ical-sources`);
}

async function boot() {
  reservationsCache = await api('/v1/reservations?limit=100').catch(() => []);
  await loadStructure();
  await loadWorkspace();
  reservationsCache = state.reservations;
  state.calStart = iso(new Date());
  await loadAvailability();
  renderShell();
  await renderContent();
}

async function refreshAll() {
  await loadStructure();
  await loadWorkspace();
  await loadAvailability();
  renderUnitsNav();
  await renderContent();
}

// ───────────────────────────── visão geral ─────────────────────────────

async function renderDashboard() {
  setActions(`<button class="btn btn-sm" id="refresh">${icon('refresh', 14)} Atualizar</button>`, {
    refresh: async () => {
      await refreshAll();
      toast('Dados atualizados');
    },
  });

  // Visão geral é da operação inteira, não da unidade selecionada: somar todas
  // evita a leitura errada de "0% de ocupação" quando a venda está em outra unidade.
  const today = iso(new Date());
  const perUnit = await Promise.all(
    state.units.slice(0, 12).map((unit) =>
      api(`/v1/units/${unit.id}/availability?from=${today}&to=${addDays(today, 30)}`).catch(() => []),
    ),
  );
  const byDate = new Map();
  for (const days of perUnit) {
    for (const day of days) {
      const acc = byDate.get(day.date) ?? { inventory: 0, available: 0, rateCents: null };
      acc.inventory += day.inventory;
      acc.available += day.available;
      acc.rateCents = day.rateCents ?? acc.rateCents;
      byDate.set(day.date, acc);
    }
  }
  const next30 = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 30)
    .map(([date, acc]) => ({ date, ...acc }));
  const capacity = next30.reduce((sum, day) => sum + day.inventory, 0);
  const free = next30.reduce((sum, day) => sum + day.available, 0);
  const occupancy = capacity ? Math.round(((capacity - free) / capacity) * 100) : 0;

  const upcoming = [...state.reservations]
    .filter((reservation) => reservation.checkin >= today && reservation.status !== 'cancelled')
    .sort((a, b) => a.checkin.localeCompare(b.checkin))
    .slice(0, 5);

  const soldOut = next30.filter((day) => day.available === 0).length;
  // Diária média = receita das reservas ÷ noites vendidas no período.
  // Usar a tarifa anunciada daria um número que nunca foi praticado.
  const windowed = state.reservations.filter(
    (reservation) =>
      reservation.status !== 'cancelled' &&
      reservation.checkin >= today &&
      reservation.checkin <= addDays(today, 30),
  );
  const windowedNights = windowed.reduce(
    (sum, reservation) => sum + nights(reservation.checkin, reservation.checkout),
    0,
  );
  const adr = windowedNights
    ? windowed.reduce((sum, reservation) => sum + reservation.totalCents, 0) / windowedNights
    : 0;

  const attention = [];
  if (state.summary?.outbox?.dead > 0)
    attention.push({
      label: 'Eventos em dead-letter',
      value: state.summary.outbox.dead,
      note: 'não serão reenviados sem ação',
      tone: 'critical',
      go: 'channels',
    });
  if (state.summary?.outbox?.failed > 0)
    attention.push({ label: 'Eventos com falha', value: state.summary.outbox.failed, note: 'serão reprocessados', tone: 'warning' });
  if (state.tasks.length > 0)
    attention.push({
      label: 'Tarefas pendentes',
      value: state.tasks.length,
      note: 'limpeza, check-in e check-out',
      tone: 'warning',
      go: 'tasks',
    });
  const semIntegracao = state.channels.filter((channel) => !channel.implemented && channel.channel !== 'mock');
  if (semIntegracao.length > 0)
    attention.push({
      label: 'Canais sem integração',
      value: semIntegracao.length,
      note: semIntegracao.map((channel) => channelLabel(channel.channel)).join(', '),
      tone: 'warning',
      go: 'channels',
    });

  $('#content').replaceChildren(
    el(`<div>
      <div class="kpis">
        <div class="kpi accent">
          <div class="l">Ocupação · 30 dias</div>
          <div class="n">${occupancy}%</div>
          <div class="d">todas as unidades · ${capacity - free} de ${plural(capacity, 'unidade-noite', 'unidades-noite')}</div>
        </div>
        <div class="kpi">
          <div class="l">Receita ativa</div>
          <div class="n">${brl(state.summary?.grossCents ?? 0)}</div>
          <div class="d">${plural(state.summary?.activeReservations ?? 0, 'reserva ativa', 'reservas ativas')} · líquido ${brl(state.summary?.netCents ?? 0)}</div>
        </div>
        <div class="kpi">
          <div class="l">Diária média vendida</div>
          <div class="n">${brl(adr)}</div>
          <div class="d">${plural(windowed.length, 'reserva', 'reservas')} nos próximos 30 dias</div>
        </div>
        <div class="kpi ${soldOut > 0 ? 'danger' : ''}">
          <div class="l">Noites esgotadas</div>
          <div class="n">${soldOut}</div>
          <div class="d">${soldOut > 0 ? 'sem disponibilidade para vender' : 'agenda com folga'}</div>
        </div>
      </div>

      <div class="split">
        <div class="card">
          <div class="card-head">
            <div><h2>Ocupação dos próximos 30 dias</h2><div class="sub">todas as unidades · preenchimento = proporção vendida no dia</div></div>
            <a class="link-btn" href="#" id="goCalendar">abrir calendário →</a>
          </div>
          <div class="card-body">
            ${
              next30.length
                ? (capacity - free === 0
                    ? `<div class="chart-empty">
                         <div class="t">Nenhuma noite vendida nos próximos 30 dias</div>
                         <div class="h">${plural(capacity, 'unidade-noite livre', 'unidades-noite livres')} em ${plural(state.units.reduce((sum, unit) => sum + unit.inventory, 0), 'unidade de inventário', 'unidades de inventário')} — o gráfico aparece quando houver reserva no período.</div>
                       </div>`
                    : `<div class="chart">${next30
                    .map((day) => {
                      const sold = Math.max(0, day.inventory - day.available);
                      const pct = day.inventory ? Math.round((sold / day.inventory) * 100) : 0;
                      return `<div class="col" title="${fmtFull(day.date)} · ${sold} de ${day.inventory} vendidas">
                        <div class="track${day.date === today ? ' today' : ''}">
                          <div class="fill${pct === 100 ? ' sold' : ''}" style="height:${pct === 0 ? 0 : Math.max(6, pct)}%"></div>
                        </div>
                      </div>`;
                    })
                    .join('')}</div>
                  <div class="chart-axis"><span>${fmtDate(next30[0]?.date)}</span><span>${fmtDate(next30[Math.floor(next30.length / 2)]?.date)}</span><span>${fmtDate(next30[next30.length - 1]?.date)}</span></div>
                  <div class="chart-foot">${capacity - free} de ${plural(capacity, 'unidade-noite vendida', 'unidades-noite vendidas')} · pico de ${Math.max(...next30.map((d) => (d.inventory ? Math.round(((d.inventory - d.available) / d.inventory) * 100) : 0)))}% — cada barra é um dia</div>`)
                : empty('Sem dados de disponibilidade', 'Cadastre um imóvel com unidade e tarifa.')
            }
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h2>Precisa de atenção</h2><div class="sub">o que trava a operação hoje</div></div></div>
          ${
            attention.length
              ? `<div class="list">${attention
                  .map(
                    (item) => `<div class="list-row${item.go ? ' clickable' : ''}" ${item.go ? `data-go="${item.go}"` : ''}>
                      <div class="main-col"><div class="t">${item.label}</div><div class="h">${item.note}</div></div>
                      <div class="right"><span class="pill ${item.tone}">${item.value}</span></div>
                    </div>`,
                  )
                  .join('')}</div>`
              : empty('Nada pendente', 'Filas, tarefas e canais em ordem.')
          }
        </div>
      </div>

      <div class="card" style="margin-top:18px">
        <div class="card-head">
          <div><h2>Próximas chegadas</h2><div class="sub">por data de check-in</div></div>
          <span class="hint">${upcoming.length} de ${plural(state.reservations.length, 'reserva', 'reservas')}</span>
        </div>
        ${
          upcoming.length
            ? `<table><thead><tr><th>Hóspede</th><th>Período</th><th>Canal</th><th>Status</th><th class="num">Total</th></tr></thead>
              <tbody>${upcoming
                .map(
                  (reservation) => `<tr>
                    <td><div class="cell-person"><span class="avatar">${initials(reservation.guestName)}</span>
                      <div><span class="k">${reservation.guestName ?? 'Sem nome'}</span>
                      <span class="sub">${plural(nights(reservation.checkin, reservation.checkout), 'noite', 'noites')} · ${plural(reservation.guests ?? 0, 'hóspede', 'hóspedes')}</span></div></div></td>
                    <td>${fmtFull(reservation.checkin)}<span class="sub">até ${fmtFull(reservation.checkout)}</span></td>
                    <td><span class="tag">${channelLabel(reservation.channel)}</span></td>
                    <td><span class="pill ${reservation.status}">${pt(reservation.status)}</span></td>
                    <td class="num k">${brl(reservation.totalCents)}</td>
                  </tr>`,
                )
                .join('')}</tbody></table>`
            : empty('Nenhuma chegada prevista', 'Reservas novas aparecem aqui assim que entrarem.')
        }
      </div>
    </div>`),
  );

  document.querySelectorAll('[data-go]').forEach((node) => {
    node.addEventListener('click', () => document.querySelector(`[data-tab="${node.dataset.go}"]`)?.click());
  });

  $('#goCalendar')?.addEventListener('click', (event) => {
    event.preventDefault();
    document.querySelector('[data-tab="calendar"]')?.click();
  });
}

// ───────────────────────────── calendário ─────────────────────────────

async function renderCalendar() {
  setActions(
    `<div class="cal-toolbar">
      <button class="btn btn-sm" id="prev">←</button>
      <button class="btn btn-sm" id="today">Hoje</button>
      <button class="btn btn-sm" id="next">→</button>
    </div>`,
    {
      prev: async () => {
        state.calStart = addDays(state.calStart, -28);
        await loadAvailability();
        await renderCalendar();
      },
      next: async () => {
        state.calStart = addDays(state.calStart, 28);
        await loadAvailability();
        await renderCalendar();
      },
      today: async () => {
        state.calStart = iso(new Date());
        await loadAvailability();
        await renderCalendar();
      },
    },
  );

  if (!state.unit) {
    $('#content').replaceChildren(el(empty('Nenhuma unidade selecionada', 'Cadastre um imóvel em Imóveis.')));
    return;
  }

  const days = state.availability;
  const today = iso(new Date());
  const inWindow = days.filter((day) => day.date >= today).slice(0, 30);
  const capacity = inWindow.reduce((sum, day) => sum + day.inventory, 0);
  const free = inWindow.reduce((sum, day) => sum + day.available, 0);
  const occupancy = capacity ? Math.round(((capacity - free) / capacity) * 100) : 0;

  $('#content').replaceChildren(
    el(`<div>
      <div class="kpis">
        <div class="kpi accent"><div class="l">Ocupação</div><div class="n">${occupancy}%</div><div class="d">próximos 30 dias</div></div>
        <div class="kpi"><div class="l">Inventário</div><div class="n">${state.unit.inventory}</div><div class="d">${state.unit.capacity ?? 2} hóspedes por unidade</div></div>
        <div class="kpi"><div class="l">Noites livres</div><div class="n">${free}</div><div class="d">de ${capacity} unidades-noite</div></div>
        <div class="kpi"><div class="l">Fechadas</div><div class="n">${days.filter((day) => day.closed).length}</div><div class="d">bloqueio manual no período</div></div>
      </div>

      <div class="card">
        <div class="card-head">
          <div><h2>${state.unit.name}</h2><div class="sub">${fmtFull(days[0]?.date)} → ${fmtFull(days[days.length - 1]?.date)} · preço, disponibilidade e bloqueios</div></div>
          <div class="legend">
            <span><span class="swatch" style="background:#fff"></span>livre</span>
            <span><span class="swatch" style="background:#fdf4f3;border-color:#f0d9d6"></span>reservado</span>
            <span><span class="swatch" style="background:#f2ecdf;border-color:#e3d5bd"></span>fechado</span>
          </div>
        </div>
        <div class="card-body">
          <div class="weekdays"><div>seg</div><div>ter</div><div>qua</div><div>qui</div><div>sex</div><div>sáb</div><div>dom</div></div>
          <div class="cal" id="cal"></div>
        </div>
      </div>
    </div>`),
  );

  const cal = $('#cal');
  const first = new Date(`${state.calStart}T00:00:00Z`);
  const offset = (first.getUTCDay() + 6) % 7;
  for (let i = 0; i < offset; i++) cal.appendChild(el('<div></div>'));

  for (const day of days) {
    const weekday = new Date(`${day.date}T00:00:00Z`).getUTCDay();
    const cls = ['day'];
    if (day.closed) cls.push('closed');
    else if (day.available === 0) cls.push('sold');
    if (weekday === 0 || weekday === 6) cls.push('weekend');
    if (day.date === today) cls.push('today');
    if (day.date < today) cls.push('past');

    const status = day.closed
      ? 'fechado'
      : day.available === 0
        ? 'reservado'
        : `${day.available} livre${day.available > 1 ? 's' : ''}`;
    const isFirstOfMonth = day.date.endsWith('-01');
    const cell = el(`<div class="${cls.join(' ')}" title="${fmtFull(day.date)}">
      <span class="d">${isFirstOfMonth ? `${MONTHS[Number(day.date.slice(5, 7)) - 1]} 01` : fmtDate(day.date)}${day.date === today ? ' · hoje' : ''}</span>
      <span class="p">${day.rateCents ? brl(day.rateCents) : '—'}</span>
      <span class="a">${status}</span>
      ${day.reserved ? '<span class="bar"></span>' : ''}
    </div>`);
    if (day.date >= today && can('ari:write')) cell.addEventListener('click', () => openDayEditor(day, cell));
    cal.appendChild(cell);
  }
}

function openDayEditor(day, cell) {
  document.querySelectorAll('.day.focus').forEach((node) => node.classList.remove('focus'));
  cell?.classList.add('focus');

  const drawer = $('#drawer');
  drawer.replaceChildren(
    el(`<div style="display:contents">
      <div>
        <h2>${fmtFull(day.date)}</h2>
        <div class="sub">${state.unit.name} · ${day.reserved} reservada(s) · ${day.available} de ${day.inventory} livres</div>
      </div>
      <div class="field">
        <label for="price">Preço da noite (R$)</label>
        <input id="price" type="number" min="0" step="10" value="${day.rateCents ? (day.rateCents / 100).toFixed(0) : ''}" placeholder="usa a tarifa base" />
        <div class="hint">vazio = tarifa base do rate plan</div>
      </div>
      <div class="form-grid two">
        <div class="field"><label for="minStay">Mínimo de noites</label><input id="minStay" type="number" min="1" value="${day.minStay ?? 1}" /></div>
        <div class="field"><label for="available">Disponível</label><input id="available" type="number" min="0" max="${day.inventory}" value="${day.available}" /><div class="hint">inventário: ${day.inventory}</div></div>
      </div>
      <label style="display:flex;gap:9px;align-items:center;text-transform:none;letter-spacing:0;font-size:13px;color:var(--ink-2)">
        <input id="closed" type="checkbox" ${day.closed ? 'checked' : ''} /> Fechar esta data para venda
      </label>
      <div class="actions">
        <button class="btn btn-primary" id="save">Aplicar</button>
        <button class="btn" id="cancel">Cancelar</button>
      </div>
    </div>`),
  );
  $('#backdrop').classList.add('open');
  drawer.classList.add('open');
  $('#cancel').addEventListener('click', closeDrawer);
  $('#save').addEventListener('click', async () => {
    try {
      const price = $('#price').value === '' ? null : Math.round(Number($('#price').value) * 100);
      const result = await api(`/v1/units/${state.unit.id}/ari`, {
        method: 'PUT',
        body: {
          days: [
            {
              date: day.date,
              rateCents: price,
              minStay: Number($('#minStay').value) || null,
              available: Number($('#available').value),
              closed: $('#closed').checked,
            },
          ],
        },
      });
      closeDrawer();
      await loadAvailability();
      await renderCalendar();
      toast(`${fmtFull(day.date)} atualizado · ${result.events} evento(s) no outbox`);
    } catch (error) {
      toast(error.message, true);
    }
  });
}

function closeDrawer() {
  $('#drawer')?.classList.remove('open');
  $('#backdrop')?.classList.remove('open');
  document.querySelectorAll('.day.focus').forEach((node) => node.classList.remove('focus'));
}

// ───────────────────────────── reservas ─────────────────────────────

async function renderReservations() {
  setActions('');
  const rows = state.reservations
    .map(
      (reservation) => `<tr>
        <td><div class="cell-person"><span class="avatar">${initials(reservation.guestName)}</span>
          <div><span class="k">${reservation.guestName ?? 'Sem nome'}</span>
          <span class="sub">${state.units.find((unit) => unit.id === reservation.unitId)?.name ?? ''}</span></div></div></td>
        <td>${fmtFull(reservation.checkin)}<span class="sub">até ${fmtFull(reservation.checkout)} · ${plural(nights(reservation.checkin, reservation.checkout), 'noite', 'noites')}</span></td>
        <td><span class="tag">${channelLabel(reservation.channel)}</span></td>
        <td><span class="pill ${reservation.status}">${pt(reservation.status)}</span></td>
        <td class="num">${brl(reservation.totalCents)}<span class="sub">comissão ${brl(reservation.commissionCents)}</span></td>
        <td class="row-actions">${
          can('reservation:write') && ['confirmed', 'checked_in'].includes(reservation.status)
            ? `<button class="btn btn-sm" data-status="${reservation.id}" data-next="${reservation.status === 'confirmed' ? 'checked_in' : 'checked_out'}">
                ${reservation.status === 'confirmed' ? 'Check-in' : 'Check-out'}</button>`
            : ''
        }</td>
      </tr>`,
    )
    .join('');

  $('#content').replaceChildren(
    el(`<div class="card">
      <div class="card-head"><div><h2>Reservas</h2><div class="sub">${plural(state.reservations.length, 'registro', 'registros')} · todas as unidades</div></div></div>
      ${
        state.reservations.length
          ? `<table><thead><tr><th>Hóspede</th><th>Período</th><th>Canal</th><th>Status</th><th class="num">Valor</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
          : empty('Nenhuma reserva ainda', 'Publique um anúncio ou use o simulador de canal para exercitar o fluxo.')
      }
    </div>`),
  );

  document.querySelectorAll('[data-status]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await api(`/v1/reservations/${button.dataset.status}/status`, {
          method: 'POST',
          body: { status: button.dataset.next },
        });
        await loadWorkspace();
        await loadAvailability();
        await renderReservations();
        toast('Status atualizado');
      } catch (error) {
        toast(error.message, true);
      }
    });
  });
}

// ───────────────────────────── tarefas ─────────────────────────────

async function renderTasks() {
  setActions('');
  const groups = new Map();
  for (const task of state.tasks) {
    if (!groups.has(task.dueDate)) groups.set(task.dueDate, []);
    groups.get(task.dueDate).push(task);
  }

  const list = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([date, tasks]) => `<div class="list-row">
        <div style="width:96px"><div class="t">${fmtFull(date)}</div><div class="h">${plural(tasks.length, 'tarefa', 'tarefas')}</div></div>
        <div class="main-col" style="display:flex;gap:6px;flex-wrap:wrap">
          ${tasks
            .map(
              (task) => `<span class="tag on">${pt(task.type)}<span style="color:var(--muted)"> · ${
                state.units.find((unit) => unit.id === task.unitId)?.name ?? '—'
              }</span></span>`,
            )
            .join('')}
        </div>
      </div>`,
    )
    .join('');

  $('#content').replaceChildren(
    el(`<div class="card">
      <div class="card-head"><div><h2>Operação por data</h2><div class="sub">${plural(state.tasks.length, 'tarefa pendente', 'tarefas pendentes')}</div></div></div>
      ${state.tasks.length ? `<div class="list">${list}</div>` : empty('Sem tarefas pendentes', 'Limpeza e check-in são criados junto com a reserva.')}
    </div>`),
  );
}

// ───────────────────────────── canais + iCal ─────────────────────────────

async function renderChannels() {
  setActions('');
  await loadIcalSources();

  const cards = state.channels
    .map((channel) => {
      const capabilities = Object.entries(channel.capabilities)
        .map(([key, on]) => `<span class="tag ${on ? 'on' : 'off'}">${key}</span>`)
        .join('');
      const connections = state.connections.filter((connection) => connection.channel === channel.channel);
      const implemented = channel.channel === 'mock' || channel.implemented;
      return `<div class="channel">
        <div class="channel-top">
          <h3>${channelLabel(channel.channel)}</h3>
          <span class="pill ${implemented ? 'gold' : 'warning'}">${channel.channel === 'mock' ? 'dev' : implemented ? 'protocolo' : 'pendente'}</span>
        </div>
        <div class="state muted">${
          channel.channel === 'mock'
            ? 'canal de desenvolvimento, sem homologação'
            : channel.implemented
              ? 'protocolo implementado · homologação pendente'
              : 'sem integração — exige programa de parceiro'
        }</div>
        <div class="caps">${capabilities}</div>
        <div class="note">${channel.certification}</div>
        ${
          connections.length
            ? `<div class="caps">${connections
                .map((connection) => `<span class="tag ${connection.status === 'active' ? 'on' : ''}">${connection.label}</span>`)
                .join('')}</div>`
            : ''
        }
      </div>`;
    })
    .join('');

  const listings = state.listings
    .map(
      (listing) => `<tr>
        <td class="k">${listing.unitName ?? listing.unitId.slice(0, 8)}</td>
        <td><span class="tag">${channelLabel(listing.channel)}</span></td>
        <td class="mono">${listing.externalId ?? '—'}</td>
        <td><span class="pill ${listing.status}">${pt(listing.status)}</span></td>
        <td class="row-actions">${
          listing.status !== 'published' && can('listing:publish')
            ? `<button class="btn btn-sm" data-publish="${listing.id}">Publicar</button>`
            : ''
        }</td>
      </tr>`,
    )
    .join('');

  const sourceRows = state.icalSources
    .map(
      (source) => `<div class="list-row">
        <div class="main-col">
          <div class="t">${source.label ?? source.url}</div>
          <div class="h mono">${source.url.length > 56 ? `${source.url.slice(0, 56)}…` : source.url}</div>
          <div class="h">${
            source.lastSyncedAt
              ? `última sync ${new Date(source.lastSyncedAt).toLocaleString('pt-BR')} · ${pt(source.lastStatus ?? '')}`
              : 'nunca sincronizado'
          }${source.lastError ? ` · ${source.lastError}` : ''}</div>
        </div>
        <div class="right">
          <span class="pill ${source.lastStatus === 'error' ? 'critical' : source.lastStatus === 'ok' ? 'ok' : 'draft'}">
            ${source.lastStatus ? pt(source.lastStatus) : 'novo'}
          </span>
        </div>
        <div class="row-actions">
          <button class="btn btn-sm" data-sync="${source.id}">Sincronizar</button>
          <button class="btn btn-sm" data-remove="${source.id}">Remover</button>
        </div>
      </div>`,
    )
    .join('');

  $('#content').replaceChildren(
    el(`<div>
      <div class="channels">${cards}</div>

      <div class="card" style="margin-top:18px">
        <div class="card-head">
          <div><h2>Calendários · iCal</h2><div class="sub">sincronização que funciona hoje, sem homologação de OTA</div></div>
          <span class="pill gold">${plural(state.icalSources.length, 'fonte', 'fontes')}</span>
        </div>
        <div class="card-body">
          ${
            state.unit
              ? `<div class="form-grid two" style="align-items:end">
                  <div class="field" style="margin:0">
                    <label for="icalUrl">URL do feed do canal (.ics)</label>
                    <input id="icalUrl" placeholder="https://www.airbnb.com.br/calendar/ical/12345678.ics" />
                    <div class="hint">Airbnb, Booking e Vrbo exportam por anúncio. Cole o endereço e sincronize.</div>
                  </div>
                  <div class="field" style="margin:0">
                    <label for="icalLabel">Rótulo</label>
                    <div style="display:flex;gap:8px">
                      <input id="icalLabel" placeholder="Airbnb — Suíte Aurora" />
                      <button class="btn btn-primary" id="addSource">Adicionar feed</button>
                    </div>
                  </div>
                </div>`
              : '<div class="hint">Selecione uma unidade para importar calendário.</div>'
          }
        </div>
        ${
          state.icalSources.length
            ? `<div class="list">${sourceRows}</div>`
            : `<div class="list"><div class="list-row"><div class="main-col"><div class="t">Nenhum feed importado</div>
                <div class="h">Enquanto não houver feed, uma reserva feita no Airbnb não fecha esta noite aqui.</div></div></div></div>`
        }
        <div class="card-body" style="border-top:1px solid var(--line-soft)">
          <div class="section-title">exportar calendário de ${state.unit?.name ?? 'esta unidade'}</div>
          <div class="inline">
            <input id="feedUrl" readonly value="carregando…" class="mono input-readonly" style="flex:1" />
            <button class="btn" id="copyFeed">${icon('link', 14)} Copiar</button>
          </div>
          <div class="hint" style="margin-top:8px">
            É esse endereço que você cadastra como "importar calendário" no Airbnb ou Booking. Ele expõe
            apenas as noites ocupadas — nunca hóspede, valor ou documento.
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:18px">
        <div class="card-head"><div><h2>Anúncios</h2><div class="sub">${plural(state.listings.length, 'anúncio vinculado', 'anúncios vinculados')} a canal · todas as unidades</div></div></div>
        ${
          state.listings.length
            ? `<table><thead><tr><th>Unidade</th><th>Canal</th><th>Id externo</th><th>Status</th><th></th></tr></thead><tbody>${listings}</tbody></table>`
            : empty('Nenhum anúncio', 'Publique uma unidade no canal mock para ver o fluxo completo.')
        }
      </div>
    </div>`),
  );

  document.querySelectorAll('[data-publish]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        button.disabled = true;
        const result = await api(`/v1/listings/${button.dataset.publish}/publish`, { method: 'POST' });
        await loadWorkspace();
        await renderChannels();
        toast(`Publicado como ${result.externalId} · ${result.daysSynced} dias sincronizados`);
      } catch (error) {
        button.disabled = false;
        toast(error.message, true);
      }
    });
  });

  document.querySelectorAll('[data-sync]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        button.disabled = true;
        const result = await api(`/v1/ical-sources/${button.dataset.sync}/sync`, { method: 'POST' });
        await loadAvailability();
        await renderChannels();
        toast(result.message ?? 'Feed sincronizado', result.status === 'error');
      } catch (error) {
        button.disabled = false;
        toast(error.message, true);
      }
    });
  });

  document.querySelectorAll('[data-remove]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        const result = await api(`/v1/ical-sources/${button.dataset.remove}`, { method: 'DELETE' });
        await loadAvailability();
        await renderChannels();
        toast(`Fonte removida · ${result.removedBlocks} bloqueio(s) liberado(s)`);
      } catch (error) {
        toast(error.message, true);
      }
    });
  });

  $('#addSource')?.addEventListener('click', async () => {
    try {
      const url = $('#icalUrl').value.trim();
      if (!url) {
        toast('Informe a URL do feed', true);
        return;
      }
      await api(`/v1/units/${state.unit.id}/ical-sources`, {
        method: 'POST',
        body: { url, label: $('#icalLabel').value.trim() || null },
      });
      await renderChannels();
      toast('Fonte adicionada — clique em Sincronizar');
    } catch (error) {
      toast(error.message, true);
    }
  });

  if (state.unit) {
    try {
      const feed = await api(`/v1/units/${state.unit.id}/ical-feed`);
      const input = $('#feedUrl');
      if (input) input.value = `${location.origin}${feed.url}`;
      $('#copyFeed')?.addEventListener('click', async () => {
        await navigator.clipboard.writeText(`${location.origin}${feed.url}`);
        toast('Endereço copiado');
      });
    } catch (error) {
      toast(error.message, true);
    }
  }
}

// ───────────────────────────── imóveis (onboarding) ─────────────────────────────

async function renderProperties() {
  setActions('');
  if (state.amenities.length === 0) state.amenities = await api('/v1/amenities');
  const unit = state.unit;
  const selected = new Set(unit?.amenities ?? []);
  const groups = ['essencial', 'conforto', 'exterior', 'familia'];

  const amenityGroups = groups
    .map((group) => {
      const items = state.amenities.filter((amenity) => amenity.group === group);
      if (!items.length) return '';
      return `<div style="margin-bottom:12px">
        <div class="section-title">${group}</div>
        <div class="inline">
          ${items
            .map(
              (amenity) => `<label class="tag ${selected.has(amenity.code) ? 'on' : ''}"
                style="cursor:pointer;display:inline-flex;gap:6px;align-items:center;text-transform:none;letter-spacing:0;font-weight:500">
                <input type="checkbox" data-amenity="${amenity.code}" ${selected.has(amenity.code) ? 'checked' : ''} style="width:14px;height:14px;min-height:0" />
                ${amenity.label}
              </label>`,
            )
            .join('')}
        </div>
      </div>`;
    })
    .join('');

  $('#content').replaceChildren(
    el(`<div class="split">
      <div class="card">
        <div class="card-head"><div><h2>Novo imóvel</h2><div class="sub">imóvel, unidade e tarifa em uma transação</div></div></div>
        <div class="card-body">
          <div class="form-grid two">
            <div class="field"><label for="obName">Nome do imóvel</label><input id="obName" placeholder="Casa Praia do Forte" /></div>
            <div class="field"><label for="obCity">Cidade</label><input id="obCity" placeholder="Mata de São João" /></div>
            <div class="field"><label for="obOwner">Proprietário</label><input id="obOwner" placeholder="Nome do proprietário" /></div>
            <div class="field"><label for="obShare">Repasse ao proprietário (%)</label><input id="obShare" type="number" min="0" max="100" value="70" /></div>
          </div>
          <hr class="divider" />
          <div class="form-grid three">
            <div class="field"><label for="obUnit">Unidade</label><input id="obUnit" placeholder="Suíte Aurora" /></div>
            <div class="field"><label for="obCapacity">Capacidade</label><input id="obCapacity" type="number" min="1" value="2" /></div>
            <div class="field"><label for="obMinStay">Mín. de noites</label><input id="obMinStay" type="number" min="1" value="2" /></div>
            <div class="field"><label for="obPrice">Preço/noite (R$)</label><input id="obPrice" type="number" min="0" step="10" value="450" /></div>
            <div class="field"><label for="obCleaning">Limpeza (R$)</label><input id="obCleaning" type="number" min="0" step="10" value="150" /></div>
            <div class="field" style="align-self:end"><button class="btn btn-primary btn-block" id="obCreate">Criar imóvel</button></div>
          </div>
          <div class="hint">A unidade nasce com tarifa — sem tarifa ela não vende em canal nenhum.</div>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head">
            <div><h2>${unit ? unit.name : 'Selecione uma unidade'}</h2><div class="sub">comodidades e fotos</div></div>
            ${unit ? '<button class="btn btn-sm" id="obDuplicate">Duplicar</button>' : ''}
          </div>
          <div class="card-body">
            ${unit ? amenityGroups : empty('Nenhuma unidade', 'Crie um imóvel ao lado.')}
            ${unit ? '<button class="btn btn-sm" id="obSaveAmenities">Salvar comodidades</button>' : ''}
            <hr class="divider" />
            <div class="field" style="margin:0">
              <label for="obPhoto">Fotos</label>
              <input id="obPhoto" type="file" accept="image/jpeg,image/png,image/webp" ${unit ? '' : 'disabled'} />
              <div class="hint">JPEG, PNG ou WebP até 8 MB · conteúdo idêntico não duplica</div>
            </div>
            <div id="obPhotos" class="inline" style="margin-top:12px"></div>
          </div>
        </div>
      </div>
    </div>`),
  );

  if (!unit) return;
  await loadPhotos(unit.id);

  $('#obSaveAmenities')?.addEventListener('click', async () => {
    try {
      const codes = [...document.querySelectorAll('[data-amenity]:checked')].map((node) => node.dataset.amenity);
      await api(`/v1/units/${unit.id}/amenities`, { method: 'PUT', body: { codes } });
      await loadStructure();
      await renderProperties();
      toast('Comodidades atualizadas');
    } catch (error) {
      toast(error.message, true);
    }
  });

  $('#obDuplicate')?.addEventListener('click', async () => {
    try {
      const result = await api(`/v1/units/${unit.id}/duplicate`, { method: 'POST', body: { name: `${unit.name} 2` } });
      await loadStructure();
      renderUnitsNav();
      await renderProperties();
      toast(`Unidade criada · ${result.copiedRatePlans} tarifa(s), ${result.copiedAmenities} comodidade(s)`);
    } catch (error) {
      toast(error.message, true);
    }
  });

  $('#obPhoto')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const dataBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.onerror = () => reject(new Error('falha ao ler o arquivo'));
        reader.readAsDataURL(file);
      });
      await api(`/v1/units/${unit.id}/photos`, { method: 'POST', body: { dataBase64, contentType: file.type } });
      await loadPhotos(unit.id);
      toast('Foto enviada');
    } catch (error) {
      toast(error.message, true);
    }
  });

  $('#obCreate')?.addEventListener('click', async () => {
    try {
      const result = await api('/v1/onboarding', {
        method: 'POST',
        body: {
          property: {
            name: $('#obName').value || 'Novo imóvel',
            city: $('#obCity').value || null,
            ownerName: $('#obOwner').value || null,
            ownerSharePct: Number($('#obShare').value) || 70,
          },
          units: [
            {
              name: $('#obUnit').value || 'Unidade 1',
              capacity: Number($('#obCapacity').value) || 2,
              basePriceCents: Math.round(Number($('#obPrice').value || 0) * 100),
              cleaningFeeCents: Math.round(Number($('#obCleaning').value || 0) * 100),
              minStay: Number($('#obMinStay').value) || 1,
            },
          ],
        },
      });
      await loadStructure();
      state.unit = state.units.find((item) => item.id === result.units[0]?.id) ?? state.unit;
      await loadWorkspace();
      await loadAvailability();
      renderUnitsNav();
      await renderProperties();
      toast('Imóvel criado — unidade pronta para publicar');
    } catch (error) {
      toast(error.message, true);
    }
  });
}

async function loadPhotos(unitId) {
  const container = $('#obPhotos');
  if (!container) return;
  try {
    const photos = await api(`/v1/units/${unitId}/photos`);
    container.innerHTML = photos.length
      ? photos
          .map(
            (photo) => `<div style="position:relative">
              <img src="${photo.url}?t=${encodeURIComponent(state.token)}" alt="" width="92" height="70"
                   style="object-fit:cover;border-radius:9px;border:1px solid var(--line)" />
              <button class="btn btn-sm" data-del-photo="${photo.id}" title="remover"
                      style="position:absolute;top:-7px;right:-7px;min-height:22px;padding:0 6px">×</button>
            </div>`,
          )
          .join('')
      : '<span class="hint">Nenhuma foto ainda.</span>';
    container.querySelectorAll('[data-del-photo]').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          await api(`/v1/photos/${button.dataset.delPhoto}`, { method: 'DELETE' });
          await loadPhotos(unitId);
        } catch (error) {
          toast(error.message, true);
        }
      });
    });
  } catch {
    container.innerHTML = '<span class="hint">Não foi possível carregar as fotos.</span>';
  }
}

// ───────────────────────────── financeiro ─────────────────────────────

async function renderFinance() {
  setActions('');
  const from = state.calStart || iso(new Date());
  const to = addDays(from, 120);

  const [finance, reconciliation] = await Promise.all([
    api(`/v1/finance/payouts?from=${from}&to=${to}`),
    api(`/v1/reconciliation?from=${from}&to=${to}`),
  ]);

  const payoutRows = finance.properties
    .map(
      (entry) => `<tr>
        <td class="k">${entry.propertyName}<span class="sub">${entry.ownerName ?? 'sem proprietário'}</span></td>
        <td class="num">${brlExact(entry.payout.grossCents)}</td>
        <td class="num muted">−${brlExact(entry.payout.commissionCents)}</td>
        <td class="num">${brlExact(entry.payout.netCents)}</td>
        <td class="num">${entry.ownerSharePct}%</td>
        <td class="num k">${brlExact(entry.payout.ownerPayableCents)}</td>
      </tr>`,
    )
    .join('');

  const channelRows = finance.channels
    .map(
      (row) => `<tr>
        <td class="k">${channelLabel(row.channel)}</td>
        <td class="num">${brlExact(row.grossCents)}</td>
        <td class="num muted">−${brlExact(row.commissionCents)}</td>
        <td class="num">${brlExact(row.netCents)}</td>
        <td class="num">${row.netMarginPct}%</td>
      </tr>`,
    )
    .join('');

  const issueRows = reconciliation.issues
    .map(
      (issue) => `<tr>
        <td><span class="pill ${issue.severity}">${pt(issue.severity)}</span></td>
        <td class="k">${issue.kind.replace(/_/g, ' ')}</td>
        <td class="muted">${issue.message}</td>
      </tr>`,
    )
    .join('');

  $('#content').replaceChildren(
    el(`<div>
      <div class="kpis">
        <div class="kpi"><div class="l">Bruto no período</div><div class="n">${brlExact(finance.totals.grossCents)}</div><div class="d">${finance.from} → ${finance.to}</div></div>
        <div class="kpi"><div class="l">Líquido</div><div class="n">${brlExact(finance.totals.netCents)}</div><div class="d">após comissões de canal</div></div>
        <div class="kpi accent"><div class="l">Repasse a proprietários</div><div class="n">${brlExact(finance.totals.ownerPayableCents)}</div><div class="d">calculado sobre o líquido</div></div>
        <div class="kpi ${reconciliation.counts.critical ? 'danger' : ''}"><div class="l">Críticos na conciliação</div><div class="n">${reconciliation.counts.critical}</div><div class="d">${plural(reconciliation.counts.warning, 'aviso', 'avisos')}</div></div>
      </div>

      <div class="card">
        <div class="card-head"><div><h2>Repasse por proprietário</h2><div class="sub">percentual aplicado sobre o valor líquido</div></div><span class="hint">${plural(finance.totals.nights, 'noite vendida', 'noites vendidas')}</span></div>
        ${
          finance.properties.length
            ? `<table><thead><tr><th>Imóvel / proprietário</th><th class="num">Bruto</th><th class="num">Comissão</th><th class="num">Líquido</th><th class="num">%</th><th class="num">Repasse</th></tr></thead><tbody>${payoutRows}</tbody></table>`
            : empty('Sem estadias no período', 'O relatório considera a data de check-in.')
        }
      </div>

      <div class="split" style="margin-top:18px">
        <div class="card">
          <div class="card-head"><div><h2>Margem por canal</h2><div class="sub">quanto sobra depois da comissão</div></div></div>
          ${
            finance.channels.length
              ? `<table><thead><tr><th>Canal</th><th class="num">Bruto</th><th class="num">Comissão</th><th class="num">Líquido</th><th class="num">Margem</th></tr></thead><tbody>${channelRows}</tbody></table>`
              : empty('Sem reservas no período', 'A margem aparece quando houver estadia confirmada.')
          }
        </div>
        <div class="card">
          <div class="card-head"><div><h2>Conciliação</h2><div class="sub">o que impede fechar o mês</div></div></div>
          ${
            reconciliation.issues.length
              ? `<table><thead><tr><th>Severidade</th><th>Problema</th><th>Detalhe</th></tr></thead><tbody>${issueRows}</tbody></table>`
              : empty('Tudo confere', 'Reservas, lançamentos e anúncios batem no período.')
          }
        </div>
      </div>
    </div>`),
  );
}

// ───────────────────────────── orquestração ─────────────────────────────

async function renderContent() {
  try {
    if (state.tab === 'dashboard') await renderDashboard();
    if (state.tab === 'calendar') await renderCalendar();
    if (state.tab === 'reservations') await renderReservations();
    if (state.tab === 'tasks') await renderTasks();
    if (state.tab === 'channels') await renderChannels();
    if (state.tab === 'properties') await renderProperties();
    if (state.tab === 'finance') await renderFinance();
  } catch (error) {
    if (error.status === 401) {
      logout();
      return;
    }
    $('#content').replaceChildren(el(empty('Não foi possível carregar', error.message)));
  }
}

(async () => {
  const urlToken = new URLSearchParams(location.search).get('t');
  if (urlToken) {
    state.token = urlToken.trim();
    localStorage.setItem('hosfera.token', state.token);
    history.replaceState({}, '', location.pathname);
  }

  if (!state.token) return renderAuth();
  try {
    await boot();
  } catch (error) {
    state.token = '';
    localStorage.removeItem('hosfera.token');
    renderAuth(error.message);
  }
})();
