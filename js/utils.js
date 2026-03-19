// ============================================================
// SILICON LAB — utils.js
// ============================================================

const Utils = {
  // Generate unique IDs
  uid: (() => {
    let n = 1;
    return (prefix = 'C') => `${prefix}${String(n++).padStart(3,'0')}`;
  })(),

  // Clamp value
  clamp: (v, min, max) => Math.max(min, Math.min(max, v)),

  // Distance between two points
  dist: (a, b) => Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2),

  // Snap to grid
  snap: (v, grid = 20) => Math.round(v / grid) * grid,

  // Lerp
  lerp: (a, b, t) => a + (b - a) * t,

  // Format number
  fmtV: (v, decimals = 2) => {
    if (Math.abs(v) >= 1e9) return (v/1e9).toFixed(decimals) + 'G';
    if (Math.abs(v) >= 1e6) return (v/1e6).toFixed(decimals) + 'M';
    if (Math.abs(v) >= 1e3) return (v/1e3).toFixed(decimals) + 'k';
    if (Math.abs(v) >= 1)   return v.toFixed(decimals);
    if (Math.abs(v) >= 1e-3) return (v*1e3).toFixed(decimals) + 'm';
    if (Math.abs(v) >= 1e-6) return (v*1e6).toFixed(decimals) + 'µ';
    return (v*1e9).toFixed(decimals) + 'n';
  },

  // Temperature color (cool→hot)
  tempColor: (t, min=25, max=150) => {
    const r = Utils.clamp((t - min) / (max - min), 0, 1);
    const h = Utils.lerp(180, 0, r);  // cyan to red
    return `hsl(${h}, 100%, 50%)`;
  },

  // Random in range
  rand: (min, max) => min + Math.random() * (max - min),

  // Debounce
  debounce: (fn, ms) => {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  },

  // Deep clone (simple)
  clone: (obj) => JSON.parse(JSON.stringify(obj)),

  // Format timestamp
  ts: () => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
  },

  // Point inside rectangle
  ptInRect: (px, py, rx, ry, rw, rh) => px >= rx && px <= rx+rw && py >= ry && py <= ry+rh,

  // Hex to RGB
  hexToRgb: (hex) => {
    const r = parseInt(hex.slice(1,3),16);
    const g = parseInt(hex.slice(3,5),16);
    const b = parseInt(hex.slice(5,7),16);
    return {r,g,b};
  },

  // Map range
  mapRange: (v, inMin, inMax, outMin, outMax) => outMin + (v - inMin) / (inMax - inMin) * (outMax - outMin),
};

// Event bus
const EventBus = {
  _listeners: {},
  on(evt, fn) {
    if (!this._listeners[evt]) this._listeners[evt] = [];
    this._listeners[evt].push(fn);
  },
  off(evt, fn) {
    if (!this._listeners[evt]) return;
    this._listeners[evt] = this._listeners[evt].filter(f => f !== fn);
  },
  emit(evt, data) {
    (this._listeners[evt] || []).forEach(fn => fn(data));
  },
};
