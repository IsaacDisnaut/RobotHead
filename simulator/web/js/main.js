import { Robot3D, drawEyeCanvas } from './robot3d.js';
import { Esp32Firmware, Jawduino } from './firmware.js';
import { RobotBrain, CONFIG } from './brain.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let started = false;   // ผู้ใช้กดเริ่มแล้ว (เบราว์เซอร์อนุญาตเสียง)

const fw = new Esp32Firmware();
const jaw = new Jawduino();
const robot = new Robot3D($('#three'));
robot.onStatus = (m) => toast(m);

// ================== Serial (จำลอง + ส่งต่อหุ่นจริง) ==================
let hwConnected = null;
let hwQueue = [];
const serialLog = $('#serialLog');
let lastLogEl = null, lastLogCmd = null, lastLogCount = 0;

function serial(line) {
  fw.receive(line);
  if (hwConnected) hwQueue.push(line);
  logSerial(line);
}

function logSerial(line) {
  const cmd = line.startsWith('T,') ? 'T' : line.startsWith('I') ? 'I' : line;
  const time = new Date().toLocaleTimeString('th-TH', { hour12: false });
  // รวมคำสั่ง T ที่ส่งถี่ๆ ไว้บรรทัดเดียว
  if (cmd === 'T' && lastLogCmd === 'T' && lastLogEl) {
    lastLogCount++;
    lastLogEl.innerHTML = `<span class="t">${time}</span><span class="c-T">${line}</span> <span class="n">×${lastLogCount}</span>`;
    return;
  }
  const el = document.createElement('div');
  el.innerHTML = `<span class="t">${time}</span><span class="c-${cmd}">${line}</span>`;
  serialLog.appendChild(el);
  while (serialLog.children.length > 200) serialLog.firstChild.remove();
  serialLog.scrollTop = serialLog.scrollHeight;
  lastLogEl = el; lastLogCmd = cmd; lastLogCount = 1;
}
$('#clearSerial').onclick = () => { serialLog.innerHTML = ''; lastLogEl = null; lastLogCmd = null; };

setInterval(async () => {
  if (!hwConnected || !hwQueue.length) return;
  // คำสั่ง T ส่งแค่ตัวล่าสุด ที่เหลือส่งครบ
  const lines = [];
  let lastT = null;
  for (const l of hwQueue) { if (l.startsWith('T,')) lastT = l; else lines.push(l); }
  if (lastT) lines.push(lastT);
  hwQueue = [];
  try {
    await fetch('/api/serial/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines }) });
  } catch {}
}, 40);

// ================== Chat UI ==================
const chatLog = $('#chatLog');
function addMsg(kind, text, meta) {
  const el = document.createElement('div');
  el.className = 'msg ' + kind;
  if (kind === 'bot') el.innerHTML = `<b>น้องมะลิ</b>`;
  el.appendChild(document.createTextNode(text));
  if (meta) { const m = document.createElement('div'); m.className = 'meta'; m.textContent = meta; el.appendChild(m); }
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
}

const brain = new RobotBrain({
  serial, jaw, firmware: fw,
  ui: {
    onSay: (t, meta) => addMsg('bot', t, meta),
    onMicNote: (t) => ($('#micNote').textContent = t),
    onHeard: (t) => addMsg('user', t),
    onLog: (t, kind = '') => addMsg('sys ' + kind, t),
    onState: () => {},
    onListen: (on) => {
      $('#micBtn').classList.toggle('rec', on);
      // ได้สิทธิ์ไมค์ครั้งแรก -> เบราว์เซอร์เพิ่งยอมบอกชื่อลำโพง โหลดรายการใหม่ (จะเลือกสาย jack ให้เอง)
      if (on && !speakerLabels) refreshSpeakers();
    },
    onMicLevel: (v) => ($('#micLevel').style.width = clamp(v * 40, 0, 100) + '%'),
    speechRate: () => +$('#cfgRate').value,
  },
});
window.sim = { fw, jaw, brain, robot, serial };   // ไว้ลองเล่นใน DevTools

$('#chatForm').onsubmit = (e) => {
  e.preventDefault();
  const t = $('#chatText').value.trim();
  if (!t) return;
  if (brain.busy) { toast('น้องมะลิกำลังพูด/คิดอยู่ รอสักครู่นะคะ'); return; }
  $('#chatText').value = '';
  brain.handleUserText(t);
};
$$('.qp').forEach((b) => (b.onclick = () => {
  if (brain.busy) { toast('น้องมะลิกำลังพูด/คิดอยู่ รอสักครู่นะคะ'); return; }
  brain.handleUserText(b.textContent);
}));
$('#micBtn').onclick = () => {
  if (brain.isListening) brain.cancelListen = true;
  else brain.listenOnce(false);
};
$('#stopSpeak').onclick = () => brain.stopSpeaking();

// ฟังต่อเนื่อง: วนฟังตลอดเมื่อไม่ได้พูดอยู่ (เหมือน voice_worker)
(async function continuousListen() {
  while (true) {
    // รอให้เสียงลำโพงเงียบสนิทก่อน (ไม่ให้ไมค์ได้ยินเสียงหุ่นตัวเอง)
    const quiet = Date.now() - brain.lastSpeechTime > 800;
    if ($('#contListen').checked && !brain.busy && !brain.isListening && started && quiet) await brain.listenOnce(true);
    await sleep(250);
  }
})();

// ================== Manual control ==================
const sliders = { pan: $('#sPan'), tilt: $('#sTilt'), ex: $('#sEyeX'), ey: $('#sEyeY') };
const outs = { pan: $('#oPan'), tilt: $('#oTilt'), ex: $('#oEyeX'), ey: $('#oEyeY') };
const syncOut = () => { for (const k in sliders) outs[k].textContent = sliders[k].value; updateEyePadDot(); };
Object.values(sliders).forEach((s) => s.addEventListener('input', () => {
  if (!$('#manualMode').checked) $('#manualMode').checked = true;
  syncOut();
}));
setInterval(() => {
  if (!$('#manualMode').checked) return;
  brain.holdUntil = performance.now() + 200;
  serial(`T,${sliders.pan.value},${sliders.tilt.value},${sliders.ex.value},${sliders.ey.value}`);
}, 50);

const eyePad = $('#eyePad'), eyeDot = eyePad.querySelector('span');
function updateEyePadDot() {
  eyeDot.style.left = (sliders.ex.value / 1023) * 100 + '%';
  eyeDot.style.top = (sliders.ey.value / 1023) * 100 + '%';
}
function eyePadMove(e) {
  const r = eyePad.getBoundingClientRect();
  const x = clamp((e.clientX - r.left) / r.width, 0, 1), y = clamp((e.clientY - r.top) / r.height, 0, 1);
  sliders.ex.value = Math.round(x * 1023); sliders.ey.value = Math.round(y * 1023);
  // หันคอตามไปด้วยครึ่งหนึ่ง: ขวาของจอ = ซ้ายของหุ่น = pan มากขึ้น
  sliders.pan.value = Math.round(90 + (x - 0.5) * 70);
  sliders.tilt.value = Math.round(90 - (y - 0.5) * 50);
  $('#manualMode').checked = true;
  syncOut();
}
eyePad.addEventListener('pointerdown', (e) => { eyePad.setPointerCapture(e.pointerId); eyePadMove(e); });
eyePad.addEventListener('pointermove', (e) => e.buttons && eyePadMove(e));
$('#centerBtn').onclick = () => {
  sliders.pan.value = 90; sliders.tilt.value = 90; sliders.ex.value = 512; sliders.ey.value = 512; syncOut();
};
$('#manualMode').onchange = () => { if (!$('#manualMode').checked) brain.holdUntil = 0; };

$$('.btn.cmd').forEach((b) => (b.onclick = () => {
  serial(b.dataset.cmd);
  b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 300);
}));
$('#rawForm').onsubmit = (e) => {
  e.preventDefault();
  const v = $('#rawCmd').value.trim();
  if (v) serial(v);
};
$('#sayForm').onsubmit = async (e) => {
  e.preventDefault();
  if (brain.busy) return;
  brain.busy = true; brain.isSpeaking = true;
  await brain.speak($('#sayText').value);
  brain.isSpeaking = false; brain.busy = false;
};
$('#sJaw').oninput = () => ($('#oJaw').textContent = $('#sJaw').value);

// ================== กล้องคอมจริง (เซิร์ฟเวอร์เปิดกล้องด้วย OpenCV + Haar cascade แบบเดียวกับ robot_brain.py) ==================
const cam = brain.camera;
const camCanvas = $('#camCanvas'), cg = camCanvas.getContext('2d');
const realCam = { on: false, gen: 0, error: null, faces: [], width: 640, height: 480, fps: 0, img: $('#camImg') };

async function startRealCam() {
  realCam.error = null;
  $('#camInfo').textContent = 'กำลังเปิดกล้อง...';
  let s;
  try {
    s = await (await fetch('/api/camera/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: +$('#camIndex').value }),
    })).json();
  } catch (e) {
    s = { error: 'ติดต่อเซิร์ฟเวอร์ไม่ได้' };
  }
  if (s.error || !s.running) {
    realCam.error = s.error || 'เปิดกล้องไม่ได้';
    toast(realCam.error);
    $('#camInfo').textContent = realCam.error;
    return;
  }
  realCam.on = true;
  cam.present = false;
  realCam.img.src = '/api/camera/stream?t=' + Date.now();
  pollRealCam(++realCam.gen);
}

async function stopRealCam() {
  realCam.on = false;
  realCam.img.removeAttribute('src');
  realCam.faces = [];
  realCam.target = null;
  cam.present = false;
  try { await fetch('/api/camera/stop', { method: 'POST' }); } catch {}
}

async function pollRealCam(gen) {
  // gen: กันลูปเก่าค้างอยู่ตอนเปิดกล้องใหม่ (เปลี่ยนหมายเลขกล้อง / กดเปิดใหม่)
  while (realCam.on && gen === realCam.gen) {
    try {
      const s = await (await fetch('/api/camera/state')).json();
      if (!realCam.on || gen !== realCam.gen) break;
      if (s.error || !s.running) {
        realCam.error = s.error || 'กล้องหยุดทำงาน';
        toast(realCam.error);
        $('#camInfo').textContent = realCam.error;
        stopRealCam();
        break;
      }
      Object.assign(realCam, { faces: s.faces, target: s.target, speaker: s.speaker, mouthScores: s.mouth_scores || [], voice: s.voice, width: s.width, height: s.height, fps: s.fps });
      // แปลงเป็นค่าเดียวกับ robot_brain.py: norm_x, norm_y, face_ratio ของคนที่ใกล้ที่สุด (ล็อกเป้าแล้ว)
      if (s.target) {
        const [fx, fy, fw_, fh] = s.target;
        cam.present = true;
        cam.normX = (fx + fw_ / 2) / s.width;
        cam.normY = (fy + fh / 2) / s.height;
        cam.ratio = fw_ / s.width;
      } else {
        cam.present = false;
      }
      $('#camInfo').textContent = `${s.fps} fps · พบ ${s.faces.length} ใบหน้า · ${s.detector || ''}`;
    } catch {}
    await sleep(30);
  }
}

function _iou(a, b) {
  const iw = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const ih = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const inter = iw * ih;
  return inter / (a[2] * a[3] + b[2] * b[3] - inter || 1);
}

function restartRealCam() {
  realCam.on = false;   // หยุดลูป poll เดิม
  startRealCam();
}
$('#camIndex').onchange = restartRealCam;
$('#camRetry').onclick = restartRealCam;
window.addEventListener('beforeunload', () => { if (realCam.on) navigator.sendBeacon('/api/camera/stop'); });
startRealCam();

function drawCamera() {
  const W = camCanvas.width, H = camCanvas.height;
  const g = cg;
  drawRealCamera(g, W, H);
  // แถบสถานะเหมือนหน้าต่าง OpenCV ของ robot_brain.py
  const [st, cls] = brain.statusText;
  g.fillStyle = 'rgb(30,30,30)'; g.fillRect(0, 0, W, 45);
  g.font = 'bold 20px JetBrains Mono, IBM Plex Sans Thai, monospace';
  g.fillStyle = { speaking: '#ff00ff', thinking: '#ffff00', listening: '#00ff00', idle: '#c8c8c8' }[cls];
  g.fillText(st, 15, 30);
  if (brain.lastUserSaid) {
    g.fillStyle = 'rgb(20,20,20)'; g.fillRect(0, H - 35, W, 35);
    g.font = '16px IBM Plex Sans Thai, sans-serif'; g.fillStyle = '#fff';
    g.fillText('Heard: ' + brain.lastUserSaid, 15, H - 12);
  }
}

function drawRealCamera(g, W, H) {
  const img = realCam.img;
  if (realCam.on && img.complete && img.naturalWidth) {
    g.drawImage(img, 0, 0, W, H);
  } else {
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#888'; g.font = '18px IBM Plex Sans Thai, sans-serif'; g.textAlign = 'center';
    g.fillText(realCam.error ? `${realCam.error} — กด "↻ เปิดกล้องใหม่"` : 'กำลังเปิดกล้อง...', W / 2, H / 2);
    g.textAlign = 'left';
  }
  const sx = W / realCam.width, sy = H / realCam.height;
  // หน้าอื่นๆ ที่ตรวจเจอ (หุ่นไม่สนใจ)
  g.setLineDash([5, 4]); g.strokeStyle = '#ffffff70'; g.lineWidth = 1;
  g.font = '12px JetBrains Mono, monospace';
  realCam.faces.forEach(([x, y, w, h], i) => {
    g.strokeRect(x * sx, y * sy, w * sx, h * sy);
    // คะแนนขยับปาก (ไว้ปรับจูน SpeakerDetector.MIN_SCORE)
    if (realCam.mouthScores?.[i] != null) { g.fillStyle = '#ffffffb0'; g.fillText(`👄 ${realCam.mouthScores[i].toFixed(1)}`, x * sx + 2, y * sy - 4); }
  });
  g.setLineDash([]);
  // คนที่กำลังพูด (ตรวจจากเสียงไมค์ + การขยับปาก)
  if (realCam.speaker) {
    const [x, y, w, h] = realCam.speaker;
    g.strokeStyle = '#ff00ff'; g.lineWidth = 2;
    g.strokeRect(x * sx - 4, y * sy - 4, w * sx + 8, h * sy + 8);
  }
  // คนที่หุ่นล็อกเป้าไว้ (คนที่กำลังพูด หรือคนที่ใกล้ที่สุด)
  if (realCam.target) {
    const [x, y, w, h] = realCam.target;
    const close = w / realCam.width >= CONFIG.FACE_CLOSE_THRESHOLD;
    g.strokeStyle = close ? '#ffd34d' : '#00ff00'; g.lineWidth = 3;
    g.strokeRect(x * sx, y * sy, w * sx, h * sy);
    g.font = '13px JetBrains Mono, IBM Plex Sans Thai, monospace'; g.fillStyle = g.strokeStyle;
    const who = realCam.speaker && _iou(realCam.speaker, realCam.target) > 0.2 ? '🗣️ กำลังพูด' : '🎯 ใกล้สุด';
    g.fillText(`${who} · ratio ${(w / realCam.width).toFixed(2)}${close ? '  ≥ ทักทาย!' : ''}`, x * sx, (y + h) * sy + 16);
  }
  if (realCam.voice) { g.fillStyle = '#ff00ff'; g.font = '13px IBM Plex Sans Thai, sans-serif'; g.fillText('🎤 ได้ยินเสียงพูด', 8, H - 10); }
}

// ================== Settings ==================
const cfgMap = { cfgRevPan: 'REVERSE_PAN', cfgRevTilt: 'REVERSE_TILT', cfgRevEyeX: 'REVERSE_EYE_X', cfgRevEyeY: 'REVERSE_EYE_Y' };
for (const [id, key] of Object.entries(cfgMap)) {
  $('#' + id).checked = CONFIG[key];
  $('#' + id).onchange = (e) => (CONFIG[key] = e.target.checked);
}
$('#cfgThr').value = CONFIG.FACE_CLOSE_THRESHOLD; $('#oThr').textContent = CONFIG.FACE_CLOSE_THRESHOLD;
$('#cfgThr').oninput = (e) => { CONFIG.FACE_CLOSE_THRESHOLD = +e.target.value; $('#oThr').textContent = e.target.value; $('#rThr').textContent = e.target.value; };
$('#cfgMic').value = CONFIG.MIC_ENERGY_THRESHOLD; $('#oMic').textContent = CONFIG.MIC_ENERGY_THRESHOLD;
$('#cfgMic').oninput = (e) => { CONFIG.MIC_ENERGY_THRESHOLD = +e.target.value; $('#oMic').textContent = e.target.value; };
$('#cfgRate').oninput = (e) => ($('#oRate').textContent = e.target.value);

// ลำโพงที่ใช้พูด (จำค่าที่เลือกไว้ในเบราว์เซอร์นี้)
const SPK_KEY = 'mali.speaker';
let speakerLabels = false;   // เบราว์เซอร์บอกชื่อลำโพงแล้วหรือยัง (ต้องอนุญาตไมค์ก่อน)
async function refreshSpeakers() {
  const sel = $('#spkSel');
  let saved = '';
  try { saved = localStorage.getItem(SPK_KEY) || ''; } catch {}
  const cur = sel.value || saved;
  let outs = [];
  try { outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput'); } catch {}
  speakerLabels = outs.some((d) => d.label);
  sel.innerHTML = '<option value="">ลำโพงหลักของ Windows</option>' + outs
    .filter((d) => d.deviceId && d.deviceId !== 'default')
    .map((d, i) => `<option value="${d.deviceId}">${d.label || 'ลำโพง ' + (i + 1)}</option>`).join('');
  // ยังไม่เคยเลือก -> ใช้ลำโพงที่เสียบสาย jack 3.5 มม. (Realtek "Headphones") เป็นค่าเริ่มต้น
  const jack = [...sel.options].find((o) => /headphone|หูฟัง/i.test(o.textContent));
  if ([...sel.options].some((o) => o.value === cur) && cur) sel.value = cur;
  else sel.value = jack ? jack.value : '';
  await brain.setOutputDevice(sel.value);
}
$('#spkSel').onchange = async (e) => {
  try { localStorage.setItem(SPK_KEY, e.target.value); } catch {}
  if (!(await brain.setOutputDevice(e.target.value))) toast('เบราว์เซอร์นี้เลือกลำโพงไม่ได้ ใช้ Chrome หรือ Edge รุ่นใหม่');
};
$('#spkRefresh').onclick = refreshSpeakers;
$('#spkTest').onclick = () => { brain.ensureAudio(); brain.speak('ทดสอบลำโพงค่ะ ได้ยินเสียงหนูไหมคะ'); };
navigator.mediaDevices?.addEventListener?.('devicechange', refreshSpeakers);
refreshSpeakers();
$('#autoBrain').onchange = (e) => (brain.autoBrain = e.target.checked);
$('#showMask').onchange = (e) => robot.setShowMask(e.target.checked);
$('#viewFront').onclick = () => robot.frontView();
$('#viewReset').onclick = () => robot.resetView();
$('#viewWide').onclick = () => robot.setView('wide');

async function refreshStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    $('#aiStatus').textContent = s.chat_model ? `AI พร้อม · ${s.chat_model} (Groq)` : `AI: ${s.ai_status}`;
    $('#aiDot').className = 'dot ' + (s.chat_model ? 'ok' : 'bad');
    $('#sAi').textContent = s.ai_status;
    $('#sChatModel').textContent = s.chat_model || '-';
    $('#sSttModel').textContent = s.stt_model || '-';
    const opts = s.serial_ports.length
      ? s.serial_ports.map((p) => `<option value="${p.port}">${p.port} — ${p.desc}</option>`).join('')
      : '<option value="">(ไม่พบ COM พอร์ต)</option>';
    for (const id of ['#portSel', '#jawPortSel']) {
      const sel = $(id), cur = sel.value;
      sel.innerHTML = opts;
      if (cur) sel.value = cur;
    }
    setHw(s.serial_connected);
    setJawHw(s.jaw_connected);
  } catch {
    $('#aiStatus').textContent = 'ติดต่อเซิร์ฟเวอร์ไม่ได้ — เปิด robot_sim_server.py ก่อน';
    $('#aiDot').className = 'dot bad';
  }
}
function setHw(port) {
  hwConnected = port;
  $('#chipHw').textContent = port ? `หุ่นจริง: ${port}` : 'หุ่นจริง: ไม่ได้เชื่อมต่อ';
  $('#chipHw').classList.toggle('on', !!port);
  $('#portConnect').textContent = port ? 'ตัดการเชื่อมต่อ' : 'เชื่อมต่อ';
}
$('#portRefresh').onclick = refreshStatus;

// ปากหุ่นจริง (Nano): ส่งระดับอ้าปากตามเสียงพูดในจำลอง
let jawHw = null, jawSentPct = -1, jawSentAt = 0;
function setJawHw(port) {
  jawHw = port;
  $('#jawConnect').textContent = port ? `ตัดการเชื่อมต่อปาก (${port})` : 'เชื่อมต่อปาก';
}
$('#jawConnect').onclick = async () => {
  const port = jawHw ? null : $('#jawPortSel').value;
  if (!jawHw && !port) return;
  if (port && port === hwConnected) { toast('พอร์ตนี้ใช้กับ ESP32 อยู่แล้ว เลือกพอร์ตของ Nano'); return; }
  const r = await (await fetch('/api/jaw/connect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port }),
  })).json();
  if (r.error) toast('เชื่อมต่อปากไม่ได้: ' + r.error);
  setJawHw(r.connected || null);
};
setInterval(() => {
  if (!jawHw) return;
  const pct = Math.round(jaw.level / 3 * 100);
  const now = performance.now();
  // ส่งเมื่อค่าเปลี่ยน หรือทุก 200ms (Nano จะหุบปากเองถ้าไม่ได้รับคำสั่งเกิน 400ms)
  if (pct === jawSentPct && now - jawSentAt < 200) return;
  jawSentPct = pct; jawSentAt = now;
  fetch('/api/jaw/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pct }) }).catch(() => {});
}, 30);

function renderInfo(info) {
  const box = $('#infoList');
  box.innerHTML = '';
  if (!info.files.length) {
    box.innerHTML = '<div class="muted">ยังไม่มีไฟล์ในโฟลเดอร์ information</div>';
    return;
  }
  for (const f of info.files) {
    const row = document.createElement('div');
    const name = document.createElement('b'); name.textContent = '📄 ' + f.name;
    const meta = document.createElement('span');
    meta.textContent = f.error ? 'อ่านไม่ได้' : `${f.chars.toLocaleString()} ตัวอักษร`;
    if (f.error) { meta.className = 'err'; meta.title = f.error; }
    row.append(name, meta);
    box.appendChild(row);
  }
}
async function loadInfo(reload) {
  try {
    const r = await fetch(reload ? '/api/info/reload' : '/api/info', { method: reload ? 'POST' : 'GET' });
    renderInfo(await r.json());
  } catch {}
}
$('#infoReload').onclick = () => loadInfo(true);
$('#infoOpen').onclick = () => fetch('/api/info/open', { method: 'POST' });
loadInfo(false);
setInterval(() => loadInfo(false), 10000);
$('#portConnect').onclick = async () => {
  const port = hwConnected ? null : $('#portSel').value;
  if (!hwConnected && !port) return;
  const r = await (await fetch('/api/serial/connect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port }),
  })).json();
  if (r.error) toast('เชื่อมต่อไม่ได้: ' + r.error);
  setHw(r.connected || null);
};

// ================== Tabs / toast / splash ==================
$$('.tab').forEach((t) => (t.onclick = () => {
  $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
  $$('.pane').forEach((p) => p.classList.toggle('active', p.id === 'pane-' + t.dataset.tab));
}));
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}
$('#startBtn').onclick = () => {
  started = true;
  brain.ensureAudio();
  $('#splash').classList.add('hide');
  addMsg('sys', 'เริ่มจำลองแล้ว — ลองพิมพ์คุย กดไมค์พูด หรือเดินเข้าใกล้กล้องคอมเพื่อให้น้องมะลิทักทาย');
};
const params = new URLSearchParams(location.search);
if (params.has('autostart')) $('#startBtn').click();
if (params.get('view')) robot.setView(params.get('view'));
if (params.get('mask') === '0') { $('#showMask').checked = false; robot.setShowMask(false); }
if (params.get('tab')) document.querySelector(`.tab[data-tab="${params.get('tab')}"]`)?.click();
if (params.get('listen') === 'manual') setTimeout(() => brain.listenOnce(false), 300);
if (params.get('listen') === 'cont') $('#contListen').checked = true;
if (params.get('say')) setTimeout(() => brain.handleUserText(params.get('say')), 500);

// ================== Main loop ==================
const eyeHud = [$('#eyeR'), $('#eyeL')];
let last = performance.now();
function loop(now) {
  const dt = Math.min(100, now - last); last = now;

  if (started) brain.visionTick(now);
  brain.audioTick();
  if (!brain.currentAudio && !brain.synthSpeaking && +$('#sJaw').value > 0) jaw.level = +$('#sJaw').value;

  fw.update(dt, now);
  jaw.update(dt);
  robot.setCustomer(cam.present, cam.normX, cam.normY, cam.ratio);
  robot.update(fw, jaw);

  eyeHud.forEach((c, i) => drawEyeCanvas(c, fw, i));
  drawCamera();
  updateHud();
  requestAnimationFrame(loop);
}

function updateHud() {
  const [st, cls] = brain.statusText;
  const sb = $('#statusBar');
  sb.textContent = st; sb.className = 'status-bar ' + cls;
  const chip = $('#chipState');
  chip.textContent = brain.state; chip.className = 'chip st-' + brain.state;
  $('#chipFace').textContent = brain.facePresent ? `เห็นลูกค้า (ratio ${brain.faceRatio.toFixed(2)})` : 'ไม่มีลูกค้า';
  $('#chipFace').classList.toggle('on', brain.facePresent);
  $('#mPan').textContent = fw.servoPan + '°';
  $('#bPan').style.width = ((fw.servoPan - 30) / 120) * 100 + '%';
  $('#mTilt').textContent = fw.servoTilt + '°';
  $('#bTilt').style.width = ((fw.servoTilt - 50) / 80) * 100 + '%';
  $('#mJaw').textContent = Math.round(jaw.current) + '°';
  $('#bJaw').style.width = jaw.openness * 100 + '%';
  $$('#mLed s').forEach((s, i) => s.classList.toggle('on', jaw.level > i));

  const c = brain.computed;
  $('#rNorm').textContent = cam.present ? `${cam.normX.toFixed(2)} / ${cam.normY.toFixed(2)}` : '-';
  $('#rRatio').textContent = cam.present ? cam.ratio.toFixed(3) : '-';
  $('#rDist').textContent = cam.present ? `${(0.16 / (1.155 * cam.ratio)).toFixed(2)} ม.` : '-';
  $('#rPT').textContent = cam.present ? `${c.pan}° / ${c.tilt}°` : '-';
  $('#rEye').textContent = cam.present ? `${c.eyeX} / ${c.eyeY}` : '-';
}

syncOut();
refreshStatus();
setInterval(refreshStatus, 15000);
requestAnimationFrame(loop);
