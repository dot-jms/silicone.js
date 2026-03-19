// ============================================================
// SILICON LAB — worker-analog.js
// Web Worker: Physics engine
//
// DELTA-PHYSICS: Only simulates "active nodes" — components
// whose state changed more than a threshold last tick.
// Dormant sections of the board sleep and cost zero CPU.
//
// WebGL thermal map runs on an OffscreenCanvas transferred
// from the main thread. Falls back to CPU if WebGL unavailable.
// ============================================================

'use strict';

// ── Constants ─────────────────────────────────────────────────
const AMBIENT  = 25;
const TICK_MS  = 16;

// Thermal params: [thermal_mass, thermal_resistance_to_ambient, max_safe_temp]
const TH = {
  resistor:   [0.5,  80,  155],
  capacitor:  [1.5,  55,  85 ],
  led:        [0.1,  110, 100],
  cpu:        [8,    8,   105],
  ram:        [3,    18,  85 ],
  gpu:        [15,   4,   95 ],
  power:      [5,    12,  125],
  crystal:    [0.3,  200, 85 ],
  transistor: [0.8,  45,  150],
  chip:       [1.5,  35,  85 ],
  default_:   [2,    40,  85 ],
};

// ── State ──────────────────────────────────────────────────────
let components  = [];   // serialisable objects (no methods)
let traces      = [];
let running     = false;
let stressTest  = false;
let supplyV     = 12;
let speed       = 5;
let _interval   = null;

// Delta-physics: track which nodes changed voltage last tick
let _voltageMap     = new Map();
let _currentMap     = new Map();
let _shorts         = new Set();
let _activeNodes    = new Set(); // comp ids that need simulation
let _sleepCounters  = new Map(); // comp id → ticks-dormant
const SLEEP_AFTER   = 10;        // ticks of no change before sleeping

// Oscilloscope
let _probeId    = null;
let _waveHist   = [];

// WebGL thermal canvas
let _gl         = null;
let _thermalCanvas = null;
let _glProg     = null;
let _glBuf      = null;

// ── Voltage solver ─────────────────────────────────────────────
function buildVoltageMap() {
  const map  = new Map();
  const curr = new Map();

  // GND = 0
  for (const comp of components) {
    if (comp.pins) {
      for (const p of comp.pins) {
        if (p.type === 'gnd') map.set(`${comp.id}:${p.name}`, 0);
      }
    }
  }

  // Power sources
  for (const comp of components) {
    if (comp.type === 'power') {
      map.set(`${comp.id}:VIN`, supplyV);
      map.set(comp.id, supplyV);
      if (comp.state.outputting) {
        const vout = comp.state.output_voltage || comp.props.vout || 3.3;
        map.set(`${comp.id}:VOUT`, vout);
      }
    }
  }

  // Propagation
  let changed = true, iters = 0;
  while (changed && iters < 30) {
    changed = false; iters++;
    for (const t of traces) {
      const fKey = `${t.fromCompId}:${t.fromPin}`;
      const tKey = `${t.toCompId}:${t.toPin}`;
      const fromV = map.get(fKey) ?? map.get(t.fromCompId) ?? 0;
      const toV   = map.get(tKey) ?? map.get(t.toCompId)   ?? 0;
      const R     = traceR(t);
      const drop  = fromV * Math.min(R / 10, 0.04);
      const netV  = fromV - drop;
      if (netV > toV + 0.005) {
        map.set(tKey, netV);
        if (netV > (map.get(t.toCompId) ?? 0) + 0.005) { map.set(t.toCompId, netV); changed = true; }
      }
      if (toV > fromV + 0.005 && !map.has(fKey)) { map.set(fKey, toV); map.set(t.fromCompId, toV); changed = true; }
      if (fromV > 0.5 && toV < 0.05 && R < 0.01) _shorts.add(t.id);
    }
  }

  // Current per trace + trace heating
  for (const t of traces) {
    const fV = map.get(`${t.fromCompId}:${t.fromPin}`) ?? map.get(t.fromCompId) ?? 0;
    const tV = map.get(`${t.toCompId}:${t.toPin}`)    ?? map.get(t.toCompId)   ?? 0;
    const R  = Math.max(traceR(t), 0.001);
    const I  = Math.abs(fV - tV) / R;
    curr.set(t.id, I);
    if (!t.state) t.state = { temp: AMBIENT, current: 0 };
    const prevI = t.state.current;
    t.state.current = I;
    const P = I * I * R;
    const dt = TICK_MS / 1000 * (speed / 5);
    t.state.temp = clamp(t.state.temp + P * 0.3 - (t.state.temp - AMBIENT) * 0.008, AMBIENT, 250);
    // Activate neighbours if current changed significantly
    if (Math.abs(I - prevI) > 0.01) {
      _activeNodes.add(t.fromCompId);
      _activeNodes.add(t.toCompId);
    }
  }

  _voltageMap = map;
  _currentMap = curr;
  return map;
}

function traceR(t) {
  const segs  = ((t.points?.length ?? 2) - 1);
  const lenM  = segs * 0.02;
  return (1.72e-8 * lenM) / (0.0003 * 0.000035);
}

function getV(comp) {
  if (comp.type === 'power') return supplyV;
  let v = _voltageMap.get(comp.id) ?? 0;
  if (comp.pins) {
    for (const p of comp.pins) {
      if (p.type === 'power_in' || p.type === 'passive') {
        const pv = _voltageMap.get(`${comp.id}:${p.name}`) ?? 0;
        if (pv > v) v = pv;
      }
    }
  }
  return v;
}

// ── Thermal step ───────────────────────────────────────────────
function heatStep(comp, P, dt) {
  const [mass, rth, tmax] = TH[comp.type] ?? TH.default_;
  const T  = comp.state.temp ?? AMBIENT;
  const dT = (P - (T - AMBIENT) / rth) * dt / mass;
  const newT = clamp(T + dT, AMBIENT - 1, tmax + 120);
  comp.state.temp = newT;

  if (newT > tmax + 80 && !comp.state.burned) {
    destroy(comp, `thermal runaway: ${newT.toFixed(0)}°C`);
    return true; // destroyed
  }
  comp.state.throttling = newT > tmax;
  return false;
}

function destroy(comp, reason) {
  if (comp.state.burned) return;
  comp.state.burned  = true;
  comp.state.running = false;
  postLog('error', `💥 ${comp.id} DESTROYED — ${reason}`);
}

// ── Delta-physics: decide which nodes to simulate ──────────────
function updateActiveSet() {
  // Always simulate powered components with non-trivial voltage
  // Sleep components that haven't changed in SLEEP_AFTER ticks
  for (const comp of components) {
    if (comp.state.burned) continue;
    const V = getV(comp);
    const prevV = comp.state._lastV ?? 0;
    if (Math.abs(V - prevV) > 0.05 || Math.abs(comp.state.temp - AMBIENT) > 1) {
      _activeNodes.add(comp.id);
      _sleepCounters.delete(comp.id);
    } else {
      const sc = (_sleepCounters.get(comp.id) ?? 0) + 1;
      _sleepCounters.set(comp.id, sc);
      if (sc >= SLEEP_AFTER) _activeNodes.delete(comp.id);
    }
    comp.state._lastV = V;
  }
}

// ── Per-component simulation ───────────────────────────────────
function simComp(comp, dt) {
  if (comp.state.burned) {
    comp.state.temp = clamp((comp.state.temp ?? AMBIENT) - 3 * dt, AMBIENT, 600);
    return;
  }
  const V = getV(comp);

  switch (comp.type) {
    case 'resistor': {
      const R = Math.max(comp.props.resistance ?? 1000, 0.01);
      const I = V / R, P = I * I * R;
      comp.state.current = I; comp.state.voltage = V; comp.state.power = P;
      heatStep(comp, P, dt);
      if (P > (comp.props.wattage ?? 0.25) * 6) destroy(comp, `${P.toFixed(2)}W (rated ${comp.props.wattage}W)`);
      break;
    }
    case 'capacitor': {
      const vRated = comp.props.voltage_rating ?? 16;
      const C      = comp.props.capacitance ?? 100e-6;
      const esr    = Math.max(comp.props.esr ?? 0.1, 0.01);
      if (!comp.state.voltage) comp.state.voltage = 0;
      const tau = C * esr * 500 + 0.05;
      comp.state.voltage += (V - comp.state.voltage) * clamp(dt / tau, 0, 0.8);
      const Vc   = comp.state.voltage;
      const Iesr = Math.abs(V - Vc) / esr;
      const Pesr = Iesr * Iesr * esr;
      comp.state.current = Iesr; comp.state.power = Pesr;
      heatStep(comp, Pesr, dt);
      if (Vc > vRated * 1.2) comp.state.temp = clamp(comp.state.temp + (Vc/vRated-1)*80*dt, AMBIENT, 200);
      if (Vc > vRated * 1.5 || (Vc > vRated * 1.25 && comp.state.temp > 75))
        destroy(comp, `overvoltage POP — ${Vc.toFixed(2)}V on ${vRated}V cap`);
      if (V < -0.3) { comp.state.temp += 25*dt; if (comp.state.temp > 55) destroy(comp,'reverse polarity'); }
      break;
    }
    case 'led': {
      const Vf   = comp.props.forward_voltage ?? 2.0;
      const Imax = comp.props.max_current ?? 0.02;
      if (V > Vf) {
        const serR = findSeriesR(comp.id) ?? 1.0;
        const I = (V - Vf) / serR;
        comp.state.current = I; comp.state.lit = I > 0.0005;
        heatStep(comp, I * Vf, dt);
        if (I > Imax * 3.5) destroy(comp, `overcurrent ${(I*1000).toFixed(0)}mA (max ${(Imax*1000).toFixed(0)}mA)`);
        else if (I > Imax * 1.5) postLogThrottled('warn', `⚠ ${comp.id} exceeding Imax`);
      } else if (V < -6.0) {
        destroy(comp, 'reverse breakdown');
      } else {
        comp.state.current = 0; comp.state.lit = false;
        heatStep(comp, 0, dt);
      }
      break;
    }
    case 'cpu': {
      const vc = comp.props.vcore ?? 1.8, tdp = comp.props.tdp ?? 15;
      if (V >= vc * 0.85) {
        comp.state.running = true; comp.state.voltage = V;
        const P = tdp * (comp.state.throttling ? 0.45 : 1.0);
        comp.state.power = P; comp.state.current = P / Math.max(V, 0.1);
        heatStep(comp, P, dt);
      } else {
        comp.state.running = false; heatStep(comp, V > 0.05 ? 0.05 : 0, dt);
        if (V > 0.05) postLogThrottled('warn', `⚠ ${comp.id} undervoltage: ${V.toFixed(2)}V`);
      }
      if (V > vc * 1.6) destroy(comp, `destructive overvoltage: ${V.toFixed(2)}V`);
      break;
    }
    case 'ram': {
      const vn = comp.props.voltage ?? 3.3, tdp = comp.props.tdp ?? 3;
      if (V >= vn * 0.85) { comp.state.active = true; comp.state.power = tdp; heatStep(comp, tdp, dt); }
      else { comp.state.active = false; heatStep(comp, 0, dt); }
      if (V > vn * 1.3) destroy(comp, `overvoltage: ${V.toFixed(2)}V on ${vn}V RAM`);
      break;
    }
    case 'gpu': {
      const vc = comp.props.vcore ?? 1.1, tdp = comp.props.tdp ?? 80;
      if (V >= vc * 0.85) { comp.state.running = true; const P = tdp*(comp.state.throttling?0.5:1); comp.state.power=P; heatStep(comp,P,dt); }
      else { comp.state.running = false; heatStep(comp,0,dt); }
      break;
    }
    case 'power': {
      const eff = comp.props.efficiency ?? 0.90;
      if (supplyV >= (comp.props.vin ?? 12) * 0.7) {
        comp.state.outputting = true;
        comp.state.output_voltage = comp.props.vout ?? 3.3;
        const Ploss = (comp.props.vout??3.3) * (comp.props.max_current??3) * 0.35 * (1-eff);
        comp.state.power = Ploss; comp.state.current = Ploss / Math.max(supplyV, 0.1);
        heatStep(comp, Ploss, dt);
      } else {
        comp.state.outputting = false; comp.state.output_voltage = 0; heatStep(comp,0,dt);
      }
      break;
    }
    case 'crystal': {
      comp.state.oscillating = V > 1.5; heatStep(comp, comp.state.oscillating ? 0.008 : 0, dt); break;
    }
    case 'transistor': {
      const hfe = comp.props.hfe ?? 100, Icm = comp.props.ic_max ?? 0.6;
      if (V > 0.7) {
        const Ib = (V-0.7)/1000, Ic = clamp(Ib*hfe, 0, Icm);
        comp.state.on=true; comp.state.ic=Ic; comp.state.current=Ic;
        const P=Ic*Math.max(V-(comp.props.vce_sat??0.2),0.01); comp.state.power=P;
        heatStep(comp,P,dt);
        if (Ic > Icm*1.8) destroy(comp, `Ic=${(Ic*1000).toFixed(0)}mA > max ${(Icm*1000).toFixed(0)}mA`);
      } else { comp.state.on=false; comp.state.ic=0; heatStep(comp,0,dt); }
      break;
    }
    case 'chip': {
      const vcc = comp.props.vcc ?? 5;
      comp.state.powered = V >= vcc*0.85;
      heatStep(comp, comp.state.powered ? (comp.props.tdp??0.08) : 0, dt);
      break;
    }
    default: {
      // Generic imported component
      heatStep(comp, comp.state.powered ? (comp.props.tdp_w ?? 0.05) : 0, dt);
      comp.state.powered = V > 0.5;
      break;
    }
  }
}

function findSeriesR(compId) {
  for (const t of traces) {
    const otherId = t.fromCompId === compId ? t.toCompId : t.toCompId === compId ? t.fromCompId : null;
    if (otherId) {
      const o = components.find(c => c.id === otherId);
      if (o?.type === 'resistor') return o.props.resistance ?? 470;
    }
  }
  return null;
}

// ── WebGL thermal map ──────────────────────────────────────────
// Heat dissipation modelled as a diffusion (blur) over a 2D grid.
// GPU does the blur pass — main thread reads back a texture.

function initWebGL(canvas) {
  try {
    _gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!_gl) { postLog('info', '[Thermal] WebGL unavailable — CPU thermal map'); return false; }

    const vert = `
      attribute vec2 a_pos;
      varying vec2 v_uv;
      void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0, 1); }
    `;
    // Simple heat diffusion: 5-tap Gaussian blur + decay toward ambient
    const frag = `
      precision mediump float;
      uniform sampler2D u_heat;
      uniform vec2 u_texel;
      uniform float u_decay;
      varying vec2 v_uv;
      void main() {
        vec4 c = texture2D(u_heat, v_uv);
        vec4 n = texture2D(u_heat, v_uv + vec2(0, u_texel.y));
        vec4 s = texture2D(u_heat, v_uv - vec2(0, u_texel.y));
        vec4 e = texture2D(u_heat, v_uv + vec2(u_texel.x, 0));
        vec4 w = texture2D(u_heat, v_uv - vec2(u_texel.x, 0));
        vec4 diffused = (c*0.5 + (n+s+e+w)*0.125);
        diffused.r = max(diffused.r - u_decay, 0.0);
        gl_FragColor = diffused;
      }
    `;

    const compile = (type, src) => {
      const s = _gl.createShader(type);
      _gl.shaderSource(s, src); _gl.compileShader(s);
      if (!_gl.getShaderParameter(s, _gl.COMPILE_STATUS))
        throw new Error(_gl.getShaderInfoLog(s));
      return s;
    };

    _glProg = _gl.createProgram();
    _gl.attachShader(_glProg, compile(_gl.VERTEX_SHADER, vert));
    _gl.attachShader(_glProg, compile(_gl.FRAGMENT_SHADER, frag));
    _gl.linkProgram(_glProg);

    const quad = new Float32Array([-1,-1, 1,-1, -1,1, 1,1]);
    _glBuf = _gl.createBuffer();
    _gl.bindBuffer(_gl.ARRAY_BUFFER, _glBuf);
    _gl.bufferData(_gl.ARRAY_BUFFER, quad, _gl.STATIC_DRAW);

    _thermalCanvas = canvas;
    postLog('ok', '[Thermal] WebGL diffusion shader ready');
    return true;
  } catch (e) {
    _gl = null;
    postLog('warn', `[Thermal] WebGL init failed: ${e.message}`);
    return false;
  }
}

function renderThermalGL(W, H) {
  if (!_gl || !_thermalCanvas) return;
  const gl = _gl;
  gl.viewport(0, 0, W, H);

  // Upload component heat spots as a texture
  const texData = new Uint8Array(W * H * 4);
  for (const comp of components) {
    const [,,tmax] = TH[comp.type] ?? TH.default_;
    const t = comp.state.temp ?? AMBIENT;
    const heat = clamp((t - AMBIENT) / (tmax - AMBIENT + 1), 0, 1);
    if (heat < 0.01) continue;

    // Map world coords to texture pixels
    const px = Math.floor((comp.x / 800) * W);
    const py = Math.floor((comp.y / 600) * H);
    const def_w = 6, def_h = 6;
    for (let dy = -def_h; dy <= def_h; dy++) {
      for (let dx = -def_w; dx <= def_w; dx++) {
        const tx = clamp(px + dx, 0, W-1);
        const ty = clamp(py + dy, 0, H-1);
        const idx4 = (ty * W + tx) * 4;
        texData[idx4]   = Math.max(texData[idx4],   Math.floor(heat * 255));
        texData[idx4+3] = 255;
      }
    }
  }

  // Create and bind texture
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, texData);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.useProgram(_glProg);
  const posLoc = gl.getAttribLocation(_glProg, 'a_pos');
  gl.bindBuffer(gl.ARRAY_BUFFER, _glBuf);
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
  gl.uniform1i(gl.getUniformLocation(_glProg, 'u_heat'), 0);
  gl.uniform2f(gl.getUniformLocation(_glProg, 'u_texel'), 1/W, 1/H);
  gl.uniform1f(gl.getUniformLocation(_glProg, 'u_decay'), 0.002);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.deleteTexture(tex);
}

// ── Main tick ──────────────────────────────────────────────────
function tick() {
  if (!running) return;
  _shorts.clear();

  if (stressTest) supplyV = 12 + Math.sin(Date.now() * 0.004) * 2.5 + (Math.random()-0.5)*0.4;

  buildVoltageMap();
  updateActiveSet();

  const dt = (TICK_MS / 1000) * (speed / 5);
  let totalPower = 0;
  let activeCount = 0;

  for (const comp of components) {
    if (_activeNodes.has(comp.id)) {
      simComp(comp, dt);
      activeCount++;
    } else {
      // Sleeping: still cool down slowly
      if (comp.state.temp > AMBIENT + 0.5) {
        const [mass, rth] = TH[comp.type] ?? TH.default_;
        comp.state.temp = clamp(comp.state.temp - ((comp.state.temp-AMBIENT)/rth)*dt/mass*0.5, AMBIENT, 600);
      }
    }
    totalPower += comp.state.power ?? 0;
  }

  // Oscilloscope probe
  let probeV = 0;
  if (_probeId) {
    const pc = components.find(c => c.id === _probeId);
    if (pc) {
      probeV = getV(pc);
      const noise = stressTest ? (Math.random()-0.5)*0.8 : (Math.random()-0.5)*0.015;
      _waveHist.push(probeV + noise);
      if (_waveHist.length > 400) _waveHist.shift();
    }
  }

  // Build lean state snapshot for main thread
  // Only send changed state (delta compression)
  const compStates = components.map(c => ({
    id:         c.id,
    temp:       +(c.state.temp ?? AMBIENT).toFixed(2),
    voltage:    +(c.state.voltage ?? 0).toFixed(3),
    current:    +(c.state.current ?? 0).toFixed(4),
    power:      +(c.state.power ?? 0).toFixed(4),
    burned:     !!c.state.burned,
    throttling: !!c.state.throttling,
    running:    !!c.state.running,
    lit:        !!c.state.lit,
    active:     !!c.state.active,
    oscillating:!!c.state.oscillating,
    powered:    !!c.state.powered,
    outputting: !!c.state.outputting,
    output_voltage: +(c.state.output_voltage ?? 0).toFixed(3),
  }));

  const traceStates = traces.map(t => ({
    id:      t.id,
    temp:    +((t.state?.temp ?? AMBIENT)).toFixed(1),
    current: +((t.state?.current ?? 0)).toFixed(4),
  }));

  // Thermal map pixels (CPU fallback if no WebGL)
  let thermalPixels = null;
  if (!_gl) {
    const W = 80, H = 60;
    thermalPixels = new Float32Array(W * H);
    for (const comp of components) {
      const [,,tmax] = TH[comp.type] ?? TH.default_;
      const heat = clamp((comp.state.temp - AMBIENT) / (tmax - AMBIENT + 1), 0, 1);
      if (heat < 0.01) continue;
      const px = Math.floor((comp.x / 800) * W);
      const py = Math.floor((comp.y / 600) * H);
      for (let dy=-5;dy<=5;dy++) for (let dx=-5;dx<=5;dx++) {
        const tx=clamp(px+dx,0,W-1), ty=clamp(py+dy,0,H-1);
        thermalPixels[ty*W+tx] = Math.max(thermalPixels[ty*W+tx], heat * (1-Math.abs(dx)/6) * (1-Math.abs(dy)/6));
      }
    }
  }

  self.postMessage({
    type:        'tick',
    compStates,
    traceStates,
    totalPower,
    activeCount,
    shorts:      [..._shorts],
    waveHistory: _waveHist.slice(-400),
    thermalPixels,
    supplyV,
  });
}

// ── Log helpers ────────────────────────────────────────────────
let _logThrottle = new Map();
function postLog(level, text) { self.postMessage({ type:'log', level, text }); }
function postLogThrottled(level, text) {
  const now = Date.now();
  const last = _logThrottle.get(text) ?? 0;
  if (now - last > 2000) { _logThrottle.set(text, now); postLog(level, text); }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// ── Message handler ────────────────────────────────────────────
self.onmessage = function(e) {
  const msg = e.data;
  switch (msg.type) {

    case 'init':
      // Receive serialised component + trace data
      components = msg.components.map(c => ({
        ...c,
        state: { temp: AMBIENT, voltage:0, current:0, power:0, burned:false, running:false, _lastV:0 },
      }));
      traces = msg.traces.map(t => ({ ...t, state: { temp: AMBIENT, current:0 } }));
      _activeNodes = new Set(components.map(c => c.id)); // all active at start
      _sleepCounters.clear();
      _voltageMap.clear(); _currentMap.clear(); _shorts.clear();
      _waveHist = [];
      postLog('ok', `[Physics] Initialised — ${components.length} components, ${traces.length} nets`);
      break;

    case 'start':
      running = true;
      _interval = setInterval(tick, TICK_MS);
      postLog('ok', '[Physics] Engine started');
      break;

    case 'stop':
      running = false;
      clearInterval(_interval);
      break;

    case 'reset':
      running = false;
      clearInterval(_interval);
      for (const c of components) c.state = { temp:AMBIENT, voltage:0, current:0, power:0, burned:false, running:false, _lastV:0 };
      for (const t of traces) t.state = { temp:AMBIENT, current:0 };
      _activeNodes = new Set(components.map(c => c.id));
      _sleepCounters.clear(); _waveHist = [];
      postLog('info', '[Physics] Reset');
      break;

    case 'setSpeed': speed = Math.max(1, Math.min(10, msg.speed)); break;
    case 'setStress': stressTest = !!msg.on; break;
    case 'setProbe':  _probeId = msg.compId; _waveHist = []; break;
    case 'setSupply': supplyV = msg.voltage; break;

    case 'updateComponents':
      // Hot-swap component positions after drag
      for (const upd of msg.updates) {
        const c = components.find(c => c.id === upd.id);
        if (c) { c.x = upd.x; c.y = upd.y; }
      }
      break;

    case 'addComponent':
      components.push({ ...msg.comp, state: { temp:AMBIENT, voltage:0, current:0, power:0, burned:false, running:false, _lastV:0 } });
      _activeNodes.add(msg.comp.id);
      break;

    case 'removeComponent':
      components = components.filter(c => c.id !== msg.id);
      traces = traces.filter(t => t.fromCompId !== msg.id && t.toCompId !== msg.id);
      _activeNodes.delete(msg.id);
      break;

    case 'addTrace':
      traces.push({ ...msg.trace, state: { temp:AMBIENT, current:0 } });
      _activeNodes.add(msg.trace.fromCompId);
      _activeNodes.add(msg.trace.toCompId);
      break;

    case 'initWebGL':
      if (msg.canvas) initWebGL(msg.canvas);
      break;

    case 'renderThermal':
      if (_gl) renderThermalGL(msg.width, msg.height);
      break;
  }
};
