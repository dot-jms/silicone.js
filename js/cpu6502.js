// ============================================================
// SILICON LAB — cpu6502.js
// Complete MOS 6502 CPU emulator
// Executes real 6502 machine code / assembly
// Used by the simulator's digital engine
// ============================================================

const CPU6502 = (() => {

  // ── CPU State ─────────────────────────────────────────────
  function createState() {
    return {
      // Registers
      A: 0, X: 0, Y: 0,
      SP: 0xFD,
      PC: 0xFFFC,
      // Status flags (P register)
      C: 0, Z: 0, I: 1, D: 0, B: 0, V: 0, N: 0,
      // Memory (64KB)
      mem: new Uint8Array(65536),
      // Cycle counter
      cycles: 0,
      totalCycles: 0,
      // State
      halted: false,
      nmi: false,
      irq: false,
      // Execution log (last N instructions)
      log: [],
    };
  }

  // ── Memory helpers ────────────────────────────────────────
  function read(cpu, addr) {
    return cpu.mem[addr & 0xFFFF];
  }
  function read16(cpu, addr) {
    return read(cpu, addr) | (read(cpu, addr + 1) << 8);
  }
  function write(cpu, addr, val) {
    cpu.mem[addr & 0xFFFF] = val & 0xFF;
  }

  // ── Stack helpers ─────────────────────────────────────────
  function push(cpu, val) {
    write(cpu, 0x100 + cpu.SP, val & 0xFF);
    cpu.SP = (cpu.SP - 1) & 0xFF;
  }
  function pop(cpu) {
    cpu.SP = (cpu.SP + 1) & 0xFF;
    return read(cpu, 0x100 + cpu.SP);
  }
  function push16(cpu, val) {
    push(cpu, (val >> 8) & 0xFF);
    push(cpu, val & 0xFF);
  }
  function pop16(cpu) {
    const lo = pop(cpu);
    const hi = pop(cpu);
    return lo | (hi << 8);
  }

  // ── Flags ─────────────────────────────────────────────────
  function setNZ(cpu, val) {
    cpu.Z = (val === 0) ? 1 : 0;
    cpu.N = (val & 0x80) ? 1 : 0;
  }
  function getP(cpu) {
    return (cpu.N<<7)|(cpu.V<<6)|(1<<5)|(cpu.B<<4)|(cpu.D<<3)|(cpu.I<<2)|(cpu.Z<<1)|(cpu.C);
  }
  function setP(cpu, p) {
    cpu.N=(p>>7)&1; cpu.V=(p>>6)&1; cpu.B=(p>>4)&1;
    cpu.D=(p>>3)&1; cpu.I=(p>>2)&1; cpu.Z=(p>>1)&1; cpu.C=p&1;
  }

  // ── Addressing modes ──────────────────────────────────────
  function addrImm(cpu)  { return cpu.PC++; }
  function addrZP(cpu)   { return read(cpu, cpu.PC++); }
  function addrZPX(cpu)  { return (read(cpu, cpu.PC++) + cpu.X) & 0xFF; }
  function addrZPY(cpu)  { return (read(cpu, cpu.PC++) + cpu.Y) & 0xFF; }
  function addrAbs(cpu)  { const a = read16(cpu, cpu.PC); cpu.PC += 2; return a; }
  function addrAbsX(cpu) { const a = read16(cpu, cpu.PC); cpu.PC += 2; return (a + cpu.X) & 0xFFFF; }
  function addrAbsY(cpu) { const a = read16(cpu, cpu.PC); cpu.PC += 2; return (a + cpu.Y) & 0xFFFF; }
  function addrIndX(cpu) { const z = (read(cpu, cpu.PC++) + cpu.X) & 0xFF; return read16(cpu, z); }
  function addrIndY(cpu) { const z = read(cpu, cpu.PC++); return (read16(cpu, z) + cpu.Y) & 0xFFFF; }
  function addrInd(cpu)  { const a = read16(cpu, cpu.PC); cpu.PC += 2;
    // 6502 page boundary bug
    const hi = (a & 0xFF00) | ((a + 1) & 0x00FF);
    return read(cpu, a) | (read(cpu, hi) << 8);
  }

  // ── ALU helpers ───────────────────────────────────────────
  function adc(cpu, val) {
    const sum = cpu.A + val + cpu.C;
    cpu.V = (~(cpu.A ^ val) & (cpu.A ^ sum) & 0x80) ? 1 : 0;
    cpu.C = sum > 0xFF ? 1 : 0;
    cpu.A = sum & 0xFF;
    setNZ(cpu, cpu.A);
  }
  function sbc(cpu, val) { adc(cpu, val ^ 0xFF); }
  function cmp(cpu, reg, val) {
    const r = (reg - val) & 0xFF;
    cpu.C = reg >= val ? 1 : 0;
    setNZ(cpu, r);
  }
  function asl(cpu, val) {
    cpu.C = (val >> 7) & 1;
    const r = (val << 1) & 0xFF;
    setNZ(cpu, r);
    return r;
  }
  function lsr(cpu, val) {
    cpu.C = val & 1;
    const r = val >> 1;
    setNZ(cpu, r);
    return r;
  }
  function rol(cpu, val) {
    const r = ((val << 1) | cpu.C) & 0xFF;
    cpu.C = (val >> 7) & 1;
    setNZ(cpu, r);
    return r;
  }
  function ror(cpu, val) {
    const r = ((val >> 1) | (cpu.C << 7)) & 0xFF;
    cpu.C = val & 1;
    setNZ(cpu, r);
    return r;
  }
  function branch(cpu, cond) {
    const off = read(cpu, cpu.PC++);
    if (cond) {
      cpu.PC = (cpu.PC + (off < 0x80 ? off : off - 0x100)) & 0xFFFF;
      cpu.cycles += 2;
    }
  }

  // ── Step one instruction ──────────────────────────────────
  function step(cpu) {
    if (cpu.halted) return 0;

    // NMI
    if (cpu.nmi) {
      cpu.nmi = false;
      push16(cpu, cpu.PC);
      push(cpu, getP(cpu) & ~0x10);
      cpu.I = 1;
      cpu.PC = read16(cpu, 0xFFFA);
      cpu.cycles += 7;
    }
    // IRQ
    if (cpu.irq && !cpu.I) {
      cpu.irq = false;
      push16(cpu, cpu.PC);
      push(cpu, getP(cpu) & ~0x10);
      cpu.I = 1;
      cpu.PC = read16(cpu, 0xFFFE);
      cpu.cycles += 7;
    }

    const pc = cpu.PC;
    const op = read(cpu, cpu.PC++);
    cpu.cycles = 2; // base cycles

    switch (op) {
      // ── LDA ──
      case 0xA9: cpu.A = read(cpu, addrImm(cpu));  setNZ(cpu,cpu.A); cpu.cycles=2; break;
      case 0xA5: cpu.A = read(cpu, addrZP(cpu));   setNZ(cpu,cpu.A); cpu.cycles=3; break;
      case 0xB5: cpu.A = read(cpu, addrZPX(cpu));  setNZ(cpu,cpu.A); cpu.cycles=4; break;
      case 0xAD: cpu.A = read(cpu, addrAbs(cpu));  setNZ(cpu,cpu.A); cpu.cycles=4; break;
      case 0xBD: cpu.A = read(cpu, addrAbsX(cpu)); setNZ(cpu,cpu.A); cpu.cycles=4; break;
      case 0xB9: cpu.A = read(cpu, addrAbsY(cpu)); setNZ(cpu,cpu.A); cpu.cycles=4; break;
      case 0xA1: cpu.A = read(cpu, addrIndX(cpu)); setNZ(cpu,cpu.A); cpu.cycles=6; break;
      case 0xB1: cpu.A = read(cpu, addrIndY(cpu)); setNZ(cpu,cpu.A); cpu.cycles=5; break;
      // ── LDX ──
      case 0xA2: cpu.X = read(cpu, addrImm(cpu));  setNZ(cpu,cpu.X); cpu.cycles=2; break;
      case 0xA6: cpu.X = read(cpu, addrZP(cpu));   setNZ(cpu,cpu.X); cpu.cycles=3; break;
      case 0xB6: cpu.X = read(cpu, addrZPY(cpu));  setNZ(cpu,cpu.X); cpu.cycles=4; break;
      case 0xAE: cpu.X = read(cpu, addrAbs(cpu));  setNZ(cpu,cpu.X); cpu.cycles=4; break;
      case 0xBE: cpu.X = read(cpu, addrAbsY(cpu)); setNZ(cpu,cpu.X); cpu.cycles=4; break;
      // ── LDY ──
      case 0xA0: cpu.Y = read(cpu, addrImm(cpu));  setNZ(cpu,cpu.Y); cpu.cycles=2; break;
      case 0xA4: cpu.Y = read(cpu, addrZP(cpu));   setNZ(cpu,cpu.Y); cpu.cycles=3; break;
      case 0xB4: cpu.Y = read(cpu, addrZPX(cpu));  setNZ(cpu,cpu.Y); cpu.cycles=4; break;
      case 0xAC: cpu.Y = read(cpu, addrAbs(cpu));  setNZ(cpu,cpu.Y); cpu.cycles=4; break;
      case 0xBC: cpu.Y = read(cpu, addrAbsX(cpu)); setNZ(cpu,cpu.Y); cpu.cycles=4; break;
      // ── STA ──
      case 0x85: write(cpu, addrZP(cpu),   cpu.A); cpu.cycles=3; break;
      case 0x95: write(cpu, addrZPX(cpu),  cpu.A); cpu.cycles=4; break;
      case 0x8D: write(cpu, addrAbs(cpu),  cpu.A); cpu.cycles=4; break;
      case 0x9D: write(cpu, addrAbsX(cpu), cpu.A); cpu.cycles=5; break;
      case 0x99: write(cpu, addrAbsY(cpu), cpu.A); cpu.cycles=5; break;
      case 0x81: write(cpu, addrIndX(cpu), cpu.A); cpu.cycles=6; break;
      case 0x91: write(cpu, addrIndY(cpu), cpu.A); cpu.cycles=6; break;
      // ── STX ──
      case 0x86: write(cpu, addrZP(cpu),  cpu.X); cpu.cycles=3; break;
      case 0x96: write(cpu, addrZPY(cpu), cpu.X); cpu.cycles=4; break;
      case 0x8E: write(cpu, addrAbs(cpu), cpu.X); cpu.cycles=4; break;
      // ── STY ──
      case 0x84: write(cpu, addrZP(cpu),  cpu.Y); cpu.cycles=3; break;
      case 0x94: write(cpu, addrZPX(cpu), cpu.Y); cpu.cycles=4; break;
      case 0x8C: write(cpu, addrAbs(cpu), cpu.Y); cpu.cycles=4; break;
      // ── Transfer ──
      case 0xAA: cpu.X=cpu.A; setNZ(cpu,cpu.X); cpu.cycles=2; break; // TAX
      case 0xA8: cpu.Y=cpu.A; setNZ(cpu,cpu.Y); cpu.cycles=2; break; // TAY
      case 0x8A: cpu.A=cpu.X; setNZ(cpu,cpu.A); cpu.cycles=2; break; // TXA
      case 0x98: cpu.A=cpu.Y; setNZ(cpu,cpu.A); cpu.cycles=2; break; // TYA
      case 0xBA: cpu.X=cpu.SP; setNZ(cpu,cpu.X); cpu.cycles=2; break; // TSX
      case 0x9A: cpu.SP=cpu.X; cpu.cycles=2; break; // TXS
      // ── ADC ──
      case 0x69: adc(cpu, read(cpu, addrImm(cpu)));  cpu.cycles=2; break;
      case 0x65: adc(cpu, read(cpu, addrZP(cpu)));   cpu.cycles=3; break;
      case 0x75: adc(cpu, read(cpu, addrZPX(cpu)));  cpu.cycles=4; break;
      case 0x6D: adc(cpu, read(cpu, addrAbs(cpu)));  cpu.cycles=4; break;
      case 0x7D: adc(cpu, read(cpu, addrAbsX(cpu))); cpu.cycles=4; break;
      case 0x79: adc(cpu, read(cpu, addrAbsY(cpu))); cpu.cycles=4; break;
      case 0x61: adc(cpu, read(cpu, addrIndX(cpu))); cpu.cycles=6; break;
      case 0x71: adc(cpu, read(cpu, addrIndY(cpu))); cpu.cycles=5; break;
      // ── SBC ──
      case 0xE9: sbc(cpu, read(cpu, addrImm(cpu)));  cpu.cycles=2; break;
      case 0xE5: sbc(cpu, read(cpu, addrZP(cpu)));   cpu.cycles=3; break;
      case 0xF5: sbc(cpu, read(cpu, addrZPX(cpu)));  cpu.cycles=4; break;
      case 0xED: sbc(cpu, read(cpu, addrAbs(cpu)));  cpu.cycles=4; break;
      case 0xFD: sbc(cpu, read(cpu, addrAbsX(cpu))); cpu.cycles=4; break;
      case 0xF9: sbc(cpu, read(cpu, addrAbsY(cpu))); cpu.cycles=4; break;
      case 0xE1: sbc(cpu, read(cpu, addrIndX(cpu))); cpu.cycles=6; break;
      case 0xF1: sbc(cpu, read(cpu, addrIndY(cpu))); cpu.cycles=5; break;
      // ── AND ──
      case 0x29: cpu.A&=read(cpu,addrImm(cpu));  setNZ(cpu,cpu.A); cpu.cycles=2; break;
      case 0x25: cpu.A&=read(cpu,addrZP(cpu));   setNZ(cpu,cpu.A); cpu.cycles=3; break;
      case 0x35: cpu.A&=read(cpu,addrZPX(cpu));  setNZ(cpu,cpu.A); cpu.cycles=4; break;
      case 0x2D: cpu.A&=read(cpu,addrAbs(cpu));  setNZ(cpu,cpu.A); cpu.cycles=4; break;
      case 0x3D: cpu.A&=read(cpu,addrAbsX(cpu)); setNZ(cpu,cpu.A); cpu.cycles=4; break;
      case 0x39: cpu.A&=read(cpu,addrAbsY(cpu)); setNZ(cpu,cpu.A); cpu.cycles=4; break;
      // ── ORA ──
      case 0x09: cpu.A|=read(cpu,addrImm(cpu));  setNZ(cpu,cpu.A); cpu.cycles=2; break;
      case 0x05: cpu.A|=read(cpu,addrZP(cpu));   setNZ(cpu,cpu.A); cpu.cycles=3; break;
      case 0x15: cpu.A|=read(cpu,addrZPX(cpu));  setNZ(cpu,cpu.A); cpu.cycles=4; break;
      case 0x0D: cpu.A|=read(cpu,addrAbs(cpu));  setNZ(cpu,cpu.A); cpu.cycles=4; break;
      case 0x1D: cpu.A|=read(cpu,addrAbsX(cpu)); setNZ(cpu,cpu.A); cpu.cycles=4; break;
      case 0x19: cpu.A|=read(cpu,addrAbsY(cpu)); setNZ(cpu,cpu.A); cpu.cycles=4; break;
      // ── EOR ──
      case 0x49: cpu.A^=read(cpu,addrImm(cpu));  setNZ(cpu,cpu.A); cpu.cycles=2; break;
      case 0x45: cpu.A^=read(cpu,addrZP(cpu));   setNZ(cpu,cpu.A); cpu.cycles=3; break;
      case 0x55: cpu.A^=read(cpu,addrZPX(cpu));  setNZ(cpu,cpu.A); cpu.cycles=4; break;
      case 0x4D: cpu.A^=read(cpu,addrAbs(cpu));  setNZ(cpu,cpu.A); cpu.cycles=4; break;
      case 0x5D: cpu.A^=read(cpu,addrAbsX(cpu)); setNZ(cpu,cpu.A); cpu.cycles=4; break;
      case 0x59: cpu.A^=read(cpu,addrAbsY(cpu)); setNZ(cpu,cpu.A); cpu.cycles=4; break;
      // ── CMP ──
      case 0xC9: cmp(cpu,cpu.A,read(cpu,addrImm(cpu)));  cpu.cycles=2; break;
      case 0xC5: cmp(cpu,cpu.A,read(cpu,addrZP(cpu)));   cpu.cycles=3; break;
      case 0xD5: cmp(cpu,cpu.A,read(cpu,addrZPX(cpu)));  cpu.cycles=4; break;
      case 0xCD: cmp(cpu,cpu.A,read(cpu,addrAbs(cpu)));  cpu.cycles=4; break;
      case 0xDD: cmp(cpu,cpu.A,read(cpu,addrAbsX(cpu))); cpu.cycles=4; break;
      case 0xD9: cmp(cpu,cpu.A,read(cpu,addrAbsY(cpu))); cpu.cycles=4; break;
      // ── CPX/CPY ──
      case 0xE0: cmp(cpu,cpu.X,read(cpu,addrImm(cpu))); cpu.cycles=2; break;
      case 0xE4: cmp(cpu,cpu.X,read(cpu,addrZP(cpu)));  cpu.cycles=3; break;
      case 0xEC: cmp(cpu,cpu.X,read(cpu,addrAbs(cpu))); cpu.cycles=4; break;
      case 0xC0: cmp(cpu,cpu.Y,read(cpu,addrImm(cpu))); cpu.cycles=2; break;
      case 0xC4: cmp(cpu,cpu.Y,read(cpu,addrZP(cpu)));  cpu.cycles=3; break;
      case 0xCC: cmp(cpu,cpu.Y,read(cpu,addrAbs(cpu))); cpu.cycles=4; break;
      // ── INC/DEC ──
      case 0xE6: { const a=addrZP(cpu);  const v=(read(cpu,a)+1)&0xFF; write(cpu,a,v); setNZ(cpu,v); cpu.cycles=5; break; }
      case 0xF6: { const a=addrZPX(cpu); const v=(read(cpu,a)+1)&0xFF; write(cpu,a,v); setNZ(cpu,v); cpu.cycles=6; break; }
      case 0xEE: { const a=addrAbs(cpu); const v=(read(cpu,a)+1)&0xFF; write(cpu,a,v); setNZ(cpu,v); cpu.cycles=6; break; }
      case 0xFE: { const a=addrAbsX(cpu);const v=(read(cpu,a)+1)&0xFF; write(cpu,a,v); setNZ(cpu,v); cpu.cycles=7; break; }
      case 0xC6: { const a=addrZP(cpu);  const v=(read(cpu,a)-1)&0xFF; write(cpu,a,v); setNZ(cpu,v); cpu.cycles=5; break; }
      case 0xD6: { const a=addrZPX(cpu); const v=(read(cpu,a)-1)&0xFF; write(cpu,a,v); setNZ(cpu,v); cpu.cycles=6; break; }
      case 0xCE: { const a=addrAbs(cpu); const v=(read(cpu,a)-1)&0xFF; write(cpu,a,v); setNZ(cpu,v); cpu.cycles=6; break; }
      case 0xDE: { const a=addrAbsX(cpu);const v=(read(cpu,a)-1)&0xFF; write(cpu,a,v); setNZ(cpu,v); cpu.cycles=7; break; }
      case 0xE8: cpu.X=(cpu.X+1)&0xFF; setNZ(cpu,cpu.X); cpu.cycles=2; break; // INX
      case 0xC8: cpu.Y=(cpu.Y+1)&0xFF; setNZ(cpu,cpu.Y); cpu.cycles=2; break; // INY
      case 0xCA: cpu.X=(cpu.X-1)&0xFF; setNZ(cpu,cpu.X); cpu.cycles=2; break; // DEX
      case 0x88: cpu.Y=(cpu.Y-1)&0xFF; setNZ(cpu,cpu.Y); cpu.cycles=2; break; // DEY
      // ── ASL ──
      case 0x0A: cpu.A=asl(cpu,cpu.A); cpu.cycles=2; break;
      case 0x06: { const a=addrZP(cpu);  write(cpu,a,asl(cpu,read(cpu,a))); cpu.cycles=5; break; }
      case 0x16: { const a=addrZPX(cpu); write(cpu,a,asl(cpu,read(cpu,a))); cpu.cycles=6; break; }
      case 0x0E: { const a=addrAbs(cpu); write(cpu,a,asl(cpu,read(cpu,a))); cpu.cycles=6; break; }
      case 0x1E: { const a=addrAbsX(cpu);write(cpu,a,asl(cpu,read(cpu,a))); cpu.cycles=7; break; }
      // ── LSR ──
      case 0x4A: cpu.A=lsr(cpu,cpu.A); cpu.cycles=2; break;
      case 0x46: { const a=addrZP(cpu);  write(cpu,a,lsr(cpu,read(cpu,a))); cpu.cycles=5; break; }
      case 0x56: { const a=addrZPX(cpu); write(cpu,a,lsr(cpu,read(cpu,a))); cpu.cycles=6; break; }
      case 0x4E: { const a=addrAbs(cpu); write(cpu,a,lsr(cpu,read(cpu,a))); cpu.cycles=6; break; }
      case 0x5E: { const a=addrAbsX(cpu);write(cpu,a,lsr(cpu,read(cpu,a))); cpu.cycles=7; break; }
      // ── ROL/ROR ──
      case 0x2A: cpu.A=rol(cpu,cpu.A); cpu.cycles=2; break;
      case 0x26: { const a=addrZP(cpu);  write(cpu,a,rol(cpu,read(cpu,a))); cpu.cycles=5; break; }
      case 0x36: { const a=addrZPX(cpu); write(cpu,a,rol(cpu,read(cpu,a))); cpu.cycles=6; break; }
      case 0x2E: { const a=addrAbs(cpu); write(cpu,a,rol(cpu,read(cpu,a))); cpu.cycles=6; break; }
      case 0x3E: { const a=addrAbsX(cpu);write(cpu,a,rol(cpu,read(cpu,a))); cpu.cycles=7; break; }
      case 0x6A: cpu.A=ror(cpu,cpu.A); cpu.cycles=2; break;
      case 0x66: { const a=addrZP(cpu);  write(cpu,a,ror(cpu,read(cpu,a))); cpu.cycles=5; break; }
      case 0x76: { const a=addrZPX(cpu); write(cpu,a,ror(cpu,read(cpu,a))); cpu.cycles=6; break; }
      case 0x6E: { const a=addrAbs(cpu); write(cpu,a,ror(cpu,read(cpu,a))); cpu.cycles=6; break; }
      case 0x7E: { const a=addrAbsX(cpu);write(cpu,a,ror(cpu,read(cpu,a))); cpu.cycles=7; break; }
      // ── BIT ──
      case 0x24: { const v=read(cpu,addrZP(cpu));  cpu.Z=(cpu.A&v)?0:1; cpu.N=(v>>7)&1; cpu.V=(v>>6)&1; cpu.cycles=3; break; }
      case 0x2C: { const v=read(cpu,addrAbs(cpu)); cpu.Z=(cpu.A&v)?0:1; cpu.N=(v>>7)&1; cpu.V=(v>>6)&1; cpu.cycles=4; break; }
      // ── Branches ──
      case 0x10: branch(cpu, !cpu.N); break; // BPL
      case 0x30: branch(cpu,  cpu.N); break; // BMI
      case 0x50: branch(cpu, !cpu.V); break; // BVC
      case 0x70: branch(cpu,  cpu.V); break; // BVS
      case 0x90: branch(cpu, !cpu.C); break; // BCC
      case 0xB0: branch(cpu,  cpu.C); break; // BCS
      case 0xD0: branch(cpu, !cpu.Z); break; // BNE
      case 0xF0: branch(cpu,  cpu.Z); break; // BEQ
      // ── JMP/JSR/RTS/RTI ──
      case 0x4C: cpu.PC = addrAbs(cpu); cpu.cycles=3; break;
      case 0x6C: cpu.PC = addrInd(cpu); cpu.cycles=5; break;
      case 0x20: push16(cpu, (cpu.PC + 1) & 0xFFFF); cpu.PC = addrAbs(cpu); cpu.cycles=6; break;
      case 0x60: cpu.PC = (pop16(cpu) + 1) & 0xFFFF; cpu.cycles=6; break;
      case 0x40: setP(cpu, pop(cpu)); cpu.PC = pop16(cpu); cpu.I=0; cpu.cycles=6; break;
      // ── Stack ──
      case 0x48: push(cpu, cpu.A); cpu.cycles=3; break;   // PHA
      case 0x68: cpu.A=pop(cpu); setNZ(cpu,cpu.A); cpu.cycles=4; break; // PLA
      case 0x08: push(cpu, getP(cpu)|0x30); cpu.cycles=3; break; // PHP
      case 0x28: setP(cpu, pop(cpu)); cpu.cycles=4; break; // PLP
      // ── Flags ──
      case 0x18: cpu.C=0; cpu.cycles=2; break; // CLC
      case 0x38: cpu.C=1; cpu.cycles=2; break; // SEC
      case 0x58: cpu.I=0; cpu.cycles=2; break; // CLI
      case 0x78: cpu.I=1; cpu.cycles=2; break; // SEI
      case 0xD8: cpu.D=0; cpu.cycles=2; break; // CLD
      case 0xF8: cpu.D=1; cpu.cycles=2; break; // SED
      case 0xB8: cpu.V=0; cpu.cycles=2; break; // CLV
      // ── NOP ──
      case 0xEA: cpu.cycles=2; break;
      // ── BRK ──
      case 0x00:
        push16(cpu, (cpu.PC+1)&0xFFFF);
        push(cpu, getP(cpu)|0x30);
        cpu.I=1;
        cpu.PC = read16(cpu, 0xFFFE);
        cpu.cycles=7;
        // Log BRK
        cpu.log.push({ pc, op: 'BRK', msg: 'Software interrupt' });
        break;
      default:
        // Illegal/unknown opcode — treat as NOP + log
        cpu.log.push({ pc, op: `ILL($${op.toString(16).padStart(2,'0')})`, msg: 'Illegal opcode' });
        cpu.cycles = 2;
        break;
    }

    cpu.totalCycles += cpu.cycles;

    // Keep log trimmed
    if (cpu.log.length > 20) cpu.log.shift();

    return cpu.cycles;
  }

  // ── Run N cycles ──────────────────────────────────────────
  function runCycles(cpu, targetCycles) {
    let ran = 0;
    while (ran < targetCycles && !cpu.halted) {
      ran += step(cpu);
    }
    return ran;
  }

  // ── Reset ─────────────────────────────────────────────────
  function reset(cpu) {
    cpu.A = cpu.X = cpu.Y = 0;
    cpu.SP = 0xFD;
    cpu.C = cpu.Z = cpu.D = cpu.B = cpu.V = cpu.N = 0;
    cpu.I = 1;
    cpu.PC = read16(cpu, 0xFFFC);
    cpu.cycles = 0;
    cpu.totalCycles = 0;
    cpu.halted = false;
    cpu.log = [];
  }

  // ── Simple assembler (for the firmware editor) ────────────
  // Supports: LDA/LDX/LDY/STA/STX/STY + immediate, zero page, absolute
  // ADC/SBC/AND/ORA/EOR + immediate
  // INX/INY/DEX/DEY/NOP/BRK + branches + JMP/JSR/RTS
  function assemble(source) {
    const lines = source.split('\n');
    const bytes = [];
    const labels = {};
    const patches = []; // { byteIdx, label, type: 'abs'|'rel' }

    // Two-pass assembler
    for (let pass = 0; pass < 2; pass++) {
      bytes.length = 0;
      let addr = 0;

      lines.forEach((rawLine, lineNum) => {
        const line = rawLine.replace(/;.*/, '').trim();
        if (!line) return;

        // .org directive
        if (line.startsWith('.org') || line.startsWith('ORG')) {
          const m = line.match(/[oO][rR][gG]\s+(0x[\da-fA-F]+|\$[\da-fA-F]+|\d+)/);
          if (m) addr = parseInt(m[1].replace('$','0x'));
          return;
        }

        // Label definition
        if (line.endsWith(':')) {
          if (pass === 0) labels[line.slice(0,-1).toUpperCase()] = addr;
          return;
        }

        const parts = line.split(/[\s,]+/).filter(Boolean);
        const mnem = parts[0].toUpperCase();
        const arg  = parts[1] || '';

        const emit = (...bs) => {
          if (pass === 1) bytes.push(...bs);
          addr += bs.length;
        };

        const imm = (a) => { const m = a.match(/^#(0x[\da-fA-F]+|\$[\da-fA-F]+|%[01]+|\d+)$/i); if(!m) return null; return parseInt(m[1].replace('$','0x').replace('%','0b')); };
        const zp  = (a) => { const m = a.match(/^(0x[\da-fA-F]+|\$[\da-fA-F]{1,2}|\d{1,3})$/i); if(!m) return null; return parseInt(m[1].replace('$','0x')); };
        const abs16 = (a) => { const m = a.match(/^(0x[\da-fA-F]+|\$[\da-fA-F]{3,4}|\d+)$/i); if(!m) return null; const v=parseInt(m[1].replace('$','0x')); return v > 0xFF ? v : null; };
        const labelAddr = (a) => pass===1 ? (labels[a.toUpperCase()] ?? null) : 0;

        switch (mnem) {
          case 'LDA': {
            const i=imm(arg); if(i!==null){emit(0xA9,i);break;}
            const z=zp(arg);  if(z!==null){emit(0xA5,z);break;}
            const a=abs16(arg)||labelAddr(arg); if(a!==null){emit(0xAD,a&0xFF,(a>>8)&0xFF);break;}
            break;
          }
          case 'LDX': {
            const i=imm(arg); if(i!==null){emit(0xA2,i);break;}
            const z=zp(arg);  if(z!==null){emit(0xA6,z);break;}
            const a=abs16(arg)||labelAddr(arg); if(a!==null){emit(0xAE,a&0xFF,(a>>8)&0xFF);break;}
            break;
          }
          case 'LDY': {
            const i=imm(arg); if(i!==null){emit(0xA0,i);break;}
            const z=zp(arg);  if(z!==null){emit(0xA4,z);break;}
            break;
          }
          case 'STA': {
            const z=zp(arg);  if(z!==null){emit(0x85,z);break;}
            const a=abs16(arg)||labelAddr(arg); if(a!==null){emit(0x8D,a&0xFF,(a>>8)&0xFF);break;}
            break;
          }
          case 'STX': { const z=zp(arg); if(z!==null){emit(0x86,z);break;} break; }
          case 'STY': { const z=zp(arg); if(z!==null){emit(0x84,z);break;} break; }
          case 'ADC': { const i=imm(arg); if(i!==null){emit(0x69,i);} break; }
          case 'SBC': { const i=imm(arg); if(i!==null){emit(0xE9,i);} break; }
          case 'AND': { const i=imm(arg); if(i!==null){emit(0x29,i);} break; }
          case 'ORA': { const i=imm(arg); if(i!==null){emit(0x09,i);} break; }
          case 'EOR': { const i=imm(arg); if(i!==null){emit(0x49,i);} break; }
          case 'CMP': { const i=imm(arg); if(i!==null){emit(0xC9,i);} break; }
          case 'CPX': { const i=imm(arg); if(i!==null){emit(0xE0,i);} break; }
          case 'CPY': { const i=imm(arg); if(i!==null){emit(0xC0,i);} break; }
          case 'INC': { const z=zp(arg); if(z!==null){emit(0xE6,z);break;} const a=abs16(arg); if(a!==null){emit(0xEE,a&0xFF,(a>>8)&0xFF);} break; }
          case 'DEC': { const z=zp(arg); if(z!==null){emit(0xC6,z);break;} break; }
          case 'INX': emit(0xE8); break;
          case 'INY': emit(0xC8); break;
          case 'DEX': emit(0xCA); break;
          case 'DEY': emit(0x88); break;
          case 'TAX': emit(0xAA); break;
          case 'TAY': emit(0xA8); break;
          case 'TXA': emit(0x8A); break;
          case 'TYA': emit(0x98); break;
          case 'TXS': emit(0x9A); break;
          case 'TSX': emit(0xBA); break;
          case 'PHA': emit(0x48); break;
          case 'PLA': emit(0x68); break;
          case 'PHP': emit(0x08); break;
          case 'PLP': emit(0x28); break;
          case 'CLC': emit(0x18); break;
          case 'SEC': emit(0x38); break;
          case 'CLI': emit(0x58); break;
          case 'SEI': emit(0x78); break;
          case 'CLD': emit(0xD8); break;
          case 'SED': emit(0xF8); break;
          case 'CLV': emit(0xB8); break;
          case 'NOP': emit(0xEA); break;
          case 'BRK': emit(0x00); break;
          case 'RTS': emit(0x60); break;
          case 'RTI': emit(0x40); break;
          case 'ASL': emit(0x0A); break;
          case 'LSR': emit(0x4A); break;
          case 'ROL': emit(0x2A); break;
          case 'ROR': emit(0x6A); break;
          case 'JMP': {
            const a = abs16(arg) ?? labelAddr(arg);
            if (a !== null) emit(0x4C, a&0xFF, (a>>8)&0xFF);
            break;
          }
          case 'JSR': {
            const a = abs16(arg) ?? labelAddr(arg);
            if (a !== null) emit(0x20, a&0xFF, (a>>8)&0xFF);
            break;
          }
          // Branches (relative)
          case 'BEQ': case 'BNE': case 'BCS': case 'BCC':
          case 'BMI': case 'BPL': case 'BVS': case 'BVC': {
            const ops = {BEQ:0xF0,BNE:0xD0,BCS:0xB0,BCC:0x90,BMI:0x30,BPL:0x10,BVS:0x70,BVC:0x50};
            const target = labelAddr(arg);
            if (target !== null) {
              const rel = target - (addr + 2);
              emit(ops[mnem], rel & 0xFF);
            } else {
              emit(ops[mnem], 0x00); // placeholder
            }
            break;
          }
          // .byte directive
          case '.BYTE': case 'DB': case '.DB':
            parts.slice(1).forEach(p => {
              const v = parseInt(p.replace('$','0x').replace('#',''));
              if (!isNaN(v)) emit(v & 0xFF);
            });
            break;
          case '.WORD': case 'DW': case '.DW':
            parts.slice(1).forEach(p => {
              const v = parseInt(p.replace('$','0x').replace('#',''));
              if (!isNaN(v)) { emit(v&0xFF); emit((v>>8)&0xFF); }
            });
            break;
        }
      });
    }

    return new Uint8Array(bytes);
  }

  // ── Load assembled bytes into CPU memory ──────────────────
  function loadProgram(cpu, bytes, startAddr = 0x8000) {
    for (let i = 0; i < bytes.length; i++) {
      cpu.mem[(startAddr + i) & 0xFFFF] = bytes[i];
    }
    // Set reset vector
    cpu.mem[0xFFFC] = startAddr & 0xFF;
    cpu.mem[0xFFFD] = (startAddr >> 8) & 0xFF;
    reset(cpu);
  }

  // ── Disassemble one instruction ───────────────────────────
  const MNEMONICS = {
    0xA9:'LDA#',0xA5:'LDA zp',0xAD:'LDA abs',0xB5:'LDA zp,X',0xBD:'LDA abs,X',0xB9:'LDA abs,Y',
    0xA2:'LDX#',0xA6:'LDX zp',0xAE:'LDX abs',
    0xA0:'LDY#',0xA4:'LDY zp',0xAC:'LDY abs',
    0x85:'STA zp',0x8D:'STA abs',0x95:'STA zp,X',0x9D:'STA abs,X',
    0x86:'STX zp',0x8E:'STX abs',0x84:'STY zp',0x8C:'STY abs',
    0x69:'ADC#',0xE9:'SBC#',0x29:'AND#',0x09:'ORA#',0x49:'EOR#',
    0xC9:'CMP#',0xE0:'CPX#',0xC0:'CPY#',
    0xE8:'INX',0xC8:'INY',0xCA:'DEX',0x88:'DEY',
    0xAA:'TAX',0xA8:'TAY',0x8A:'TXA',0x98:'TYA',0x9A:'TXS',0xBA:'TSX',
    0x48:'PHA',0x68:'PLA',0x08:'PHP',0x28:'PLP',
    0x18:'CLC',0x38:'SEC',0x58:'CLI',0x78:'SEI',0xD8:'CLD',0xF8:'SED',0xB8:'CLV',
    0xEA:'NOP',0x00:'BRK',0x60:'RTS',0x40:'RTI',
    0x4C:'JMP abs',0x6C:'JMP()',0x20:'JSR abs',
    0xF0:'BEQ',0xD0:'BNE',0xB0:'BCS',0x90:'BCC',0x30:'BMI',0x10:'BPL',0x70:'BVS',0x50:'BVC',
    0x0A:'ASL A',0x4A:'LSR A',0x2A:'ROL A',0x6A:'ROR A',
  };

  function disasm(cpu, addr) {
    const op = cpu.mem[addr];
    const mn = MNEMONICS[op] || `???($${op.toString(16).padStart(2,'0')})`;
    const lo = cpu.mem[(addr+1)&0xFFFF];
    const hi = cpu.mem[(addr+2)&0xFFFF];
    const abs = lo | (hi<<8);
    if (mn.includes('abs')) return `$${addr.toString(16).padStart(4,'0')}: ${mn.replace('abs','$'+abs.toString(16).padStart(4,'0'))}`;
    if (mn.includes('#'))   return `$${addr.toString(16).padStart(4,'0')}: ${mn.replace('#','#$'+lo.toString(16).padStart(2,'0'))}`;
    if (mn.includes('zp'))  return `$${addr.toString(16).padStart(4,'0')}: ${mn.replace('zp','$'+lo.toString(16).padStart(2,'0'))}`;
    if (['BEQ','BNE','BCS','BCC','BMI','BPL','BVS','BVC'].includes(mn)) {
      const target = (addr + 2 + (lo < 0x80 ? lo : lo - 0x100)) & 0xFFFF;
      return `$${addr.toString(16).padStart(4,'0')}: ${mn} $${target.toString(16).padStart(4,'0')}`;
    }
    return `$${addr.toString(16).padStart(4,'0')}: ${mn}`;
  }

  return { createState, reset, step, runCycles, loadProgram, assemble, disasm, read, write, read16 };
})();
