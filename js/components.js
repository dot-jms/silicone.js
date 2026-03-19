// ============================================================
// SILICON LAB — components.js
// Component library with physics properties
// ============================================================

const ComponentDefs = {

  resistor: {
    label: 'Resistor',
    shortLabel: 'R',
    width: 40,
    height: 20,
    color: '#c8a060',
    pins: [
      { x: 0,  y: 10, name: 'A', type: 'passive' },
      { x: 40, y: 10, name: 'B', type: 'passive' },
    ],
    defaults: { resistance: 1000, tolerance: 5, wattage: 0.25 },
    props: ['resistance', 'tolerance', 'wattage'],
    units: { resistance: 'Ω', tolerance: '%', wattage: 'W' },
    thermalCoeff: 0.001,  // heat per watt
    description: 'Fixed resistor. Limits current flow.',
    draw(ctx, c, sim) {
      const w = this.width, h = this.height;
      const hot = sim.running ? Utils.clamp((c.state.temp - 25) / 100, 0, 1) : 0;
      // body
      ctx.fillStyle = hot > 0.5 ? `hsl(${30 - hot*30}, 80%, 40%)` : '#c8a060';
      ctx.fillRect(8, 4, w-16, h-8);
      // bands
      const bandColors = ['#222', '#8b4513', '#ff8800', '#ffe033', '#00aa44'];
      const bw = 4;
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = bandColors[i % bandColors.length];
        ctx.fillRect(12 + i*6, 4, bw, h-8);
      }
      // leads
      ctx.strokeStyle = '#999';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, h/2);
      ctx.lineTo(8, h/2);
      ctx.moveTo(w-8, h/2);
      ctx.lineTo(w, h/2);
      ctx.stroke();
    },
    simulate(comp, dt, voltage) {
      const r = comp.props.resistance || 1000;
      const current = voltage / r;
      const power = current * current * r;
      const heat = power * comp.props.wattage;
      comp.state.current = current;
      comp.state.voltage = voltage;
      comp.state.power = power;
      comp.state.temp = Utils.clamp(comp.state.temp + heat * dt * 50 - (comp.state.temp - 25) * 0.01, 25, 500);
      if (comp.state.temp > 200) comp.state.burned = true;
      return { current, power, temp: comp.state.temp };
    },
  },

  capacitor: {
    label: 'Capacitor',
    shortLabel: 'C',
    width: 30,
    height: 30,
    color: '#4499ff',
    pins: [
      { x: 0,  y: 15, name: '+', type: 'passive' },
      { x: 30, y: 15, name: '-', type: 'passive' },
    ],
    defaults: { capacitance: 100e-6, voltage_rating: 16, esr: 0.1 },
    props: ['capacitance', 'voltage_rating', 'esr'],
    units: { capacitance: 'F', voltage_rating: 'V', esr: 'Ω' },
    thermalCoeff: 0.002,
    description: 'Electrolytic capacitor. Stores charge, filters noise.',
    draw(ctx, c, sim) {
      const w = this.width, h = this.height;
      const vc = sim.running ? (c.state.voltage || 0) : 0;
      const rated = c.props.voltage_rating || 16;
      const hot = Utils.clamp(vc / rated, 0, 1);
      // cylinder body
      ctx.fillStyle = hot > 0.9 ? '#ff3333' : (hot > 0.7 ? '#ff8800' : '#334466');
      ctx.beginPath();
      ctx.ellipse(w/2, 6, w/2-2, 5, 0, 0, Math.PI*2);
      ctx.fill();
      ctx.fillRect(2, 6, w-4, h-12);
      ctx.fillStyle = '#222';
      ctx.fillRect(2, h-6, w-4, 6);
      // + - marks
      ctx.fillStyle = '#fff';
      ctx.font = '8px monospace';
      ctx.fillText('+', 4, 16);
      // leads
      ctx.strokeStyle = '#999';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, h/2);
      ctx.lineTo(2, h/2);
      ctx.moveTo(w-2, h/2);
      ctx.lineTo(w, h/2);
      ctx.stroke();
    },
    simulate(comp, dt, voltage) {
      const C = comp.props.capacitance || 100e-6;
      const rated = comp.props.voltage_rating || 16;
      comp.state.voltage = Utils.lerp(comp.state.voltage || 0, voltage, Utils.clamp(dt / (C * 10), 0, 0.5));
      comp.state.temp = Utils.clamp(comp.state.temp + 0.001 - (comp.state.temp - 25) * 0.005, 25, 200);
      if (comp.state.voltage > rated * 1.2) comp.state.burned = true;
      return { voltage: comp.state.voltage, temp: comp.state.temp };
    },
  },

  led: {
    label: 'LED',
    shortLabel: 'D',
    width: 28,
    height: 22,
    color: '#ff3399',
    pins: [
      { x: 0,  y: 11, name: 'A', type: 'passive' },  // anode
      { x: 28, y: 11, name: 'K', type: 'passive' },  // cathode
    ],
    defaults: { forward_voltage: 2.0, max_current: 20e-3, color: 'red' },
    props: ['forward_voltage', 'max_current', 'color'],
    units: { forward_voltage: 'V', max_current: 'A', color: '' },
    thermalCoeff: 0.005,
    description: 'Light-emitting diode.',
    draw(ctx, c, sim) {
      const w = this.width, h = this.height;
      const on = sim.running && (c.state.current || 0) > 0.001;
      const ledColors = { red:'#ff3333', green:'#00ff44', blue:'#4499ff', yellow:'#ffe033', white:'#eeeeff' };
      const col = ledColors[c.props.color] || '#ff3333';
      // glow
      if (on) {
        ctx.shadowColor = col;
        ctx.shadowBlur = 12;
      }
      // triangle body
      ctx.fillStyle = on ? col : '#444';
      ctx.beginPath();
      ctx.moveTo(6, 2);
      ctx.lineTo(22, h/2);
      ctx.lineTo(6, h-2);
      ctx.closePath();
      ctx.fill();
      // cathode bar
      ctx.fillStyle = '#aaa';
      ctx.fillRect(22, 2, 2, h-4);
      ctx.shadowBlur = 0;
      // leads
      ctx.strokeStyle = '#999';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, h/2); ctx.lineTo(6, h/2);
      ctx.moveTo(24, h/2); ctx.lineTo(w, h/2);
      ctx.stroke();
    },
    simulate(comp, dt, voltage) {
      const vf = comp.props.forward_voltage || 2.0;
      const max_i = comp.props.max_current || 0.02;
      if (voltage > vf) {
        const current = Utils.clamp((voltage - vf) / 50, 0, max_i * 2);
        comp.state.current = current;
        comp.state.lit = current > 0.001;
        comp.state.temp = Utils.clamp(comp.state.temp + current * 10 * dt - (comp.state.temp - 25) * 0.02, 25, 150);
        if (current > max_i * 1.5) comp.state.burned = true;
      } else {
        comp.state.current = 0;
        comp.state.lit = false;
        comp.state.temp = Utils.clamp(comp.state.temp - 1 * dt, 25, 150);
      }
      return { current: comp.state.current, temp: comp.state.temp };
    },
  },

  cpu: {
    label: 'CPU',
    shortLabel: 'CPU',
    width: 80,
    height: 80,
    color: '#222',
    pins: [
      { x: 0,  y: 20, name: 'VCC',  type: 'power_in' },
      { x: 0,  y: 40, name: 'GND',  type: 'gnd' },
      { x: 0,  y: 60, name: 'DATA', type: 'data_io' },
      { x: 80, y: 20, name: 'CLK',  type: 'clock_in' },
      { x: 80, y: 40, name: 'ADDR', type: 'data_io' },
      { x: 80, y: 60, name: 'RST',  type: 'control' },
      { x: 20, y: 0,  name: 'MISO', type: 'data_io' },
      { x: 60, y: 0,  name: 'MOSI', type: 'data_io' },
      { x: 40, y: 80, name: 'INT',  type: 'control' },
    ],
    defaults: { tdp: 15, vcore: 1.8, clock_mhz: 100, cores: 1 },
    props: ['tdp', 'vcore', 'clock_mhz', 'cores'],
    units: { tdp: 'W', vcore: 'V', clock_mhz: 'MHz', cores: '' },
    thermalCoeff: 0.5,
    description: 'Central Processing Unit. Executes firmware code.',
    draw(ctx, c, sim) {
      const w = this.width, h = this.height;
      const hot = sim.running ? Utils.clamp((c.state.temp - 25) / 80, 0, 1) : 0;
      // die package
      ctx.fillStyle = `hsl(${hot > 0.5 ? 20 : 200}, ${hot*60}%, ${10 + hot*10}%)`;
      ctx.strokeStyle = '#444';
      ctx.lineWidth = 1;
      ctx.fillRect(2, 2, w-4, h-4);
      ctx.strokeRect(2, 2, w-4, h-4);
      // die mark
      ctx.fillStyle = '#aaa';
      ctx.font = 'bold 9px Orbitron, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('CPU', w/2, h/2 - 4);
      ctx.font = '7px monospace';
      ctx.fillStyle = '#666';
      ctx.fillText(`${c.props.clock_mhz}MHz`, w/2, h/2 + 8);
      // activity indicator
      if (sim.running && c.state.running) {
        ctx.fillStyle = `rgba(0,255,136,${0.3 + Math.sin(Date.now()*0.01)*0.2})`;
        ctx.fillRect(w-14, 4, 8, 8);
      }
      // pin dots
      ctx.fillStyle = '#cc9922';
      this.pins.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI*2);
        ctx.fill();
      });
      ctx.textAlign = 'left';
    },
    simulate(comp, dt, voltage) {
      const tdp = comp.props.tdp || 15;
      const vcore = comp.props.vcore || 1.8;
      if (voltage >= vcore * 0.9) {
        comp.state.running = true;
        comp.state.temp = Utils.clamp(comp.state.temp + tdp * dt * 2 - (comp.state.temp - 25) * 0.02, 25, 120);
        comp.state.pc = ((comp.state.pc || 0) + 1) % 0xFFFF;
        comp.state.voltage = voltage;
      } else {
        comp.state.running = false;
        comp.state.temp = Utils.clamp(comp.state.temp - 5 * dt, 25, 120);
      }
      if (comp.state.temp > 105) comp.state.throttling = true;
      else comp.state.throttling = false;
      return { temp: comp.state.temp, running: comp.state.running };
    },
  },

  ram: {
    label: 'RAM',
    shortLabel: 'RAM',
    width: 80,
    height: 35,
    color: '#114',
    pins: [
      { x: 0,  y: 10, name: 'VCC',  type: 'power_in' },
      { x: 0,  y: 25, name: 'GND',  type: 'gnd' },
      { x: 80, y: 10, name: 'DATA', type: 'data_io' },
      { x: 80, y: 25, name: 'CLK',  type: 'clock_in' },
      { x: 20, y: 0,  name: 'CS',   type: 'control' },
      { x: 60, y: 0,  name: 'WE',   type: 'control' },
    ],
    defaults: { capacity_mb: 256, voltage: 3.3, speed_mhz: 200, tdp: 3 },
    props: ['capacity_mb', 'voltage', 'speed_mhz', 'tdp'],
    units: { capacity_mb: 'MB', voltage: 'V', speed_mhz: 'MHz', tdp: 'W' },
    thermalCoeff: 0.1,
    description: 'Random Access Memory. Stores program data.',
    draw(ctx, c, sim) {
      const w = this.width, h = this.height;
      ctx.fillStyle = '#111';
      ctx.fillRect(2, 2, w-4, h-4);
      // chips on stick
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = '#222';
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 0.5;
        ctx.fillRect(5 + i*18, 5, 14, h-10);
        ctx.strokeRect(5 + i*18, 5, 14, h-10);
        ctx.fillStyle = '#333';
        ctx.font = '5px monospace';
        ctx.fillText('IC', 8 + i*18, h/2+1);
      }
      ctx.fillStyle = '#4499ff';
      ctx.font = '7px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${c.props.capacity_mb}MB RAM`, w/2, h-2);
      ctx.textAlign = 'left';
      // notch
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(w/2, h-2, 3, Math.PI, 0);
      ctx.fill();
      // activity
      if (sim.running && c.state.active) {
        ctx.fillStyle = `rgba(68,153,255,${0.4 + Math.random()*0.3})`;
        ctx.fillRect(2, 2, 4, 4);
      }
    },
    simulate(comp, dt, voltage) {
      const tdp = comp.props.tdp || 3;
      if (voltage >= (comp.props.voltage || 3.3) * 0.85) {
        comp.state.active = Math.random() > 0.3;
        comp.state.temp = Utils.clamp(comp.state.temp + tdp * dt - (comp.state.temp - 25) * 0.03, 25, 80);
      } else {
        comp.state.active = false;
        comp.state.temp = Utils.clamp(comp.state.temp - 3*dt, 25, 80);
      }
      return { temp: comp.state.temp };
    },
  },

  gpu: {
    label: 'GPU',
    shortLabel: 'GPU',
    width: 100,
    height: 90,
    color: '#1a0022',
    pins: [
      { x: 0,  y: 20, name: 'VCC',   type: 'power_in' },
      { x: 0,  y: 45, name: 'GND',   type: 'gnd' },
      { x: 0,  y: 70, name: 'DATA',  type: 'data_io' },
      { x: 100, y: 20, name: 'CLK',  type: 'clock_in' },
      { x: 100, y: 45, name: 'HDMI', type: 'data_io' },
      { x: 100, y: 70, name: 'RST',  type: 'control' },
      { x: 30, y: 0,  name: 'VRAM+', type: 'data_io' },
      { x: 70, y: 0,  name: 'VRAM-', type: 'data_io' },
    ],
    defaults: { tdp: 80, vcore: 1.1, clock_mhz: 800, vram_mb: 512 },
    props: ['tdp', 'vcore', 'clock_mhz', 'vram_mb'],
    units: { tdp: 'W', vcore: 'V', clock_mhz: 'MHz', vram_mb: 'MB' },
    thermalCoeff: 1.5,
    description: 'Graphics Processing Unit. High-power parallel processor.',
    draw(ctx, c, sim) {
      const w = this.width, h = this.height;
      const hot = sim.running ? Utils.clamp((c.state.temp - 25) / 80, 0, 1) : 0;
      ctx.fillStyle = `hsl(${280 - hot*280}, 50%, ${8 + hot*15}%)`;
      ctx.strokeStyle = '#553399';
      ctx.lineWidth = 1.5;
      ctx.fillRect(2, 2, w-4, h-4);
      ctx.strokeRect(2, 2, w-4, h-4);
      // shaders
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          ctx.fillStyle = `rgba(${100+hot*100},${50},${200-hot*150},${0.5+Math.random()*0.2})`;
          ctx.fillRect(8 + i*30, 10 + j*22, 22, 14);
        }
      }
      ctx.fillStyle = '#cc88ff';
      ctx.font = 'bold 9px Orbitron, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('GPU', w/2, h-10);
      ctx.font = '6px monospace';
      ctx.fillStyle = '#8844aa';
      ctx.fillText(`${c.props.vram_mb}MB VRAM`, w/2, h-2);
      ctx.textAlign = 'left';
      this.pins.forEach(p => {
        ctx.fillStyle = '#cc8800';
        ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI*2); ctx.fill();
      });
    },
    simulate(comp, dt, voltage) {
      const tdp = comp.props.tdp || 80;
      const vcore = comp.props.vcore || 1.1;
      if (voltage >= vcore * 0.85) {
        comp.state.running = true;
        comp.state.temp = Utils.clamp(comp.state.temp + tdp * dt * 1.5 - (comp.state.temp - 25) * 0.015, 25, 110);
        comp.state.voltage = voltage;
      } else {
        comp.state.running = false;
        comp.state.temp = Utils.clamp(comp.state.temp - 3*dt, 25, 110);
      }
      if (comp.state.temp > 95) comp.state.throttling = true;
      else comp.state.throttling = false;
      return { temp: comp.state.temp, running: comp.state.running };
    },
  },

  power: {
    label: 'Power Regulator',
    shortLabel: 'VReg',
    width: 50,
    height: 30,
    color: '#220000',
    pins: [
      { x: 0,  y: 10, name: 'VIN',  type: 'power_in' },
      { x: 0,  y: 25, name: 'GND',  type: 'gnd' },
      { x: 50, y: 10, name: 'VOUT', type: 'power_out' },
      { x: 50, y: 25, name: 'EN',   type: 'control' },
    ],
    defaults: { vin: 12, vout: 3.3, max_current: 3, efficiency: 0.90 },
    props: ['vin', 'vout', 'max_current', 'efficiency'],
    units: { vin: 'V', vout: 'V', max_current: 'A', efficiency: '' },
    thermalCoeff: 0.3,
    description: 'Voltage regulator / DC-DC converter.',
    draw(ctx, c, sim) {
      const w = this.width, h = this.height;
      const on = sim.running && c.state.outputting;
      ctx.fillStyle = on ? '#330000' : '#1a0000';
      ctx.strokeStyle = on ? '#ff4400' : '#441100';
      ctx.lineWidth = 1;
      ctx.fillRect(2, 2, w-4, h-4);
      ctx.strokeRect(2, 2, w-4, h-4);
      ctx.fillStyle = on ? '#ff6633' : '#884422';
      ctx.font = '8px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('VREG', w/2, 14);
      ctx.fillStyle = '#cc4400';
      ctx.font = '7px monospace';
      ctx.fillText(`${c.props.vout}V`, w/2, h-4);
      ctx.textAlign = 'left';
      if (on) {
        ctx.fillStyle = 'rgba(255,68,0,0.15)';
        ctx.fillRect(2, 2, w-4, h-4);
      }
    },
    simulate(comp, dt, voltage) {
      if (voltage >= (comp.props.vin || 12) * 0.8) {
        comp.state.outputting = true;
        comp.state.output_voltage = comp.props.vout || 3.3;
        const loss = comp.state.output_voltage * comp.props.max_current * (1 - (comp.props.efficiency || 0.9));
        comp.state.temp = Utils.clamp(comp.state.temp + loss * dt * 3 - (comp.state.temp - 25) * 0.025, 25, 130);
      } else {
        comp.state.outputting = false;
        comp.state.output_voltage = 0;
        comp.state.temp = Utils.clamp(comp.state.temp - 2*dt, 25, 130);
      }
      return { output_voltage: comp.state.output_voltage, temp: comp.state.temp };
    },
  },

  crystal: {
    label: 'Crystal Oscillator',
    shortLabel: 'XTAL',
    width: 30,
    height: 20,
    color: '#444',
    pins: [
      { x: 0,  y: 10, name: 'A', type: 'clock_out' },
      { x: 30, y: 10, name: 'B', type: 'clock_out' },
    ],
    defaults: { frequency_mhz: 16, load_cap_pf: 18 },
    props: ['frequency_mhz', 'load_cap_pf'],
    units: { frequency_mhz: 'MHz', load_cap_pf: 'pF' },
    thermalCoeff: 0.01,
    description: 'Quartz crystal oscillator. Provides clock signal.',
    draw(ctx, c, sim) {
      const w = this.width, h = this.height;
      const osc = sim.running && Math.sin(Date.now() * 0.05 * (c.props.frequency_mhz || 16)) > 0;
      ctx.fillStyle = '#333';
      ctx.strokeStyle = osc ? '#00ffcc' : '#555';
      ctx.lineWidth = 1.5;
      ctx.fillRect(5, 2, w-10, h-4);
      ctx.strokeRect(5, 2, w-10, h-4);
      ctx.fillStyle = osc ? '#00ffcc' : '#888';
      ctx.font = '6px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${c.props.frequency_mhz}M`, w/2, h/2+2);
      ctx.textAlign = 'left';
      ctx.strokeStyle = '#999';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, h/2); ctx.lineTo(5, h/2);
      ctx.moveTo(w-5, h/2); ctx.lineTo(w, h/2);
      ctx.stroke();
    },
    simulate(comp, dt, voltage) {
      comp.state.oscillating = voltage > 1.5;
      comp.state.frequency = comp.props.frequency_mhz * 1e6;
      comp.state.temp = 25 + (comp.state.oscillating ? 5 : 0);
      return { oscillating: comp.state.oscillating };
    },
  },

  transistor: {
    label: 'NPN Transistor',
    shortLabel: 'Q',
    width: 30,
    height: 40,
    color: '#333',
    pins: [
      { x: 0,  y: 10, name: 'B',  type: 'passive' },
      { x: 15, y: 0,  name: 'C',  type: 'passive' },
      { x: 15, y: 40, name: 'E',  type: 'passive' },
    ],
    defaults: { hfe: 100, vce_sat: 0.2, ic_max: 0.6 },
    props: ['hfe', 'vce_sat', 'ic_max'],
    units: { hfe: '', vce_sat: 'V', ic_max: 'A' },
    thermalCoeff: 0.05,
    description: 'NPN bipolar junction transistor. Current amplifier / switch.',
    draw(ctx, c, sim) {
      const w = this.width, h = this.height;
      const on = sim.running && c.state.on;
      ctx.strokeStyle = on ? '#00ff88' : '#888';
      ctx.lineWidth = 1.5;
      // base lead
      ctx.beginPath(); ctx.moveTo(0, 10); ctx.lineTo(10, 10); ctx.stroke();
      // collector
      ctx.beginPath(); ctx.moveTo(15, 0); ctx.lineTo(15, 15);
      ctx.moveTo(10, 10); ctx.lineTo(15, 15); ctx.stroke();
      // emitter
      ctx.beginPath(); ctx.moveTo(15, 40); ctx.lineTo(15, 25);
      ctx.moveTo(10, 10); ctx.lineTo(15, 25); ctx.stroke();
      // arrow on emitter
      ctx.fillStyle = on ? '#00ff88' : '#888';
      ctx.beginPath();
      ctx.moveTo(15, 30); ctx.lineTo(18, 25); ctx.lineTo(12, 25);
      ctx.fill();
      // body circle
      ctx.strokeStyle = on ? '#00ff88' : '#666';
      ctx.beginPath(); ctx.arc(15, 18, 12, 0, Math.PI*2); ctx.stroke();
    },
    simulate(comp, dt, voltage) {
      const hfe = comp.props.hfe || 100;
      const ib = voltage > 0.7 ? (voltage - 0.7) / 1000 : 0;
      comp.state.on = ib > 0.0001;
      comp.state.ic = Utils.clamp(ib * hfe, 0, comp.props.ic_max || 0.6);
      comp.state.temp = Utils.clamp(comp.state.temp + comp.state.ic * dt - (comp.state.temp - 25) * 0.05, 25, 150);
      return { ic: comp.state.ic, on: comp.state.on, temp: comp.state.temp };
    },
  },

  chip: {
    label: 'Logic IC',
    shortLabel: 'IC',
    width: 50,
    height: 50,
    color: '#1a1a2e',
    pins: [
      { x: 0,   y: 12, name: 'A0',  type: 'data_io' },
      { x: 0,   y: 24, name: 'A1',  type: 'data_io' },
      { x: 0,   y: 36, name: 'VCC', type: 'power_in' },
      { x: 50,  y: 12, name: 'Y0',  type: 'data_io' },
      { x: 50,  y: 24, name: 'Y1',  type: 'data_io' },
      { x: 50,  y: 36, name: 'GND', type: 'gnd' },
      { x: 12,  y: 0,  name: 'OE',  type: 'control' },
      { x: 38,  y: 50, name: 'CLK', type: 'clock_in' },
    ],
    defaults: { function: 'NAND', logic_family: 'CMOS', vcc: 5.0, propagation_ns: 5 },
    props: ['function', 'logic_family', 'vcc', 'propagation_ns'],
    units: { function: '', logic_family: '', vcc: 'V', propagation_ns: 'ns' },
    thermalCoeff: 0.05,
    description: 'Generic logic IC (NAND, NOR, XOR, etc.)',
    draw(ctx, c, sim) {
      const w = this.width, h = this.height;
      ctx.fillStyle = '#111';
      ctx.strokeStyle = '#444';
      ctx.lineWidth = 1;
      ctx.fillRect(2, 2, w-4, h-4);
      ctx.strokeRect(2, 2, w-4, h-4);
      // pin 1 marker
      ctx.fillStyle = '#666';
      ctx.beginPath();
      ctx.arc(6, h-6, 3, 0, Math.PI*2);
      ctx.fill();
      ctx.fillStyle = '#99aaff';
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(c.props.function || 'IC', w/2, h/2+3);
      ctx.font = '6px monospace';
      ctx.fillStyle = '#5566aa';
      ctx.fillText(c.props.logic_family || 'CMOS', w/2, h/2+12);
      ctx.textAlign = 'left';
      this.pins.forEach(p => {
        ctx.fillStyle = '#cc9922';
        ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI*2); ctx.fill();
      });
    },
    simulate(comp, dt, voltage) {
      comp.state.powered = voltage >= (comp.props.vcc || 5) * 0.85;
      comp.state.temp = Utils.clamp(comp.state.temp + (comp.state.powered ? 0.3 : 0)*dt - (comp.state.temp-25)*0.05, 25, 85);
      return { powered: comp.state.powered, temp: comp.state.temp };
    },
  },
};

// Create a component instance
function createComponent(type, x, y) {
  const def = ComponentDefs[type];
  if (!def) throw new Error(`Unknown component type: ${type}`);

  return {
    id: Utils.uid(def.shortLabel),
    type,
    x,
    y,
    props: { ...def.defaults },
    state: {
      temp: 25,
      voltage: 0,
      current: 0,
      power: 0,
      burned: false,
      running: false,
    },
    nets: {},           // pin name → net id
    label: def.label,
    rotation: 0,
  };
}
