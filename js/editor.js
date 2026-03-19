// ============================================================
// SILICON LAB — editor.js
// Board state manager + UI panel updates
// ============================================================

const Board = (() => {
  let components = [];
  let traces = [];

  return {
    getComponents() { return components; },
    getTraces() { return traces; },

    addComponent(type, x, y) {
      const comp = createComponent(type, x, y);
      components.push(comp);
      Simulator.init(components, traces);
      Renderer.setBoard(components, traces);
      EventBus.emit('board:add', { comp });
      Simulator.onComponentAdded(comp);
      UI.updateBOM();
      UI.updateComponentCount();
      return comp;
    },

    removeComponent(id) {
      components = components.filter(c => c.id !== id);
      traces = traces.filter(t => t.fromCompId !== id && t.toCompId !== id);
      Simulator.init(components, traces);
      Renderer.setBoard(components, traces);
      Renderer.deselect(id);
      EventBus.emit('board:remove', { id });
      Simulator.onComponentRemoved(id);
      UI.updateBOM();
      UI.updateComponentCount();
    },

    addTrace(trace) {
      traces.push(trace);
      Simulator.init(components, traces);
      Renderer.setBoard(components, traces);
      EventBus.emit('board:trace_add', { trace });
      Simulator.onTraceAdded(trace);
      UI.updateComponentCount();
      UI.updateSignalIntegrity();
    },

    clear() {
      components = [];
      traces = [];
      Simulator.init(components, traces);
      Renderer.setBoard(components, traces);
      Renderer.clearSelection();
      EventBus.emit('board:cleared');
      UI.updateBOM();
      UI.updateComponentCount();
      UI.clearProps();
    },

    getComponent(id) { return components.find(c => c.id === id); },
  };
})();

// ── UI Panel Manager ─────────────────────────────────────────
const UI = {

  updateComponentCount() {
    const el = document.getElementById('component-count');
    if (el) el.textContent = `${Board.getComponents().length} components · ${Board.getTraces().length} nets`;
  },

  showProps(comp) {
    const def = ComponentDefs[comp.type];
    const el = document.getElementById('props-content');
    if (!el || !def) return;

    let html = `<div class="prop-row"><span class="prop-label">ID</span><span class="prop-value">${comp.id}</span></div>`;
    html += `<div class="prop-row"><span class="prop-label">Type</span><span class="prop-value" style="color:var(--green)">${def.label}</span></div>`;
    html += `<div class="prop-row"><span class="prop-label">Position</span><span class="prop-value">(${comp.x}, ${comp.y})</span></div>`;

    def.props.forEach(key => {
      const unit = def.units?.[key] || '';
      const val = comp.props[key];
      const dispVal = typeof val === 'number' ? Utils.fmtV(val) + unit : `${val} ${unit}`;
      html += `<div class="prop-row">
        <span class="prop-label">${key}</span>
        <span class="prop-value" data-edit="${comp.id}:${key}" title="Click to edit">${dispVal}</span>
      </div>`;
    });

    if (Simulator.running) {
      html += `<div class="prop-row"><span class="prop-label">Temp</span><span class="prop-value" style="color:${Utils.tempColor(comp.state.temp || 25)}">${(comp.state.temp||25).toFixed(1)}°C</span></div>`;
      const v = Simulator.getComponentVoltage(comp);
      html += `<div class="prop-row"><span class="prop-label">Voltage</span><span class="prop-value">${v.toFixed(3)}V</span></div>`;
    }

    el.innerHTML = html;

    // Edit on click
    el.querySelectorAll('[data-edit]').forEach(el2 => {
      el2.addEventListener('click', () => {
        const [id, key] = el2.dataset.edit.split(':');
        Modal.editProp(id, key);
      });
    });
  },

  clearProps() {
    const el = document.getElementById('props-content');
    if (el) el.innerHTML = '<p class="hint">Select a component to view and edit its properties.</p>';
  },

  updateBOM() {
    const el = document.getElementById('bom-content');
    if (!el) return;
    const bom = Simulator.generateBOM();
    if (Object.keys(bom).length === 0) {
      el.innerHTML = '<p class="hint">Add components to generate BOM.</p>';
      return;
    }
    let html = '';
    Object.entries(bom).forEach(([type, items]) => {
      const def = ComponentDefs[type];
      html += `<div class="bom-row">
        <span class="bom-type">${def?.shortLabel || type}</span>
        <span class="bom-count">×${items.length}</span>
        <span class="bom-value">${def?.label || type}</span>
      </div>`;
    });
    el.innerHTML = html;
  },

  updateThermal() {
    const components = Board.getComponents();
    if (components.length === 0) return;
    const temps = components.map(c => c.state.temp || 25);
    const peak = Math.max(...temps);
    const avg = temps.reduce((a,b)=>a+b,0) / temps.length;
    const peakEl = document.getElementById('thermal-peak');
    const avgEl = document.getElementById('thermal-avg');
    if (peakEl) { peakEl.textContent = peak.toFixed(0); peakEl.style.color = Utils.tempColor(peak); }
    if (avgEl) { avgEl.textContent = avg.toFixed(0); avgEl.style.color = Utils.tempColor(avg); }
  },

  updateSignalIntegrity() {
    const el = document.getElementById('si-content');
    if (!el) return;
    const results = Simulator.getSignalIntegrity();
    if (results.length === 0) {
      el.innerHTML = '<p class="hint">Run simulation to analyse signals.</p>';
      return;
    }
    let html = '';
    results.forEach(r => {
      html += `<div class="si-item">
        <div class="si-dot si-${r.status}"></div>
        <span class="si-label">${r.label}</span>
        <span class="si-value">${r.value}</span>
      </div>`;
    });
    el.innerHTML = html;
  },

  updateConfidence() {
    const el = document.getElementById('confidence-score');
    if (!el) return;
    const result = Simulator.getConfidenceScore();
    if (!result) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.querySelector('b').textContent = `${result.score}%`;
    el.className = result.score >= 80 ? 'good' : result.score >= 50 ? '' : 'bad';
  },

  updateStatus(msg) {
    const el = document.getElementById('status-msg');
    if (el) el.textContent = msg;
  },

  updateSimState(state) {
    const el = document.getElementById('sim-state-indicator');
    if (!el) return;
    el.className = state;
    el.textContent = { running: '● RUNNING', stopped: '● STOPPED', warning: '⚠ WARNING', error: '✕ ERROR' }[state] || state;
  },
};

// ── Modal ─────────────────────────────────────────────────────
const Modal = {
  _onOk: null,

  show(title, bodyHtml, onOk) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = bodyHtml;
    document.getElementById('modal-overlay').classList.remove('hidden');
    this._onOk = onOk;
  },

  hide() {
    document.getElementById('modal-overlay').classList.add('hidden');
    this._onOk = null;
  },

  editProp(compId, key) {
    const comp = Board.getComponent(compId);
    if (!comp) return;
    const def = ComponentDefs[comp.type];
    const unit = def.units?.[key] || '';
    const cur = comp.props[key];

    const isStr = typeof cur === 'string';
    const input = isStr
      ? `<input type="text" id="prop-input" value="${cur}" />`
      : `<input type="number" id="prop-input" value="${cur}" step="any" />`;

    this.show(
      `Edit ${comp.id} — ${key}`,
      `<div class="modal-field">
        <label>${key.toUpperCase()} (${unit})</label>
        ${input}
        <p style="font-size:10px;color:var(--text-dim);margin-top:6px">${def.description || ''}</p>
      </div>`,
      () => {
        const val = document.getElementById('prop-input').value;
        comp.props[key] = isStr ? val : parseFloat(val) || 0;
        UI.showProps(comp);
        Renderer.markDirty();
        Debug.log(`Edited ${compId}.${key} = ${val}`, 'ok');
      }
    );
    setTimeout(() => document.getElementById('prop-input')?.focus(), 50);
  },
};

// Subscribe to sim ticks for live panel updates
EventBus.on('sim:tick', () => {
  UI.updateThermal();
  UI.updateConfidence();

  const t = Simulator.time;
  const pw = Simulator.power;
  const simTimeEl = document.getElementById('sim-time');
  const powerEl = document.getElementById('power-draw');
  if (simTimeEl) simTimeEl.textContent = `T: ${t.toFixed(3)}s`;
  if (powerEl) powerEl.textContent = `Power: ${(pw * 1000).toFixed(1)}mW`;

  // Update selected component props live
  const sel = Renderer.getSelection();
  if (sel.length === 1) {
    const comp = Board.getComponent(sel[0]);
    if (comp) UI.showProps(comp);
  }
});
