// ============================================================
// SILICON LAB — oscilloscope.js
// Real-time waveform display
// ============================================================

const Oscilloscope = (() => {
  let canvas, ctx;
  let _raf = null;
  let _running = false;

  const GRID_COLOR = 'rgba(0,180,80,0.15)';
  const WAVE_COLOR = '#00ff88';
  const AXIS_COLOR = 'rgba(0,255,136,0.3)';

  function init(canvasEl) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    render([]);
  }

  function render(data) {
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = '#050f05';
    ctx.fillRect(0, 0, W, H);

    // Grid
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;
    const cols = 10, rows = 6;
    for (let i = 0; i <= cols; i++) {
      const x = (i / cols) * W;
      ctx.beginPath();
      ctx.moveTo(x, 0); ctx.lineTo(x, H);
      ctx.stroke();
    }
    for (let j = 0; j <= rows; j++) {
      const y = (j / rows) * H;
      ctx.beginPath();
      ctx.moveTo(0, y); ctx.lineTo(W, y);
      ctx.stroke();
    }

    // Centre axis
    ctx.strokeStyle = AXIS_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, H/2); ctx.lineTo(W, H/2);
    ctx.stroke();
    ctx.setLineDash([]);

    if (!data || data.length < 2) {
      // Idle line
      ctx.strokeStyle = 'rgba(0,255,136,0.2)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, H/2); ctx.lineTo(W, H/2);
      ctx.stroke();
      return;
    }

    // Scale data
    const maxV = Math.max(...data.map(Math.abs), 0.1);
    const minV = Math.min(...data);
    const range = (maxV - Math.min(minV, 0)) || 1;

    // Glow pass
    ctx.shadowColor = WAVE_COLOR;
    ctx.shadowBlur = 8;
    ctx.strokeStyle = WAVE_COLOR;
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    const step = W / (data.length - 1);
    data.forEach((v, i) => {
      const x = i * step;
      const norm = Utils.clamp((v - minV) / range, 0, 1);
      const y = H - norm * (H * 0.85) - H * 0.075;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Highlight latest point
    const lastV = data[data.length - 1];
    const norm = Utils.clamp((lastV - minV) / range, 0, 1);
    const lastY = H - norm * (H * 0.85) - H * 0.075;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(W - 2, lastY, 2.5, 0, Math.PI*2);
    ctx.fill();

    // Voltage axis labels
    ctx.fillStyle = 'rgba(0,255,136,0.5)';
    ctx.font = '8px Share Tech Mono, monospace';
    ctx.fillText(`${maxV.toFixed(2)}V`, 3, 10);
    ctx.fillText(`${minV.toFixed(2)}V`, 3, H - 3);
  }

  function getStats(data) {
    if (!data || data.length < 2) return { freq: 0, volt: 0 };
    const avg = data.reduce((a,b) => a+b, 0) / data.length;
    const peak = Math.max(...data.map(Math.abs));

    // Crude zero-crossing frequency estimate
    let crossings = 0;
    for (let i = 1; i < data.length; i++) {
      if ((data[i-1] < avg) !== (data[i] < avg)) crossings++;
    }
    const duration = data.length * 0.016; // approx seconds
    const freq = crossings / (2 * duration);

    return { freq, volt: peak };
  }

  // Subscribe to sim ticks
  EventBus.on('sim:tick', ({ waveHistory }) => {
    render(waveHistory);
    const stats = getStats(waveHistory);
    const statusEl = document.getElementById('osc-status');
    const freqEl = document.getElementById('osc-freq');
    const voltEl = document.getElementById('osc-volt');

    if (statusEl) {
      statusEl.textContent = '● LIVE';
      statusEl.className = 'running';
    }
    if (freqEl) freqEl.textContent = `${Utils.fmtV(stats.freq)}Hz`;
    if (voltEl) voltEl.textContent = `${stats.volt.toFixed(2)}V`;
  });

  EventBus.on('sim:stopped', () => {
    const statusEl = document.getElementById('osc-status');
    if (statusEl) { statusEl.textContent = '● IDLE'; statusEl.className = ''; }
  });

  EventBus.on('sim:reset', () => {
    render([]);
  });

  return { init, render, getStats };
})();
