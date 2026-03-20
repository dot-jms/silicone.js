// ============================================================
// SILICON LAB — component-ingestor.js
// Universal Component Ingestor
//
// Three-layer strategy (as designed):
//  1. METADATA   — Octopart / Nexar API (pinout, specs, footprint)
//  2. PHYSICS    — SPICE model fetch + parsing into simulator format
//  3. LOGIC      — AI-assisted behavioral model generation
//
// Because Octopart requires a backend proxy (CORS), we use a
// combination of:
//   • Open Hardware APIs that allow direct browser access
//   • A Claude AI call to parse raw datasheet text / SPICE into
//     a live ComponentDef + simulate() function
//   • A local cache so repeated lookups are instant
// ============================================================

const ComponentIngestor = (() => {

  // ── Cache ─────────────────────────────────────────────────
  const _cache = new Map();   // partNumber → ComponentDef
  const _searchCache = new Map(); // query → results[]

  // ── SPICE model sources (CORS-friendly mirrors) ───────────
  const SPICE_SOURCES = [
    // SpiceLib mirror (public)
    (pn) => `https://raw.githubusercontent.com/eventuallyconsultant/codemodel/main/spice/${pn.toLowerCase()}.lib`,
  ];

  // ── Open Parts DB (no key needed) ─────────────────────────
  // We use the free Kitspace parts API as our metadata source
  const KITSPACE_SEARCH = (q) =>
    `https://api.kitspace.org/v1/1_part_searches?q=${encodeURIComponent(q)}&limit=8`;

  // ── Known behavioral models (community digital twins) ─────
  // These map part families to pre-built logic descriptions
  // that the AI can use as a starting point
  const KNOWN_FAMILIES = {
    '6502':  { type: 'cpu_8bit', clock: 1.79, vcc: 5, tdp: 0.15,  desc: 'MOS 6502 — used in NES, Apple II, C64' },
    '6510':  { type: 'cpu_8bit', clock: 1.02, vcc: 5, tdp: 0.2,   desc: 'MOS 6510 — Commodore 64 CPU' },
    'Z80':   { type: 'cpu_8bit', clock: 4,    vcc: 5, tdp: 0.5,   desc: 'Zilog Z80 — ZX Spectrum, CP/M systems' },
    '8051':  { type: 'cpu_8bit', clock: 12,   vcc: 5, tdp: 0.3,   desc: 'Intel 8051 microcontroller' },
    'ATmega328': { type: 'mcu', clock: 16, vcc: 5, tdp: 0.2,     desc: 'Arduino Uno MCU' },
    'ATmega32U4': { type: 'mcu', clock: 16, vcc: 5, tdp: 0.25,   desc: 'Arduino Leonardo MCU' },
    'ESP32': { type: 'mcu', clock: 240, vcc: 3.3, tdp: 0.5,       desc: 'ESP32 dual-core WiFi/BT MCU' },
    'ESP8266': { type: 'mcu', clock: 80, vcc: 3.3, tdp: 0.4,     desc: 'ESP8266 WiFi SoC' },
    'STM32': { type: 'mcu', clock: 72, vcc: 3.3, tdp: 0.3,       desc: 'STM32 ARM Cortex-M MCU' },
    'RP2040': { type: 'mcu', clock: 133, vcc: 3.3, tdp: 0.35,    desc: 'Raspberry Pi RP2040 dual-core MCU' },
    '74HC':  { type: 'logic_cmos', vcc: 5, tdp: 0.025,           desc: '74HC series CMOS logic family' },
    '74LS':  { type: 'logic_ttl',  vcc: 5, tdp: 0.05,            desc: '74LS series TTL logic family' },
    'LM741': { type: 'opamp', vcc: 15, tdp: 0.1,                  desc: 'LM741 general-purpose op-amp' },
    'LM358': { type: 'opamp', vcc: 5,  tdp: 0.06,                desc: 'LM358 dual op-amp' },
    'NE555': { type: 'timer', vcc: 9,  tdp: 0.06,                desc: 'NE555 timer IC — astable/monostable' },
    'LM7805': { type: 'vreg', vout: 5, vin_max: 35, tdp: 1.5,    desc: 'LM7805 +5V linear regulator' },
    'LM317': { type: 'vreg_adj', vout: 1.25, vin_max: 40, tdp: 2, desc: 'LM317 adjustable linear regulator' },
    'AMS1117': { type: 'vreg', vout: 3.3, vin_max: 15, tdp: 0.8, desc: 'AMS1117 3.3V LDO regulator' },
    '2N3904': { type: 'npn', hfe: 100, vce: 40, ic_max: 0.2,     desc: '2N3904 NPN small-signal transistor' },
    '2N2222': { type: 'npn', hfe: 150, vce: 40, ic_max: 0.6,     desc: '2N2222 NPN general-purpose transistor' },
    'IRF540': { type: 'nmos', rds: 0.044, vgs: 10, id_max: 28,   desc: 'IRF540 N-channel power MOSFET' },
    'MPU6050': { type: 'sensor_imu', vcc: 3.3, tdp: 0.005,       desc: 'MPU-6050 6-axis IMU (gyro+accel)' },
    'DS18B20': { type: 'sensor_temp', vcc: 3.3, tdp: 0.001,      desc: 'DS18B20 1-Wire temperature sensor' },
    'EEPROM': { type: 'memory', vcc: 5, tdp: 0.05,               desc: 'Generic EEPROM memory IC' },
    '2114':  { type: 'sram', vcc: 5, tdp: 0.15, capacity: 1024,  desc: '2114 1K×4 SRAM — used in early computers' },
    'PPU':   { type: 'gpu_tile', vcc: 5, tdp: 0.3,               desc: 'Picture Processing Unit — NES graphics' },
    'APU':   { type: 'audio', vcc: 5, tdp: 0.1,                  desc: 'Audio Processing Unit — NES sound' },
  };

  // ── AI-powered component parser ───────────────────────────
  async function parseWithAI(partNumber, rawData, spiceText) {
  Debug.log(`[AI] Parsing ${partNumber} with Claude...`, 'sim');

  const prompt = `You are a hardware simulation engine assistant for "Silicon Lab", a browser-based PCB simulator.

Your job is to convert component datasheet information into a JavaScript simulation definition.

PART NUMBER: ${partNumber}

RAW METADATA (from parts database):
${rawData ? JSON.stringify(rawData, null, 2).slice(0, 2000) : 'Not available'}

SPICE MODEL (if available):
${spiceText ? spiceText.slice(0, 1500) : 'Not available'}

KNOWN FAMILY DATA:
${JSON.stringify(findFamilyData(partNumber), null, 2)}

Generate a JSON object with this EXACT structure (no markdown, no code blocks, raw JSON only):
{
  "label": "Full component name",
  "shortLabel": "2-5 char abbreviation",
  "width": 60,
  "height": 50,
  "description": "One sentence description",
  "color": "#hexcolor",
  "category": "cpu|mcu|logic|memory|analog|power|sensor|passive|rf|display",
  "pins": [
    {"x": 0, "y": 10, "name": "VCC", "type": "power_in"},
    {"x": 0, "y": 25, "name": "GND", "type": "gnd"},
    {"x": 60, "y": 10, "name": "OUT", "type": "data_io"}
  ],
  "defaults": {
    "vcc": 5.0,
    "tdp_w": 0.5,
    "clock_mhz": 1.0
  },
  "props": ["vcc", "tdp_w", "clock_mhz"],
  "units": {"vcc": "V", "tdp_w": "W", "clock_mhz": "MHz"},
  "thermalCoeff": 0.1,
  "physics": {
    "type": "digital|analog|mixed|passive",
    "vcc_nom": 5.0,
    "vcc_min": 4.5,
    "vcc_max": 5.5,
    "icc_active_ma": 15,
    "icc_idle_ma": 2,
    "temp_max_c": 85,
    "propagation_ns": 10,
    "output_high_v": 4.5,
    "output_low_v": 0.1
  },
  "simulateBehavior": "standard_digital|standard_analog|oscillator|voltage_regulator|sensor|opamp|transistor_npn|transistor_pmos|power_switch|counter|shift_register|memory|cpu_8bit|mcu",
  "spiceParams": {}
}

Pin types must be one of: power_in, power_out, gnd, data_io, clock_in, clock_out, control, analog_in, analog_out, pwm_out, reset.
Pin x/y must place pins ON the component edges (x=0 for left edge, x=width for right edge, y=0 for top, y=height for bottom).
Use realistic pin counts and placement for the actual chip.
Return ONLY the JSON object, nothing else.`;

  try {
    const response = await fetch('https://siliconejs-vhkbvt8ak5a9.dot-jms.deno.net', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Proxy returned ${response.status}`);
    }

    const data = await response.json();

    // Handle both Anthropic format and OpenRouter format
    const text = data.content?.[0]?.text
      || data.choices?.[0]?.message?.content
      || '';

    if (!text) throw new Error('Empty response from AI');

    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);

  } catch (err) {
    Debug.log(`[AI] Parse error: ${err.message}`, 'error');
    return null;
  }
}
  // ── Family matcher ─────────────────────────────────────────
  function findFamilyData(partNumber) {
    const pnUpper = partNumber.toUpperCase();
    for (const [key, data] of Object.entries(KNOWN_FAMILIES)) {
      if (pnUpper.includes(key.toUpperCase())) return { family: key, ...data };
    }
    return null;
  }

  // ── Search parts database ─────────────────────────────────
  async function searchParts(query) {
    if (_searchCache.has(query)) return _searchCache.get(query);

    Debug.log(`[Search] Querying parts DB for: "${query}"`, 'info');

    const results = [];

    // 1. Check local known families
    for (const [key, data] of Object.entries(KNOWN_FAMILIES)) {
      if (key.toLowerCase().includes(query.toLowerCase()) ||
          data.desc.toLowerCase().includes(query.toLowerCase())) {
        results.push({
          partNumber: key,
          description: data.desc,
          manufacturer: 'Various',
          source: 'builtin',
          familyData: data,
        });
      }
    }

    // 2. Try Kitspace API (CORS-open)
    try {
      const url = KITSPACE_SEARCH(query);
      const resp = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (resp.ok) {
        const json = await resp.json();
        const items = Array.isArray(json) ? json : (json.results || json.parts || []);
        items.slice(0, 6).forEach(item => {
          results.push({
            partNumber: item.mpn || item.partNumber || item.name || query,
            description: item.description || item.desc || '',
            manufacturer: item.manufacturer || item.mfr || 'Unknown',
            datasheet: item.datasheet || item.datasheetUrl || '',
            source: 'kitspace',
            raw: item,
          });
        });
      }
    } catch (e) {
      Debug.log(`[Search] Kitspace unavailable (${e.message}) — using local library`, 'warn');
    }

    // 3. Fallback: generate a synthetic result so the user can still place it
    if (results.length === 0) {
      results.push({
        partNumber: query.toUpperCase(),
        description: `Custom part: ${query}`,
        manufacturer: 'Unknown',
        source: 'synthetic',
      });
    }

    _searchCache.set(query, results);
    return results;
  }

  // ── Fetch SPICE model ─────────────────────────────────────
  async function fetchSpiceModel(partNumber) {
    for (const srcFn of SPICE_SOURCES) {
      try {
        const url = srcFn(partNumber);
        const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
          const text = await resp.text();
          if (text.includes('.SUBCKT') || text.includes('.MODEL') || text.includes('.model')) {
            Debug.log(`[SPICE] Model found for ${partNumber}`, 'ok');
            return text;
          }
        }
      } catch (e) { /* try next source */ }
    }
    Debug.log(`[SPICE] No SPICE model found for ${partNumber} — using AI estimation`, 'info');
    return null;
  }

  // ── Build ComponentDef from AI JSON ───────────────────────
  function buildComponentDef(aiJson, partNumber) {
    const def = {
      label: aiJson.label || partNumber,
      shortLabel: aiJson.shortLabel || partNumber.slice(0, 4),
      width:  aiJson.width  || 60,
      height: aiJson.height || 50,
      color:  aiJson.color  || '#1a1a2e',
      description: aiJson.description || '',
      category: aiJson.category || 'generic',
      pins: aiJson.pins || [
        { x: 0, y: 10, name: 'VCC', type: 'power_in' },
        { x: 0, y: 30, name: 'GND', type: 'gnd' },
      ],
      defaults: aiJson.defaults || { vcc: 5 },
      props:   aiJson.props   || ['vcc'],
      units:   aiJson.units   || { vcc: 'V' },
      thermalCoeff: aiJson.thermalCoeff || 0.05,
      physics: aiJson.physics || {},
      _isImported: true,
      _partNumber: partNumber,
      _behavior: aiJson.simulateBehavior || 'standard_digital',

      // ── draw() ────────────────────────────────────────────
      draw(ctx, comp, sim) {
        const w = this.width, h = this.height;
        const hot = sim.running ? Utils.clamp((comp.state.temp - 25) / 80, 0, 1) : 0;

        // Package body
        ctx.fillStyle = hot > 0.6 ? `hsl(${20 - hot*20},70%,${15+hot*10}%)` : this.color;
        ctx.strokeStyle = '#555';
        ctx.lineWidth = 1;
        ctx.fillRect(2, 2, w-4, h-4);
        ctx.strokeRect(2, 2, w-4, h-4);

        // Pin 1 marker
        ctx.fillStyle = '#888';
        ctx.beginPath();
        ctx.arc(5, h-5, 3, 0, Math.PI*2);
        ctx.fill();

        // Label
        ctx.fillStyle = hot > 0.5 ? '#ff8844' : '#ccd';
        ctx.font = `bold ${Math.min(10, Math.floor(w/this.shortLabel.length) - 1)}px Orbitron, monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(this.shortLabel, w/2, h/2 - 4);
        ctx.font = '6px Share Tech Mono, monospace';
        ctx.fillStyle = '#666';
        const pnShort = partNumber.length > 10 ? partNumber.slice(0,10) : partNumber;
        ctx.fillText(pnShort, w/2, h/2 + 6);
        ctx.textAlign = 'left';

        // Activity LED for powered digital parts
        if (sim.running && comp.state.powered) {
          ctx.fillStyle = `rgba(0,255,136,${0.5 + Math.sin(Date.now()*0.008)*0.3})`;
          ctx.beginPath();
          ctx.arc(w-6, 6, 3, 0, Math.PI*2);
          ctx.fill();
        }

        // Draw pin stubs
        ctx.strokeStyle = '#cc9922';
        ctx.lineWidth = 1.5;
        this.pins.forEach(pin => {
          ctx.beginPath();
          if (pin.x === 0) { ctx.moveTo(0, pin.y); ctx.lineTo(4, pin.y); }
          else if (pin.x === w) { ctx.moveTo(w-4, pin.y); ctx.lineTo(w, pin.y); }
          else if (pin.y === 0) { ctx.moveTo(pin.x, 0); ctx.lineTo(pin.x, 4); }
          else if (pin.y === h) { ctx.moveTo(pin.x, h-4); ctx.lineTo(pin.x, h); }
          ctx.stroke();

          // Pin dot
          ctx.fillStyle = '#aa7700';
          ctx.beginPath();
          ctx.arc(pin.x, pin.y, 2.5, 0, Math.PI*2);
          ctx.fill();
        });
      },

      // ── simulate() ────────────────────────────────────────
      simulate(comp, dt, voltage) {
        const phys = this.physics;
        const vccNom = phys.vcc_nom || comp.props.vcc || 5;
        const iccActive = (phys.icc_active_ma || 10) / 1000;
        const iccIdle   = (phys.icc_idle_ma   || 1)  / 1000;
        const tempMax   = phys.temp_max_c || 85;
        const tdp       = comp.props.tdp_w || 0.5;

        const powered = voltage >= vccNom * 0.85;
        comp.state.powered = powered;

        if (!powered) {
          comp.state.running = false;
          comp.state.temp = Utils.clamp(comp.state.temp - 3*dt, 25, tempMax);
          return { temp: comp.state.temp, powered: false };
        }

        comp.state.running = true;
        const current = powered ? iccActive : iccIdle;
        const power = voltage * current;

        // Behavioral modifiers
        let heatMult = 1;
        switch (this._behavior) {
          case 'cpu_8bit':
          case 'mcu':
            comp.state.pc = ((comp.state.pc || 0) + 1) % 0xFFFF;
            comp.state.clk = ((comp.state.clk || 0) + 1);
            heatMult = 1.2;
            break;
          case 'voltage_regulator': {
            const vout = comp.props.vout || (vccNom * 0.66);
            comp.state.output_voltage = powered ? vout : 0;
            heatMult = 2.0;
            break;
          }
          case 'oscillator':
            comp.state.oscillating = powered;
            comp.state.frequency = (comp.props.clock_mhz || 1) * 1e6;
            heatMult = 0.5;
            break;
          case 'sensor':
            comp.state.reading = powered ? (20 + Math.sin(Date.now()*0.001)*5) : 0;
            heatMult = 0.1;
            break;
          case 'opamp':
            comp.state.gain = 1;
            heatMult = 0.3;
            break;
          case 'transistor_npn':
            comp.state.on = voltage > 0.7;
            comp.state.ic = comp.state.on ? Math.min(voltage * 100, comp.props.ic_max || 1) : 0;
            heatMult = 0.8;
            break;
        }

        comp.state.temp = Utils.clamp(
          comp.state.temp + power * heatMult * dt * 40 - (comp.state.temp - 25) * 0.02,
          25, tempMax + 30
        );

        if (comp.state.temp > tempMax) comp.state.throttling = true;
        else comp.state.throttling = false;

        if (comp.state.temp > tempMax + 50) comp.state.burned = true;

        return {
          power, current,
          temp: comp.state.temp,
          powered,
          running: comp.state.running,
        };
      },
    };

    return def;
  }

  // ── Main ingest function ──────────────────────────────────
  async function ingest(partNumber, rawSearchResult) {
    const cacheKey = partNumber.toUpperCase();
    if (_cache.has(cacheKey)) {
      Debug.log(`[Cache] ${partNumber} loaded from cache`, 'ok');
      return _cache.get(cacheKey);
    }

    Debug.log(`[Ingest] Starting ingest for: ${partNumber}`, 'sim');

    // Step 1: Get SPICE model (background, best-effort)
    const spicePromise = fetchSpiceModel(partNumber);

    // Step 2: Prepare raw data for AI
    const rawData = rawSearchResult || { partNumber, source: 'user_input' };

    // Step 3: Add family data if known
    const familyData = findFamilyData(partNumber);
    if (familyData) {
      Debug.log(`[Family] Matched family: ${familyData.family}`, 'info');
      rawData.familyHint = familyData;
    }

    // Step 4: Wait for SPICE (with timeout)
    let spiceText = null;
    try {
      spiceText = await Promise.race([spicePromise, new Promise(r => setTimeout(() => r(null), 3000))]);
    } catch (e) {}

    // Step 5: AI parse
    const aiJson = await parseWithAI(partNumber, rawData, spiceText);

    if (!aiJson) {
      Debug.log(`[Ingest] AI parse failed — using generic fallback`, 'warn');
      return buildFallbackDef(partNumber, familyData);
    }

    const def = buildComponentDef(aiJson, partNumber);
    _cache.set(cacheKey, def);

    Debug.log(`[Ingest] ✓ ${partNumber} (${def.label}) ready — ${def.pins.length} pins, behavior: ${def._behavior}`, 'ok');
    return def;
  }

  // ── Fallback if AI unavailable ─────────────────────────────
  function buildFallbackDef(partNumber, familyData) {
    const fd = familyData || {};
    const def = {
      label: partNumber,
      shortLabel: partNumber.slice(0, 5),
      width: 60, height: 50,
      color: '#1a1a2e',
      description: fd.desc || `Imported: ${partNumber}`,
      category: 'generic',
      pins: [
        { x: 0,  y: 10, name: 'VCC', type: 'power_in' },
        { x: 0,  y: 25, name: 'GND', type: 'gnd' },
        { x: 60, y: 10, name: 'OUT', type: 'data_io' },
        { x: 60, y: 25, name: 'IN',  type: 'data_io' },
      ],
      defaults: { vcc: fd.vcc || 5, tdp_w: fd.tdp || 0.1 },
      props: ['vcc', 'tdp_w'],
      units: { vcc: 'V', tdp_w: 'W' },
      thermalCoeff: 0.05,
      physics: { vcc_nom: fd.vcc || 5, icc_active_ma: 10, temp_max_c: 85 },
      _isImported: true, _partNumber: partNumber, _behavior: 'standard_digital',
      draw(ctx, comp, sim) {
        const w = this.width, h = this.height;
        ctx.fillStyle = '#1a1a2e'; ctx.strokeStyle = '#444'; ctx.lineWidth = 1;
        ctx.fillRect(2,2,w-4,h-4); ctx.strokeRect(2,2,w-4,h-4);
        ctx.fillStyle = '#aaa'; ctx.font = '8px monospace'; ctx.textAlign = 'center';
        ctx.fillText(this.shortLabel, w/2, h/2);
        ctx.fillStyle = '#555'; ctx.font = '6px monospace';
        ctx.fillText('(fallback)', w/2, h/2+10);
        ctx.textAlign = 'left';
        this.pins.forEach(p => {
          ctx.fillStyle = '#aa7700';
          ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI*2); ctx.fill();
        });
      },
      simulate(comp, dt, voltage) {
        const powered = voltage >= (comp.props.vcc || 5) * 0.85;
        comp.state.powered = powered;
        comp.state.temp = Utils.clamp(comp.state.temp + (powered ? 0.3 : -1)*dt - (comp.state.temp-25)*0.02, 25, 120);
        return { powered, temp: comp.state.temp };
      },
    };
    return def;
  }

  // ── Register imported def into ComponentDefs ──────────────
  function register(partNumber, def) {
    const key = `imported_${partNumber.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    ComponentDefs[key] = def;
    Debug.log(`[Registry] ${partNumber} registered as "${key}"`, 'ok');
    return key;
  }

  // ── Public API ────────────────────────────────────────────
  return {
    search: searchParts,
    ingest,
    register,
    getCached: (pn) => _cache.get(pn.toUpperCase()),
    getKnownFamilies: () => Object.entries(KNOWN_FAMILIES).map(([k, v]) => ({ id: k, ...v })),
  };

})();
