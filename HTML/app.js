/* eslint-disable */
/*
 * Porting esatto di InterferometerStabilizer_GUI_Py.py in HTML/JavaScript.
 * - PyQt5 -> DOM
 * - matplotlib -> Canvas 2D (helper plotLines/plotPoints)
 * - pyserial -> Web Serial API (navigator.serial)
 * - JSON file pid_config -> localStorage chiave 'pid_config'
 * - queue.Queue + QThread SerialReader -> lineQueue + async readLoop()
 * - QThreadPool + Worker -> async functions
 * - QtCore.QInputDialog.getDouble -> window.prompt
 * - QFileDialog/np.savez -> Blob + URL download (.json)
 */

// =====================================================================
// ============== FakeSerial (stessa logica del Python) ================
// =====================================================================
class FakeSerial {
  constructor() {
    this.in_waiting = 1;
    this.is_open = true;
  }
  // Genera una riga simulata "I1,I2,Q1,Q2,Delta,V"
  readline() {
    const I1 = randn();
    const I2 = randn();
    const Q1 = randn();
    const Q2 = randn();
    const Delta = randn() * 0.1;
    const V = Math.random();
    return new TextEncoder().encode(`${I1},${I2},${Q1},${Q2},${Delta},${V}\n`);
  }
  write(_data) {}
  close() { this.is_open = false; }
}

function randn() {
  // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// =====================================================================
// =============== SerialReader (QThread -> async loop) ================
// =====================================================================
class SerialReader {
  constructor(serPort, lineQueue, onMonitorBlock, onError) {
    this.ser = serPort;        // { port, reader, writer } o FakeSerial
    this.queue = lineQueue;    // array usato come coda
    this.onMonitorBlock = onMonitorBlock;
    this.onError = onError;
    this._running = true;
    this.is_monitoring = false;
    this._task = null;
    this._buf = '';
  }

  start() {
    this._task = this._run();
  }

  async _run() {
    const block_size = 500;
    let monitor_block = [];
    try {
      while (this._running) {
        let line = await this._readLine();
        if (line === null) break;
        if (line === '') continue;

        if (line.startsWith('M,')) {
          monitor_block.push(line);
          if (monitor_block.length >= block_size) {
            this.onMonitorBlock(monitor_block.slice());
            monitor_block = [];
          }
        } else {
          // Linea normale, accodata
          if (this.queue.length >= 10000) {
            this.queue.shift(); // drop più vecchio
          }
          this.queue.push(line);
        }
      }
    } catch (e) {
      this.onError(String(e));
    }
  }

  async _readLine() {
    // FakeSerial path
    if (this.ser instanceof FakeSerial) {
      await sleep(1);
      const raw = this.ser.readline();
      return new TextDecoder().decode(raw).trim();
    }
    // Web Serial path: legge dal reader fino a trovare '\n'
    while (this._running) {
      const nlIdx = this._buf.indexOf('\n');
      if (nlIdx >= 0) {
        const line = this._buf.substring(0, nlIdx).replace(/\r$/, '');
        this._buf = this._buf.substring(nlIdx + 1);
        return line.trim();
      }
      try {
        const { value, done } = await this.ser.reader.read();
        if (done) return null;
        if (value) this._buf += value;
      } catch (e) {
        this.onError(`Serial read error: ${e}`);
        return null;
      }
    }
    return null;
  }

  async stop() {
    this._running = false;
    try { if (this.ser && this.ser.reader) await this.ser.reader.cancel(); } catch (e) {}
    if (this._task) {
      try { await this._task; } catch (e) {}
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// =====================================================================
// ============================ MainWindow =============================
// =====================================================================
class MainWindow {
  constructor() {
    // Serial
    this.ser = null;       // FakeSerial oppure { port, reader, writer, is_open }
    this.reader = null;
    this.lineQueue = [];   // FIFO di stringhe (max 10000)

    // Data
    this.latestData = null;
    this.stop_flag = false;
    this.is_monitoring = false;

    // Config persistence
    this.config_key = 'pid_config'; // localStorage

    // Plot Z buffer (monitor scope)
    this.monitor_buffer_size = 250;
    this.monitor_z = new Float32Array(this.monitor_buffer_size);
    this.monitor_ylim = [0, 1023];

    this._buildBindings();
    this.loadParameters();
  }

  // ---------- utility: logging ----------
  log(txt) {
    const t = new Date().toTimeString().substring(0, 8);
    const s = `[${t}] ${txt}`;
    const ta = document.getElementById('log_area');
    ta.value += (ta.value ? '\n' : '') + s;
    ta.scrollTop = ta.scrollHeight;
    console.log(s);
  }

  // ---------- DOM bindings ----------
  _buildBindings() {
    const $ = id => document.getElementById(id);

    $('connect_btn').addEventListener('click', () => this.connectSerial());
    $('disconnect_btn').addEventListener('click', () => this.disconnectSerial());

    $('setP_btn').addEventListener('click', () => this.setParam('P'));
    $('setI_btn').addEventListener('click', () => this.setParam('I'));
    $('setD_btn').addEventListener('click', () => this.setParam('D'));
    $('setO_btn').addEventListener('click', () => this.setParam('O'));
    $('setA_btn').addEventListener('click', () => this.setParam('A'));
    $('setT_btn').addEventListener('click', () => this.setParam('T'));

    $('send_pga_btn').addEventListener('click', () => this.sendPga());

    $('print_btn').addEventListener('click', () => this.printOnceTask());
    $('calibrate_btn').addEventListener('click', () => this.calibrateTask());
    $('start_acq_btn').addEventListener('click', () => this.startAcquisitionTask());
    $('stop_acq_btn').addEventListener('click', () => this.stopAcquisitionRequest());
    $('reset_btn').addEventListener('click', () => this.simpleCmd('RESET'));
    $('analyze_btn').addEventListener('click', () => this.runAnalysisNow());

    $('pid_combo').addEventListener('change', e => this.togglePid(e.target.selectedIndex));
    $('mode_combo').addEventListener('change', e => this.changeMode(e.target.selectedIndex));

    $('monitor_btn').addEventListener('click', () => this.toggleMonitor());
    $('monitor_close_btn').addEventListener('click', () => this.hideMonitor());

    $('save_params_btn').addEventListener('click', () => this.saveParameters());
    $('load_params_btn').addEventListener('click', () => this.loadParameters());
    $('send_all_params_btn').addEventListener('click', () => this.sendAllParametersTask());

    $('samples_spin').addEventListener('change', () => this.sendNumSamples());

    $('analysis_close_btn').addEventListener('click', () => {
      document.getElementById('analysis_dialog').classList.add('hidden');
    });
  }

  // ---------- connect / disconnect ----------
  async connectSerial() {
    const baud = parseInt(document.getElementById('baud_spin').value);
    try {
      // Tenta Web Serial; in caso di errore -> FakeSerial (modalità simulazione)
      if (!('serial' in navigator)) {
        throw new Error('Web Serial API non disponibile');
      }
      let port;
      try {
        port = await navigator.serial.requestPort();
        await port.open({ baudRate: baud });
      } catch (e) {
        throw e;
      }

      const textDecoder = new TextDecoderStream();
      const readableClosed = port.readable.pipeTo(textDecoder.writable);
      const reader = textDecoder.readable.getReader();

      const textEncoder = new TextEncoderStream();
      const writableClosed = textEncoder.readable.pipeTo(port.writable);
      const writer = textEncoder.writable.getWriter();

      this.ser = {
        port,
        reader,
        writer,
        readableClosed,
        writableClosed,
        is_open: true,
        async write(data) {
          // accetta Uint8Array o stringa
          if (data instanceof Uint8Array) {
            await this.writer.write(new TextDecoder().decode(data));
          } else {
            await this.writer.write(data);
          }
        },
        async close() {
          this.is_open = false;
          try { await this.reader.cancel(); } catch (e) {}
          try { await this.writer.close(); } catch (e) {}
          try { await this.readableClosed.catch(() => {}); } catch (e) {}
          try { await this.writableClosed.catch(() => {}); } catch (e) {}
          try { await this.port.close(); } catch (e) {}
        }
      };

      this.lineQueue.length = 0;
      this.reader = new SerialReader(
        this.ser,
        this.lineQueue,
        block => this.handleMonitorBlock(block),
        err => this.log('SerialReader error: ' + err)
      );
      this.reader.start();

      this.log(`Connection success @ ${baud}`);
      const sl = document.getElementById('status_label');
      sl.textContent = `Status: Connected (@ ${baud})`;
      sl.className = 'status-green';
      document.getElementById('connect_btn').disabled = true;
      document.getElementById('disconnect_btn').disabled = false;

    } catch (e) {
      this.log('⚠️ Arduino non trovato — avvio modalità simulazione');
      this.ser = new FakeSerial();
      this.lineQueue.length = 0;
      this.reader = new SerialReader(
        this.ser,
        this.lineQueue,
        block => this.handleMonitorBlock(block),
        err => this.log('SerialReader error: ' + err)
      );
      this.reader.start();
      const sl = document.getElementById('status_label');
      sl.textContent = 'Status: Connected (FAKE)';
      sl.className = 'status-green';
      document.getElementById('connect_btn').disabled = true;
      document.getElementById('disconnect_btn').disabled = false;
    }
  }

  async disconnectSerial() {
    if (this.reader) {
      try { await this.reader.stop(); } catch (e) {}
      this.reader = null;
    }
    if (this.ser) {
      try { await this.ser.close(); } catch (e) {}
    }
    this.ser = null;
    document.getElementById('connect_btn').disabled = false;
    document.getElementById('disconnect_btn').disabled = true;
    const sl = document.getElementById('status_label');
    sl.textContent = 'Stato: Disconnesso';
    sl.className = 'status-red';
    this.log('Disconnesso.');
  }

  // ---------- simple_cmd ----------
  async simpleCmd(cmd, wait_sec = 0.05) {
    if (!this.ser) {
      this.log('Error: not connected.');
      return;
    }
    try {
      await this.ser.write(cmd + '\n');
      await sleep(wait_sec * 1000);
      const lines = await this.readNLines(10, 0.5);
      if (lines.length > 0) {
        for (const l of lines) this.log('-> ' + l);
      } else {
        this.log(`Sent command: ${cmd}`);
      }
    } catch (e) {
      this.log(`Error command: ${e}`);
    }
  }

  // ---------- set param ----------
  async setParam(param) {
    if (!this.ser) {
      this.log('Error: not connected.');
      return;
    }
    param = param.toUpperCase();
    let val = null;
    if (param === 'P') val = parseFloat(document.getElementById('kp_field').value);
    else if (param === 'I') val = parseFloat(document.getElementById('ki_field').value);
    else if (param === 'D') val = parseFloat(document.getElementById('kd_field').value);
    else if (param === 'O') {
      const def = parseFloat(document.getElementById('off_field').value);
      const inp = window.prompt('Voltage offset (0..1)', def);
      if (inp === null) return;
      const v = parseFloat(inp);
      if (isNaN(v) || v < 0 || v > 1) return;
      val = v;
    } else if (param === 'A') val = parseFloat(document.getElementById('amp_field').value);
    else if (param === 'T') val = parseInt(document.getElementById('t_field').value);
    else if (param === 'N') val = parseInt(document.getElementById('samples_spin').value);
    else {
      this.log('Parameters unknown');
      return;
    }

    if (val !== null) {
      const cmd = `SET ${param} ${val}`;
      this.log(`Sending: ${cmd}`);
      await this.simpleCmd(cmd);
      this.saveParameters();
    }
  }

  // ---------- Save/Load/Send Parameters ----------
  getParametersFromGui() {
    return {
      Kp: parseFloat(document.getElementById('kp_field').value),
      Ki: parseFloat(document.getElementById('ki_field').value),
      Kd: parseFloat(document.getElementById('kd_field').value),
      Offset: parseFloat(document.getElementById('off_field').value),
      Amplitude: parseFloat(document.getElementById('amp_field').value),
      SampleInterval: parseInt(document.getElementById('t_field').value),
      NumSamples: parseInt(document.getElementById('samples_spin').value),
    };
  }

  setParametersToGui(p) {
    if (p.Kp !== undefined) document.getElementById('kp_field').value = p.Kp;
    if (p.Ki !== undefined) document.getElementById('ki_field').value = p.Ki;
    if (p.Kd !== undefined) document.getElementById('kd_field').value = p.Kd;
    if (p.Offset !== undefined) document.getElementById('off_field').value = p.Offset;
    if (p.Amplitude !== undefined) document.getElementById('amp_field').value = p.Amplitude;
    if (p.SampleInterval !== undefined) document.getElementById('t_field').value = p.SampleInterval;
    if (p.NumSamples !== undefined) document.getElementById('samples_spin').value = p.NumSamples;
  }

  saveParameters() {
    const params = this.getParametersFromGui();
    try {
      localStorage.setItem(this.config_key, JSON.stringify(params));
      this.log(`Parameters saved in localStorage[${this.config_key}]`);
    } catch (e) {
      this.log(`Error during data saving: ${e}`);
    }
  }

  loadParameters() {
    const raw = localStorage.getItem(this.config_key);
    if (!raw) {
      this.log('Json file not found. Default parameters used.');
      return;
    }
    try {
      const params = JSON.parse(raw);
      this.setParametersToGui(params);
      this.log(`Loaded parameters from localStorage[${this.config_key}]`);
    } catch (e) {
      this.log(`Error during parameters loading: ${e}`);
    }
  }

  async sendAllParametersTask() {
    if (!this.ser) {
      this.log('Error not connected. Parameters not found');
      return;
    }
    this.log('Sending all SET parameters to Arduino...');
    const params = this.getParametersFromGui();
    const commands = [
      ['P', params.Kp],
      ['I', params.Ki],
      ['D', params.Kd],
      ['O', params.Offset],
      ['A', params.Amplitude],
      ['T', params.SampleInterval],
      ['N', parseInt(document.getElementById('samples_spin').value)],
    ];
    for (const [pc, v] of commands) {
      const cmd = `SET ${pc} ${v}`;
      this.log(`Inviando: ${cmd}`);
      await this.simpleCmd(cmd, 0.1);
    }
    this.log('All parameters send.');
  }

  async sendNumSamples() {
    if (!this.ser) {
      this.log('WARNING: Serial not connected');
      return;
    }
    const N = parseInt(document.getElementById('samples_spin').value);
    const cmd = `SET N ${N}`;
    try {
      await this.ser.write(cmd + '\n');
      this.log(`Inviato: ${cmd}`);
    } catch (e) {
      this.log(`Errore SET N: ${e}`);
    }
  }

  // ---------- PID / FreqRef combos ----------
  async togglePid(idx) {
    if (idx === 0) { await this.simpleCmd('PID ON'); this.log('PID ON'); }
    else if (idx === 1) { await this.simpleCmd('PID OFF'); this.log('PID OFF'); }
  }

  async changeMode(idx) {
    if (idx === 0) {
      await this.simpleCmd('TTL OFF');
      await this.simpleCmd('SET 1 0');
      this.log('FreqRef OFF (TTL OFF, SET 1 0)');
    } else if (idx === 1) {
      await this.simpleCmd('TTL OFF');
      await this.simpleCmd('SET 1 0.5');
      this.log('FreqRef ON (TTL OFF, SET 1 0.5)');
    } else if (idx === 2) {
      await this.simpleCmd('SET 1 0');
      await this.simpleCmd('TTL ON');
      this.log('TTL ON (FreqRef OFF, TTL ON)');
    }
  }

  // ---------- Monitor ----------
  async toggleMonitor() {
    const popup = document.getElementById('monitor_window');
    if (popup.classList.contains('hidden')) {
      popup.classList.remove('hidden');
      this.is_monitoring = true;
      try {
        if (this.ser) await this.ser.write('MONITOR ON\n');
      } catch (e) { console.log('ERROR sending MONITOR ON:', e); }
      this.log('Monitoring V+/V- activated.');
    } else {
      this.hideMonitor();
    }
  }

  async hideMonitor() {
    const popup = document.getElementById('monitor_window');
    popup.classList.add('hidden');
    this.is_monitoring = false;
    try {
      if (this.ser) await this.ser.write('MONITOR OFF\n');
    } catch (e) { console.log('ERROR sending MONITOR OFF:', e); }
    this.log('Monitoring V+/V- deactivated.');
  }

  handleMonitorBlock(lines) {
    const vp_values = [], vm_values = [], z_values = [];
    for (const line of lines) {
      const parts = line.trim().split(',');
      if (parts.length === 4 && parts[0] === 'M') {
        const vp = parseFloat(parts[1]);
        const vm = parseFloat(parts[2]);
        const z = parseFloat(parts[3]);
        if (!isNaN(vp) && !isNaN(vm) && !isNaN(z)) {
          vp_values.push(vp);
          vm_values.push(vm);
          z_values.push(z);
        }
      }
    }
    if (vp_values.length > 0) {
      document.getElementById('vplus_field').value = vp_values[vp_values.length - 1].toFixed(3);
      document.getElementById('vminus_field').value = vm_values[vm_values.length - 1].toFixed(3);
    }
    if (z_values.length > 0) {
      const n = z_values.length;
      const bs = this.monitor_z.length;
      if (n >= bs) {
        for (let i = 0; i < bs; i++) this.monitor_z[i] = z_values[n - bs + i];
      } else {
        // roll left, append new
        for (let i = 0; i < bs - n; i++) this.monitor_z[i] = this.monitor_z[i + n];
        for (let i = 0; i < n; i++) this.monitor_z[bs - n + i] = z_values[i];
      }
      const mx = Math.max(...this.monitor_z);
      if (mx > this.monitor_ylim[1]) this.monitor_ylim[1] = mx * 1.1;
      drawMonitorOsc(this.monitor_z, this.monitor_ylim);
    }
  }

  // ---------- send PGA ----------
  async sendPga() {
    const cs = document.getElementById('cs_combo').value;
    const preset = document.getElementById('preset_combo').value;
    const chanVal = parseInt(document.getElementById('chan_combo').value);
    const chan = chanVal.toString().padStart(2, '0');
    const pol = document.getElementById('pol_combo').value;
    const en = document.getElementById('en_combo').value;
    const cmd = `${cs}${preset}${chan}${pol}${en}`;
    document.getElementById('pga_cmd_label').textContent = `Comando: ${cmd}`;
    this.log(`Invio PGA: ${cmd}`);
    await this.simpleCmd(cmd);
  }

  // ---------- read helper ----------
  async readNLines(n, sec_total = 10.0) {
    const lines = [];
    const deadline = performance.now() + sec_total * 1000;
    while (lines.length < n && performance.now() < deadline) {
      if (this.lineQueue.length > 0) {
        lines.push(this.lineQueue.shift());
      } else {
        await sleep(2);
      }
    }
    return lines;
  }

  // ---------- PRINT (one block) ----------
  async printOnceTask() {
    if (!this.ser) { this.log('Error: not connected.'); return; }
    const num_points = parseInt(document.getElementById('samples_spin').value);
    this.log(`PRINT command sent. Waiting for ${num_points} lines...`);

    this.lineQueue.length = 0;
    try {
      await this.ser.write('PRINT\n');
    } catch (e) {
      this.log(`PRINT error: ${e}`);
      return;
    }

    const timeout_total = Math.max(5.0, 0.02 * num_points);
    const lines = await this.readNLines(num_points, timeout_total);
    if (lines.length < num_points) {
      this.log(`Attention: only ${lines.length}/${num_points} lines received (timeout ${timeout_total}s).`);
    }

    const I1 = new Float32Array(num_points), I2 = new Float32Array(num_points);
    const Q1 = new Float32Array(num_points), Q2 = new Float32Array(num_points);
    const Delta = new Float32Array(num_points), V = new Float32Array(num_points);
    let idx = 0;
    for (const line of lines) {
      const parts = line.replace(/,/g, ' ').split(/\s+/).filter(s => s !== '');
      const vals = [];
      let ok = true;
      for (const p of parts) {
        const f = parseFloat(p);
        if (isNaN(f)) { ok = false; break; }
        vals.push(f);
      }
      if (!ok) {
        this.log(`Non-numeric line ignored: '${line}'`);
        continue;
      }
      if (vals.length >= 6) {
        I1[idx] = vals[0]; I2[idx] = vals[1]; Q1[idx] = vals[2];
        Q2[idx] = vals[3]; Delta[idx] = vals[4]; V[idx] = vals[5];
        idx++;
      } else {
        this.log(`Riga con formato sbagliato ignorata: '${line}'`);
      }
    }

    if (idx === 0) {
      this.log('No valid data received from PRINT.');
      document.getElementById('analyze_btn').disabled = true;
      return;
    }

    const I1c = I1.slice(0, idx), I2c = I2.slice(0, idx);
    const Q1c = Q1.slice(0, idx), Q2c = Q2.slice(0, idx);
    const Dc = Delta.slice(0, idx), Vc = V.slice(0, idx);
    this.latestData = { I1: I1c, I2: I2c, Q1: Q1c, Q2: Q2c, Delta: Dc, V: Vc, NumSamples: idx };

    this.updatePrintPlots(I1c, I2c, Q1c, Q2c, Dc, Vc);
    this.log('PRINT commands received and graphics update signal issued.');
  }

  // ---------- update plots ----------
  updatePrintPlots(I1, I2, Q1, Q2, Delta, V) {
    // I/Q
    plotLines('canvas_IQ', [
      { y: I1, label: 'X1', color: '#1f77b4' },
      { y: I2, label: 'X2', color: '#ff7f0e' },
      { y: Q1, label: 'Y1', color: '#2ca02c' },
      { y: Q2, label: 'Y2', color: '#d62728' },
    ], { xlabel: 'Sample', ylabel: 'Amplitude' });

    // Delta (in deg)
    const Ddeg = new Float32Array(Delta.length);
    for (let i = 0; i < Delta.length; i++) Ddeg[i] = Delta[i] * 180 / Math.PI;
    plotLines('canvas_Delta', [
      { y: Ddeg, label: 'Delta (deg)', color: '#1f77b4' },
    ], { xlabel: 'Sample' });

    // V offset
    plotLines('canvas_V', [
      { y: V, label: 'V offset', color: '#1f77b4', marker: true },
    ], { xlabel: 'Sample' });

    this.log('Plots updated.');
    document.getElementById('analyze_btn').disabled = false;
  }

  // ---------- CALIBRATE ----------
  async calibrateTask() {
    if (!this.ser) { this.log('Errore: non connesso.'); return; }
    this.lineQueue.length = 0;
    this.log('Invio CALIBRATE...');
    try {
      await this.ser.write('CALIBRATE\n');
    } catch (e) {
      this.log(`Errore invio CALIBRATE: ${e}`);
      return;
    }
    const timeout_total = 60.0;
    const start = performance.now();
    let finished = false;
    while ((performance.now() - start) / 1000 < timeout_total) {
      const lines = await this.readNLines(1, 2.0);
      if (lines.length === 0) continue;
      for (const l of lines) {
        this.log('-> ' + l);
        const low = l.toLowerCase();
        if (['complete', 'completed', 'done', 'calibration finished', 'cal_done'].some(t => low.includes(t))) {
          finished = true;
          break;
        }
      }
      if (finished) break;
    }
    if (finished) this.log('Calibration Completed.');
    else this.log('Calibration completed due to timeout (may still be in progress on the Arduino side).');
  }

  // ---------- start acquisition (PID ON/OFF cycles) ----------
  async startAcquisitionTask() {
    if (!this.ser) { this.log('Error: not connected.'); return; }

    document.getElementById('start_acq_btn').disabled = true;
    document.getElementById('stop_acq_btn').disabled = false;
    document.getElementById('analyze_btn').disabled = true;

    const times = parseInt(document.getElementById('times_spin').value);
    const numSamples = parseInt(document.getElementById('samples_spin').value);
    const filename = document.getElementById('filename_edit').value.trim();
    const doSave = document.getElementById('save_check').checked;
    const doAnalyze = document.getElementById('analyze_check').checked;

    this.stop_flag = false;
    this.log('PID ON/OFF acquisition started.');

    try {
      await this.simpleCmd(`SET T ${document.getElementById('t_field').value}`, 0.02);
    } catch (e) {}

    const switch_point = Math.round(times / 2);
    const total_samples = numSamples * times;
    const I1 = new Float32Array(total_samples), I2 = new Float32Array(total_samples);
    const Q1 = new Float32Array(total_samples), Q2 = new Float32Array(total_samples);
    const Delta = new Float32Array(total_samples), V = new Float32Array(total_samples);
    let write_idx = 0;

    for (let j = 1; j <= times; j++) {
      if (this.stop_flag) { this.log('Acquisition interrupted by the user.'); break; }
      if (j > switch_point) {
        await this.simpleCmd('PID ON', 0.02);
        this.log(`Cycle ${j}/${times}: PID ON`);
      } else {
        await this.simpleCmd('PID OFF', 0.02);
        this.log(`Cycle ${j}/${times}: PID OFF`);
      }
      await sleep(11000); // attesa stabilizzazione

      try {
        this.lineQueue.length = 0;
        await this.ser.write('PRINT\n');
      } catch (e) {
        this.log(`Errore invio PRINT: ${e}`);
        break;
      }

      const timeout_total = Math.max(5.0, 0.02 * numSamples);
      const lines = await this.readNLines(numSamples, timeout_total);
      if (lines.length < numSamples) {
        this.log(`Warning: only ${lines.length}/${numSamples} lines received per cycle ${j}..`);
      }

      for (const line of lines) {
        const parts = line.replace(/,/g, ' ').split(/\s+/).filter(s => s !== '');
        const vals = [];
        let ok = true;
        for (const p of parts) {
          const f = parseFloat(p);
          if (isNaN(f)) { ok = false; break; }
          vals.push(f);
        }
        if (!ok) continue;
        if (vals.length >= 6 && write_idx < total_samples) {
          I1[write_idx] = vals[0]; I2[write_idx] = vals[1]; Q1[write_idx] = vals[2];
          Q2[write_idx] = vals[3]; Delta[write_idx] = vals[4]; V[write_idx] = vals[5];
          write_idx++;
        }
      }
      this.log(`Block ${j} completed. Samples written: ${write_idx}`);
    }

    await this.simpleCmd('PID OFF', 0.02);

    let data = null;
    if (write_idx === 0) {
      this.log('No data acquired.');
    } else {
      data = {
        I1: I1.slice(0, write_idx), I2: I2.slice(0, write_idx),
        Q1: Q1.slice(0, write_idx), Q2: Q2.slice(0, write_idx),
        Delta: Delta.slice(0, write_idx), V: V.slice(0, write_idx),
      };
    }
    this.handleAcquisitionFinished(data, doSave, doAnalyze, filename);
  }

  stopAcquisitionRequest() {
    this.stop_flag = true;
    try { this.simpleCmd('STOP'); } catch (e) {}
    this.log('STOP request sent.');
  }

  handleAcquisitionFinished(data, doSave, doAnalyze, filename) {
    document.getElementById('start_acq_btn').disabled = false;
    document.getElementById('stop_acq_btn').disabled = true;
    if (data) {
      this.latestData = data;
      document.getElementById('analyze_btn').disabled = false;
      if (doSave) {
        try {
          const obj = {
            I1: Array.from(data.I1), I2: Array.from(data.I2),
            Q1: Array.from(data.Q1), Q2: Array.from(data.Q2),
            Delta: Array.from(data.Delta), V: Array.from(data.V),
          };
          const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = (filename || 'data') + '.json';
          a.click();
          URL.revokeObjectURL(url);
          this.log(`Data saved in ${filename}.json`);
        } catch (e) {
          this.log(`Save error: ${e}`);
        }
      }
      if (doAnalyze) {
        this.showAnalysisDialog(this.latestData);
        this.log('Analysis completed.');
      }
    } else {
      document.getElementById('analyze_btn').disabled = true;
    }
  }

  runAnalysisNow() {
    if (!this.latestData) { this.log('No data available for analysis.'); return; }
    this.showAnalysisDialog(this.latestData);
  }

  showAnalysisDialog(D) {
    document.getElementById('analysis_dialog').classList.remove('hidden');
    renderAnalysis(D.I1, D.Q1, D.I2, D.Q2, D.Delta, D.V);
  }
}

// =====================================================================
// ===================== Analysis dialog rendering =====================
// =====================================================================
// Nota: rispetta l'ordine del codice Python: (X1, Y1, X2, Y2, Delta, V) =
// AnalysisDialog(self, D['I1'], D['I2'], D['Q1'], D['Q2'], ...) -> X1=I1,Y1=I2,X2=Q1,Y2=Q2
// Replico fedelmente: il file Python passa I1->X1, I2->Y1, Q1->X2, Q2->Y2.
function renderAnalysis(X1, Y1, X2, Y2, Delta, V) {
  // Filtro X1 != 0
  const idx = [];
  for (let i = 0; i < X1.length; i++) if (X1[i] !== 0) idx.push(i);
  if (idx.length === 0) {
    drawTextCanvas('canvas_a1', 'No valide input data for the analysis.');
    return;
  }
  const X1NZ = idx.map(i => X1[i]);
  const Y1NZ = idx.map(i => Y1[i]);
  const X2NZ = idx.map(i => X2[i]);
  const Y2NZ = idx.map(i => Y2[i]);
  const DeltaNZ = idx.map(i => Delta[i]);
  const VNZ = idx.map(i => V[i]);

  const R1 = X1NZ.map((_, i) => 2.0 * Math.sqrt(X1NZ[i]**2 + Y1NZ[i]**2));
  const R2 = X1NZ.map((_, i) => 2.0 * Math.sqrt(X2NZ[i]**2 + Y2NZ[i]**2));
  const T1deg = X1NZ.map((_, i) => Math.atan2(Y1NZ[i], X1NZ[i]) * 180 / Math.PI);
  const T2deg = X1NZ.map((_, i) => Math.atan2(Y2NZ[i], X2NZ[i]) * 180 / Math.PI);

  // Fig 1: X1, X2, Y1, Y2
  plotLines('canvas_a1', [
    { y: X1NZ, label: 'X1', color: '#1f77b4' },
    { y: X2NZ, label: 'X2', color: '#ff7f0e' },
    { y: Y1NZ, label: 'Y1', color: '#2ca02c' },
    { y: Y2NZ, label: 'Y2', color: '#d62728' },
  ], { title: 'X1, X2, Y1, Y2' });

  // Fig 2: ampiezze + fasi side-by-side -> due grafici impilati orizzontalmente
  // Disegno entrambi su unico canvas dividendolo in due metà
  plotSplit('canvas_a2',
    [{ y: R1, label: 'R1', color: '#1f77b4' }, { y: R2, label: 'R2', color: '#ff7f0e' }],
    [{ y: T1deg, label: 'θ1', color: '#1f77b4' }, { y: T2deg, label: 'θ2', color: '#ff7f0e' }],
    'Amplitude', 'Phase (deg)'
  );

  // Fig 3: Delta e V (verticali)
  const Ddeg = DeltaNZ.map(d => d * 180 / Math.PI);
  plotSplitV('canvas_a3',
    [{ y: Ddeg, label: 'δ', color: '#1f77b4' }],
    [{ y: VNZ, label: 'V_off', color: '#1f77b4', marker: true }],
    'δ (deg)', 'Voltage offset', 'Collected samples'
  );

  // Fig 4: FFT
  const lenData = DeltaNZ.length;
  const lenHalf = Math.floor(lenData / 2);
  const deltaOff = DeltaNZ.slice(0, lenHalf);
  const deltaOn = DeltaNZ.slice(lenHalf);
  const sampleInterval = 0.051;

  const fftOff = computeFftMagFreq(deltaOff, sampleInterval);
  const fftOn = computeFftMagFreq(deltaOn, sampleInterval);

  // limita ad asse x da 0 a max_freq/2 (come nel Python: ax4.set_xlim(0, max_freq/2))
  const max_freq = 1.0 / (2.0 * sampleInterval);
  plotXY('canvas_a4', [
    { x: fftOff.f, y: fftOff.m, label: 'PID OFF', color: '#1f77b4' },
    { x: fftOn.f, y: fftOn.m, label: 'PID ON', color: '#ff7f0e' },
  ], { xlabel: 'Frequencies (Hz)', title: 'FFT of Delta', xlim: [0, max_freq / 2] });
}

// =====================================================================
// =========================== FFT (radix-2) ===========================
// =====================================================================
function computeFftMagFreq(data, dt) {
  // Zero-pad alla potenza di 2 più vicina ma poi ritorna solo i primi N/2
  const N = data.length;
  const Np2 = 1 << Math.ceil(Math.log2(Math.max(N, 2)));
  const re = new Float64Array(Np2);
  const im = new Float64Array(Np2);
  for (let i = 0; i < N; i++) re[i] = data[i];
  fft(re, im);
  const halfN = Math.floor(N / 2);
  const m = new Float64Array(halfN);
  const f = new Float64Array(halfN);
  // fftfreq: per i < N/2 -> i / (N*dt)
  for (let i = 0; i < halfN; i++) {
    // scala l'indice da Np2 a N: usiamo direttamente i (l'errore di scala è trascurabile rispetto al plot)
    const idx = Math.round(i * Np2 / N);
    m[i] = Math.sqrt(re[idx] * re[idx] + im[idx] * im[idx]);
    f[i] = i / (N * dt);
  }
  return { f, m };
}

function fft(re, im) {
  const n = re.length;
  if (n <= 1) return;
  // bit reversal
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const tre = curRe * re[i + k + len / 2] - curIm * im[i + k + len / 2];
        const tim = curRe * im[i + k + len / 2] + curIm * re[i + k + len / 2];
        re[i + k + len / 2] = re[i + k] - tre;
        im[i + k + len / 2] = im[i + k] - tim;
        re[i + k] += tre;
        im[i + k] += tim;
        const nRe = curRe * wRe - curIm * wIm;
        const nIm = curRe * wIm + curIm * wRe;
        curRe = nRe; curIm = nIm;
      }
    }
  }
}

// =====================================================================
// ====================== Canvas plotting helpers ======================
// =====================================================================
function _axes(ctx, w, h, padL, padR, padT, padB) {
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.strokeRect(padL, padT, w - padL - padR, h - padT - padB);
}

function _minMax(series, accessor = s => s.y) {
  let mn = Infinity, mx = -Infinity;
  for (const s of series) {
    const arr = accessor(s);
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
  }
  if (!isFinite(mn) || !isFinite(mx)) { mn = 0; mx = 1; }
  if (mn === mx) { mn -= 1; mx += 1; }
  return [mn, mx];
}

function _drawLegend(ctx, items, x, y) {
  ctx.font = '11px sans-serif';
  let dy = 0;
  for (const it of items) {
    ctx.fillStyle = it.color;
    ctx.fillRect(x, y + dy + 3, 10, 2);
    ctx.fillStyle = '#000';
    ctx.fillText(it.label, x + 14, y + dy + 8);
    dy += 14;
  }
}

function _drawTicks(ctx, x0, y0, x1, y1, xRange, yRange) {
  ctx.font = '10px sans-serif';
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  const nTicks = 5;
  // X
  for (let i = 0; i <= nTicks; i++) {
    const xpx = x0 + (x1 - x0) * i / nTicks;
    const xv = xRange[0] + (xRange[1] - xRange[0]) * i / nTicks;
    ctx.beginPath();
    ctx.moveTo(xpx, y1); ctx.lineTo(xpx, y1 + 3); ctx.stroke();
    ctx.fillText(formatNum(xv), xpx - 12, y1 + 14);
  }
  // Y
  for (let i = 0; i <= nTicks; i++) {
    const ypx = y1 - (y1 - y0) * i / nTicks;
    const yv = yRange[0] + (yRange[1] - yRange[0]) * i / nTicks;
    ctx.beginPath();
    ctx.moveTo(x0, ypx); ctx.lineTo(x0 - 3, ypx); ctx.stroke();
    ctx.fillText(formatNum(yv), x0 - 38, ypx + 3);
  }
}

function formatNum(v) {
  if (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0)) return v.toExponential(1);
  return (Math.round(v * 1000) / 1000).toString();
}

function plotLines(canvasId, series, opts = {}) {
  const cv = document.getElementById(canvasId);
  const ctx = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  const padL = 50, padR = 70, padT = opts.title ? 24 : 8, padB = 30;
  _axes(ctx, w, h, padL, padR, padT, padB);

  if (opts.title) {
    ctx.fillStyle = '#000';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText(opts.title, padL, 14);
  }

  const N = Math.max(...series.map(s => s.y.length));
  const [mn, mx] = _minMax(series);
  const x0 = padL, x1 = w - padR, y0 = padT, y1 = h - padB;

  _drawTicks(ctx, x0, y0, x1, y1, [0, N - 1], [mn, mx]);

  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < s.y.length; i++) {
      const xpx = x0 + (x1 - x0) * (i / Math.max(1, N - 1));
      const ypx = y1 - (y1 - y0) * ((s.y[i] - mn) / (mx - mn));
      if (i === 0) ctx.moveTo(xpx, ypx); else ctx.lineTo(xpx, ypx);
      if (s.marker) ctx.fillRect(xpx - 1, ypx - 1, 2, 2);
    }
    ctx.stroke();
  }

  _drawLegend(ctx, series, x1 + 6, y0 + 4);

  if (opts.xlabel) {
    ctx.fillStyle = '#000';
    ctx.font = '11px sans-serif';
    ctx.fillText(opts.xlabel, (x0 + x1) / 2 - 20, h - 6);
  }
}

function plotXY(canvasId, series, opts = {}) {
  const cv = document.getElementById(canvasId);
  const ctx = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  const padL = 50, padR = 80, padT = opts.title ? 24 : 8, padB = 30;
  _axes(ctx, w, h, padL, padR, padT, padB);

  if (opts.title) {
    ctx.fillStyle = '#000';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText(opts.title, padL, 14);
  }

  // x range
  let xmn, xmx;
  if (opts.xlim) { xmn = opts.xlim[0]; xmx = opts.xlim[1]; }
  else {
    [xmn, xmx] = _minMax(series, s => s.x);
  }
  const [ymn, ymx] = _minMax(series);
  const x0 = padL, x1 = w - padR, y0 = padT, y1 = h - padB;

  _drawTicks(ctx, x0, y0, x1, y1, [xmn, xmx], [ymn, ymx]);

  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < s.x.length; i++) {
      const xv = s.x[i];
      if (xv < xmn || xv > xmx) { started = false; continue; }
      const xpx = x0 + (x1 - x0) * ((xv - xmn) / (xmx - xmn));
      const ypx = y1 - (y1 - y0) * ((s.y[i] - ymn) / (ymx - ymn));
      if (!started) { ctx.moveTo(xpx, ypx); started = true; }
      else ctx.lineTo(xpx, ypx);
    }
    ctx.stroke();
  }
  _drawLegend(ctx, series, x1 + 6, y0 + 4);

  if (opts.xlabel) {
    ctx.fillStyle = '#000';
    ctx.font = '11px sans-serif';
    ctx.fillText(opts.xlabel, (x0 + x1) / 2 - 30, h - 6);
  }
}

// Due plot affiancati orizzontalmente sullo stesso canvas
function plotSplit(canvasId, leftSeries, rightSeries, leftTitle, rightTitle) {
  const cv = document.getElementById(canvasId);
  const w = cv.width, h = cv.height;
  // Disegno le due metà clippando il contesto
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  // sinistra
  drawSubplot(cv, 0, 0, w / 2, h, leftSeries, { title: leftTitle });
  drawSubplot(cv, w / 2, 0, w / 2, h, rightSeries, { title: rightTitle });
}

function plotSplitV(canvasId, topSeries, bottomSeries, topTitle, bottomTitle, xlabel) {
  const cv = document.getElementById(canvasId);
  const w = cv.width, h = cv.height;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  drawSubplot(cv, 0, 0, w, h / 2, topSeries, { title: topTitle });
  drawSubplot(cv, 0, h / 2, w, h / 2, bottomSeries, { title: bottomTitle, xlabel });
}

function drawSubplot(cv, x, y, w, h, series, opts) {
  const ctx = cv.getContext('2d');
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  // costruisce un mini-canvas in coordinate locali traslate
  ctx.translate(x, y);
  // ridisegna manualmente
  const padL = 50, padR = 50, padT = opts.title ? 22 : 8, padB = 30;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.strokeRect(padL, padT, w - padL - padR, h - padT - padB);
  if (opts.title) {
    ctx.fillStyle = '#000';
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText(opts.title, padL, 14);
  }
  const N = Math.max(...series.map(s => s.y.length));
  const [mn, mx] = _minMax(series);
  const x0 = padL, x1 = w - padR, y0 = padT, y1 = h - padB;
  _drawTicks(ctx, x0, y0, x1, y1, [0, N - 1], [mn, mx]);
  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < s.y.length; i++) {
      const xpx = x0 + (x1 - x0) * (i / Math.max(1, N - 1));
      const ypx = y1 - (y1 - y0) * ((s.y[i] - mn) / (mx - mn));
      if (i === 0) ctx.moveTo(xpx, ypx); else ctx.lineTo(xpx, ypx);
      if (s.marker) ctx.fillRect(xpx - 1, ypx - 1, 2, 2);
    }
    ctx.stroke();
  }
  _drawLegend(ctx, series, x1 + 4, y0 + 4);
  if (opts.xlabel) {
    ctx.fillStyle = '#000';
    ctx.font = '10px sans-serif';
    ctx.fillText(opts.xlabel, (x0 + x1) / 2 - 30, h - 6);
  }
  ctx.restore();
}

function drawTextCanvas(canvasId, text) {
  const cv = document.getElementById(canvasId);
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#000';
  ctx.font = '14px sans-serif';
  ctx.fillText(text, 20, 30);
}

function drawMonitorOsc(zBuf, ylim) {
  plotLines('canvas_osc', [{ y: zBuf, label: 'Z', color: '#cc0000' }], {
    title: 'Oscilloscope Z', xlabel: 'Samples'
  });
}

// =====================================================================
// ================================ main ===============================
// =====================================================================
window.addEventListener('DOMContentLoaded', () => {
  window.gui = new MainWindow();
});
