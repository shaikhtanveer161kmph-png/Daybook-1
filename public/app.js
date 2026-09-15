const state = {
  user: null,
  entries: [],
  draft: null,
  draftForm: null,
  editingEntryId: null,
  editingEntryForm: null,
  confirmDeleteId: null,
  expandedId: null,
  loading: false,
  error: '',
};

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function formatDate(iso) {
  try {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch (e) {
    return iso;
  }
}
function formatAmount(n, currency) {
  const num = Number(n) || 0;
  const hasDecimals = Math.round(num * 100) % 100 !== 0;
  return currency + num.toLocaleString('en-IN', { minimumFractionDigits: hasDecimals ? 2 : 0, maximumFractionDigits: 2 });
}
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- Auth screens ---------------- */

async function checkSession() {
  try {
    const me = await api('/auth/me');
    state.user = me;
    await loadEntries();
    renderApp();
  } catch (e) {
    renderAuth('login');
  }
}

function renderAuth(mode) {
  const root = document.getElementById('root');
  root.innerHTML = `
    <div class="auth-wrap">
      <div class="brand"><span class="brand-mark">&#9638;</span><h1>Daybook</h1></div>
      <p class="muted">Write what happened. Get the voucher or bill.</p>
      <form id="auth-form" class="card">
        <h2>${mode === 'login' ? 'Log in' : 'Create your account'}</h2>
        <label>Email<input type="email" name="email" required /></label>
        <label>Password<input type="password" name="password" required minlength="10" /></label>
        <p class="muted small" style="margin-top:-0.5rem;">At least 10 characters.</p>
        <div id="auth-error" class="error" style="display:none;"></div>
        <button type="submit" class="btn primary">${mode === 'login' ? 'Log in' : 'Sign up'}</button>
      </form>
      <p class="muted small">${
        mode === 'login'
          ? `New here? <a href="#" id="switch-mode">Create an account</a>`
          : `Already have an account? <a href="#" id="switch-mode">Log in</a>`
      }</p>
    </div>
  `;
  document.getElementById('switch-mode').addEventListener('click', (e) => {
    e.preventDefault();
    renderAuth(mode === 'login' ? 'signup' : 'login');
  });
  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const email = fd.get('email');
    const password = fd.get('password');
    const errEl = document.getElementById('auth-error');
    errEl.style.display = 'none';
    try {
      await api(mode === 'login' ? '/auth/login' : '/auth/signup', { method: 'POST', body: { email, password } });
      await checkSession();
    } catch (err) {
      errEl.textContent = err.data?.error || 'Something went wrong.';
      errEl.style.display = 'block';
    }
  });
}

async function loadEntries() {
  const data = await api('/entries');
  state.entries = data.entries;
}

/* ---------------- Document + edit form rendering ---------------- */

function documentCardHtml(entry, currency) {
  const isBill = entry.docType === 'bill';
  const accent = isBill ? 'bill' : 'voucher';
  if (isBill) {
    const total = entry.total ?? entry.items.reduce((s, i) => s + i.amount, 0);
    const itemsHtml = entry.items
      .map((i) => `<div class="line-row"><span>${escapeHtml(i.description)}</span><span class="mono">${formatAmount(i.amount, currency)}</span></div>`)
      .join('');
    return `
      <div class="doc-card ${accent}">
        <div class="doc-head">
          <span class="doc-type bill-text">Bill</span>
          <span class="mono muted">${entry.number ? entry.number + ' &middot; ' : 'Draft &middot; '}${formatDate(entry.date)}</span>
        </div>
        <div class="doc-party">Bill to <strong>${escapeHtml(entry.party)}</strong></div>
        <div class="line-list">${itemsHtml}</div>
        <div class="line-total"><span>Total</span><span class="mono bill-text">${formatAmount(total, currency)}</span></div>
        <div class="narration">${escapeHtml(entry.narration || '')}</div>
      </div>`;
  }
  const debitTotal = entry.entries.filter((x) => x.side === 'debit').reduce((s, x) => s + x.amount, 0);
  const creditTotal = entry.entries.filter((x) => x.side === 'credit').reduce((s, x) => s + x.amount, 0);
  const balanced = Math.abs(debitTotal - creditTotal) < 0.01;
  const linesHtml = entry.entries
    .map(
      (l) => `
      <div class="line-row" style="${l.side === 'credit' ? 'padding-left:1.25rem' : ''}">
        <span><span class="mono side-tag">${l.side === 'debit' ? 'Dr' : 'Cr'}</span>${escapeHtml(l.account)}</span>
        <span class="mono">${formatAmount(l.amount, currency)}</span>
      </div>`
    )
    .join('');
  return `
    <div class="doc-card ${accent}">
      <div class="doc-head">
        <span class="doc-type voucher-text">Journal voucher</span>
        <span class="mono muted">${entry.number ? entry.number + ' &middot; ' : 'Draft &middot; '}${formatDate(entry.date)}</span>
      </div>
      <div class="line-list">${linesHtml}</div>
      <div class="line-total">
        <span style="${balanced ? '' : 'color:var(--rule)'}">${balanced ? 'Balanced' : 'Does not balance — check before posting'}</span>
        <span class="mono voucher-text">${formatAmount(debitTotal, currency)}</span>
      </div>
      <div class="narration">${escapeHtml(entry.narration || '')}</div>
    </div>`;
}

function editFormHtml(form, scope) {
  const isBill = form.docType === 'bill';
  const accent = isBill ? 'bill' : 'voucher';
  const currency = state.user.currency;
  if (isBill) {
    const itemsHtml = form.items
      .map(
        (it, i) => `
      <div class="edit-row">
        <input type="text" data-field="item-desc" data-index="${i}" value="${escapeHtml(it.description)}" placeholder="Item or service" />
        <input type="number" data-field="item-amt" data-index="${i}" value="${it.amount}" />
        <button type="button" class="icon-btn remove-item" data-i="${i}">&#10005;</button>
      </div>`
      )
      .join('');
    const total = form.items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
    return `
      <div class="edit-card ${accent}" data-scope="${scope}">
        <div class="edit-row">
          <input type="date" data-field="date" value="${form.date}" />
          <input type="text" data-field="party" value="${escapeHtml(form.party)}" placeholder="Customer name" />
        </div>
        <div class="items-wrap">${itemsHtml}</div>
        <button type="button" class="link-btn add-item">+ Add item</button>
        <div class="line-total"><span>Total</span><span class="mono bill-text">${formatAmount(total, currency)}</span></div>
        <textarea data-field="narration" rows="2" placeholder="Narration">${escapeHtml(form.narration || '')}</textarea>
      </div>`;
  }
  const linesHtml = form.entries
    .map(
      (l, i) => `
      <div class="edit-row">
        <button type="button" class="side-toggle" data-i="${i}">${l.side === 'debit' ? 'Dr' : 'Cr'}</button>
        <input type="text" data-field="entry-account" data-index="${i}" value="${escapeHtml(l.account)}" placeholder="Account name" />
        <input type="number" data-field="entry-amt" data-index="${i}" value="${l.amount}" />
        <button type="button" class="icon-btn remove-entry" data-i="${i}">&#10005;</button>
      </div>`
    )
    .join('');
  const debitTotal = const debitTotal = form.entries.filter((x) => x.side === 'debit').reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const creditTotal = form.entries.filter((x) => x.side === 'credit').reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const balanced = Math.abs(debitTotal - creditTotal) < 0.01;
  return `
    <div class="edit-card ${accent}" data-scope="${scope}">
      <div class="edit-row">
        <input type="date" data-field="date" value="${form.date}" />
      </div>
      <div class="items-wrap">${linesHtml}</div>
      <button type="button" class="link-btn add-entry">+ Add line</button>
      <div class="line-total">
        <span style="${balanced ? '' : 'color:var(--rule)'}">${balanced ? 'Balanced' : `Off by ${formatAmount(Math.abs(debitTotal - creditTotal), currency)}`}</span>
        <span class="mono voucher-text">${formatAmount(debitTotal, currency)}</span>
      </div>
      <textarea data-field="narration" rows="2" placeholder="Narration">${escapeHtml(form.narration || '')}</textarea>
    </div>`;
}

/* ---------------- Main app rendering ---------------- */

function renderReview() {
  if (!state.draft) return '';
  if (state.draftForm) {
    return `
      <h2 class="section-title">Review</h2>
      ${editFormHtml(state.draftForm, 'draft')}
      <div class="actions-row">
        <button class="btn muted" id="cancel-edit-draft">Cancel</button>
        <button class="btn primary" id="approve-draft">&#10003; Approve</button>
      </div>`;
  }
  return `
    <h2 class="section-title">Review</h2>
    ${documentCardHtml(state.draft, state.user.currency)}
    <div class="actions-row">
      <button class="btn muted" id="discard-draft">&#128465; Discard</button>
      <button class="btn" id="edit-draft">&#9998; Edit</button>
      <button class="btn primary" id="approve-draft">&#10003; Approve</button>
    </div>`;
}

function renderRegister() {
  if (!state.entries.length) {
    return `<div class="empty-state">No entries yet. Your first voucher or bill will appear here.</div>`;
  }
  return state.entries
    .map((entry) => {
      const isExpanded = state.expandedId === entry.id;
      const isEditing = state.editingEntryId === entry.id;
      const isConfirming = state.confirmDeleteId === entry.id;
      const label = entry.docType === 'bill' ? entry.party : entry.narration;
      const amount = entry.docType === 'bill' ? entry.total : entry.entries.filter((x) => x.side === 'debit').reduce((s, x) => s + x.amount, 0);
      return `
      <div class="register-row" data-id="${entry.id}">
        <div class="row-summary" data-action="toggle-expand" data-id="${entry.id}">
          <span class="mono muted date-col">${formatDate(entry.date)}</span>
          <span class="badge ${entry.docType === 'bill' ? 'bill' : 'voucher'}">${entry.docType === 'bill' ? 'Bill' : 'Voucher'}</span>
          <span class="label-col">${escapeHtml(label)}</span>
          <span class="mono">${formatAmount(amount, state.user.currency)}</span>
          <span class="chevron">${isExpanded ? '&#9650;' : '&#9660;'}</span>
        </div>
        ${
          isExpanded
            ? `<div class="row-detail">
                ${
                  isEditing
                    ? `${editFormHtml(state.editingEntryForm, 'entry')}
                       <div class="actions-row">
                         <button class="btn muted" data-action="cancel-edit-entry">Cancel</button>
                         <button class="btn primary" data-action="save-entry" data-id="${entry.id}">&#10003; Save changes</button>
                       </div>`
                    : `${documentCardHtml(entry, state.user.currency)}
                       <div class="actions-row">
                         ${
                           isConfirming
                             ? `<span class="muted">Remove this entry?</span>
                                <button class="icon-btn" data-action="confirm-delete" data-id="${entry.id}">&#10003;</button>
                                <button class="icon-btn" data-action="cancel-delete">&#10005;</button>`
                             : `<button class="btn" data-action="edit-entry" data-id="${entry.id}">&#9998; Edit</button>
                                <button class="btn muted" data-action="ask-delete" data-id="${entry.id}">&#128465; Remove</button>`
                         }
                       </div>`
                }
              </div>`
            : ''
        }
      </div>`;
    })
    .join('');
}
function renderApp() {
  const root = document.getElementById('root');
  const u = state.user;
  const totals = state.entries.reduce(
    (acc, e) => {
      if (e.docType === 'bill') acc.sales += e.total;
      if (e.docType === 'voucher') acc.expense += e.entries.filter((x) => x.side === 'debit').reduce((s, x) => s + x.amount, 0);
      return acc;
    },
    { sales: 0, expense: 0 }
  );

  root.innerHTML = `
    <div class="app-wrap">
      <div class="header-row">
        <div class="brand"><span class="brand-mark">&#9638;</span><h1>Daybook</h1></div>
        <div class="header-actions">
          <div class="currency-group">
            ${['₹', '$', '€', '£'].map((sym) => `<button class="sym-btn ${u.currency === sym ? 'active' : ''}" data-sym="${sym}">${sym}</button>`).join('')}
          </div>
          <button id="billing-btn" class="btn small">${u.subscriptionStatus === 'active' ? 'Manage billing' : 'Subscribe'}</button>
          <button id="logout-btn" class="btn small muted">Log out</button>
        </div>
      </div>
      <p class="muted">Write what happened. Get the voucher or bill.</p>
      ${
        u.subscriptionStatus !== 'active'
          ? `<div class="trial-note">Free trial: ${u.entryCount} of 5 entries used.</div>`
          : ''
      }

      <textarea id="input-text" rows="3" placeholder="e.g. Paid 1,200 cash for the office electricity bill" ${state.draft ? 'disabled' : ''}></textarea>
      <div class="row-between">
        <span class="hint">${state.draft ? 'Approve or discard the entry below to add another' : 'Enter to create · Shift+Enter for a new line'}</span>
        <button id="create-btn" class="btn primary" ${state.draft || state.loading ? 'disabled' : ''}>${state.loading ? 'Drafting…' : 'Create entry'}</button>
      </div>
      ${state.error ? `<div class="error-banner">${escapeHtml(state.error)}</div>` : ''}

      <div id="review-area">${renderReview()}</div>

      ${
        state.entries.length
          ? `<div class="summary-grid">
              <div class="summary-cell"><div class="label">Sales</div><div class="mono bill-color">${formatAmount(totals.sales, u.currency)}</div></div>
              <div class="summary-cell"><div class="label">Expenses</div><div class="mono voucher-color">${formatAmount(totals.expense, u.currency)}</div></div>
              <div class="summary-cell"><div class="label">Net</div><div class="mono">${formatAmount(totals.sales - totals.expense, u.currency)}</div></div>
            </div>`
          : ''
      }

      <h2 class="section-title">Entries</h2>
      <div id="register">${renderRegister()}</div>
    </div>
  `;

  attachAppHandlers();
}

/* ---------------- Actions ---------------- */

async function handleCreateEntry() {
  const textEl = document.getElementById('input-text');
  const text = textEl.value.trim();
  if (!text || state.draft || state.loading) return;
  state.loading = true;
  state.error = '';
  renderApp();
  try {
    const draft = await api('/entries/draft', { method: 'POST', body: { text } });
    state.draft = draft;
  } catch (e) {
    state.error =
      e.status === 402
        ? 'Free trial used up — subscribe to keep creating entries.'
        : e.data?.error || "Couldn't turn that into an entry. Try including an amount and what it was for.";
  } finally {
    state.loading = false;
    renderApp();
  }
}

function handleEditDraft() {
  state.draftForm = JSON.parse(JSON.stringify(state.draft));
  renderApp();
}
function handleCancelEditDraft() {
  state.draftForm = null;
  renderApp();
}
function handleDiscardDraft() {
  state.draft = null;
  state.draftForm = null;
  renderApp();
}
async function handleApproveDraft() {
  const data = state.draftForm || state.draft;
  try {
    const saved = await api('/entries', { method: 'POST', body: data });
    state.entries = [saved, ...state.entries];
    state.draft = null;
    state.draftForm = null;
    state.user.entryCount = (state.user.entryCount || 0) + 1;
  } catch (e) {
    state.error = e.data?.error || 'Could not save the entry.';
  }
  renderApp();
}

async function handleSaveEntry(id) {
  try {
    const updated = await api('/entries/' + id, { method: 'PUT', body: state.editingEntryForm });
    state.entries = state.entries.map((e) => (e.id === id ? updated : e));
    state.editingEntryId = null;
    state.editingEntryForm = null;
  } catch (e) {
    state.error = e.data?.error || 'Could not save changes.';
  }
  renderApp();
}
async function handleDeleteEntry(id) {
  try {
    await api('/entries/' + id, { method: 'DELETE' });
    state.entries = state.entries.filter((e) => e.id !== id);
    state.confirmDeleteId = null;
    if (state.expandedId === id) state.expandedId = null;
  } catch (e) {
    state.error = e.data?.error || 'Could not remove the entry.';
  }
  renderApp();
}
async function handleCurrencyChange(sym) {
  state.user.currency = sym;
  renderApp();
  try {
    await api('/auth/currency', { method: 'PUT', body: { currency: sym } });
  } catch (e) {
    // best-effort
  }
}
async function handleLogout() {
  await api('/auth/logout', { method: 'POST' });
  state.user = null;
  state.entries = [];
  renderAuth('login');
}
async function handleBilling() {
  try {
    const path = state.user.subscriptionStatus === 'active' ? '/billing/portal' : '/billing/create-checkout-session';
    const { url } = await api(path, { method: 'POST' });
    window.location.href = url;
  } catch (e) {
    state.error = e.data?.error || 'Billing is not set up yet.';
    renderApp();
  }
}

function attachAppHandlers() {
  const root = document.getElementById('root');

  document.getElementById('input-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleCreateEntry();
    }
  });
  document.getElementById('create-btn').addEventListener('click', handleCreateEntry);
  document.getElementById('logout-btn').addEventListener('click', handleLogout);
  document.getElementById('billing-btn').addEventListener('click', handleBilling);
  document.querySelectorAll('.sym-btn').forEach((btn) => btn.addEventListener('click', () => handleCurrencyChange(btn.dataset.sym)));

  const approveBtn = document.getElementById('approve-draft');
  if (approveBtn) approveBtn.addEventListener('click', handleApproveDraft);
  const editBtn = document.getElementById('edit-draft');
  if (editBtn) editBtn.addEventListener('click', handleEditDraft);
  const discardBtn = document.getElementById('discard-draft');
  if (discardBtn) discardBtn.addEventListener('click', handleDiscardDraft);
  const cancelEditDraftBtn = document.getElementById('cancel-edit-draft');
  if (cancelEditDraftBtn) cancelEditDraftBtn.addEventListener('click', handleCancelEditDraft);

  root.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-action]');
    if (actionEl) {
      const action = actionEl.dataset.action;
      const id = actionEl.dataset.id ? Number(actionEl.dataset.id) : null;
      if (action === 'toggle-expand') {
        if (state.editingEntryId === id) return;
        state.expandedId = state.expandedId === id ? null : id;
        state.confirmDeleteId = null;
        renderApp();
      } else if (action === 'edit-entry') {
        const entry = state.entries.find((x) => x.id === id);
        state.editingEntryId = id;
        state.editingEntryForm = JSON.parse(JSON.stringify(entry));
        state.expandedId = id;
        renderApp();
      } else if (action === 'cancel-edit-entry') {
        state.editingEntryId = null;
        state.editingEntryForm = null;
        renderApp();
      } else if (action === 'save-entry') {
        handleSaveEntry(id);
      } else if (action === 'ask-delete') {
        state.confirmDeleteId = id;
        renderApp();
      } else if (action === 'cancel-delete') {
        state.confirmDeleteId = null;
        renderApp();
      } else if (action === 'confirm-delete') {
        handleDeleteEntry(id);
      }
      return;
    }

    const scopeEl = e.target.closest('[data-scope]');
    if (!scopeEl) return;
    const scope = scopeEl.dataset.scope;
    const form = scope === 'draft' ? state.draftForm : state.editingEntryForm;
    if (!form) return;

    if (e.target.classList.contains('add-item')) {
      form.items.push({ description: '', amount: 0 });
      renderApp();
    } else if (e.target.classList.contains('remove-item')) {
      form.items.splice(Number(e.target.dataset.i), 1);
      renderApp();
    } else if (e.target.classList.contains('add-entry')) {
      form.entries.push({ account: '', side: 'debit', amount: 0 });
      renderApp();
    } else if (e.target.classList.contains('remove-entry')) {
      form.entries.splice(Number(e.target.dataset.i), 1);
      renderApp();
    } else if (e.target.classList.contains('side-toggle')) {
      const i = Number(e.target.dataset.i);
      form.entries[i].side = form.entries[i].side === 'debit' ? 'credit' : 'debit';
      renderApp();
    }
  });

  root.addEventListener('input', (e) => {
    const el = e.target;
    const field = el.dataset.field;
    if (!field) return;
    const scopeEl = el.closest('[data-scope]');
    if (!scopeEl) return;
    const scope = scopeEl.dataset.scope;
    const form = scope === 'draft' ? state.draftForm : state.editingEntryForm;
    if (!form) return;
    const idx = el.dataset.index !== undefined ? Number(el.dataset.index) : null;
    if (field === 'date') form.date = el.value;
    else if (field === 'party') form.party = el.value;
    else if (field === 'narration') form.narration = el.value;
    else if (field === 'item-desc') form.items[idx].description = el.value;
    else if (field === 'item-amt') form.items[idx].amount = el.value;
    else if (field === 'entry-account') form.entries[idx].account = el.value;
    else if (field === 'entry-amt') form.entries[idx].amount = el.value;
  });
}

checkSession();