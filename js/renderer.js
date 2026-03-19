// ============================================================
// SILICON LAB — renderer.js
// Top-down 3D PCB canvas renderer
// ============================================================

const Renderer = (() => {

  let canvas, ctx;
  let board = {
    components: [],
    traces: [],
    width: 0,
    height: 0,
  };
  let view = {
    offsetX: 0,
    offsetY: 0,
    zoom: 1,
  };
  let selection = new Set();  // selected component ids
  let _raf = null;
  let _dirty = true;

  const GRID = 20;
  const PCB_COLOR = '#0d2010';
  const GRID_COLOR = 'rgba(0,180,60,0.08)';
  const TRACE_COLOR = '#cc8800';
  const TRACE_WIDTH = 3;
  const SELECTED_COLOR = '#00ffcc';

  // ── Init ──────────────────────────────────────────────────
  function init(canvasEl) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
    startRenderLoop();
  }

  function resize() {
    const wrap = canvas.parentElement;
    canvas.width = wrap.clientWidth;
    canvas.height = wrap.clientHeight - 32; // header
    view.offsetX = canvas.width / 2 - 400;
    view.offsetY = canvas.height / 2 - 300;
    _dirty = true;
  }

  // ── Coordinate transforms ─────────────────────────────────
  function worldToScreen(wx, wy) {
    return {
      x: wx * view.zoom + view.offsetX,
      y: wy * view.zoom + view.offsetY,
    };
  }

  function screenToWorld(sx, sy) {
    return {
      x: (sx - view.offsetX) / view.zoom,
      y: (sy - view.offsetY) / view.zoom,
    };
  }

  // ── Render loop ───────────────────────────────────────────
  function startRenderLoop() {
    function loop() {
      if (_dirty || Simulator.running) {
        render();
        _dirty = false;
      }
      _raf = requestAnimationFrame(loop);
    }
    _raf = requestAnimationFrame(loop);
  }

  function render() {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.save();

    // Background
    ctx.fillStyle = '#060a06';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // PCB Board
    const bx = view.offsetX;
    const by = view.offsetY;
    const bw = 800 * view.zoom;
    const bh = 600 * view.zoom;

    // Board shadow
    ctx.shadowColor = 'rgba(0,255,100,0.15)';
    ctx.shadowBlur = 30;
    ctx.fillStyle = PCB_COLOR;
    ctx.fillRect(bx, by, bw, bh);
    ctx.shadowBlur = 0;

    // Board edge (copper ring)
    ctx.strokeStyle = '#1a4020';
    ctx.lineWidth = 2 * view.zoom;
    ctx.strokeRect(bx, by, bw, bh);

    // Mounting holes
    const holes = [
      [30, 30], [770, 30], [30, 570], [770, 570],
    ];
    holes.forEach(([hx, hy]) => {
      const s = worldToScreen(hx, hy);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 5 * view.zoom, 0, Math.PI * 2);
      ctx.fillStyle = '#060a06';
      ctx.fill();
      ctx.strokeStyle = '#cc9900';
      ctx.lineWidth = 2 * view.zoom;
      ctx.stroke();
    });

    // Grid
    drawGrid(bx, by, bw, bh);

    // Traces
    board.traces.forEach(trace => drawTrace(trace));

    // Wire-in-progress
    if (_wireState.active) {
      drawWireInProgress();
    }

    // Components (sorted by z: large ones first)
    const sorted = [...board.components].sort((a, b) => {
      const az = (ComponentDefs[a.type]?.width || 0) * (ComponentDefs[a.type]?.height || 0);
      const bz = (ComponentDefs[b.type]?.width || 0) * (ComponentDefs[b.type]?.height || 0);
      return bz - az;
    });

    sorted.forEach(comp => drawComponent(comp));

    // Probe indicator
    if (_probeComp) drawProbeIndicator(_probeComp);

    // Thermal overlay (CPU-side pixels from analog worker)
    if (_thermalPixels && Simulator.running) drawThermalOverlay();

    // Performance HUD
    drawPerfHUD();

    ctx.restore();
  }

  function drawGrid(bx, by, bw, bh) {
    const gridPx = GRID * view.zoom;
    if (gridPx < 8) return;

    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;

    const startX = Math.ceil((-view.offsetX) / gridPx) * gridPx + view.offsetX;
    const startY = Math.ceil((-view.offsetY) / gridPx) * gridPx + view.offsetY;

    for (let x = startX; x < bx + bw; x += gridPx) {
      if (x < bx) continue;
      ctx.beginPath();
      ctx.moveTo(x, Math.max(by, 0));
      ctx.lineTo(x, Math.min(by + bh, canvas.height));
      ctx.stroke();
    }
    for (let y = startY; y < by + bh; y += gridPx) {
      if (y < by) continue;
      ctx.beginPath();
      ctx.moveTo(Math.max(bx, 0), y);
      ctx.lineTo(Math.min(bx + bw, canvas.width), y);
      ctx.stroke();
    }
  }

  function drawTrace(trace) {
    const def = ComponentDefs[trace.fromType];
    const isHighSpeed = def && (def.label === 'CPU' || def.label === 'GPU' || def.label === 'RAM');

    let traceColor = TRACE_COLOR;
    let traceW = TRACE_WIDTH;

    if (isHighSpeed) {
      traceColor = '#cc5500';
      traceW = 2;
    }

    // Thermal glow if sim running
    if (Simulator.running) {
      const fromComp = board.components.find(c => c.id === trace.fromCompId);
      if (fromComp && fromComp.state.temp > 60) {
        const hot = Utils.clamp((fromComp.state.temp - 60) / 60, 0, 1);
        traceColor = `hsl(${30 - hot * 30}, 100%, ${40 + hot * 20}%)`;
        if (hot > 0.8) {
          ctx.shadowColor = `rgba(255,${100-hot*80},0,0.5)`;
          ctx.shadowBlur = 6;
        }
      }
    }

    const points = trace.points || [];
    if (points.length < 2) return;

    ctx.strokeStyle = traceColor;
    ctx.lineWidth = traceW * view.zoom;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();

    const p0 = worldToScreen(points[0].x, points[0].y);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < points.length; i++) {
      const p = worldToScreen(points[i].x, points[i].y);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Vias
    if (points.length > 2) {
      points.slice(1, -1).forEach(pt => {
        const s = worldToScreen(pt.x, pt.y);
        ctx.beginPath();
        ctx.arc(s.x, s.y, 4 * view.zoom, 0, Math.PI*2);
        ctx.fillStyle = '#aa6600';
        ctx.fill();
        ctx.strokeStyle = '#ffaa00';
        ctx.lineWidth = 1;
        ctx.stroke();
      });
    }
  }

  function drawWireInProgress() {
    const pts = _wireState.points;
    if (pts.length === 0) return;
    ctx.strokeStyle = '#ffee00';
    ctx.lineWidth = 2 * view.zoom;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    const p0 = worldToScreen(pts[0].x, pts[0].y);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < pts.length; i++) {
      const p = worldToScreen(pts[i].x, pts[i].y);
      ctx.lineTo(p.x, p.y);
    }
    if (_wireState.cursor) {
      ctx.lineTo(_wireState.cursor.sx, _wireState.cursor.sy);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawComponent(comp) {
    const def = ComponentDefs[comp.type];
    if (!def) return;

    const s = worldToScreen(comp.x, comp.y);
    const sw = def.width * view.zoom;
    const sh = def.height * view.zoom;

    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.scale(view.zoom, view.zoom);

    // 3D shadow (offset top-left)
    if (view.zoom > 0.4) {
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowOffsetX = 3;
      ctx.shadowOffsetY = 3;
      ctx.shadowBlur = 6;
    }

    // Burned overlay
    if (comp.state.burned) {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, def.width, def.height);
      ctx.fillStyle = '#333';
      ctx.font = '8px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('BURNED', def.width/2, def.height/2);
      ctx.textAlign = 'left';
    } else {
      def.draw(ctx, comp, Simulator);
    }

    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.shadowBlur = 0;

    // Selection outline
    if (selection.has(comp.id)) {
      ctx.strokeStyle = SELECTED_COLOR;
      ctx.lineWidth = 2 / view.zoom;
      ctx.strokeRect(-2, -2, def.width+4, def.height+4);
      ctx.fillStyle = 'rgba(0,255,204,0.05)';
      ctx.fillRect(-2, -2, def.width+4, def.height+4);
    }

    // Label
    if (view.zoom > 0.5) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(0, def.height + 2, 40, 10);
      ctx.fillStyle = '#aaa';
      ctx.font = '7px Share Tech Mono, monospace';
      ctx.fillText(comp.id, 2, def.height + 10);
    }

    // Thermal indicator dot
    if (Simulator.running && comp.state.temp > 40) {
      const col = Utils.tempColor(comp.state.temp);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(def.width - 5, 5, 4, 0, Math.PI*2);
      ctx.fill();
      if (comp.state.temp > 80) {
        ctx.shadowColor = col;
        ctx.shadowBlur = 8;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }

    // Warning triangle
    if (comp.state.burned || comp.state.throttling) {
      ctx.fillStyle = comp.state.burned ? '#ff3333' : '#ff8800';
      ctx.font = '12px monospace';
      ctx.fillText('⚠', def.width/2 - 6, def.height/2 + 6);
    }

    ctx.restore();
  }

  function drawProbeIndicator(comp) {
    const def = ComponentDefs[comp.type];
    if (!def) return;
    const s = worldToScreen(comp.x + def.width/2, comp.y + def.height/2);
    ctx.save();
    ctx.strokeStyle = '#00ffcc';
    ctx.lineWidth = 2;
    const r = 20 * view.zoom;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI*2);
    ctx.stroke();
    // crosshair
    ctx.beginPath();
    ctx.moveTo(s.x - r - 5, s.y); ctx.lineTo(s.x + r + 5, s.y);
    ctx.moveTo(s.x, s.y - r - 5); ctx.lineTo(s.x, s.y + r + 5);
    ctx.stroke();
    // pulsing ring
    ctx.globalAlpha = 0.3 + Math.sin(Date.now() * 0.005) * 0.2;
    ctx.strokeStyle = '#00ffcc';
    ctx.beginPath();
    ctx.arc(s.x, s.y, r * 1.5, 0, Math.PI*2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // ── Thermal overlay ───────────────────────────────────────
  let _thermalPixels = null;    // Float32Array 80×60 from analog worker
  let _thermalOpacity = 0.55;

  function drawThermalOverlay() {
    if (!_thermalPixels) return;
    const W = 80, H = 60;
    const bx = view.offsetX, by = view.offsetY;
    const bw = 800 * view.zoom, bh = 600 * view.zoom;
    const cellW = bw / W, cellH = bh / H;

    ctx.save();
    ctx.globalAlpha = _thermalOpacity;
    for (let ty = 0; ty < H; ty++) {
      for (let tx = 0; tx < W; tx++) {
        const heat = _thermalPixels[ty * W + tx];
        if (heat < 0.01) continue;
        // FLIR-style: blue→cyan→green→yellow→red
        const h = (1 - heat) * 240; // hsl hue
        ctx.fillStyle = `hsl(${h.toFixed(0)},100%,50%)`;
        ctx.fillRect(bx + tx * cellW, by + ty * cellH, cellW + 1, cellH + 1);
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // Performance HUD
  let _perfFrames = 0, _perfFPS = 0, _perfLastT = 0;
  function drawPerfHUD() {
    const now = performance.now();
    _perfFrames++;
    if (now - _perfLastT >= 1000) {
      _perfFPS = _perfFrames;
      _perfFrames = 0;
      _perfLastT = now;
    }
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(canvas.width - 170, 8, 162, Simulator.running ? 60 : 20);
    ctx.fillStyle = _perfFPS >= 55 ? '#00ff88' : _perfFPS >= 30 ? '#ffe033' : '#ff3333';
    ctx.font = '10px Share Tech Mono, monospace';
    ctx.fillText(`FPS: ${_perfFPS}`, canvas.width - 162, 21);
    if (Simulator.running) {
      ctx.fillStyle = '#00ffcc';
      ctx.fillText(`T: ${Simulator.time.toFixed(2)}s`, canvas.width - 162, 35);
      ctx.fillText(`PWR: ${(Simulator.power * 1000).toFixed(0)}mW`, canvas.width - 162, 49);
      const an = Simulator.activeNodes;
      ctx.fillStyle = an < 5 ? '#00ff88' : '#ffe033';
      ctx.fillText(`ACTIVE: ${an}/${Board.getComponents().length}`, canvas.width - 162, 63);
    }
    ctx.restore();
  }

  // ── Wire drawing state ────────────────────────────────────
  const _wireState = {
    active: false,
    fromComp: null,
    fromPin: null,
    points: [],
    cursor: null,
  };

  let _probeComp = null;

  // ── Interaction helpers ───────────────────────────────────
  function hitTestComponent(wx, wy) {
    for (let i = board.components.length - 1; i >= 0; i--) {
      const comp = board.components[i];
      const def = ComponentDefs[comp.type];
      if (!def) continue;
      if (Utils.ptInRect(wx, wy, comp.x, comp.y, def.width, def.height)) {
        return comp;
      }
    }
    return null;
  }

  function hitTestPin(wx, wy, radius = 10) {
    for (const comp of board.components) {
      const def = ComponentDefs[comp.type];
      if (!def) continue;
      for (const pin of def.pins) {
        const px = comp.x + pin.x;
        const py = comp.y + pin.y;
        if (Utils.dist({x:wx,y:wy}, {x:px,y:py}) <= radius) {
          return { comp, pin };
        }
      }
    }
    return null;
  }

  // ── Public API ────────────────────────────────────────────
  return {
    init,
    worldToScreen,
    screenToWorld,
    markDirty() { _dirty = true; },
    board,

    setBoard(components, traces) {
      board.components = components;
      board.traces = traces;
      _dirty = true;
    },

    select(id) { selection.add(id); _dirty = true; },
    deselect(id) { selection.delete(id); _dirty = true; },
    clearSelection() { selection.clear(); _dirty = true; },
    isSelected(id) { return selection.has(id); },
    getSelection() { return [...selection]; },

    hitTestComponent,
    hitTestPin,

    startWire(comp, pin) {
      _wireState.active = true;
      _wireState.fromComp = comp;
      _wireState.fromPin = pin;
      const def = ComponentDefs[comp.type];
      const pinDef = def.pins.find(p => p.name === pin);
      _wireState.points = [{ x: comp.x + pinDef.x, y: comp.y + pinDef.y }];
    },

    addWirePoint(wx, wy) {
      const snapped = { x: Utils.snap(wx), y: Utils.snap(wy) };
      _wireState.points.push(snapped);
    },

    finishWire(comp, pin) {
      if (!_wireState.active || !_wireState.fromComp) return null;
      const fromDef = ComponentDefs[_wireState.fromComp.type];
      const fromPin = fromDef.pins.find(p => p.name === _wireState.fromPin);
      const toDef = ComponentDefs[comp.type];
      const toPin = toDef.pins.find(p => p.name === pin);
      const endPt = { x: comp.x + toPin.x, y: comp.y + toPin.y };
      const pts = [..._wireState.points, endPt];

      const trace = {
        id: Utils.uid('T'),
        fromCompId: _wireState.fromComp.id,
        fromPin: _wireState.fromPin,
        fromType: _wireState.fromComp.type,
        toCompId: comp.id,
        toPin: pin,
        x1: pts[0].x, y1: pts[0].y,
        x2: endPt.x, y2: endPt.y,
        points: pts,
      };

      _wireState.active = false;
      _wireState.fromComp = null;
      _wireState.points = [];
      _dirty = true;
      return trace;
    },

    cancelWire() {
      _wireState.active = false;
      _wireState.fromComp = null;
      _wireState.points = [];
      _dirty = true;
    },

    updateWireCursor(sx, sy) {
      _wireState.cursor = { sx, sy };
    },

    setProbeComponent(comp) {
      _probeComp = comp;
      _dirty = true;
    },

    pan(dx, dy) {
      view.offsetX += dx;
      view.offsetY += dy;
      _dirty = true;
    },

    zoom(factor, cx, cy) {
      const before = screenToWorld(cx, cy);
      view.zoom = Utils.clamp(view.zoom * factor, 0.2, 4);
      const after = screenToWorld(cx, cy);
      view.offsetX += (after.x - before.x) * view.zoom;
      view.offsetY += (after.y - before.y) * view.zoom;
      _dirty = true;
      EventBus.emit('view:zoom', view.zoom);
    },

    getZoom() { return view.zoom; },
    getWireState() { return _wireState; },
    getCanvas() { return canvas; },
    setThermalPixels(pixels) { _thermalPixels = pixels; },
    setThermalOpacity(v) { _thermalOpacity = v; },
  };
})();
