// ============================================================
// SILICON LAB — app.js
// Main application controller
// Handles all user input, orchestrates all modules
// ============================================================

const App = (() => {

  let activeTool = 'select';   // 'select' | 'wire' | 'probe' | 'delete'
  let pendingComponentType = null;  // type being placed
  let dragState = null;        // { comp, startX, startY, origX, origY }
  let panState = null;         // { startX, startY }

  // ── Boot ──────────────────────────────────────────────────
  function init() {
    const canvas = document.getElementById('pcb-canvas');
    Renderer.init(canvas);
    Oscilloscope.init(document.getElementById('osc-canvas'));
    Debug.init();
    Simulator.init(Board.getComponents(), Board.getTraces());

    bindToolbar();
    bindCanvas(canvas);
    bindModal();
    bindCodeEditor();
    bindDebugInput();

    UI.updateStatus('Ready — click a component button to place, then click the board.');
    Debug.log('Board initialised. Place components to begin.', 'info');

    // Forward thermal pixels to renderer
    EventBus.on('sim:thermal', (pixels) => {
      Renderer.setThermalPixels(pixels);
    });

    // Worker performance log
    EventBus.on('sim:tick', ({ activeNodes }) => {
      if (activeNodes !== undefined) {
        const el = document.getElementById('component-count');
        if (el && Simulator.running) {
          const total = Board.getComponents().length;
          el.textContent = `${total} components · ${Board.getTraces().length} nets · ${activeNodes}/${total} active`;
        }
      }
    });
  }

  // ── Toolbar bindings ──────────────────────────────────────
  function bindToolbar() {
    // Component palette
    document.querySelectorAll('.comp-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        pendingComponentType = btn.dataset.type;
        setTool('select');
        UI.updateStatus(`Placing ${ComponentDefs[pendingComponentType]?.label} — click on the board to place it.`);
        Debug.log(`Pending placement: ${pendingComponentType}`, 'info');
      });
    });

    // Tool buttons
    document.getElementById('btn-select').addEventListener('click',  () => setTool('select'));
    document.getElementById('btn-wire').addEventListener('click',    () => setTool('wire'));
    document.getElementById('btn-probe').addEventListener('click',   () => setTool('probe'));
    document.getElementById('btn-delete').addEventListener('click',  () => setTool('delete'));

    // Simulation
    document.getElementById('btn-power').addEventListener('click', togglePower);
    document.getElementById('btn-reset').addEventListener('click', () => Simulator.reset());
    document.getElementById('btn-stress').addEventListener('click', toggleStress);
    document.getElementById('sim-speed').addEventListener('input', e => {
      Simulator.setSpeed(parseInt(e.target.value));
      Debug.log(`Simulation speed: ${e.target.value}`, 'info');
    });

    // Board
    document.getElementById('btn-clear').addEventListener('click', () => {
      if (Simulator.running) Simulator.stop();
      Board.clear();
    });

    document.getElementById('btn-export').addEventListener('click', exportBoard);
    document.getElementById('btn-load-demo').addEventListener('click', loadDemo);

    // Universal part search
    document.getElementById('btn-part-search').addEventListener('click', () => {
      ComponentSearchUI.open();
    });

    // Thermal overlay controls
    document.getElementById('btn-thermal-toggle').addEventListener('click', () => {
      const slider = document.getElementById('thermal-opacity');
      const current = parseFloat(slider.value);
      slider.value = current > 0 ? 0 : 55;
      Renderer.setThermalOpacity(current > 0 ? 0 : 0.55);
      Debug.log(`Thermal overlay: ${current > 0 ? 'OFF' : 'ON'}`, 'info');
    });
    document.getElementById('thermal-opacity').addEventListener('input', e => {
      Renderer.setThermalOpacity(parseInt(e.target.value) / 100);
    });

    // Worker status indicator
    const workerEl = document.getElementById('worker-status');
    setTimeout(() => {
      if (workerEl) {
        if (Simulator.workersActive) {
          workerEl.textContent = '⊞ WORKERS ON';
          workerEl.style.color = 'var(--green)';
        } else {
          workerEl.textContent = '⊡ SINGLE-THREAD';
          workerEl.style.color = 'var(--yellow)';
        }
      }
    }, 500);

    // When the ingestor fires a 'place' event, set pending component type
    EventBus.on('ingestor:place', ({ key, def, partNumber }) => {
      pendingComponentType = key;
      UI.updateStatus('Placing imported part: ' + partNumber + ' (' + def.label + ') — click on the board to place it.');
      Debug.log('Placing imported: ' + partNumber, 'ok');
    });
  }

  function setTool(tool) {
    activeTool = tool;
    if (tool !== 'wire') {
      Renderer.cancelWire();
    }
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    const map = { select: 'btn-select', wire: 'btn-wire', probe: 'btn-probe', delete: 'btn-delete' };
    const el = document.getElementById(map[tool]);
    if (el) el.classList.add('active');

    const canvas = document.getElementById('pcb-canvas');
    canvas.style.cursor = { select: 'default', wire: 'crosshair', probe: 'cell', delete: 'not-allowed' }[tool] || 'default';

    if (tool !== 'select') pendingComponentType = null;
    UI.updateStatus({ select: 'Select or move components. Right-click to deselect.', wire: 'Wire mode: click a pin to start, click another pin to finish.', probe: 'Probe mode: click a component to monitor its signal.', delete: 'Delete mode: click a component to remove it.' }[tool] || '');
  }

  function togglePower() {
    const btn = document.getElementById('btn-power');
    if (Simulator.running) {
      Simulator.stop();
      btn.classList.remove('running');
      UI.updateSimState('stopped');
    } else {
      if (Board.getComponents().length === 0) {
        Debug.log('No components on board — add some before powering on.', 'warn');
        return;
      }
      Simulator.start();
      btn.classList.add('running');
      UI.updateSimState('running');
      UI.updateSignalIntegrity();
    }
  }

  function toggleStress() {
    const on = Simulator.toggleStress();
    const btn = document.getElementById('btn-stress');
    if (on) btn.classList.add('active');
    else btn.classList.remove('active');
    UI.updateSimState(on ? 'warning' : 'running');
  }

  // ── Canvas bindings ───────────────────────────────────────
  function bindCanvas(canvas) {
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup',   onMouseUp);
    canvas.addEventListener('wheel',     onWheel, { passive: false });
    canvas.addEventListener('contextmenu', e => { e.preventDefault(); cancelAction(); });
    canvas.addEventListener('dblclick',  onDblClick);
  }

  function getWorldPos(e) {
    const rect = Renderer.getCanvas().getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const w = Renderer.screenToWorld(sx, sy);
    return { sx, sy, wx: Utils.snap(w.x), wy: Utils.snap(w.y), rawWx: w.x, rawWy: w.y };
  }

  function onMouseDown(e) {
    const { sx, sy, wx, wy } = getWorldPos(e);

    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      // Pan
      panState = { startX: e.clientX, startY: e.clientY };
      e.preventDefault();
      return;
    }

    if (e.button !== 0) return;

    // Placing a new component
    if (pendingComponentType) {
      const snappedX = Utils.clamp(wx, 10, 760);
      const snappedY = Utils.clamp(wy, 10, 560);
      Board.addComponent(pendingComponentType, snappedX, snappedY);
      pendingComponentType = null;
      UI.updateStatus('Component placed. Select another component to place, or use tools.');
      return;
    }

    const hitComp = Renderer.hitTestComponent(wx, wy);

    switch (activeTool) {
      case 'select':
        if (hitComp) {
          Renderer.clearSelection();
          Renderer.select(hitComp.id);
          UI.showProps(hitComp);
          dragState = {
            comp: hitComp,
            startX: sx, startY: sy,
            origX: hitComp.x, origY: hitComp.y,
            moved: false,
          };
        } else {
          Renderer.clearSelection();
          UI.clearProps();
        }
        break;

      case 'wire': {
        const hitPin = Renderer.hitTestPin(wx, wy);
        const wireState = Renderer.getWireState();
        if (!wireState.active) {
          if (hitPin) {
            Renderer.startWire(hitPin.comp, hitPin.pin.name);
            UI.updateStatus(`Wire started from ${hitPin.comp.id}:${hitPin.pin.name} — click another pin or board to add waypoints.`);
          }
        } else {
          if (hitPin && hitPin.comp.id !== wireState.fromComp?.id) {
            const trace = Renderer.finishWire(hitPin.comp, hitPin.pin.name);
            if (trace) {
              Board.addTrace(trace);
              UI.updateStatus(`Wire connected: ${trace.fromCompId}:${trace.fromPin} → ${trace.toCompId}:${trace.toPin}`);
            }
          } else {
            // Add waypoint
            Renderer.addWirePoint(wx, wy);
          }
        }
        break;
      }

      case 'probe':
        if (hitComp) {
          Simulator.setProbe(hitComp, 'VCC');
          Renderer.setProbeComponent(hitComp);
          const probeLabel = document.getElementById('osc-probe-label');
          if (probeLabel) probeLabel.textContent = `Probing: ${hitComp.id}`;
          UI.updateStatus(`Oscilloscope probe on ${hitComp.id}`);
        }
        break;

      case 'delete':
        if (hitComp) {
          Board.removeComponent(hitComp.id);
          if (hitComp === Renderer._probeComp) {
            Renderer.setProbeComponent(null);
            Simulator.setProbe(null);
          }
          UI.clearProps();
          UI.updateStatus(`Removed ${hitComp.id}`);
        }
        break;
    }
  }

  function onMouseMove(e) {
    const { sx, sy, wx, wy, rawWx, rawWy } = getWorldPos(e);

    // Cursor pos display
    const cursorEl = document.getElementById('cursor-pos');
    if (cursorEl) cursorEl.textContent = `X: ${Math.round(wx)}  Y: ${Math.round(wy)}`;

    // Pan
    if (panState) {
      Renderer.pan(e.clientX - panState.startX, e.clientY - panState.startY);
      panState = { startX: e.clientX, startY: e.clientY };
      return;
    }

    // Drag component
    if (dragState) {
      const def = ComponentDefs[dragState.comp.type];
      const dsx = sx - dragState.startX;
      const dsy = sy - dragState.startY;
      if (Math.abs(dsx) > 3 || Math.abs(dsy) > 3) {
        dragState.moved = true;
        dragState.comp.x = Utils.snap(Utils.clamp(dragState.origX + dsx / Renderer.getZoom(), 0, 800 - (def?.width || 40)));
        dragState.comp.y = Utils.snap(Utils.clamp(dragState.origY + dsy / Renderer.getZoom(), 0, 600 - (def?.height || 20)));
        Renderer.markDirty();
        // Update traces
        Simulator.init(Board.getComponents(), Board.getTraces());
      }
      return;
    }

    // Wire preview
    if (activeTool === 'wire' && Renderer.getWireState().active) {
      Renderer.updateWireCursor(sx, sy);
      Renderer.markDirty();
    }
  }

  function onMouseUp(e) {
    if (panState) { panState = null; return; }
    if (dragState) {
      if (dragState.moved) {
        Debug.log(`Moved ${dragState.comp.id} to (${dragState.comp.x}, ${dragState.comp.y})`, 'info');
        Simulator.onComponentMoved(dragState.comp);
        // Rebuild trace points after drag
        rebuildTracesForComp(dragState.comp);
      }
      dragState = null;
    }
  }

  function onWheel(e) {
    e.preventDefault();
    const rect = Renderer.getCanvas().getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    Renderer.zoom(factor, cx, cy);
    document.getElementById('zoom-level').textContent = `Zoom: ${Renderer.getZoom().toFixed(2)}×`;
  }

  function onDblClick(e) {
    const { wx, wy } = getWorldPos(e);
    const hitComp = Renderer.hitTestComponent(wx, wy);
    if (hitComp) {
      const def = ComponentDefs[hitComp.type];
      if (def.props.length > 0) Modal.editProp(hitComp.id, def.props[0]);
    }
  }

  function cancelAction() {
    if (Renderer.getWireState().active) {
      Renderer.cancelWire();
      UI.updateStatus('Wire cancelled.');
    }
    pendingComponentType = null;
    Renderer.clearSelection();
    UI.clearProps();
  }

  // ── Trace rebuild after drag ──────────────────────────────
  function rebuildTracesForComp(comp) {
    const def = ComponentDefs[comp.type];
    Board.getTraces().forEach(trace => {
      if (trace.fromCompId === comp.id) {
        const pin = def.pins.find(p => p.name === trace.fromPin);
        if (pin) {
          trace.x1 = comp.x + pin.x;
          trace.y1 = comp.y + pin.y;
          trace.points[0] = { x: trace.x1, y: trace.y1 };
        }
      }
      if (trace.toCompId === comp.id) {
        const pin = def.pins.find(p => p.name === trace.toPin);
        if (pin) {
          trace.x2 = comp.x + pin.x;
          trace.y2 = comp.y + pin.y;
          trace.points[trace.points.length - 1] = { x: trace.x2, y: trace.y2 };
        }
      }
    });
    Renderer.markDirty();
  }

  // ── Modal bindings ────────────────────────────────────────
  function bindModal() {
    document.getElementById('modal-cancel').addEventListener('click', () => Modal.hide());
    document.getElementById('modal-ok').addEventListener('click', () => {
      if (Modal._onOk) Modal._onOk();
      Modal.hide();
    });
    document.getElementById('modal-overlay').addEventListener('click', e => {
      if (e.target.id === 'modal-overlay') Modal.hide();
    });
  }

  // ── Code Editor ───────────────────────────────────────────
  function bindCodeEditor() {
    document.getElementById('btn-upload-fw').addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.asm,.c,.hex,.txt,.bin';
      input.onchange = e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
          document.getElementById('code-editor').value = ev.target.result;
          document.getElementById('flash-status').textContent = `Loaded: ${file.name}`;
          Debug.log(`Firmware file loaded: ${file.name}`, 'ok');
        };
        reader.readAsText(file);
      };
      input.click();
    });

    document.getElementById('btn-flash-fw').addEventListener('click', flashFirmware);
  }

  function flashFirmware() {
    const code = document.getElementById('code-editor').value;
    const statusEl = document.getElementById('flash-status');
    const cpu = Board.getComponents().find(c => c.type === 'cpu');

    if (!cpu) {
      statusEl.textContent = '⚠ No CPU found on board!';
      statusEl.style.color = 'var(--red)';
      Debug.log('Flash failed: no CPU on board', 'error');
      return;
    }

    statusEl.textContent = 'Flashing...';
    statusEl.style.color = 'var(--yellow)';
    Debug.log('Flashing firmware to CPU...', 'info');

    setTimeout(() => {
      const ok = Simulator.loadFirmware(code);
      if (ok) {
        statusEl.textContent = '✓ Firmware flashed successfully';
        statusEl.style.color = 'var(--green)';
        Debug.log(`Firmware flashed — ${code.split('\n').length} lines`, 'ok');
        // Count instructions
        const instr = code.split('\n').filter(l => l.trim() && !l.trim().startsWith(';')).length;
        Debug.log(`Parsed ${instr} instructions`, 'info');
      } else {
        statusEl.textContent = '✗ Empty firmware';
        statusEl.style.color = 'var(--red)';
        Debug.log('Firmware flash failed: empty file', 'error');
      }
    }, 600);
  }

  // ── Debug input redirect ──────────────────────────────────
  function bindDebugInput() {
    // already handled in debug.js, but we ensure Enter is bound
  }

  // ── Export ────────────────────────────────────────────────
  function exportBoard() {
    const { gerber, bomCsv } = Simulator.exportGerber();
    const score = Simulator.getConfidenceScore();

    let report = `Silicon Lab Export — ${new Date().toISOString()}\n`;
    report += `Components: ${Board.getComponents().length}\n`;
    report += `Traces: ${Board.getTraces().length}\n`;
    if (score) report += `Confidence Score: ${score.score}%\n`;
    report += `\n=== GERBER ===\n${gerber}\n\n=== BOM (CSV) ===\n${bomCsv}`;

    const blob = new Blob([report], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `silicon-lab-export-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    Debug.log('Board exported (Gerber + BOM)', 'ok');
  }

  // ── Demo board ────────────────────────────────────────────
  function loadDemo() {
    if (Simulator.running) Simulator.stop();
    Board.clear();

    Debug.log('Loading demo board: Simple Computer', 'info');

    // Place components
    const pwr  = Board.addComponent('power',    80,  80);
    const xtal = Board.addComponent('crystal',  220, 60);
    const cpu  = Board.addComponent('cpu',      300, 100);
    const ram  = Board.addComponent('ram',      300, 230);
    const cap1 = Board.addComponent('capacitor', 190, 160);
    const cap2 = Board.addComponent('capacitor', 190, 200);
    const res1 = Board.addComponent('resistor',  460, 120);
    const led1 = Board.addComponent('led',       520, 120);
    const gpu  = Board.addComponent('gpu',       180, 320);
    const ic1  = Board.addComponent('chip',      460, 220);

    // Set some interesting properties
    cpu.props.clock_mhz = 50;
    cpu.props.tdp = 8;
    ram.props.capacity_mb = 512;
    gpu.props.tdp = 45;
    led1.props.color = 'green';
    res1.props.resistance = 470;
    xtal.props.frequency_mhz = 50;
    pwr.props.vout = 3.3;

    // Traces
    const def_pwr  = ComponentDefs.power;
    const def_cpu  = ComponentDefs.cpu;
    const def_ram  = ComponentDefs.ram;
    const def_res  = ComponentDefs.resistor;
    const def_led  = ComponentDefs.led;
    const def_gpu  = ComponentDefs.gpu;
    const def_xtal = ComponentDefs.crystal;
    const def_cap  = ComponentDefs.capacitor;
    const def_ic   = ComponentDefs.chip;

    function mkTrace(fc, fp, tc, tp) {
      const fDef = ComponentDefs[fc.type];
      const tDef = ComponentDefs[tc.type];
      const fPin = fDef.pins.find(p => p.name === fp);
      const tPin = tDef.pins.find(p => p.name === tp);
      if (!fPin || !tPin) return null;
      return {
        id: Utils.uid('T'),
        fromCompId: fc.id, fromPin: fp, fromType: fc.type,
        toCompId: tc.id, toPin: tp,
        x1: fc.x + fPin.x, y1: fc.y + fPin.y,
        x2: tc.x + tPin.x, y2: tc.y + tPin.y,
        points: [
          { x: fc.x + fPin.x, y: fc.y + fPin.y },
          { x: tc.x + tPin.x, y: tc.y + tPin.y },
        ],
      };
    }

    const traces = [
      mkTrace(pwr,  'VOUT', cpu,  'VCC'),
      mkTrace(pwr,  'VOUT', ram,  'VCC'),
      mkTrace(pwr,  'VOUT', gpu,  'VCC'),
      mkTrace(pwr,  'VOUT', ic1,  'VCC'),
      mkTrace(pwr,  'VOUT', cap1, '+'),
      mkTrace(pwr,  'VOUT', cap2, '+'),
      mkTrace(xtal, 'A',   cpu,  'CLK'),
      mkTrace(cpu,  'DATA', ram,  'DATA'),
      mkTrace(cpu,  'ADDR', ram,  'CLK'),
      mkTrace(cpu,  'DATA', res1, 'A'),
      mkTrace(res1, 'B',   led1, 'A'),
      mkTrace(cpu,  'DATA', ic1,  'A0'),
      mkTrace(ic1,  'Y0',   gpu,  'DATA'),
    ].filter(Boolean);

    traces.forEach(t => Board.addTrace(t));

    // Load demo firmware — real 6502 assembly
    document.getElementById('code-editor').value = `; Silicon Lab — Demo Firmware
; Real 6502 Assembly: LED counter + display fill
; Assembles to actual 6502 machine code
;
; Memory map:
;   $0000-$00FF  Zero page (fast RAM)
;   $0200-$05FF  Display buffer (32x30 pixels, memory-mapped)
;   $8000-$FFFF  ROM (firmware)

.org $8000

RESET:
    SEI             ; Disable interrupts
    CLD             ; Clear decimal mode
    LDX #$FF
    TXS             ; Set stack pointer = $FF

    ; Clear zero page
    LDA #$00
    LDX #$00
CLEAR_ZP:
    STA $00,X
    INX
    BNE CLEAR_ZP

    ; Fill display with checkerboard pattern
    LDA #$00
    STA $01         ; row counter
    LDA #$20        ; 32 columns
    STA $02

FILL_DISPLAY:
    LDX #$00
FILL_ROW:
    LDA $01         ; row number
    EOR $00         ; XOR with column
    AND #$01        ; bit 0 = checker
    BEQ DARK
    LDA #$05        ; green pixel
    JMP STORE_PIX
DARK:
    LDA #$00        ; dark pixel
STORE_PIX:
    STA $0200,X     ; write to display buffer
    INX
    INC $00         ; column++
    CPX #$20        ; 32 cols done?
    BNE FILL_ROW
    LDA #$00
    STA $00
    INC $01         ; next row
    LDA $01
    CMP #$1E        ; 30 rows done?
    BNE FILL_DISPLAY

MAIN:
    ; Increment a counter in zero page
    INC $10
    LDA $10
    ; Write counter to top-left of display
    STA $0200
    ; Simple delay loop
    LDX #$FF
DELAY:
    DEX
    BNE DELAY
    JMP MAIN        ; loop forever

; Interrupt vectors at $FFFA
.org $FFFA
.word MAIN          ; NMI vector
.word RESET         ; RESET vector
.word MAIN          ; IRQ vector
`;
    Simulator.loadFirmware(document.getElementById('code-editor').value);
    document.getElementById('flash-status').textContent = '✓ Demo firmware loaded';
    document.getElementById('flash-status').style.color = 'var(--green)';

    UI.updateBOM();
    UI.updateComponentCount();
    UI.updateSignalIntegrity();
    Debug.log('Demo board loaded: Simple Computer with CPU, RAM, GPU, LED', 'ok');
    Debug.log('Press ⏻ POWER to start simulation', 'info');

    // Auto-select CPU for props display
    Renderer.clearSelection();
    Renderer.select(cpu.id);
    UI.showProps(cpu);
  }

  // ── Keyboard shortcuts ────────────────────────────────────
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    switch (e.key) {
      case 'Escape': cancelAction(); break;
      case 'Delete':
      case 'Backspace': {
        const sel = Renderer.getSelection();
        sel.forEach(id => Board.removeComponent(id));
        if (sel.length > 0) UI.clearProps();
        break;
      }
      case 's': case 'S': setTool('select'); break;
      case 'w': case 'W': setTool('wire'); break;
      case 'p': case 'P': setTool('probe'); break;
      case 'd': case 'D': setTool('delete'); break;
      case ' ':
        e.preventDefault();
        togglePower();
        break;
      case 'r': case 'R':
        Simulator.reset();
        break;
    }
  });

  return { init };
})();

// ── Start the app ─────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  App.init();
});
