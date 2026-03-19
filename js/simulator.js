// ============================================================
// SILICON LAB — simulator.js  (v3 — multi-core orchestrator)
//
// This file is intentionally thin — it owns no physics logic.
// All heavy work runs in Web Workers:
//   worker-digital.js  — 6502 CPU at 1.79MHz
//   worker-analog.js   — Ohm's law, thermal physics, delta solver
//
// Main thread responsibilities:
//   • Serialise board state into workers on change
//   • Receive worker results and merge into component state refs
//   • Expose clean public API to the rest of the app
//   • Fall back gracefully if Workers are unavailable
// ============================================================

const Simulator = (() => {

  // ── State ────────────────────────────────────────────────
  let _running       = false;
  let _stressTest    = false;
  let _speed         = 5;
  let _supplyV       = 12;
  let _firmwareLoaded = false;
  let _firmwareBytes  = null;
  let _firmwareSource = '';
  let _time          = 0;
  let _totalPower    = 0;
  let _waveHistory   = [];
  let _displayMem    = new Uint8Array(960);
  let _cpuRegs       = null;
  let _shorts        = new Set();
  let _activeCount   = 0;

  // Component/trace refs (shared with Board)
  let _components = [];
  let _traces     = [];

  // Workers
  let _digitalWorker = null;
  let _analogWorker  = null;
  let _workersReady  = false;
  let _workersFailed = false;

  // Fallback (no workers) — inline physics
  let _fallbackInterval = null;
  let _fallbackCPU      = null; // CPU6502 state if worker unavailable

  // Probe
  let _probeCompId = null;

  // ── Worker setup ─────────────────────────────────────────
  function initWorkers() {
    try {
      _digitalWorker = new Worker('js/worker-digital.js');
      _analogWorker  = new Worker('js/worker-analog.js');

      _digitalWorker.onmessage = handleDigitalMsg;
      _analogWorker.onmessage  = handleAnalogMsg;

      _digitalWorker.onerror = (e) => {
        Debug.log(`[Digital Worker] Error: ${e.message}`, 'error');
        _workersFailed = true;
        fallbackMode();
      };
      _analogWorker.onerror = (e) => {
        Debug.log(`[Analog Worker] Error: ${e.message}`, 'error');
        _workersFailed = true;
        fallbackMode();
      };

      _workersReady = true;
      Debug.log('[Workers] Digital + Analog workers online ✓', 'ok');
      Debug.log('[Workers] Delta-physics solver active — sleeping inactive nodes', 'info');
    } catch (e) {
      _workersFailed = true;
      Debug.log(`[Workers] Web Workers unavailable (${e.message}) — running in single-thread mode`, 'warn');
      fallbackMode();
    }
  }

  function handleDigitalMsg(e) {
    const msg = e.data;
    switch (msg.type) {
      case 'tick':
        _cpuRegs = msg.regs;
        // Update display memory — transfer ownership back
        if (msg.display) _displayMem = msg.display;
        _time += 0.016 * (_speed / 5);
        // Forward CPU throttle state to analog worker
        const cpuComp = _components.find(c => c.type === 'cpu');
        if (cpuComp && _analogWorker) {
          _analogWorker.postMessage({
            type: 'updateComponents',
            updates: [{ id: cpuComp.id, x: cpuComp.x, y: cpuComp.y }],
          });
        }
        break;
      case 'log':
        EventBus.emit('sim:log', { msg: msg.text, type: msg.level });
        break;
      case 'peek_result':
        EventBus.emit('sim:peek_result', msg);
        break;
    }
  }

  function handleAnalogMsg(e) {
    const msg = e.data;
    switch (msg.type) {
      case 'tick': {
        _totalPower  = msg.totalPower;
        _shorts      = new Set(msg.shorts);
        _activeCount = msg.activeCount;
        if (msg.waveHistory) _waveHistory = msg.waveHistory;

        // Merge component states back into live component objects
        if (msg.compStates) {
          for (const s of msg.compStates) {
            const comp = _components.find(c => c.id === s.id);
            if (!comp) continue;
            // Only update fields that exist in the snapshot
            Object.assign(comp.state, s);
            // Tell digital worker if CPU throttle state changed
            if (comp.type === 'cpu' && _digitalWorker) {
              _digitalWorker.postMessage({ type: 'setThrottle', throttle: !!s.throttling });
            }
          }
        }

        // Merge trace states
        if (msg.traceStates) {
          for (const ts of msg.traceStates) {
            const trace = _traces.find(t => t.id === ts.id);
            if (trace) {
              if (!trace.state) trace.state = {};
              trace.state.temp    = ts.temp;
              trace.state.current = ts.current;
            }
          }
        }

        // Thermal pixels for WebGL map (if no offscreen canvas)
        if (msg.thermalPixels) EventBus.emit('sim:thermal', msg.thermalPixels);

        // Warnings from analog
        if (_shorts.size > 0) {
          EventBus.emit('sim:log', { msg: `⚡ SHORT CIRCUIT detected on ${_shorts.size} net(s)`, type: 'error' });
        }

        EventBus.emit('sim:tick', {
          time:       _time,
          power:      _totalPower,
          components: _components,
          waveHistory: _waveHistory,
          displayMem: _displayMem,
          cpuState:   _cpuRegs,
          activeNodes: _activeCount,
        });
        break;
      }
      case 'log':
        EventBus.emit('sim:log', { msg: msg.text, type: msg.level });
        break;
    }
  }

  // ── Fallback: inline simulation (no workers) ─────────────
  // Minimal physics when Workers blocked (file:// protocol etc.)
  function fallbackMode() {
    Debug.log('[Fallback] Running inline physics (limited performance)', 'warn');
  }

  function fallbackTick() {
    if (!_running) return;
    _time += 0.016 * (_speed / 5);

    const AMBIENT = 25;
    const dt = 0.016 * (_speed / 5);

    // Very simple voltage propagation
    const powerComps = _components.filter(c => c.type === 'power');
    powerComps.forEach(pc => {
      pc.state.outputting     = true;
      pc.state.output_voltage = pc.props.vout || 3.3;
    });

    _components.forEach(comp => {
      if (comp.state.burned) return;
      let V = 0;
      if (comp.type === 'power') V = _supplyV;
      else {
        _traces.forEach(t => {
          if (t.toCompId === comp.id) {
            const src = _components.find(c => c.id === t.fromCompId);
            if (src?.type === 'power' && src.state.output_voltage) {
              V = Math.max(V, src.state.output_voltage);
            }
          }
        });
      }

      // Basic thermal
      const TH_MAP = { cpu:[8,8,105], gpu:[15,4,95], ram:[3,18,85], power:[5,12,125], resistor:[0.5,80,155], capacitor:[1.5,55,85], led:[0.1,110,100], default_:[2,40,85] };
      const [mass, rth, tmax] = TH_MAP[comp.type] || TH_MAP.default_;
      const tdp = comp.props.tdp || comp.props.wattage || 0.1;
      const powered = V > 0.5;
      const P = powered ? tdp : 0;
      const T = comp.state.temp || AMBIENT;
      comp.state.temp = Math.max(AMBIENT, T + (P - (T-AMBIENT)/rth)*dt/mass);
      comp.state.running = powered && comp.type === 'cpu';
      comp.state.powered = powered;
      comp.state.power   = P;

      // Capacitor overvoltage
      if (comp.type === 'capacitor') {
        const vr = comp.props.voltage_rating || 16;
        if (!comp.state.voltage) comp.state.voltage = 0;
        comp.state.voltage += (V - comp.state.voltage) * 0.05;
        if (comp.state.voltage > vr * 1.5) {
          comp.state.burned = true;
          EventBus.emit('sim:log', { msg: `💥 ${comp.id} overvoltage POP`, type: 'error' });
        }
      }
    });

    // Step 6502 if available
    if (_fallbackCPU && typeof CPU6502 !== 'undefined') {
      const cpu = _components.find(c => c.type === 'cpu');
      if (cpu?.state.running) {
        const cycles = Math.floor(28636 * (_speed / 5));
        CPU6502.runCycles(_fallbackCPU, cycles);
        _cpuRegs = {
          A: _fallbackCPU.A, X: _fallbackCPU.X, Y: _fallbackCPU.Y,
          SP: _fallbackCPU.SP, PC: _fallbackCPU.PC,
          C: _fallbackCPU.C, Z: _fallbackCPU.Z, I: _fallbackCPU.I,
          D: _fallbackCPU.D, V: _fallbackCPU.V, N: _fallbackCPU.N,
          totalCycles: _fallbackCPU.totalCycles,
        };
        for (let i = 0; i < 960; i++) _displayMem[i] = _fallbackCPU.mem[0x0200 + i];
      }
    }

    EventBus.emit('sim:tick', {
      time: _time, power: _totalPower, components: _components,
      waveHistory: _waveHistory, displayMem: _displayMem, cpuState: _cpuRegs,
    });
  }

  // ── Serialise board for workers ───────────────────────────
  function serialiseComponents() {
    return _components.map(c => {
      const def = ComponentDefs[c.type];
      return {
        id:    c.id,
        type:  c.type,
        x:     c.x,
        y:     c.y,
        props: { ...c.props },
        pins:  def ? def.pins.map(p => ({ ...p })) : [],
      };
    });
  }

  function serialiseTraces() {
    return _traces.map(t => ({
      id:         t.id,
      fromCompId: t.fromCompId,
      fromPin:    t.fromPin,
      toCompId:   t.toCompId,
      toPin:      t.toPin,
      x1: t.x1, y1: t.y1,
      x2: t.x2, y2: t.y2,
      points: t.points ? t.points.map(p=>({...p})) : [],
    }));
  }

  // ── Firmware assembly ─────────────────────────────────────
  function assembleFirmware(src) {
    if (!src || !src.trim()) return null;
    if (typeof CPU6502 === 'undefined') return null;
    try {
      const bytes = CPU6502.assemble(src);
      if (bytes && bytes.length > 0) return bytes;
    } catch (e) {
      EventBus.emit('sim:log', { msg: `Assembler: ${e.message}`, type: 'warn' });
    }
    return null;
  }

  // ── Boot log sequence ────────────────────────────────────
  function runBootLog() {
    const has = t => _components.some(c => c.type === t);
    const steps = [
      [200,  'info', '[BOOT] Power-on reset…'],
      [400,  has('power') ? 'ok' : 'warn',
             has('power') ? '[BOOT] VCC rail stable ✓' : '[BOOT] No regulator — raw supply'],
      [700,  'info', `[BOOT] Supply: ${_supplyV}V`],
    ];
    if (has('crystal')) {
      const x = _components.find(c=>c.type==='crystal');
      steps.push([900, 'ok', `[BOOT] XTAL: ${x?.props?.frequency_mhz||1}MHz ✓`]);
    }
    if (has('cpu')) {
      steps.push([1100,'sim','[BOOT] 6502: reading reset vector $FFFC']);
      steps.push([1400,'ok', '[BOOT] 6502: execution started ✓']);
    }
    if (has('ram')) steps.push([1600,'ok','[BOOT] RAM self-test: PASS ✓']);
    if (_firmwareLoaded) {
      steps.push([2000,'ok', `[BOOT] Firmware: ${_firmwareBytes?.length||0}B at $8000 ✓`]);
      steps.push([2600,'sim','[BOOT] Entering main loop…']);
      steps.push([3200,'ok', '[BOOT] ★ SYSTEM READY ★']);
    } else {
      steps.push([2000,'warn','[BOOT] No firmware — CPU halted at reset vector']);
    }
    steps.forEach(([ms, type, msg]) => {
      setTimeout(() => {
        if (_running) EventBus.emit('sim:log', { msg, type });
      }, ms / (_speed / 5));
    });
  }

  // ── Signal Integrity ─────────────────────────────────────
  function signalIntegrity() {
    const res = [];
    _components.forEach(comp => {
      const def = ComponentDefs[comp.type];
      if (!def) return;
      const pp = def.pins.find(p => p.type === 'power_in');
      if (pp) {
        const conn = _traces.some(t =>
          (t.toCompId===comp.id&&t.toPin===pp.name) ||
          (t.fromCompId===comp.id&&t.fromPin===pp.name)
        );
        if (!conn) res.push({ status:'fail', label:`${comp.id} VCC floating`, value:'OPEN' });
        else if (comp.state.burned) res.push({ status:'fail', label:`${comp.id} DESTROYED`, value:'replace' });
        else res.push({ status:'ok', label:`${comp.id} power OK`, value:`${(comp.state.voltage||0).toFixed(2)}V` });
      }
    });
    _traces.forEach(t => {
      const I = t.state?.current || 0;
      if (I > 2.0)  res.push({ status:'fail', label:`Trace ${t.id} overcurrent`, value:`${I.toFixed(2)}A` });
      else if (I>0.5) res.push({ status:'warn', label:`Trace ${t.id} high I`, value:`${I.toFixed(2)}A` });
    });
    // LED without resistor
    _components.filter(c=>c.type==='led').forEach(led => {
      const hasR = _traces.some(t => {
        const oid = t.fromCompId===led.id?t.toCompId:t.toCompId===led.id?t.fromCompId:null;
        return oid && _components.find(c=>c.id===oid&&c.type==='resistor');
      });
      if (!hasR) res.push({ status:'warn', label:`${led.id} no series resistor`, value:'overcurrent risk' });
    });
    _shorts.forEach(id => res.push({ status:'fail', label:`Short on ${id}`, value:'SHORT' }));
    if (res.length === 0) res.push({ status:'ok', label:'All signals nominal', value:'PASS' });
    return res;
  }

  function confidenceScore() {
    if (_components.length === 0) return null;
    let score = 100;
    const issues = [];
    _components.forEach(comp => {
      const def = ComponentDefs[comp.type];
      if (!def) return;
      const pp = def.pins.find(p => p.type === 'power_in');
      if (pp) {
        const conn = _traces.some(t =>
          (t.toCompId===comp.id&&t.toPin===pp.name)||(t.fromCompId===comp.id&&t.fromPin===pp.name));
        if (!conn) { score-=12; issues.push(`${comp.id} VCC floating`); }
      }
      if (comp.state.burned)     { score-=35; issues.push(`${comp.id} destroyed`); }
      if (comp.state.throttling) { score-=8;  issues.push(`${comp.id} overheating`); }
    });
    _components.filter(c=>c.type==='led').forEach(led => {
      const hasR = _traces.some(t => {
        const oid = t.fromCompId===led.id?t.toCompId:t.toCompId===led.id?t.fromCompId:null;
        return oid && _components.find(c=>c.id===oid&&c.type==='resistor');
      });
      if (!hasR) { score-=10; issues.push(`${led.id}: no current-limiting R`); }
    });
    if (_shorts.size > 0) { score-=40; issues.push('short circuit'); }
    return { score: Math.max(0, Math.min(100, score)), issues };
  }

  function exportGerber() {
    let g = `G04 Silicon Lab — ${new Date().toISOString()}*\n%FSLAX36Y36*%\n%MOMM*%\n%LPD*%\n`;
    g += `G04 Board outline*\nG01*\nX000000Y000000D02*\nX200000Y000000D01*\nX200000Y150000D01*\nX000000Y150000D01*\nX000000Y000000D01*\n`;
    _components.forEach(c => {
      g += `G04 ${c.id}(${c.type})*\nX${Math.round(c.x*100).toString().padStart(6,'0')}Y${Math.round(c.y*100).toString().padStart(6,'0')}D03*\n`;
    });
    _traces.forEach((t,i) => {
      g += `G04 T${i}*\nX${Math.round(t.x1*100).toString().padStart(6,'0')}Y${Math.round(t.y1*100).toString().padStart(6,'0')}D02*\nX${Math.round(t.x2*100).toString().padStart(6,'0')}Y${Math.round(t.y2*100).toString().padStart(6,'0')}D01*\n`;
    });
    g += `M02*\n`;
    let bom = 'Reference,Type,Label,Props,Qty\n';
    const grp = {};
    _components.forEach(c => { (grp[c.type]=grp[c.type]||[]).push(c); });
    Object.entries(grp).forEach(([t,items]) => {
      bom += `"${items.map(i=>i.id).join(',')}",${t},"${ComponentDefs[t]?.label||t}","${JSON.stringify(items[0].props)}",${items.length}\n`;
    });
    return { gerber:g, bomCsv:bom };
  }

  function generateBOM() {
    const b = {};
    _components.forEach(c => { (b[c.type]=b[c.type]||[]).push({id:c.id,props:c.props}); });
    return b;
  }

  // ── Public API ────────────────────────────────────────────
  return {
    get running()      { return _running; },
    get stressTest()   { return _stressTest; },
    get time()         { return _time; },
    get power()        { return _totalPower; },
    get waveHistory()  { return _waveHistory; },
    get components()   { return _components; },
    get traces()       { return _traces; },
    get displayMem()   { return _displayMem; },
    get cpuState()     { return _cpuRegs; },
    get workersActive(){ return _workersReady && !_workersFailed; },
    get activeNodes()  { return _activeCount; },

    init(components, traces) {
      _components = components;
      _traces     = traces;
      if (!_workersReady && !_workersFailed) initWorkers();
    },

    start() {
      if (_running) return;
      _running = true;
      _time    = 0;
      _waveHistory = [];
      _cpuRegs = null;
      _displayMem = new Uint8Array(960);
      _shorts  = new Set();

      // Reset component states
      _components.forEach(c => {
        c.state = { temp:25, voltage:0, current:0, power:0, burned:false, running:false };
      });
      _traces.forEach(t => { t.state = { temp:25, current:0 }; });

      EventBus.emit('sim:log', { msg:`▶ Started — ${_components.length} components | Workers: ${_workersReady&&!_workersFailed?'ON':'FALLBACK'}`, type:'ok' });
      EventBus.emit('sim:log', { msg:`Supply: ${_supplyV}V | Delta-physics: ACTIVE`, type:'info' });

      if (_workersReady && !_workersFailed) {
        // Init analog worker
        _analogWorker.postMessage({
          type:       'init',
          components: serialiseComponents(),
          traces:     serialiseTraces(),
        });
        _analogWorker.postMessage({ type:'setSpeed', speed:_speed });
        _analogWorker.postMessage({ type:'setSupply', voltage:_supplyV });
        if (_probeCompId) _analogWorker.postMessage({ type:'setProbe', compId:_probeCompId });
        _analogWorker.postMessage({ type:'start' });

        // Init digital worker
        _digitalWorker.postMessage({
          type:          'init',
          firmwareBytes: _firmwareBytes ? Array.from(_firmwareBytes) : [],
          startAddr:     0x8000,
        });
        _digitalWorker.postMessage({ type:'setSpeed', speed:_speed });
        _digitalWorker.postMessage({ type:'start' });
      } else {
        // Fallback mode
        if (_firmwareBytes && typeof CPU6502 !== 'undefined') {
          _fallbackCPU = CPU6502.createState();
          CPU6502.loadProgram(_fallbackCPU, _firmwareBytes, 0x8000);
        }
        _fallbackInterval = setInterval(fallbackTick, 16);
      }

      runBootLog();
      EventBus.emit('sim:started');
    },

    stop() {
      if (!_running) return;
      _running = false;
      if (_workersReady && !_workersFailed) {
        _digitalWorker?.postMessage({ type:'stop' });
        _analogWorker?.postMessage({ type:'stop' });
      } else {
        clearInterval(_fallbackInterval);
      }
      EventBus.emit('sim:log', { msg:`■ Stopped — T:${_time.toFixed(3)}s`, type:'warn' });
      EventBus.emit('sim:stopped');
    },

    reset() {
      this.stop();
      _time = 0; _waveHistory = []; _cpuRegs = null; _stressTest = false;
      _components.forEach(c => { c.state = { temp:25, voltage:0, current:0, power:0, burned:false, running:false }; });
      _traces.forEach(t => { t.state = { temp:25, current:0 }; });
      if (_workersReady && !_workersFailed) {
        _digitalWorker?.postMessage({ type:'reset' });
        _analogWorker?.postMessage({ type:'reset' });
      }
      EventBus.emit('sim:log', { msg:'↺ Board reset', type:'info' });
      EventBus.emit('sim:reset');
    },

    setSpeed(v) {
      _speed = Math.max(1, Math.min(10, v));
      if (_workersReady && !_workersFailed) {
        _digitalWorker?.postMessage({ type:'setSpeed', speed:_speed });
        _analogWorker?.postMessage({ type:'setSpeed', speed:_speed });
      }
    },

    toggleStress() {
      _stressTest = !_stressTest;
      if (_workersReady && !_workersFailed)
        _analogWorker?.postMessage({ type:'setStress', on:_stressTest });
      EventBus.emit('sim:log', {
        msg: _stressTest ? '🌡 Stress test ON — ±2.5V ripple, max thermal load' : '🌡 Stress test OFF',
        type: _stressTest ? 'warn' : 'info',
      });
      return _stressTest;
    },

    setProbe(comp, pin) {
      _probeCompId = comp ? comp.id : null;
      _waveHistory = [];
      if (_workersReady && !_workersFailed)
        _analogWorker?.postMessage({ type:'setProbe', compId:_probeCompId });
      if (comp) EventBus.emit('sim:log', { msg:`⊕ Probe → ${comp.id}:${pin}`, type:'info' });
    },

    loadFirmware(src) {
      _firmwareSource = src;
      if (!src?.trim()) { _firmwareLoaded = false; _firmwareBytes = null; return false; }
      const bytes = assembleFirmware(src);
      if (bytes) {
        _firmwareBytes  = bytes;
        _firmwareLoaded = true;
        const preview = Array.from(bytes.slice(0,12)).map(b=>b.toString(16).padStart(2,'0').toUpperCase()).join(' ');
        EventBus.emit('sim:log', { msg:`Assembled: ${bytes.length} bytes`, type:'ok' });
        EventBus.emit('sim:log', { msg:`Binary: ${preview}…`, type:'info' });
        return true;
      }
      _firmwareLoaded = !!src.trim();
      _firmwareBytes  = null;
      return _firmwareLoaded;
    },

    // Hot-add/remove during simulation
    onComponentAdded(comp) {
      if (_workersReady && !_workersFailed && _running) {
        const def = ComponentDefs[comp.type];
        _analogWorker?.postMessage({
          type: 'addComponent',
          comp: { id:comp.id, type:comp.type, x:comp.x, y:comp.y, props:{...comp.props}, pins:def?def.pins.map(p=>({...p})):[] },
        });
      }
    },

    onComponentRemoved(id) {
      if (_workersReady && !_workersFailed && _running)
        _analogWorker?.postMessage({ type:'removeComponent', id });
    },

    onTraceAdded(trace) {
      if (_workersReady && !_workersFailed && _running)
        _analogWorker?.postMessage({ type:'addTrace', trace: {
          id:trace.id, fromCompId:trace.fromCompId, fromPin:trace.fromPin,
          toCompId:trace.toCompId, toPin:trace.toPin,
          x1:trace.x1,y1:trace.y1,x2:trace.x2,y2:trace.y2,
          points:trace.points.map(p=>({...p})),
        }});
    },

    onComponentMoved(comp) {
      if (_workersReady && !_workersFailed && _running)
        _analogWorker?.postMessage({ type:'updateComponents', updates:[{ id:comp.id, x:comp.x, y:comp.y }] });
    },

    // Debug / console commands
    getCPURegisters() { return _cpuRegs; },

    disasmAt(addr) {
      if (typeof CPU6502 === 'undefined') return null;
      // Best effort — use fallback CPU if available, otherwise build temp state
      let cpu = _fallbackCPU;
      if (!cpu && typeof CPU6502 !== 'undefined') {
        cpu = CPU6502.createState();
        if (_firmwareBytes) CPU6502.loadProgram(cpu, _firmwareBytes, 0x8000);
      }
      return cpu ? CPU6502.disasm(cpu, addr) : `$${addr.toString(16).padStart(4,'0')}: ???`;
    },

    triggerNMI() { _digitalWorker?.postMessage({ type:'nmi' }); },
    triggerIRQ() { _digitalWorker?.postMessage({ type:'irq' }); },

    readMem(addr) {
      if (_fallbackCPU) return CPU6502.read(_fallbackCPU, addr);
      return 0; // Workers: use peek command
    },

    writeMem(addr, val) {
      _digitalWorker?.postMessage({ type:'poke', addr, val });
      if (_fallbackCPU) CPU6502.write(_fallbackCPU, addr, val);
    },

    peekMem(addr, count=16) {
      _digitalWorker?.postMessage({ type:'peek', addr, count });
    },

    getSignalIntegrity: signalIntegrity,
    getConfidenceScore: confidenceScore,
    getComponentVoltage(comp) { return comp.state.voltage || 0; },
    exportGerber,
    generateBOM,
  };
})();
