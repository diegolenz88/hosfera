/**
 * hosfera — tela operacional (sem build, sem framework).
 *
 * Consome a mesma API pública; nenhuma regra de negócio vive aqui.
 * Token fica em localStorage: é um cliente de confiança zero — toda autorização
 * é refeita no servidor a cada requisição.
 */

const state = {
  token: localStorage.getItem('hosfera.token') ?? '',
  me: null,
  properties: [],
  units: [],
  unit: null,
  tab: 'calendar',
  calStart: null,
  availability: [],
  reservations: [],
  tasks: [],
  connections: [],
  channels: [],
  summary: null,
  dayEditor: null,
};

const $ = (sel) => document.querySelector(sel);
const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

const brl = (cents) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (dateStr, n) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
const fmtDate = (s) => {
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y.slice(2)}`;
};

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    logout();
    throw new Error('sessão expirada: informe o token novamente');
  }
  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.message ?? `erro ${res.status}`);
  return data;
}

function toast(message, isError = false) {
  let node = $('.toast');
  if (!node) {
    node = el('<div class="toast"></div>');
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    node.className = 'toast';
  }, 2600);
}

const can = (action) => Boolean(state.me?.permissions?.includes(action));

// ───────────────────────────── login ─────────────────────────────

function renderLogin() {
  document.body.replaceChildren(
    el(`<div class="login">
      <div class="login-card">
        <div class="brand">
          <div class="brand-mark"></div>
          <div>
            <div class="brand-name">hosfera</div>
            <div class="brand-sub">PMS · channel manager</div>
          </div>
        </div>
        <h1>Acessar a operação</h1>
        <p>Cole o token da sua organização. Cada token carrega organização e papel.</p>
        <label for="token">Token de acesso</label>
        <input id="token" type="password" placeholder="hsk_..." autocomplete="off" spellcheck="false" />
        <button class="btn btn-primary btn-full" id="enter">Entrar</button>
        <div class="error" id="err"></div>
        <div class="divider"></div>
        <details>
          <summary class="hint" style="cursor:pointer">Ambiente local: criar organização demo</summary>
          <div style="margin-top:10px;display:grid;gap:8px">
            <input id="orgName" placeholder="Nome da administradora" value="Administradora Demo" />
            <input id="userName" placeholder="Seu nome" value="Operador" />
            <button class="btn btn-gold btn-full" id="bootstrap">Criar e entrar</button>
            <div class="hint">Usa a chave de bootstrap do servidor. Em produção este caminho fica desabilitado.</div>
          </div>
        </details>
      </div>
    </div>`),
  );

  $('#enter').addEventListener('click', async () => {
    const token = $('#token').value.trim();
    if (!token) return;
    state.token = token;
    localStorage.setItem('hosfera.token', token);
    try {
      await boot();
    } catch (error) {
      $('#err').textContent = error.message;
    }
  });
  $('#token').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('#enter').click();
  });

  $('#bootstrap').addEventListener('click', async () => {
    try {
      const res = await fetch('/v1/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'dev-bootstrap' },
        body: JSON.stringify({ orgName: $('#orgName').value, userName: $('#userName').value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? 'falha no bootstrap');
      state.token = data.token;
      localStorage.setItem('hosfera.token', data.token);
      await boot();
      toast('Organização criada. Token salvo neste navegador.');
    } catch (error) {
      $('#err').textContent = error.message;
    }
  });
}

function logout() {
  state.token = '';
  localStorage.removeItem('hosfera.token');
  renderLogin();
}

// ───────────────────────────── shell ─────────────────────────────

function renderShell() {
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
        <div class="org-box">
          <div class="name" id="orgName"></div>
          <div class="role" id="orgRole"></div>
        </div>
        <div id="tree"></div>
        <div class="side-foot">
          <button class="btn btn-sm" id="logout" style="width:100%;background:transparent;color:#9aa0a6;border-color:#2b3138">Sair</button>
        </div>
      </aside>
      <div class="main">
        <header class="top">
          <div>
            <h1 id="viewTitle">Calendário</h1>
            <div class="sub" id="viewSub"></div>
          </div>
          <div class="tabs">
            <button class="tab active" data-tab="calendar">Calendário</button>
            <button class="tab" data-tab="reservations">Reservas</button>
            <button class="tab" data-tab="tasks">Tarefas</button>
            <button class="tab" data-tab="channels">Canais</button>
          </div>
        </header>
        <main class="content" id="content"></main>
      </div>
      <div class="drawer-backdrop" id="backdrop"></div>
      <aside class="drawer" id="drawer"></aside>
    </div>`),
  );

  $('#orgName').textContent = state.me.organization?.name ?? 'Organização';
  $('#orgRole').textContent = `${state.me.user} · ${state.me.role}`;
  $('#logout').addEventListener('click', logout);

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.tab = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      void renderContent();
    });
  });

  $('#backdrop').addEventListener('click', closeDrawer);
}

function renderTree() {
  const tree = $('#tree');
  tree.replaceChildren();
  for (const property of state.properties) {
    const units = state.units.filter((u) => u.propertyId === property.id);
    const block = el(`<div class="prop">
      <div class="prop-name">${property.name}</div>
      ${units
        .map(
          (unit) => `<div class="unit${state.unit?.id === unit.id ? ' active' : ''}" data-unit="${unit.id}">
            <span>${unit.name}</span><span class="inv">${unit.inventory} un.</span>
          </div>`,
        )
        .join('')}
    </div>`);
    block.querySelectorAll('.unit').forEach((node) => {
      node.addEventListener('click', async () => {
        state.unit = state.units.find((u) => u.id === node.dataset.unit) ?? null;
        state.availability = [];
        renderTree();
        if (state.tab === 'calendar') await loadCalendar();
        renderContent();
      });
    });
    tree.appendChild(block);
  }
  if (state.properties.length === 0) {
    tree.appendChild(el('<div class="hint" style="color:#7d858c">Nenhum imóvel cadastrado.</div>'));
  }
}

// ───────────────────────────── calendário ─────────────────────────────

async function loadCalendar() {
  if (!state.unit) return;
  const from = state.calStart;
  const to = addDays(from, 56);
  state.availability = await api(`/v1/units/${state.unit.id}/availability?from=${from}&to=${to}`);
}

function renderCalendar() {
  const content = $('#content');
  if (!state.unit) {
    content.replaceChildren(el('<div class="empty">Selecione uma unidade na coluna à esquerda.</div>'));
    return;
  }
  const days = state.availability;
  // Ocupação é ponderada pelo inventário: 2 unidades vendidas de 4 disponíveis = 50%.
  const capacity = days.reduce((s, d) => s + d.inventory, 0);
  const free = days.reduce((s, d) => s + d.available, 0);
  const occ = capacity ? Math.round(((capacity - free) / capacity) * 100) : 0;
  const avg = days.length ? Math.round(days.reduce((s, d) => s + (d.rateCents ?? 0), 0) / days.length) : 0;

  content.replaceChildren(
    el(`<div>
      <div class="kpis">
        <div class="kpi"><div class="n">${occ}%</div><div class="l">ocupação nas 8 semanas</div></div>
        <div class="kpi"><div class="n">${brl(avg)}</div><div class="l">preço médio por noite</div></div>
        <div class="kpi"><div class="n">${free}</div><div class="l">unidades-noite livres</div></div>
        <div class="kpi"><div class="n">${days.filter((d) => d.closed).length}</div><div class="l">noites fechadas</div></div>
      </div>
      <div class="card">
        <div class="card-head">
          <h2>${state.unit.name} · próximas 8 semanas</h2>
          <div class="legend">
            <span><span class="dot" style="background:#e7f3ed"></span>livre</span>
            <span><span class="dot" style="background:#fbeeec"></span>reservado</span>
            <span><span class="dot" style="background:#efe9dd"></span>fechado</span>
          </div>
        </div>
        <div style="padding:14px 16px">
          <div class="weekdays"><div>seg</div><div>ter</div><div>qua</div><div>qui</div><div>sex</div><div>sáb</div><div>dom</div></div>
          <div class="cal" id="cal"></div>
        </div>
      </div>
    </div>`),
  );

  const cal = $('#cal');
  const today = iso(new Date());
  const first = new Date(`${state.calStart}T00:00:00Z`);
  const offset = (first.getUTCDay() + 6) % 7; // segunda como primeiro dia
  for (let i = 0; i < offset; i++) cal.appendChild(el('<div></div>'));

  for (const day of days) {
    const cls = ['day'];
    if (day.closed) cls.push('closed');
    else if (day.available === 0) cls.push('sold');
    if (day.date === today) cls.push('today');
    if (day.date < today) cls.push('past');
    const label = day.closed ? 'fechado' : day.available === 0 ? 'reservado' : `${day.available} disponível`;
    const cell = el(`<div class="${cls.join(' ')}" title="${day.date}">
      <span class="d">${fmtDate(day.date)}</span>
      <span class="p">${day.rateCents ? brl(day.rateCents) : '—'}</span>
      <span class="a">${label}</span>
    </div>`);
    if (day.date >= today && can('ari:write')) cell.addEventListener('click', () => openDayEditor(day));
    cal.appendChild(cell);
  }
}

function openDayEditor(day) {
  state.dayEditor = day;
  const drawer = $('#drawer');
  const reais = day.rateCents ? (day.rateCents / 100).toFixed(0) : '';
  drawer.replaceChildren(
    el(`<div style="display:contents">
      <h2>${fmtDate(day.date)}</h2>
      <div class="muted" style="font-size:12px">${state.unit.name}</div>
      <div>
        <label for="price">Preço da noite (R$)</label>
        <input id="price" type="number" min="0" step="10" value="${reais}" placeholder="tarifa base" />
      </div>
      <div class="row">
        <div>
          <label for="minStay">Mínimo de noites</label>
          <input id="minStay" type="number" min="1" value="${day.minStay ?? 1}" />
        </div>
        <div>
          <label for="available">Disponível</label>
          <input id="available" type="number" min="0" max="${day.inventory}" value="${day.available}" />
          <div class="hint" style="margin-top:4px">inventário da unidade: ${day.inventory}</div>
        </div>
      </div>
      <label style="display:flex;gap:8px;align-items:center;text-transform:none;letter-spacing:0;font-size:13px;color:var(--ink-2)">
        <input id="closed" type="checkbox" style="width:auto" ${day.closed ? 'checked' : ''} /> Fechar esta data
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
      const payload = {
        date: day.date,
        rateCents: price,
        minStay: Number($('#minStay').value) || null,
        available: Number($('#available').value),
        closed: $('#closed').checked,
      };
      const result = await api(`/v1/units/${state.unit.id}/ari`, { method: 'PUT', body: { days: [payload] } });
      closeDrawer();
      await loadCalendar();
      renderCalendar();
      toast(`${fmtDate(day.date)} atualizado · ${result.events} evento(s) no outbox`);
    } catch (error) {
      toast(error.message, true);
    }
  });
}

function closeDrawer() {
  $('#drawer')?.classList.remove('open');
  $('#backdrop')?.classList.remove('open');
}

// ───────────────────────────── reservas ─────────────────────────────

function renderReservations() {
  const rows = state.reservations
    .map(
      (r) => `<tr>
        <td class="k">${r.guestName ?? '—'}</td>
        <td>${fmtDate(r.checkin)} → ${fmtDate(r.checkout)}</td>
        <td class="muted">${r.channel}</td>
        <td><span class="badge ${r.status}">${r.status.replace('_', ' ')}</span></td>
        <td class="num">${brl(r.totalCents)}</td>
        <td class="num muted">${brl(r.commissionCents)}</td>
        <td style="text-align:right">${
          can('reservation:write')
            ? ['confirmed', 'checked_in'].includes(r.status)
              ? `<button class="btn btn-sm" data-status="${r.id}" data-next="${r.status === 'confirmed' ? 'checked_in' : 'checked_out'}">${
                  r.status === 'confirmed' ? 'Check-in' : 'Check-out'
                }</button>`
              : ''
            : ''
        }</td>
      </tr>`,
    )
    .join('');

  $('#content').replaceChildren(
    el(`<div class="card">
      <div class="card-head"><h2>Reservas</h2><span class="muted" style="font-size:12px">${state.reservations.length} ${state.reservations.length === 1 ? 'registro' : 'registros'}</span></div>
      ${
        state.reservations.length === 0
          ? '<div class="empty">Nenhuma reserva ainda. Use o simulador de canal para testar o fluxo.</div>'
          : `<table><thead><tr><th>Hóspede</th><th>Período</th><th>Canal</th><th>Status</th><th class="num">Total</th><th class="num">Comissão</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
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
        await loadData();
        renderContent();
        toast('Status atualizado');
      } catch (error) {
        toast(error.message, true);
      }
    });
  });
}

// ───────────────────────────── tarefas ─────────────────────────────

function renderTasks() {
  const groups = new Map();
  for (const task of state.tasks) {
    if (!groups.has(task.dueDate)) groups.set(task.dueDate, []);
    groups.get(task.dueDate).push(task);
  }
  const body = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([date, tasks]) => `<tr>
        <td class="k">${fmtDate(date)}</td>
        <td>${tasks.map((t) => `<span class="cap">${t.type}</span>`).join(' ')}</td>
        <td class="muted">${tasks.length} tarefa(s)</td>
      </tr>`,
    )
    .join('');

  $('#content').replaceChildren(
    el(`<div class="card">
      <div class="card-head"><h2>Operação por data</h2><span class="muted" style="font-size:12px">${state.tasks.length} tarefas</span></div>
      ${state.tasks.length === 0 ? '<div class="empty">Sem tarefas pendentes.</div>' : `<table><thead><tr><th>Data</th><th>Tarefas</th><th></th></tr></thead><tbody>${body}</tbody></table>`}
    </div>`),
  );
}

// ───────────────────────────── canais ─────────────────────────────

function renderChannels() {
  const cards = state.channels
    .map((channel) => {
      const caps = Object.entries(channel.capabilities)
        .map(([key, on]) => `<span class="cap${on ? ' on' : ''}">${key}</span>`)
        .join('');
      const connections = state.connections.filter((c) => c.channel === channel.channel);
      return `<div class="channel">
        <h3>${channel.channel}</h3>
        <div class="status">${
          channel.channel === 'mock' ? 'canal de desenvolvimento' : 'pendente de certificação'
        }</div>
        <div class="caps">${caps}</div>
        <div class="muted" style="font-size:11px;line-height:1.45">${channel.certification}</div>
        <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
          ${connections
            .map(
              (conn) => `<span class="cap${conn.status === 'active' ? ' on' : ''}">${conn.label} · ${conn.status}</span>`,
            )
            .join('')}
        </div>
      </div>`;
    })
    .join('');

  const listings = state.listings
    .map(
      (l) => `<tr>
        <td class="k">${l.unitName ?? l.unitId.slice(0, 8)}</td>
        <td class="muted">${l.channel}</td>
        <td>${l.externalId ?? '—'}</td>
        <td><span class="badge ${l.status}">${l.status}</span></td>
        <td style="text-align:right">${
          l.status !== 'published' && can('listing:publish')
            ? `<button class="btn btn-sm" data-publish="${l.id}">Publicar</button>`
            : ''
        }</td>
      </tr>`,
    )
    .join('');

  $('#content').replaceChildren(
    el(`<div>
      <div class="channels">${cards}</div>
      <div class="card" style="margin-top:16px">
        <div class="card-head"><h2>Anúncios</h2><span class="muted" style="font-size:12px">${state.listings.length} anúncios</span></div>
        ${state.listings.length === 0 ? '<div class="empty">Nenhum anúncio.</div>' : `<table><thead><tr><th>Unidade</th><th>Canal</th><th>Id externo</th><th>Status</th><th></th></tr></thead><tbody>${listings}</tbody></table>`}
      </div>
    </div>`),
  );

  document.querySelectorAll('[data-publish]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        button.disabled = true;
        const result = await api(`/v1/listings/${button.dataset.publish}/publish`, { method: 'POST' });
        await loadData();
        renderContent();
        toast(`Publicado como ${result.externalId} · ${result.daysSynced} dias sincronizados`);
      } catch (error) {
        toast(error.message, true);
        button.disabled = false;
      }
    });
  });
}

// ───────────────────────────── orquestração ─────────────────────────────

async function renderContent() {
  const titles = {
    calendar: ['Calendário', state.unit ? `${state.unit.name} · preço, disponibilidade e bloqueios` : 'selecione uma unidade'],
    reservations: ['Reservas', 'todas as origens, com status e comissão'],
    tasks: ['Tarefas', 'limpeza, check-in e check-out gerados por reserva'],
    channels: ['Canais', 'capacidades declaradas e estado de certificação'],
  };
  const [title, sub] = titles[state.tab];
  $('#viewTitle').textContent = title;
  $('#viewSub').textContent = sub;

  if (state.tab === 'calendar') {
    if (state.availability.length === 0) await loadCalendar();
    renderCalendar();
  }
  if (state.tab === 'reservations') renderReservations();
  if (state.tab === 'tasks') renderTasks();
  if (state.tab === 'channels') renderChannels();
}

async function loadData() {
  state.summary = await api('/v1/summary');
  state.channels = await api('/v1/channels');
  state.connections = await api('/v1/connections');
  state.reservations = await api('/v1/reservations?limit=50');
  state.tasks = await api('/v1/tasks');
  state.listings = (await api('/v1/listings')).map((l) => ({
    ...l,
    unitName: state.units.find((u) => u.id === l.unitId)?.name,
    channel: state.connections.find((c) => c.id === l.connectionId)?.channel ?? '—',
  }));
}

async function boot() {
  state.me = await api('/v1/me');
  state.properties = await api('/v1/properties');
  state.units = [];
  for (const property of state.properties) {
    const units = await api(`/v1/properties/${property.id}/units`);
    state.units.push(...units);
  }
  state.unit = state.units[0] ?? null;
  state.calStart = iso(new Date());
  await loadData();
  if (state.unit) await loadCalendar();
  renderShell();
  renderTree();
  await renderContent();
}

(async () => {
  if (!state.token) return renderLogin();
  try {
    await boot();
  } catch (error) {
    if (state.token) toast(error.message, true);
    renderLogin();
  }
})();
