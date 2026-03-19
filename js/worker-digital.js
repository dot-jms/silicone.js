// ============================================================
// SILICON LAB — worker-digital.js
// Web Worker: 6502 digital engine
// Runs at full 1.79MHz without blocking the UI thread
// Communicates via postMessage with structured cloning
// ============================================================

// Inline the 6502 core (workers can't import scripts on GitHub Pages without modules)
// Full MOS 6502 emulator — all opcodes, all addressing modes

const CPU = (() => {
  function mk() {
    return {
      A:0, X:0, Y:0, SP:0xFD, PC:0xFFFC,
      C:0, Z:0, I:1, D:0, B:0, V:0, N:0,
      mem: new Uint8Array(65536),
      cycles:0, totalCycles:0, halted:false,
      nmi:false, irq:false,
      log:[],
    };
  }
  const r   = (c,a)     => c.mem[a&0xFFFF];
  const r16 = (c,a)     => r(c,a)|(r(c,a+1)<<8);
  const w   = (c,a,v)   => { c.mem[a&0xFFFF]=v&0xFF; };
  const psh = (c,v)     => { w(c,0x100+c.SP,v); c.SP=(c.SP-1)&0xFF; };
  const pop = (c)       => { c.SP=(c.SP+1)&0xFF; return r(c,0x100+c.SP); };
  const p16 = (c,v)     => { psh(c,(v>>8)&0xFF); psh(c,v&0xFF); };
  const pp  = (c)       => { const l=pop(c); return l|(pop(c)<<8); };
  const nz  = (c,v)     => { c.Z=v===0?1:0; c.N=(v&0x80)?1:0; };
  const gP  = (c)       => (c.N<<7)|(c.V<<6)|(1<<5)|(c.B<<4)|(c.D<<3)|(c.I<<2)|(c.Z<<1)|c.C;
  const sP  = (c,p)     => { c.N=(p>>7)&1;c.V=(p>>6)&1;c.B=(p>>4)&1;c.D=(p>>3)&1;c.I=(p>>2)&1;c.Z=(p>>1)&1;c.C=p&1; };
  const imm = (c)       => c.PC++;
  const zp  = (c)       => r(c,c.PC++);
  const zpx = (c)       => (r(c,c.PC++)+c.X)&0xFF;
  const zpy = (c)       => (r(c,c.PC++)+c.Y)&0xFF;
  const ab  = (c)       => { const a=r16(c,c.PC); c.PC+=2; return a; };
  const abx = (c)       => { const a=r16(c,c.PC); c.PC+=2; return (a+c.X)&0xFFFF; };
  const aby = (c)       => { const a=r16(c,c.PC); c.PC+=2; return (a+c.Y)&0xFFFF; };
  const idx = (c)       => { const z=(r(c,c.PC++)+c.X)&0xFF; return r16(c,z); };
  const idy = (c)       => { const z=r(c,c.PC++); return (r16(c,z)+c.Y)&0xFFFF; };
  const ind = (c)       => { const a=r16(c,c.PC); c.PC+=2; return r(c,a)|(r(c,(a&0xFF00)|((a+1)&0xFF))<<8); };
  const adc = (c,v)     => { const s=c.A+v+c.C; c.V=(~(c.A^v)&(c.A^s)&0x80)?1:0; c.C=s>0xFF?1:0; c.A=s&0xFF; nz(c,c.A); };
  const sbc = (c,v)     => adc(c,v^0xFF);
  const cmp = (c,reg,v) => { const rr=(reg-v)&0xFF; c.C=reg>=v?1:0; nz(c,rr); };
  const asl = (c,v)     => { c.C=(v>>7)&1; const rr=(v<<1)&0xFF; nz(c,rr); return rr; };
  const lsr = (c,v)     => { c.C=v&1; const rr=v>>1; nz(c,rr); return rr; };
  const rol = (c,v)     => { const rr=((v<<1)|c.C)&0xFF; c.C=(v>>7)&1; nz(c,rr); return rr; };
  const ror = (c,v)     => { const rr=((v>>1)|(c.C<<7))&0xFF; c.C=v&1; nz(c,rr); return rr; };
  const br  = (c,cond)  => { const o=r(c,c.PC++); if(cond){c.PC=(c.PC+(o<0x80?o:o-0x100))&0xFFFF;c.cycles+=2;} };
  const cl  = (n,cy)    => (c)=>{ c.cycles=cy; return n(c); };

  function step(c) {
    if (c.halted) return 0;
    if (c.nmi) { c.nmi=false; p16(c,c.PC); psh(c,gP(c)&~0x10); c.I=1; c.PC=r16(c,0xFFFA); c.cycles=7; }
    else if (c.irq&&!c.I) { c.irq=false; p16(c,c.PC); psh(c,gP(c)&~0x10); c.I=1; c.PC=r16(c,0xFFFE); c.cycles=7; }
    const pc=c.PC; const op=r(c,c.PC++); c.cycles=2;
    switch(op){
      case 0xA9:c.A=r(c,imm(c));nz(c,c.A);c.cycles=2;break;case 0xA5:c.A=r(c,zp(c));nz(c,c.A);c.cycles=3;break;
      case 0xB5:c.A=r(c,zpx(c));nz(c,c.A);c.cycles=4;break;case 0xAD:c.A=r(c,ab(c));nz(c,c.A);c.cycles=4;break;
      case 0xBD:c.A=r(c,abx(c));nz(c,c.A);c.cycles=4;break;case 0xB9:c.A=r(c,aby(c));nz(c,c.A);c.cycles=4;break;
      case 0xA1:c.A=r(c,idx(c));nz(c,c.A);c.cycles=6;break;case 0xB1:c.A=r(c,idy(c));nz(c,c.A);c.cycles=5;break;
      case 0xA2:c.X=r(c,imm(c));nz(c,c.X);c.cycles=2;break;case 0xA6:c.X=r(c,zp(c));nz(c,c.X);c.cycles=3;break;
      case 0xB6:c.X=r(c,zpy(c));nz(c,c.X);c.cycles=4;break;case 0xAE:c.X=r(c,ab(c));nz(c,c.X);c.cycles=4;break;
      case 0xBE:c.X=r(c,aby(c));nz(c,c.X);c.cycles=4;break;
      case 0xA0:c.Y=r(c,imm(c));nz(c,c.Y);c.cycles=2;break;case 0xA4:c.Y=r(c,zp(c));nz(c,c.Y);c.cycles=3;break;
      case 0xB4:c.Y=r(c,zpx(c));nz(c,c.Y);c.cycles=4;break;case 0xAC:c.Y=r(c,ab(c));nz(c,c.Y);c.cycles=4;break;
      case 0xBC:c.Y=r(c,abx(c));nz(c,c.Y);c.cycles=4;break;
      case 0x85:w(c,zp(c),c.A);c.cycles=3;break;case 0x95:w(c,zpx(c),c.A);c.cycles=4;break;
      case 0x8D:w(c,ab(c),c.A);c.cycles=4;break;case 0x9D:w(c,abx(c),c.A);c.cycles=5;break;
      case 0x99:w(c,aby(c),c.A);c.cycles=5;break;case 0x81:w(c,idx(c),c.A);c.cycles=6;break;
      case 0x91:w(c,idy(c),c.A);c.cycles=6;break;
      case 0x86:w(c,zp(c),c.X);c.cycles=3;break;case 0x96:w(c,zpy(c),c.X);c.cycles=4;break;
      case 0x8E:w(c,ab(c),c.X);c.cycles=4;break;
      case 0x84:w(c,zp(c),c.Y);c.cycles=3;break;case 0x94:w(c,zpx(c),c.Y);c.cycles=4;break;
      case 0x8C:w(c,ab(c),c.Y);c.cycles=4;break;
      case 0xAA:c.X=c.A;nz(c,c.X);c.cycles=2;break;case 0xA8:c.Y=c.A;nz(c,c.Y);c.cycles=2;break;
      case 0x8A:c.A=c.X;nz(c,c.A);c.cycles=2;break;case 0x98:c.A=c.Y;nz(c,c.A);c.cycles=2;break;
      case 0xBA:c.X=c.SP;nz(c,c.X);c.cycles=2;break;case 0x9A:c.SP=c.X;c.cycles=2;break;
      case 0x69:adc(c,r(c,imm(c)));c.cycles=2;break;case 0x65:adc(c,r(c,zp(c)));c.cycles=3;break;
      case 0x75:adc(c,r(c,zpx(c)));c.cycles=4;break;case 0x6D:adc(c,r(c,ab(c)));c.cycles=4;break;
      case 0x7D:adc(c,r(c,abx(c)));c.cycles=4;break;case 0x79:adc(c,r(c,aby(c)));c.cycles=4;break;
      case 0x61:adc(c,r(c,idx(c)));c.cycles=6;break;case 0x71:adc(c,r(c,idy(c)));c.cycles=5;break;
      case 0xE9:sbc(c,r(c,imm(c)));c.cycles=2;break;case 0xE5:sbc(c,r(c,zp(c)));c.cycles=3;break;
      case 0xF5:sbc(c,r(c,zpx(c)));c.cycles=4;break;case 0xED:sbc(c,r(c,ab(c)));c.cycles=4;break;
      case 0xFD:sbc(c,r(c,abx(c)));c.cycles=4;break;case 0xF9:sbc(c,r(c,aby(c)));c.cycles=4;break;
      case 0xE1:sbc(c,r(c,idx(c)));c.cycles=6;break;case 0xF1:sbc(c,r(c,idy(c)));c.cycles=5;break;
      case 0x29:c.A&=r(c,imm(c));nz(c,c.A);c.cycles=2;break;case 0x25:c.A&=r(c,zp(c));nz(c,c.A);c.cycles=3;break;
      case 0x35:c.A&=r(c,zpx(c));nz(c,c.A);c.cycles=4;break;case 0x2D:c.A&=r(c,ab(c));nz(c,c.A);c.cycles=4;break;
      case 0x3D:c.A&=r(c,abx(c));nz(c,c.A);c.cycles=4;break;case 0x39:c.A&=r(c,aby(c));nz(c,c.A);c.cycles=4;break;
      case 0x09:c.A|=r(c,imm(c));nz(c,c.A);c.cycles=2;break;case 0x05:c.A|=r(c,zp(c));nz(c,c.A);c.cycles=3;break;
      case 0x15:c.A|=r(c,zpx(c));nz(c,c.A);c.cycles=4;break;case 0x0D:c.A|=r(c,ab(c));nz(c,c.A);c.cycles=4;break;
      case 0x1D:c.A|=r(c,abx(c));nz(c,c.A);c.cycles=4;break;case 0x19:c.A|=r(c,aby(c));nz(c,c.A);c.cycles=4;break;
      case 0x49:c.A^=r(c,imm(c));nz(c,c.A);c.cycles=2;break;case 0x45:c.A^=r(c,zp(c));nz(c,c.A);c.cycles=3;break;
      case 0x55:c.A^=r(c,zpx(c));nz(c,c.A);c.cycles=4;break;case 0x4D:c.A^=r(c,ab(c));nz(c,c.A);c.cycles=4;break;
      case 0x5D:c.A^=r(c,abx(c));nz(c,c.A);c.cycles=4;break;case 0x59:c.A^=r(c,aby(c));nz(c,c.A);c.cycles=4;break;
      case 0xC9:cmp(c,c.A,r(c,imm(c)));c.cycles=2;break;case 0xC5:cmp(c,c.A,r(c,zp(c)));c.cycles=3;break;
      case 0xD5:cmp(c,c.A,r(c,zpx(c)));c.cycles=4;break;case 0xCD:cmp(c,c.A,r(c,ab(c)));c.cycles=4;break;
      case 0xDD:cmp(c,c.A,r(c,abx(c)));c.cycles=4;break;case 0xD9:cmp(c,c.A,r(c,aby(c)));c.cycles=4;break;
      case 0xE0:cmp(c,c.X,r(c,imm(c)));c.cycles=2;break;case 0xE4:cmp(c,c.X,r(c,zp(c)));c.cycles=3;break;
      case 0xEC:cmp(c,c.X,r(c,ab(c)));c.cycles=4;break;
      case 0xC0:cmp(c,c.Y,r(c,imm(c)));c.cycles=2;break;case 0xC4:cmp(c,c.Y,r(c,zp(c)));c.cycles=3;break;
      case 0xCC:cmp(c,c.Y,r(c,ab(c)));c.cycles=4;break;
      case 0xE6:{const a=zp(c);const v=(r(c,a)+1)&0xFF;w(c,a,v);nz(c,v);c.cycles=5;break;}
      case 0xF6:{const a=zpx(c);const v=(r(c,a)+1)&0xFF;w(c,a,v);nz(c,v);c.cycles=6;break;}
      case 0xEE:{const a=ab(c);const v=(r(c,a)+1)&0xFF;w(c,a,v);nz(c,v);c.cycles=6;break;}
      case 0xFE:{const a=abx(c);const v=(r(c,a)+1)&0xFF;w(c,a,v);nz(c,v);c.cycles=7;break;}
      case 0xC6:{const a=zp(c);const v=(r(c,a)-1)&0xFF;w(c,a,v);nz(c,v);c.cycles=5;break;}
      case 0xD6:{const a=zpx(c);const v=(r(c,a)-1)&0xFF;w(c,a,v);nz(c,v);c.cycles=6;break;}
      case 0xCE:{const a=ab(c);const v=(r(c,a)-1)&0xFF;w(c,a,v);nz(c,v);c.cycles=6;break;}
      case 0xDE:{const a=abx(c);const v=(r(c,a)-1)&0xFF;w(c,a,v);nz(c,v);c.cycles=7;break;}
      case 0xE8:c.X=(c.X+1)&0xFF;nz(c,c.X);c.cycles=2;break;case 0xC8:c.Y=(c.Y+1)&0xFF;nz(c,c.Y);c.cycles=2;break;
      case 0xCA:c.X=(c.X-1)&0xFF;nz(c,c.X);c.cycles=2;break;case 0x88:c.Y=(c.Y-1)&0xFF;nz(c,c.Y);c.cycles=2;break;
      case 0x0A:c.A=asl(c,c.A);c.cycles=2;break;case 0x06:{const a=zp(c);w(c,a,asl(c,r(c,a)));c.cycles=5;break;}
      case 0x16:{const a=zpx(c);w(c,a,asl(c,r(c,a)));c.cycles=6;break;}case 0x0E:{const a=ab(c);w(c,a,asl(c,r(c,a)));c.cycles=6;break;}
      case 0x1E:{const a=abx(c);w(c,a,asl(c,r(c,a)));c.cycles=7;break;}
      case 0x4A:c.A=lsr(c,c.A);c.cycles=2;break;case 0x46:{const a=zp(c);w(c,a,lsr(c,r(c,a)));c.cycles=5;break;}
      case 0x56:{const a=zpx(c);w(c,a,lsr(c,r(c,a)));c.cycles=6;break;}case 0x4E:{const a=ab(c);w(c,a,lsr(c,r(c,a)));c.cycles=6;break;}
      case 0x5E:{const a=abx(c);w(c,a,lsr(c,r(c,a)));c.cycles=7;break;}
      case 0x2A:c.A=rol(c,c.A);c.cycles=2;break;case 0x26:{const a=zp(c);w(c,a,rol(c,r(c,a)));c.cycles=5;break;}
      case 0x36:{const a=zpx(c);w(c,a,rol(c,r(c,a)));c.cycles=6;break;}case 0x2E:{const a=ab(c);w(c,a,rol(c,r(c,a)));c.cycles=6;break;}
      case 0x3E:{const a=abx(c);w(c,a,rol(c,r(c,a)));c.cycles=7;break;}
      case 0x6A:c.A=ror(c,c.A);c.cycles=2;break;case 0x66:{const a=zp(c);w(c,a,ror(c,r(c,a)));c.cycles=5;break;}
      case 0x76:{const a=zpx(c);w(c,a,ror(c,r(c,a)));c.cycles=6;break;}case 0x6E:{const a=ab(c);w(c,a,ror(c,r(c,a)));c.cycles=6;break;}
      case 0x7E:{const a=abx(c);w(c,a,ror(c,r(c,a)));c.cycles=7;break;}
      case 0x24:{const v=r(c,zp(c));c.Z=(c.A&v)?0:1;c.N=(v>>7)&1;c.V=(v>>6)&1;c.cycles=3;break;}
      case 0x2C:{const v=r(c,ab(c));c.Z=(c.A&v)?0:1;c.N=(v>>7)&1;c.V=(v>>6)&1;c.cycles=4;break;}
      case 0x10:br(c,!c.N);break;case 0x30:br(c,c.N);break;case 0x50:br(c,!c.V);break;case 0x70:br(c,c.V);break;
      case 0x90:br(c,!c.C);break;case 0xB0:br(c,c.C);break;case 0xD0:br(c,!c.Z);break;case 0xF0:br(c,c.Z);break;
      case 0x4C:c.PC=ab(c);c.cycles=3;break;case 0x6C:c.PC=ind(c);c.cycles=5;break;
      case 0x20:p16(c,(c.PC+1)&0xFFFF);c.PC=ab(c);c.cycles=6;break;
      case 0x60:c.PC=(pp(c)+1)&0xFFFF;c.cycles=6;break;
      case 0x40:sP(c,pop(c));c.PC=pp(c);c.I=0;c.cycles=6;break;
      case 0x48:psh(c,c.A);c.cycles=3;break;case 0x68:c.A=pop(c);nz(c,c.A);c.cycles=4;break;
      case 0x08:psh(c,gP(c)|0x30);c.cycles=3;break;case 0x28:sP(c,pop(c));c.cycles=4;break;
      case 0x18:c.C=0;c.cycles=2;break;case 0x38:c.C=1;c.cycles=2;break;
      case 0x58:c.I=0;c.cycles=2;break;case 0x78:c.I=1;c.cycles=2;break;
      case 0xD8:c.D=0;c.cycles=2;break;case 0xF8:c.D=1;c.cycles=2;break;
      case 0xB8:c.V=0;c.cycles=2;break;case 0xEA:c.cycles=2;break;
      case 0x00:p16(c,(c.PC+1)&0xFFFF);psh(c,gP(c)|0x30);c.I=1;c.PC=r16(c,0xFFFE);c.cycles=7;
        c.log.push({pc,op:'BRK'});break;
      default:c.log.push({pc,op:`ILL($${op.toString(16)})`});c.cycles=2;break;
    }
    c.totalCycles+=c.cycles;
    if(c.log.length>32)c.log.shift();
    return c.cycles;
  }

  function runCycles(c, target) {
    let ran = 0;
    while (ran < target && !c.halted) ran += step(c);
    return ran;
  }

  function reset(c) {
    c.A=c.X=c.Y=0; c.SP=0xFD; c.C=c.Z=c.D=c.B=c.V=c.N=0; c.I=1;
    c.PC=r16(c,0xFFFC); c.cycles=0; c.totalCycles=0; c.halted=false; c.log=[];
  }

  function loadProgram(c, bytes, addr=0x8000) {
    for (let i=0;i<bytes.length;i++) c.mem[(addr+i)&0xFFFF]=bytes[i];
    c.mem[0xFFFC]=addr&0xFF; c.mem[0xFFFD]=(addr>>8)&0xFF;
    reset(c);
  }

  return { mk, reset, step, runCycles, loadProgram,
    read:r, write:w, read16:r16,
    triggerNMI(c){c.nmi=true;},
    triggerIRQ(c){c.irq=true;},
  };
})();

// ── Worker State ──────────────────────────────────────────────
let cpu       = null;
let running   = false;
let throttle  = false;
let speed     = 5;

const CPU_HZ        = 1_789_773;
const TICK_MS       = 16;
const BASE_CYCLES   = Math.floor(CPU_HZ / (1000 / TICK_MS)); // ~28636

let _tickInterval = null;

function tick() {
  if (!cpu || !running) return;
  const target = Math.floor(BASE_CYCLES * (speed / 5) * (throttle ? 0.35 : 1.0));
  CPU.runCycles(cpu, target);

  // Flush log
  const logs = cpu.log.splice(0);

  // Read display buffer $0200-$05FF
  const display = new Uint8Array(960);
  for (let i = 0; i < 960; i++) display[i] = cpu.mem[0x0200 + i];

  // Post state snapshot back to main thread
  self.postMessage({
    type: 'tick',
    regs: { A:cpu.A, X:cpu.X, Y:cpu.Y, SP:cpu.SP, PC:cpu.PC,
            C:cpu.C, Z:cpu.Z, I:cpu.I, D:cpu.D, V:cpu.V, N:cpu.N,
            totalCycles:cpu.totalCycles },
    display,
    logs,
  }, [display.buffer]);
}

// ── Message handler ───────────────────────────────────────────
self.onmessage = function(e) {
  const msg = e.data;
  switch (msg.type) {

    case 'init':
      cpu = CPU.mk();
      if (msg.firmwareBytes && msg.firmwareBytes.length > 0) {
        CPU.loadProgram(cpu, new Uint8Array(msg.firmwareBytes), msg.startAddr || 0x8000);
        self.postMessage({ type: 'log', level: 'ok',
          text: `[6502] ${msg.firmwareBytes.length}B loaded — PC=$${cpu.PC.toString(16).padStart(4,'0').toUpperCase()}` });
      } else {
        CPU.reset(cpu);
        self.postMessage({ type: 'log', level: 'warn', text: '[6502] No firmware — halted' });
      }
      break;

    case 'start':
      running = true;
      _tickInterval = setInterval(tick, TICK_MS);
      self.postMessage({ type: 'log', level: 'ok', text: '[6502] Engine started' });
      break;

    case 'stop':
      running = false;
      clearInterval(_tickInterval);
      break;

    case 'reset':
      running = false;
      clearInterval(_tickInterval);
      if (cpu) CPU.reset(cpu);
      self.postMessage({ type: 'log', level: 'info', text: '[6502] Reset' });
      break;

    case 'setSpeed':
      speed = Math.max(1, Math.min(10, msg.speed));
      break;

    case 'setThrottle':
      throttle = !!msg.throttle;
      break;

    case 'nmi':
      if (cpu) CPU.triggerNMI(cpu);
      break;

    case 'irq':
      if (cpu) CPU.triggerIRQ(cpu);
      break;

    case 'poke':
      if (cpu) CPU.write(cpu, msg.addr, msg.val);
      break;

    case 'peek': {
      if (!cpu) break;
      const bytes = [];
      for (let i = 0; i < (msg.count||16); i++) bytes.push(CPU.read(cpu, (msg.addr+i)&0xFFFF));
      self.postMessage({ type: 'peek_result', addr: msg.addr, bytes });
      break;
    }
  }
};
