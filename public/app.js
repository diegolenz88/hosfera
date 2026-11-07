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
  amenities: [],
  photos: [],
  finance: null,
  reconciliation: null,
};

const $ = (sel) => document.querySelector(sel);
const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

/** Rótulos em pt-BR para os status que vêm da API (que permanecem em inglês). */
const PT = {
  confirmed: 'confirmada',
  pending: 'pendente',
  checked_in: 'check-in feito',
  checked_out: 'check-out feito',
  cancelled: 'cancelada',
  no_show: 'no-show',
  published: 'publicado',
  draft: 'rascunho',
  paused: 'pausado',
  active: 'ativo',
  error: 'erro',
  disabled: 'desativado',
};
const pt = (value) => PT[value] ?? String(value).replace(/_/g, ' ');

const brl = (cents) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

/** Financeiro não arredonda: centavo perdido em repasse é disputa com proprietário. */
const brlExact = (cents) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2 });

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
            <button class="tab" data-tab="onboarding">Onboarding</button>
            <button class="tab" data-tab="finance">Financeiro</button>
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
        <td><span class="badge ${r.status}">${pt(r.status)}</span></td>
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
          channel.channel === 'mock'
            ? 'canal de desenvolvimento'
            : channel.implemented
              ? 'protocolo implementado · homologação pendente'
              : 'pendente de implementação e certificação'
        }</div>
        <div class="caps">${caps}</div>
        <div class="muted" style="font-size:11px;line-height:1.45">${channel.certification}</div>
        <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
          ${connections
            .map(
              (conn) => `<span class="cap${conn.status === 'active' ? ' on' : ''}">${conn.label} · ${pt(conn.status)}</span>`,
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
        <td><span class="badge ${l.status}">${pt(l.status)}</span></td>
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


// ───────────────────────────── onboarding ─────────────────────────────

async function loadAmenities() {
  if (state.amenities.length === 0) state.amenities = await api('/v1/amenities');
}

function renderOnboarding() {
  const unit = state.unit;
  const checked = new Set(unit?.amenities ?? []);
  const groups = ['essencial', 'conforto', 'exterior', 'familia'];
  const chips = groups
    .map(
      (group) => `<div style="margin-bottom:10px">
        <div class="hint" style="text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">${group}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${state.amenities
            .filter((amenity) => amenity.group === group)
            .map(
              (amenity) => `<label class="cap" style="cursor:pointer;display:inline-flex;gap:6px;align-items:center;text-transform:none;letter-spacing:0">
                <input type="checkbox" data-amenity="${amenity.code}" ${checked.has(amenity.code) ? 'checked' : ''} style="width:auto" />
                ${amenity.label}
              </label>`,
            )
            .join('')}
        </div>
      </div>`,
    )
    .join('');

  $('#content').replaceChildren(
    el(`<div style="display:grid;grid-template-columns:1.1fr .9fr;gap:16px;align-items:start">
      <div class="card">
        <div class="card-head"><h2>Novo imóvel</h2><span class="muted" style="font-size:12px">imóvel + unidades + tarifa</span></div>
        <div style="padding:14px 16px;display:grid;gap:10px">
          <div class="row" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div><label>Nome do imóvel</label><input id="obName" placeholder="Casa Praia do Forte" /></div>
            <div><label>Cidade</label><input id="obCity" placeholder="Mata de São João" /></div>
          </div>
          <div class="row" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div><label>Proprietário</label><input id="obOwner" placeholder="Nome do proprietário" /></div>
            <div><label>Repasse ao proprietário (%)</label><input id="obShare" type="number" min="0" max="100" value="70" /></div>
          </div>
          <hr style="border:none;border-top:1px solid var(--line);margin:6px 0" />
          <div class="row" style="display:grid;grid-template-columns:1.4fr .6fr;gap:10px">
            <div><label>Unidade</label><input id="obUnit" placeholder="Suíte Aurora" /></div>
            <div><label>Capacidade</label><input id="obCapacity" type="number" min="1" value="2" /></div>
          </div>
          <div class="row" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
            <div><label>Preço/noite (R$)</label><input id="obPrice" type="number" min="0" step="10" value="450" /></div>
            <div><label>Limpeza (R$)</label><input id="obCleaning" type="number" min="0" step="10" value="150" /></div>
            <div><label>Mín. noites</label><input id="obMinStay" type="number" min="1" value="2" /></div>
          </div>
          <button class="btn btn-primary" id="obCreate">Criar imóvel</button>
          <div class="hint">A unidade nasce com tarifa padrão e fica pronta para receber fotos e ser publicada num canal.</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>${unit ? unit.name : 'Selecione uma unidade'}</h2>
          <button class="btn btn-sm" id="obDuplicate" ${unit ? '' : 'disabled'}>Duplicar unidade</button></div>
        <div style="padding:14px 16px;display:grid;gap:12px">
          ${unit ? chips : '<div class="empty">Escolha uma unidade na coluna à esquerda.</div>'}
          ${unit ? '<button class="btn" id="obSaveAmenities">Salvar comodidades</button>' : ''}
          <hr style="border:none;border-top:1px solid var(--line);margin:4px 0" />
          <div>
            <label>Fotos</label>
            <input id="obPhoto" type="file" accept="image/jpeg,image/png,image/webp" ${unit ? '' : 'disabled'} />
            <div class="hint">JPEG, PNG ou WebP até 8 MB. Conteúdo idêntico não duplica.</div>
          </div>
          <div id="obPhotos" style="display:flex;flex-wrap:wrap;gap:8px"></div>
        </div>
      </div>
    </div>`),
  );

  if (unit) {
    void loadPhotos(unit.id);
    $('#obSaveAmenities')?.addEventListener('click', async () => {
      try {
        const codes = [...document.querySelectorAll('[data-amenity]:checked')].map((node) => node.dataset.amenity);
        await api(`/v1/units/${unit.id}/amenities`, { method: 'PUT', body: { codes } });
        await refreshUnits();
        toast('Comodidades atualizadas');
      } catch (error) {
        toast(error.message, true);
      }
    });

    $('#obDuplicate')?.addEventListener('click', async () => {
      try {
        const result = await api(`/v1/units/${unit.id}/duplicate`, { method: 'POST', body: { name: `${unit.name} 2` } });
        await refreshUnits();
        toast(`Unidade criada com ${result.copiedRatePlans} tarifa(s) e ${result.copiedAmenities} comodidade(s)`);
        void renderOnboarding();
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
        await api(`/v1/units/${unit.id}/photos`, {
          method: 'POST',
          body: { dataBase64, contentType: file.type },
        });
        await loadPhotos(unit.id);
        toast('Foto enviada');
      } catch (error) {
        toast(error.message, true);
      }
    });
  }

  $('#obCreate')?.addEventListener('click', async () => {
    try {
      const body = {
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
            minStay: Number($('#obMinStay').value) || 2,
          },
        ],
      };
      const result = await api('/v1/onboarding', { method: 'POST', body });
      await reloadWorkspace(result.propertyId, result.units[0]?.id);
      toast('Imóvel criado — unidade pronta para publicar');
    } catch (error) {
      toast(error.message, true);
    }
  });
}

async function loadPhotos(unitId) {
  try {
    const photos = await api(`/v1/units/${unitId}/photos`);
    const container = $('#obPhotos');
    if (!container) return;
    container.innerHTML = photos.length
      ? photos
          .map(
            (photo) => `<div style="position:relative">
              <img src="${photo.url}?t=${encodeURIComponent(state.token)}" alt="" width="96" height="72"
                   style="object-fit:cover;border-radius:6px;border:1px solid var(--line)" />
              <button class="btn btn-sm" data-del-photo="${photo.id}"
                      style="position:absolute;top:-8px;right:-8px;padding:0 6px;line-height:18px">×</button>
            </div>`,
          )
          .join('')
      : '<div class="hint">Nenhuma foto ainda.</div>';
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
    /* silencioso: foto é enriquecimento, não bloqueia o onboarding */
  }
}

// ───────────────────────────── financeiro ─────────────────────────────

async function renderFinance() {
  const from = state.calStart;
  const to = addDays(from, 120);
  const [finance, reconciliation] = await Promise.all([
    api(`/v1/finance/payouts?from=${from}&to=${to}`),
    api(`/v1/reconciliation?from=${from}&to=${to}`),
  ]);
  state.finance = finance;
  state.reconciliation = reconciliation;

  const rows = finance.properties
    .map(
      (entry) => `<tr>
        <td class="k">${entry.propertyName}</td>
        <td>${entry.ownerName ?? '—'}</td>
        <td class="num">${brlExact(entry.payout.grossCents)}</td>
        <td class="num muted">−${brlExact(entry.payout.commissionCents)}</td>
        <td class="num">${brlExact(entry.payout.netCents)}</td>
        <td class="num">${entry.ownerSharePct}%</td>
        <td class="num k">${brlExact(entry.payout.ownerPayableCents)}</td>
      </tr>`,
    )
    .join('');

  const channels = finance.channels
    .map(
      (row) => `<tr>
        <td class="k">${row.channel}</td>
        <td class="num">${brlExact(row.grossCents)}</td>
        <td class="num muted">−${brlExact(row.commissionCents)}</td>
        <td class="num">${brlExact(row.netCents)}</td>
        <td class="num">${row.netMarginPct}%</td>
      </tr>`,
    )
    .join('');

  const issues = reconciliation.issues.length
    ? reconciliation.issues
        .map(
          (issue) => `<tr>
            <td><span class="badge ${issue.severity === 'critical' ? 'cancelled' : 'pending'}">${issue.severity}</span></td>
            <td class="k">${issue.kind.replace(/_/g, ' ')}</td>
            <td>${issue.message}</td>
          </tr>`,
        )
        .join('')
    : '';

  $('#content').replaceChildren(
    el(`<div style="display:grid;gap:16px">
      <div class="kpis">
        <div class="kpi"><div class="n">${brlExact(finance.totals.grossCents)}</div><div class="l">bruto no período</div></div>
        <div class="kpi"><div class="n">${brlExact(finance.totals.netCents)}</div><div class="l">líquido após comissões</div></div>
        <div class="kpi"><div class="n">${brlExact(finance.totals.ownerPayableCents)}</div><div class="l">repasse a proprietários</div></div>
        <div class="kpi"><div class="n">${finance.totals.nights}</div><div class="l">noites vendidas</div></div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Repasse por proprietário</h2>
          <span class="muted" style="font-size:12px">${finance.from} → ${finance.to}</span></div>
        <table><thead><tr><th>Imóvel</th><th>Proprietário</th><th class="num">Bruto</th><th class="num">Comissão</th><th class="num">Líquido</th><th class="num">%</th><th class="num">Repasse</th></tr></thead>
        <tbody>${rows}</tbody></table>
      </div>

      <div class="card">
        <div class="card-head"><h2>Margem por canal</h2></div>
        <table><thead><tr><th>Canal</th><th class="num">Bruto</th><th class="num">Comissão</th><th class="num">Líquido</th><th class="num">Margem</th></tr></thead>
        <tbody>${channels || '<tr><td colspan="5" class="muted">Sem reservas no período.</td></tr>'}</tbody></table>
      </div>

      <div class="card">
        <div class="card-head"><h2>Reconciliação</h2>
          <span class="muted" style="font-size:12px">${reconciliation.counts.critical} crítico(s) · ${reconciliation.counts.warning} aviso(s)</span></div>
        ${
          issues
            ? `<table><thead><tr><th>Severidade</th><th>Problema</th><th>Detalhe</th></tr></thead><tbody>${issues}</tbody></table>`
            : '<div class="empty">Nada inconsistente no período: reservas, lançamentos e anúncios conferem.</div>'
        }
      </div>
    </div>`),
  );
}

async function refreshUnits() {
  state.units = [];
  for (const property of state.properties) {
    const units = await api(`/v1/properties/${property.id}/units`);
    state.units.push(...units);
  }
  state.unit = state.units.find((unit) => unit.id === state.unit?.id) ?? state.units[0] ?? null;
  renderTree();
}

async function reloadWorkspace(propertyId, unitId) {
  state.properties = await api('/v1/properties');
  await refreshUnits();
  if (unitId) state.unit = state.units.find((unit) => unit.id === unitId) ?? state.unit;
  renderTree();
  await renderContent();
  void propertyId;
}

// ───────────────────────────── orquestração ─────────────────────────────

async function renderContent() {
  const titles = {
    calendar: ['Calendário', state.unit ? `${state.unit.name} · preço, disponibilidade e bloqueios` : 'selecione uma unidade'],
    reservations: ['Reservas', 'todas as origens, com status e comissão'],
    tasks: ['Tarefas', 'limpeza, check-in e check-out gerados por reserva'],
    channels: ['Canais', 'capacidades declaradas e estado de certificação'],
    onboarding: ['Onboarding', 'cadastrar imóvel, unidades, comodidades e fotos'],
    finance: ['Financeiro', 'repasse a proprietário, margem por canal e reconciliação'],
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
  if (state.tab === 'onboarding') renderOnboarding();
  if (state.tab === 'finance') await renderFinance();
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
  await loadAmenities();
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
