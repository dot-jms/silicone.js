// ============================================================
// SILICON LAB — debug.js
// Debug console: logs, commands, system info
// ============================================================

const Debug = (() => {
  let logEl, inputEl;
  let paused = false;
  let logCount = 0;
  const MAX_LOGS = 500;

  function init() {
    logEl = document.getElementById('debug-log');
    inputEl = document.getElementById('debug-input');

    document.getElementById('btn-debug-clear').addEventListener('click', clear);
    document.getElementById('btn-debug-pause').addEventListener('click', togglePause);
    inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') handleCommand(inputEl.value.trim());
    });

    // Subscribe to events
    EventBus.on('sim:log',         ({ msg, type }) => log(msg, type));
    EventBus.on('sim:warning',     ({ comp, msg }) => log(msg, 'warn'));
    EventBus.on('sim:firmware_log', msg => log(msg, 'sim'));
    EventBus.on('sim:started',     () => log('▶ Simulation engine started', 'ok'));
    EventBus.on('sim:stopped',     () => log('■ Simulation stopped', 'warn'));
    EventBus.on('sim:reset',       () => log('↺ Board state reset', 'info'));
    EventBus.on('board:add',       ({ comp }) => log(`+ Component added: ${comp.id} (${comp.type})`, 'ok'));
    EventBus.on('board:remove',    ({ id }) => log(`- Component removed: ${id}`, 'warn'));
    EventBus.on('board:trace_add', ({ trace }) => log(`⌁ Trace: ${trace.fromCompId}:${trace.fromPin} → ${trace.toCompId}:${trace.toPin}`, 'info'));
    EventBus.on('board:cleared',   () => log('Board cleared', 'warn'));

    log('Silicon Lab v1.0 initialised', 'ok');
    log('Type "help" for available commands', 'info');
  }

  function log(msg, type = 'info') {
    if (paused) return;
    if (logCount >= MAX_LOGS) {
      const first = logEl.firstChild;
      if (first) logEl.removeChild(first);
    }
    logCount++;

    const row = document.createElement('div');
    row.className = `log-${type}`;

    const ts = document.createElement('span');
    ts.className = 'log-ts';
    ts.textContent = Utils.ts();

    const text = document.createElement('span');
    text.textContent = msg;

    row.appendChild(ts);
    row.appendChild(text);
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function clear() {
    logEl.innerHTML = '';
    logCount = 0;
    log('Console cleared', 'info');
  }

  function togglePause() {
    paused = !paused;
    const btn = document.getElementById('btn-debug-pause');
    btn.textContent = paused ? '▶' : '⏸';
    btn.title = paused ? 'Resume' : 'Pause';
    log(paused ? '⏸ Log paused' : '▶ Log resumed', 'info');
  }

  function handleCommand(cmd) {
    if (!cmd) return;
    inputEl.value = '';
    log(`> ${cmd}`, 'sim');

    const parts = cmd.toLowerCase().split(/\s+/);
    const verb = parts[0];

    switch (verb) {
      case 'help':
        log('Commands: help, status, list, temp, voltage, clear, reset, probe <id>, bom, inspect <id>, nets', 'info');
        break;

      case 'status': {
        const running = Simulator.running;
        log(`Simulation: ${running ? 'RUNNING' : 'STOPPED'}`, running ? 'ok' : 'warn');
        log(`Time: ${Simulator.time.toFixed(3)}s | Power: ${Utils.fmtV(Simulator.power)}W`, 'info');
        log(`Components: ${Board.getComponents().length} | Traces: ${Board.getTraces().length}`, 'info');
        break;
      }

      case 'list':
        if (Board.getComponents().length === 0) { log('No components on board', 'warn'); break; }
        Board.getComponents().forEach(c => {
          log(`  ${c.id}  ${c.type}  @ (${c.x}, ${c.y})`, 'info');
        });
        break;

      case 'temp':
        Board.getComponents().forEach(c => {
          const t = c.state.temp || 25;
          const type = t > 80 ? 'error' : t > 50 ? 'warn' : 'ok';
          log(`  ${c.id}: ${t.toFixed(1)}°C`, type);
        });
        break;

      case 'voltage':
        Board.getComponents().forEach(c => {
          const v = Simulator.getComponentVoltage(c);
          log(`  ${c.id}: ${v.toFixed(3)}V`, 'info');
        });
        break;

      case 'inspect': {
        const id = parts[1];
        const comp = Board.getComponents().find(c => c.id === id);
        if (!comp) { log(`Component ${id} not found`, 'error'); break; }
        log(`=== ${comp.id} (${comp.type}) ===`, 'sim');
        Object.entries(comp.props).forEach(([k,v]) => log(`  ${k}: ${v}`, 'info'));
        Object.entries(comp.state).forEach(([k,v]) => {
          if (typeof v === 'number') log(`  state.${k}: ${v.toFixed ? v.toFixed(4) : v}`, 'ok');
        });
        break;
      }

      case 'probe': {
        const id = parts[1];
        if (!id) { Simulator.setProbe(null); Renderer.setProbeComponent(null); break; }
        const comp = Board.getComponents().find(c => c.id.toLowerCase() === id.toLowerCase());
        if (!comp) { log(`Component ${id} not found`, 'error'); break; }
        Simulator.setProbe(comp, 'VCC');
        Renderer.setProbeComponent(comp);
        log(`Probe placed on ${comp.id}`, 'ok');
        break;
      }

      case 'bom': {
        const bom = Simulator.generateBOM();
        log('=== Bill of Materials ===', 'sim');
        Object.entries(bom).forEach(([type, items]) => {
          log(`  ${type}: ${items.length}x`, 'info');
          items.forEach(it => log(`    ${it.id} — ${JSON.stringify(it.props)}`, 'info'));
        });
        break;
      }

      case 'nets':
        if (Board.getTraces().length === 0) { log('No nets defined', 'warn'); break; }
        Board.getTraces().forEach(t => {
          log(`  ${t.id}: ${t.fromCompId}:${t.fromPin} ↔ ${t.toCompId}:${t.toPin}`, 'info');
        });
        break;

      case 'reset':
        Simulator.reset();
        break;

      case 'clear':
        clear();
        break;

      case 'si': {
        const results = Simulator.getSignalIntegrity();
        log('=== Signal Integrity ===', 'sim');
        results.forEach(r => log(`  [${r.status.toUpperCase()}] ${r.label} ${r.value}`, r.status));
        break;
      }

      case 'score': {
        const s = Simulator.getConfidenceScore();
        if (!s) { log('No components to score', 'warn'); break; }
        log(`Confidence score: ${s.score}%`, s.score > 80 ? 'ok' : s.score > 50 ? 'warn' : 'error');
        s.issues.forEach(i => log(`  ⚠ ${i}`, 'warn'));
        break;
      }

      case 'cpu': case 'regs': {
        const r = Simulator.getCPURegisters();
        if (!r) { log('No 6502 core active — start simulation first', 'warn'); break; }
        log('=== 6502 Registers ===', 'sim');
        log('  PC:$' + r.PC.toString(16).padStart(4,'0').toUpperCase() + '  SP:$' + r.SP.toString(16).padStart(2,'0').toUpperCase(), 'ok');
        log('  A:$'  + r.A.toString(16).padStart(2,'0').toUpperCase() + '  X:$' + r.X.toString(16).padStart(2,'0').toUpperCase() + '  Y:$' + r.Y.toString(16).padStart(2,'0').toUpperCase(), 'ok');
        log('  N=' + r.N + ' V=' + r.V + ' D=' + r.D + ' I=' + r.I + ' Z=' + r.Z + ' C=' + r.C, 'info');
        log('  Cycles: ' + r.cycles.toLocaleString(), 'info');
        const d0 = Simulator.disasmAt(r.PC); if (d0) log('  → ' + d0, 'sim');
        break;
      }
      case 'mem': case 'peek': {
        const a0 = parseInt((parts[1]||'0').replace('$','0x'));
        const cnt = parseInt(parts[2]) || 16;
        log('Memory @ $' + a0.toString(16).padStart(4,'0').toUpperCase() + ':', 'sim');
        for (let row = 0; row < Math.ceil(cnt/8); row++) {
          const ra = a0 + row*8;
          const bs = Array.from({length:8}, (_,i) => Simulator.readMem(ra+i).toString(16).padStart(2,'0').toUpperCase());
          log('  $' + ra.toString(16).padStart(4,'0').toUpperCase() + ': ' + bs.join(' '), 'info');
        }
        break;
      }
      case 'poke': {
        const pa = parseInt((parts[1]||'0').replace('$','0x'));
        const pv = parseInt((parts[2]||'0').replace('$','0x'));
        Simulator.writeMem(pa, pv);
        log('Wrote $' + pv.toString(16).padStart(2,'0').toUpperCase() + ' → $' + pa.toString(16).padStart(4,'0').toUpperCase(), 'ok');
        break;
      }
      case 'disasm': {
        const da = parts[1] ? parseInt(parts[1].replace('$','0x')) : (Simulator.getCPURegisters()?.PC || 0x8000);
        log('Disasm @ $' + da.toString(16).padStart(4,'0').toUpperCase() + ':', 'sim');
        let a2 = da;
        for (let i=0;i<10;i++) { const d=Simulator.disasmAt(a2); if(d){log('  '+d,'info'); a2+=3;} }
        break;
      }
      case 'nmi': Simulator.triggerNMI(); break;
      case 'irq': Simulator.triggerIRQ(); break;
      case 'power':
        Board.getComponents().forEach(c => {
          const v = Simulator.getComponentVoltage(c);
          log('  ' + c.id + ': ' + v.toFixed(3) + 'V | ' + (c.state.power||0).toFixed(3) + 'W | ' + (c.state.temp||25).toFixed(0) + 'C', 'info');
        });
        break;
      case 'help':
        log('Board: status list clear reset', 'info');
        log('Physics: temp voltage power inspect <id> probe <id>', 'info');
        log('6502: cpu/regs disasm [addr] mem <addr> [n] poke <a> <v> nmi irq', 'info');
        log('Analysis: si score bom nets', 'info');
        break;
      default:
        log('Unknown:  + verb + . Type help.', 'error');
    }
  }

  return { init, log };
})();
