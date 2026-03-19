// ============================================================
// SILICON LAB — component-search-ui.js
// The "Universal Part Search" UI
// Opens a search drawer, lets user find any real-world part,
// previews it, then places it on the board.
// ============================================================

const ComponentSearchUI = (() => {

  let _overlay, _input, _resultsEl, _previewEl, _ingestBtn;
  let _selectedResult = null;
  let _pendingDef = null;
  let _searchTimeout = null;

  // ── Build DOM ─────────────────────────────────────────────
  function buildDOM() {
    const overlay = document.createElement('div');
    overlay.id = 'part-search-overlay';
    overlay.innerHTML = `
      <div id="part-search-panel">
        <div id="psp-header">
          <div class="psp-title">
            <span class="psp-icon">◈</span>
            UNIVERSAL COMPONENT SEARCH
          </div>
          <button id="psp-close">✕</button>
        </div>

        <div id="psp-body">
          <!-- LEFT: Search -->
          <div id="psp-left">
            <div id="psp-search-row">
              <input id="psp-input" type="text"
                placeholder="Search by part number or name (e.g. NE555, 6502, ATmega328)…"
                autocomplete="off" spellcheck="false" />
              <button id="psp-go">SEARCH</button>
            </div>
            <div id="psp-shortcuts">
              <span class="psp-tag-label">QUICK:</span>
              ${ComponentIngestor.getKnownFamilies().slice(0, 14).map(f =>
                `<button class="psp-quick-tag" data-pn="${f.id}">${f.id}</button>`
              ).join('')}
            </div>
            <div id="psp-results">
              <div class="psp-results-hint">Search for any real-world IC, transistor, sensor, or MCU.</div>
            </div>
          </div>

          <!-- RIGHT: Preview -->
          <div id="psp-right">
            <div id="psp-preview-header">COMPONENT PREVIEW</div>
            <canvas id="psp-canvas" width="280" height="200"></canvas>
            <div id="psp-preview-info">
              <p class="psp-hint">Select a search result to preview.</p>
            </div>
            <div id="psp-actions">
              <button id="psp-ingest-btn" disabled>
                ⚡ LOAD &amp; PLACE COMPONENT
              </button>
              <div id="psp-ingest-progress" class="hidden">
                <div id="psp-progress-bar"><div id="psp-progress-fill"></div></div>
                <div id="psp-progress-label">Initialising…</div>
              </div>
            </div>
          </div>
        </div>

        <div id="psp-footer">
          <span>Metadata: Kitspace / Octopart</span>
          <span>Physics: SPICE model parser</span>
          <span>Logic: Claude AI behavioral model</span>
          <span id="psp-cache-count">Cache: 0 parts</span>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    return overlay;
  }

  // ── Preview canvas renderer ───────────────────────────────
  function renderPreview(def) {
    const canvas = document.getElementById('psp-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#060a06';
    ctx.fillRect(0, 0, W, H);

    // Grid
    ctx.strokeStyle = 'rgba(0,180,60,0.08)';
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 20) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
    for (let y = 0; y < H; y += 20) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

    if (!def) return;

    // Scale to fit
    const scale = Math.min((W - 80) / def.width, (H - 80) / def.height, 3);
    const ox = (W - def.width * scale) / 2;
    const oy = (H - def.height * scale) / 2;

    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);

    // Draw component using its own draw()
    const fakeSim = { running: false };
    const fakeComp = { props: def.defaults || {}, state: { temp: 25 }, id: 'PREVIEW' };
    try {
      def.draw(ctx, fakeComp, fakeSim);
    } catch (e) {}

    // Pin labels
    ctx.font = `${8/scale}px Share Tech Mono, monospace`;
    ctx.fillStyle = '#00ff88';
    def.pins.forEach(pin => {
      const px = pin.x;
      const py = pin.y;
      const isLeft  = px === 0;
      const isRight = px === def.width;
      const isTop   = py === 0;
      ctx.textAlign = isLeft ? 'right' : isRight ? 'left' : 'center';
      const dx = isLeft ? -3/scale : isRight ? 3/scale : 0;
      const dy = isTop ? -3/scale : 3/scale;
      ctx.fillText(pin.name, px + dx, py + dy + (isTop ? 0 : 4/scale));
    });

    ctx.restore();

    // Category badge
    ctx.fillStyle = 'rgba(0,255,136,0.12)';
    ctx.fillRect(4, 4, 80, 14);
    ctx.fillStyle = '#00ff88';
    ctx.font = '8px Orbitron, monospace';
    ctx.textAlign = 'left';
    ctx.fillText((def.category || 'IC').toUpperCase(), 8, 14);
    ctx.textAlign = 'left';
  }

  function showPreviewInfo(def, partNumber) {
    const el = document.getElementById('psp-preview-info');
    if (!el) return;

    const phys = def.physics || {};
    el.innerHTML = `
      <div class="psp-info-row"><b>${def.label}</b></div>
      <div class="psp-info-row psp-desc">${def.description || ''}</div>
      <div class="psp-info-grid">
        <div class="psp-info-cell"><span>VCC</span><b>${phys.vcc_nom || def.defaults?.vcc || '?'}V</b></div>
        <div class="psp-info-cell"><span>PINS</span><b>${def.pins.length}</b></div>
        <div class="psp-info-cell"><span>BEHAVIOR</span><b>${def._behavior || 'generic'}</b></div>
        <div class="psp-info-cell"><span>TEMP MAX</span><b>${phys.temp_max_c || 85}°C</b></div>
        <div class="psp-info-cell"><span>SOURCE</span><b>${def._isImported ? 'AI Model' : 'Built-in'}</b></div>
        <div class="psp-info-cell"><span>Icc</span><b>${phys.icc_active_ma || '?'}mA</b></div>
      </div>
    `;
  }

  // ── Search results renderer ───────────────────────────────
  function renderResults(results) {
    const el = document.getElementById('psp-results');
    if (!el) return;

    if (!results || results.length === 0) {
      el.innerHTML = '<div class="psp-results-hint">No results found. Try a different search.</div>';
      return;
    }

    el.innerHTML = results.map((r, i) => `
      <div class="psp-result-row" data-idx="${i}">
        <div class="psp-result-pn">${r.partNumber}</div>
        <div class="psp-result-mfr">${r.manufacturer || ''}</div>
        <div class="psp-result-desc">${(r.description || '').slice(0, 80)}</div>
        <div class="psp-result-src psp-src-${r.source}">${r.source}</div>
      </div>
    `).join('');

    // Bind click
    el.querySelectorAll('.psp-result-row').forEach(row => {
      row.addEventListener('click', () => {
        el.querySelectorAll('.psp-result-row').forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
        const idx = parseInt(row.dataset.idx);
        _selectedResult = results[idx];
        document.getElementById('psp-ingest-btn').disabled = false;

        // If already cached, preview immediately
        const cached = ComponentIngestor.getCached(_selectedResult.partNumber);
        if (cached) {
          _pendingDef = cached;
          renderPreview(cached);
          showPreviewInfo(cached, _selectedResult.partNumber);
        } else {
          // Show placeholder
          const el2 = document.getElementById('psp-preview-info');
          if (el2) el2.innerHTML = `<p class="psp-hint">Ready to load <b>${_selectedResult.partNumber}</b>. Click "LOAD & PLACE" to ingest.</p>`;
          renderPreview(null);
        }
      });
    });
  }

  // ── Run search ────────────────────────────────────────────
  async function doSearch(query) {
    query = query.trim();
    if (!query) return;

    const el = document.getElementById('psp-results');
    el.innerHTML = '<div class="psp-loading">⟳ Searching…</div>';

    try {
      const results = await ComponentIngestor.search(query);
      renderResults(results);
    } catch (e) {
      el.innerHTML = `<div class="psp-results-hint psp-err">Search error: ${e.message}</div>`;
    }
  }

  // ── Ingest & place ────────────────────────────────────────
  async function doIngest() {
    if (!_selectedResult) return;

    const btn = document.getElementById('psp-ingest-btn');
    const prog = document.getElementById('psp-ingest-progress');
    const fill = document.getElementById('psp-progress-fill');
    const label = document.getElementById('psp-progress-label');

    btn.disabled = true;
    prog.classList.remove('hidden');

    const steps = [
      { pct: 10, msg: 'Fetching metadata…' },
      { pct: 30, msg: 'Requesting SPICE model…' },
      { pct: 55, msg: 'Sending to AI for behavioral parsing…' },
      { pct: 80, msg: 'Building simulation object…' },
      { pct: 95, msg: 'Registering component…' },
    ];

    let stepIdx = 0;
    const stepTimer = setInterval(() => {
      if (stepIdx < steps.length) {
        const s = steps[stepIdx++];
        fill.style.width = s.pct + '%';
        label.textContent = s.msg;
      }
    }, 600);

    try {
      const def = await ComponentIngestor.ingest(_selectedResult.partNumber, _selectedResult.raw || _selectedResult);
      clearInterval(stepTimer);
      fill.style.width = '100%';
      label.textContent = '✓ Component ready!';

      _pendingDef = def;
      renderPreview(def);
      showPreviewInfo(def, _selectedResult.partNumber);

      // Register & set as pending placement
      const key = ComponentIngestor.register(_selectedResult.partNumber, def);
      btn.textContent = '✓ CLICK BOARD TO PLACE';
      btn.disabled = false;
      btn.classList.add('ready');

      // Update cache count
      const cacheEl = document.getElementById('psp-cache-count');
      if (cacheEl) cacheEl.textContent = `Cache: ${Object.keys(ComponentDefs).filter(k => k.startsWith('imported_')).length} imported parts`;

      // Clicking btn or closing will trigger placement
      btn.onclick = () => {
        close();
        // Tell app to place this imported component
        EventBus.emit('ingestor:place', { key, def, partNumber: _selectedResult.partNumber });
      };

    } catch (err) {
      clearInterval(stepTimer);
      fill.style.width = '100%';
      fill.style.background = 'var(--red)';
      label.textContent = `Error: ${err.message}`;
      btn.disabled = false;
      Debug.log(`[Ingest] Failed: ${err.message}`, 'error');
    }
  }

  // ── Open / Close ─────────────────────────────────────────
  function open() {
    if (!_overlay) _overlay = buildDOM();

    // Bind events (each open)
    const input = document.getElementById('psp-input');
    const goBtn = document.getElementById('psp-go');
    const closeBtn = document.getElementById('psp-close');
    const ingestBtn = document.getElementById('psp-ingest-btn');

    input.addEventListener('keydown', e => {
      clearTimeout(_searchTimeout);
      if (e.key === 'Enter') doSearch(input.value);
      else _searchTimeout = setTimeout(() => doSearch(input.value), 500);
    });

    goBtn.addEventListener('click', () => doSearch(input.value));
    closeBtn.addEventListener('click', close);
    ingestBtn.addEventListener('click', doIngest);

    document.querySelectorAll('.psp-quick-tag').forEach(tag => {
      tag.addEventListener('click', () => {
        input.value = tag.dataset.pn;
        doSearch(tag.dataset.pn);
      });
    });

    _overlay.addEventListener('click', e => {
      if (e.target === _overlay) close();
    });

    _overlay.style.display = 'flex';
    _selectedResult = null;
    _pendingDef = null;
    input.focus();
  }

  function close() {
    if (_overlay) _overlay.style.display = 'none';
    const btn = document.getElementById('psp-ingest-btn');
    if (btn) { btn.textContent = '⚡ LOAD & PLACE COMPONENT'; btn.classList.remove('ready'); btn.disabled = true; }
    const prog = document.getElementById('psp-ingest-progress');
    if (prog) prog.classList.add('hidden');
    const fill = document.getElementById('psp-progress-fill');
    if (fill) { fill.style.width = '0'; fill.style.background = ''; }
  }

  return { open, close };
})();
