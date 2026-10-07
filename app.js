/* ระบบบันทึกผลการทดสอบ BMS Smart Accounting · หน้าเว็บ
 * ข้อมูลข้อทดสอบมาจาก cases.js (สร้างจาก tools/build_web_app.py) + ข้อที่แอดมินเพิ่มในแท็บ "ข้อทดสอบ" ของ Google Sheet
 * ผลการทดสอบส่งไป Google Apps Script (config.js) ทุกครั้งที่เลือกผลหรือพิมพ์ ถ้าเน็ตหลุดจะเก็บไว้ในเครื่องแล้วส่งให้เองภายหลัง
 */
(function () {
  'use strict';
  const API = String((window.SA_CONFIG || {}).API_URL || '').trim();
  const DATA = window.SA_DATA;
  const BUILTIN = DATA.cases;
  const LABEL = { pass: 'ผ่าน', fail: 'ไม่ผ่าน', block: 'ติดปัญหา (ทดสอบต่อไม่ได้)' };
  const SHORT = { pass: 'ผ่าน', fail: 'ไม่ผ่าน', block: 'ติดปัญหา' };
  const DAYS = ['5 ต.ค. 2569', '6 ต.ค. 2569', '7 ต.ค. 2569', '8 ต.ค. 2569'];
  // คำอธิบายประเภทโจทย์ และเกณฑ์ตัดสินผล
  const TYPE_INFO = {
    Positive: { what: 'ใช้งานปกติ ระบบต้องทำได้และให้ผลตามที่คาดหวัง',
                pass: 'ทำได้ครบทุกขั้น และผลบนหน้าจอ / การบันทึกบัญชีตรงกับผลที่คาดหวัง',
                fail: 'ทำไม่ได้ หรือผลไม่ตรงกับที่คาดหวัง' },
    Negative: { what: 'ลองทำผิดหรือทำซ้ำ ระบบต้องป้องกันหรือแจ้งเตือน',
                pass: 'ระบบป้องกันได้ (ไม่ให้ทำ หรือแจ้งเตือน) ตามที่คาดหวัง',
                fail: 'ระบบยอมให้ทำรายการที่ผิด/ซ้ำได้ โดยไม่ป้องกันหรือไม่แจ้งเตือน' },
    E2E:      { what: 'ทำต่อเนื่องทั้งวงจร ข้อมูลต้องเชื่อมถึงกันทุกขั้น',
                pass: 'ทุกขั้นทำได้ ข้อมูลส่งต่อถูกต้อง และยอดสุดท้ายตรงกับที่คาดหวัง',
                fail: 'มีขั้นใดขั้นหนึ่งผิด (ระบุขั้นที่ผิดในช่องผลที่ได้จริง)' },
  };
  const BLOCK_INFO = 'ทดสอบต่อไม่ได้ด้วยเหตุอื่นที่ไม่ใช่ผลของข้อนี้ เช่น ไม่มีข้อมูลตั้งต้น ระบบเข้าไม่ได้ หรือข้อก่อนหน้ายังไม่ผ่าน';
  const ICON = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    clip: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.3 3.3 0 0 1 4.7 4.7L10.2 17a1.7 1.7 0 0 1-2.4-2.4L15 7.5"/></svg>',
    zoom: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M11 8v6M8 11h6"/></svg>',
  };
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };
  const KEY = { session: 'sa-session', state: u => 'sa-state:' + u, outbox: u => 'sa-outbox:' + u };
  const fmtTime = t => new Date(t).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  const fmtDT = t => new Date(t).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  let session = store.get(KEY.session, null);   // { token, user: { username, full, org } }
  let state = null;                             // { code, res: { [code]: { v, note, t, img: [], day, ver } }, current: { ver }, serverCases }
  let myAnswers = {};                          // คำชี้แจง / แนวทางแก้ไขของผู้ดูแลต่อผลของผู้ใช้นี้ { [code]: { text, by, t } }
  let outbox = [];                              // ผลที่ยังไม่ได้ส่ง (ล่าสุดของแต่ละข้อ)
  let LIST = BUILTIN.slice();                   // ข้อทดสอบที่แสดง (ข้อตั้งต้น + ข้อที่แอดมินเพิ่ม)
  const localShots = {};                        // ภาพที่แนบในรอบนี้ (ใช้แสดงและพิมพ์)
  let netDown = false, sending = null, retryMs = 0, retryTimer = 0, noteTimer = 0, query = '';

  // ======================================================================= ติดต่อหลังบ้าน
  // Google Apps Script บางครั้งค้าง 10–50 วินาทีแล้วตอบเป็นหน้า 404 และบางครั้งส่งคำตอบของคำขออื่นมาให้
  // (วัดแล้ว: โค้ดของเราทำงานเสร็จในไม่กี่มิลลิวินาที ความช้าอยู่ที่ระบบส่งคำตอบ script.googleusercontent.com ของ Google)
  // คำขอที่ส่งซ้ำได้อย่างปลอดภัย: ถ้ายังไม่ตอบภายในเวลาที่กำหนด ส่งคำขอสำรองคู่ขนาน แล้วใช้คำตอบที่มาถึงก่อน
  // (สมัครสมาชิก และแนบภาพ ไม่ส่งซ้ำ เพราะจะได้บัญชีหรือไฟล์ภาพซ้ำ)
  const HEDGE = { login: 1, me: 1, save: 1, dashboard: 1, logout: 1, setCurrent: 1, setOpenDays: 1, diag: 1, answer: 1 };
  const HEDGE_AT = [0, 7000, 16000];            // เวลาที่เริ่มคำขอที่ 1, 2, 3 (มิลลิวินาที)
  const MAX_TRY = 4;                            // รวมการส่งใหม่ทันทีเมื่อคำขอก่อนหน้าล้มเหลว
  const TIMEOUT = { upload: 120000, register: 60000 };
  function attempt(action, body, ctl) {
    const tm = setTimeout(() => ctl.abort(), TIMEOUT[action] || 45000);
    const rid = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);   // ระบบหลังบ้านส่งรหัสนี้กลับมา
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(Object.assign({ action, rid }, body)), signal: ctl.signal })
      .then(res => res.json())
      .then(j => {
        if (!j || typeof j.ok !== 'boolean') throw new Error('bad response');
        if (j.rid !== rid) throw new Error('response of another request');   // คำตอบไม่ใช่ของคำขอนี้: ไม่ใช้ แล้วส่งใหม่
        return j;
      })
      .finally(() => clearTimeout(tm));
  }
  function send(action, body) {
    if (!HEDGE[action]) return attempt(action, body, new AbortController());
    return new Promise((resolve, reject) => {
      let started = 0, failed = 0, done = false, lastJson = null;
      const ctls = [], timers = [];
      const finish = (fn, v) => { if (done) return; done = true; timers.forEach(clearTimeout); ctls.forEach(c => c.abort()); fn(v); };
      const launch = () => {
        if (done || started >= MAX_TRY || started - failed >= HEDGE_AT.length) return;
        started++;
        const ctl = new AbortController(); ctls.push(ctl);
        attempt(action, body, ctl).then(j => {
          // ระบบขัดข้องชั่วคราว (เช่น Google Sheet ตอบช้า) ถือเป็นความล้มเหลวที่ลองใหม่ได้
          if (!j.ok && j.code === 'SERVER') throw Object.assign(new Error('server'), { json: j });
          finish(resolve, j);
        }).catch(e => {
          if (e && e.json) lastJson = e.json;
          failed++;
          if (done) return;
          if (failed < started) return;                                   // ยังมีคำขออื่นค้างอยู่ รอคำตอบ
          // ไม่มีคำขอค้างอยู่: ส่งใหม่เกือบทันที (การบันทึกผลมีคิวส่งใหม่ของตัวเอง จึงแจ้ง "รอส่ง" ทันที)
          if (failed >= MAX_TRY || action === 'save') return lastJson ? finish(resolve, lastJson) : finish(reject, e);
          timers.push(setTimeout(launch, 1200));
        });
      };
      HEDGE_AT.forEach(t => timers.push(setTimeout(launch, t)));
    });
  }
  async function call(action, body) {
    if (!API) throw Object.assign(new Error('ยังไม่ได้ตั้งค่าที่อยู่ระบบหลังบ้าน (config.js)'), { code: 'CONFIG' });
    let j;
    try { j = await send(action, body); }
    catch (e) { throw Object.assign(new Error('ระบบตอบช้าหรือเชื่อมต่อไม่ได้'), { code: 'NET' }); }
    if (!j.ok) throw Object.assign(new Error(j.error || 'เกิดข้อผิดพลาด'), { code: j.code || 'SERVER' });
    if (j.current && state) applyCurrent(j.current);
    return j;
  }

  // ======================================================================= ข้อทดสอบ
  const SYS_ORDER = DATA.systems.map(s => s.n);
  const EXI = DATA.extraImg || {};   // ภาพประกอบของข้อที่เพิ่มผ่านแท็บข้อทดสอบ
  function buildList(serverCases) {
    const builtin = {}; BUILTIN.forEach(c => { builtin[c.code] = c; });
    const hidden = {}, extras = [];
    (serverCases || []).forEach(s => {
      if (builtin[s.code]) { if (!s.show) hidden[s.code] = true; return; }
      if (!s.show || !s.code) return;
      const info = TYPE_INFO[s.type] ? s.type : 'Positive';
      extras.push({ sys: 'X', sysName: s.sysName || 'ข้อทดสอบเพิ่มเติม', sec: 'ข้อทดสอบ', code: s.code, task: s.task, type: info,
                    typeNote: '', slot: s.slot, menu: s.menu, pre: '', steps: String(s.steps || '').split('\n').map(x => x.trim()).filter(Boolean),
                    data: s.data, sample: [], items: null, jes: [], expect: s.expect, note: '', img: (EXI[s.code] || [])[0] || '', shotCap: (EXI[s.code] || [])[1] || '', extra: true });
    });
    const out = [];
    const groups = SYS_ORDER.concat(extras.map(e => e.sysName).filter(n => SYS_ORDER.indexOf(n) < 0));
    groups.filter((g, i) => groups.indexOf(g) === i).forEach(g => {
      BUILTIN.forEach(c => { if (c.sysName === g && !hidden[c.code]) out.push(c); });
      extras.forEach(c => { if (c.sysName === g) out.push(c); });
    });
    // ผู้ทดสอบเห็นเฉพาะข้อของวันที่เปิดให้ทดสอบ (ผู้ดูแลเห็นทุกข้อ) ข้อที่บันทึกแล้วยังแสดงเสมอ
    const days = openDays(), admin = session && session.user.role === 'admin';
    LIST = out.filter(c => admin || !c.slot || days.some(d => c.slot.indexOf(d) >= 0) || ((state && state.res[c.code]) || {}).v);
    if (!LIST.length) LIST = out;
    const ps = $('printSys'), pk = ps.value, sy = LIST.map(c => c.sysName).filter((g, i, a) => a.indexOf(g) === i);
    ps.innerHTML = '<option value="">พิมพ์ทุกระบบ</option>' + sy.map(g => `<option value="${esc(g)}" ${g === pk ? 'selected' : ''}>${esc(g)}</option>`).join('');
  }
  const TEST_DAYS = ['5 ต.ค. 2569', '6 ต.ค. 2569', '7 ต.ค. 2569', '8 ต.ค. 2569'];
  function openDays() { const d = state && state.current && state.current.days; return d && d.length ? d : TEST_DAYS.slice(0, 1); }
  const idxOf = code => LIST.findIndex(c => c.code === code);
  const cur = () => LIST[Math.max(0, idxOf(state.code))] || LIST[0];
  const res = code => state.res[code] || (state.res[code] = {});
  const pending = code => outbox.some(o => o.code === code);
  function counts() {
    const n = { pass: 0, fail: 0, block: 0, todo: 0 };
    LIST.forEach(c => { n[(state.res[c.code] || {}).v || 'todo']++; });
    return n;
  }
  function defaultDay(c) {
    const d = new Date();
    if (d.getFullYear() === 2026 && d.getMonth() === 9 && d.getDate() >= 5 && d.getDate() <= 8) return DAYS[d.getDate() - 5];
    const m = /^(\d+) ต\.ค\. 2569/.exec(c.slot || '');
    return m ? m[1] + ' ต.ค. 2569' : DAYS[0];
  }
  function applyCurrent(cu) {
    if (cu && cu.days && JSON.stringify(cu.days) !== JSON.stringify(state.current.days || [])) {
      state.current.days = cu.days; persist();
      if (session) { buildList(state.serverCases); if (!$('app').hidden) render(); }
    }
    if (!cu || !cu.ver || state.current.ver === cu.ver) return;
    state.current.ver = cu.ver; persist();
    $('curVer').textContent = cu.ver;
    const c = cur(), r = state.res[c.code] || {};
    if (!r.ver && $('ver') && document.activeElement !== $('ver')) $('ver').value = cu.ver;
  }
  function persist() {
    if (!session) return;
    store.set(KEY.state(session.user.username), state);
    store.set(KEY.outbox(session.user.username), outbox);
  }

  // ======================================================================= เข้าสู่ระบบ / สมัคร
  function showAuth(view, msg) {
    $('app').hidden = true; $('auth').hidden = false;
    $('loginForm').hidden = view !== 'login'; $('regForm').hidden = view !== 'reg';
    $('lerr').textContent = view === 'login' ? (msg || '') : ''; $('rerr').textContent = '';
    $('cfgWarn').hidden = !!API;
    setTimeout(() => { const f = view === 'login' ? $('lu') : $('rn'); if (f && !('ontouchstart' in window)) f.focus(); }, 60);
  }
  document.querySelectorAll('.eye').forEach(b => b.onclick = () => { const i = $(b.dataset.for); i.type = i.type === 'password' ? 'text' : 'password'; });
  $('toReg').onclick = () => showAuth('reg');
  $('radm').onchange = e => { $('radmBox').hidden = !e.target.checked; };
  $('toLogin').onclick = () => showAuth('login');
  async function busy(btn, label, fn) {
    const old = btn.textContent; btn.disabled = true; btn.textContent = label;
    const slow = setTimeout(() => { btn.textContent = 'ระบบตอบช้า กำลังรอผล…'; }, 8000);
    try { await fn(); } finally { clearTimeout(slow); btn.disabled = false; btn.textContent = old; }
  }
  // ปลุกระบบหลังบ้านตั้งแต่เปิดหน้าเข้าสู่ระบบ ให้กดเข้าสู่ระบบแล้วตอบเร็วขึ้น
  // (ถ้าเข้าระบบค้างไว้แล้ว หน้าเว็บโหลดผลทันทีอยู่แล้ว ไม่ต้องส่งคำขอเพิ่ม)
  if (API && !(session && session.token)) fetch(API, { method: 'GET' }).catch(() => {});
  const errText = e => e.code === 'NET' ? 'ระบบตอบช้าหรือเชื่อมต่อไม่ได้ กรุณาลองใหม่อีกครั้ง' : e.message;
  $('loginForm').onsubmit = e => {
    e.preventDefault();
    const u = $('lu').value.trim().toLowerCase(), p = $('lp').value;
    if (!u || !p) { $('lerr').textContent = 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน'; return; }
    busy($('loginBtn'), 'กำลังเข้าสู่ระบบ…', async () => {
      try { const j = await call('login', { username: u, password: p }); $('lp').value = ''; start(j); }
      catch (err) { $('lerr').textContent = errText(err); }
    });
  };
  $('regForm').onsubmit = e => {
    e.preventDefault();
    const v = id => $(id).value.trim();
    const full = v('rn'), org = v('ro'), u = v('ru').toLowerCase(), inv = v('ri'), p = $('rp').value, p2 = $('rp2').value;
    const admin = $('radm').checked, adminCode = v('rac');
    const err = m => { $('rerr').textContent = m; };
    if (!full || !u || !p || !inv) return err('กรุณากรอกช่องที่มีเครื่องหมาย * ให้ครบ');
    if (!/^[a-z0-9._-]{3,40}$/.test(u)) return err('ชื่อผู้ใช้ใช้ได้เฉพาะ a-z 0-9 . _ - อย่างน้อย 3 ตัว');
    if (p.length < 6) return err('รหัสผ่านต้องมีอย่างน้อย 6 ตัว');
    if (p !== p2) return err('รหัสผ่านทั้งสองช่องไม่ตรงกัน');
    if (admin && !adminCode) return err('กรุณากรอกรหัสผู้ดูแล');
    busy($('regBtn'), 'กำลังสมัคร…', async () => {
      try {
        const j = await call('register', { full, org, username: u, invite: inv, password: p, admin, adminCode });
        ['rn', 'ro', 'ru', 'ri', 'rp', 'rp2', 'rac'].forEach(id => { $(id).value = ''; });
        $('radm').checked = false; $('radmBox').hidden = true;
        start(j, true);
      } catch (e2) { err(errText(e2)); }
    });
  };
  function start(j, fresh) {
    session = { token: j.token, user: j.user };
    store.set(KEY.session, session);
    enterApp(fresh, j.current, j.results ? j : null);
  }
  function expire(msg) {
    session = null; store.del(KEY.session); hideDash();
    showAuth('login', msg || 'หมดเวลาเข้าระบบ กรุณาเข้าสู่ระบบใหม่ (ผลที่ยังไม่ได้ส่งจะส่งต่อให้หลังเข้าระบบ)');
  }
  $('logout').onclick = () => {
    if (outbox.length && !confirm(`ยังมีผลที่ยังไม่ได้ส่งเข้าระบบ ${outbox.length} ข้อ\nถ้าออกจากระบบตอนนี้ ผลจะยังเก็บไว้ในเครื่องนี้ และส่งให้เมื่อเข้าระบบอีกครั้ง\n\nออกจากระบบ?`)) return;
    if (session) call('logout', { token: session.token }).catch(() => {});
    session = null; store.del(KEY.session); closeSide(); hideDash();
    showAuth('login');
  };

  // ======================================================================= เข้าหน้าบันทึกผล
  async function enterApp(fresh, current, pre) {
    const u = session.user;
    state = Object.assign({ code: '', res: {}, current: { ver: '' }, serverCases: null }, store.get(KEY.state(u.username), {}));
    if (current && current.ver) state.current.ver = current.ver;
    if (current && current.days && current.days.length) state.current.days = current.days;   // วันที่เปิดให้ทดสอบจากการเข้าระบบ (ไม่ใช่ค่าเก่าในเครื่อง)
    outbox = store.get(KEY.outbox(u.username), []);
    buildList(state.serverCases);
    if (idxOf(state.code) < 0) state.code = LIST[0].code;
    $('auth').hidden = true; $('app').hidden = false;
    $('uname').textContent = u.full; $('whoName').textContent = u.full; $('whoOrg').textContent = u.org || '';
    $('av').textContent = (u.full.replace(/^(นาย|นางสาว|นาง|ดร\.|ผศ\.|รศ\.)\s*/, '').trim().charAt(0) || '?');
    $('curVer').textContent = state.current.ver || '-';
    $('dashBtn').hidden = u.role !== 'admin';
    showWelcome(fresh, true);
    render();
    try {
      const j = pre || await call('me', { token: session.token });
      session.user = j.user; store.set(KEY.session, session);
      $('dashBtn').hidden = j.user.role !== 'admin';
      state.serverCases = j.cases || null;
      myAnswers = {}; (j.answers || []).forEach(a => { myAnswers[a.code] = a; });
      if (j.current) { if (j.current.days && j.current.days.length) state.current.days = j.current.days; if (j.current.ver) { state.current.ver = j.current.ver; $('curVer').textContent = j.current.ver; } }
      const pend = {}; outbox.forEach(o => { pend[o.code] = true; });
      const merged = {};
      Object.keys(j.results || {}).forEach(code => { merged[code] = j.results[code]; });
      Object.keys(state.res).forEach(code => { if (pend[code]) merged[code] = state.res[code]; });
      state.res = merged;
      buildList(state.serverCases);
      if (idxOf(state.code) < 0) state.code = LIST[0].code;
      persist(); $('notice').hidden = true;
      showWelcome(fresh, false); render();
    } catch (e) {
      if (e.code === 'AUTH') return expire(e.message);
      notice('โหลดผลจากระบบไม่ได้ (' + errText(e) + ') กำลังแสดงผลที่เก็บในเครื่องนี้ ระบบจะลองส่งให้อัตโนมัติ');
      showWelcome(fresh, false);
    }
    flush();
  }
  function notice(msg) { $('notice').textContent = msg; $('notice').hidden = false; }
  function nextTodo() { const i = LIST.findIndex(c => !(state.res[c.code] || {}).v); return i < 0 ? null : LIST[i]; }
  function showWelcome(fresh, loading) {
    const w = $('welcome'), u = session.user, n = counts(), done = LIST.length - n.todo;
    const last = Math.max(0, ...Object.values(state.res).map(r => r.t || 0));
    const nx = nextTodo();
    const go = loading ? '' : nx ? `<button class="btn primary" id="resume">ทำต่อที่ ${esc(nx.code)} ›</button>` : '<span class="muted">บันทึกผลครบทุกข้อแล้ว กดพิมพ์สรุปผลได้ที่แถบด้านซ้าย</span>';
    const txt = loading ? `<div class="txt">กำลังโหลดผลที่บันทึกไว้…<small>${esc(u.full)}</small></div>`
      : done === 0 ? `<div class="txt">สวัสดี · ${esc(u.full)}<small>ยังไม่มีผลที่บันทึก เริ่มที่ข้อแรกได้เลย ผลจะบันทึกเข้าระบบอัตโนมัติทุกครั้งที่เลือกผลหรือพิมพ์ข้อความ</small></div>`
      : `<div class="txt">ยินดีต้อนรับกลับ · ${esc(u.full)}<small>บันทึกแล้ว ${done} / ${LIST.length} ข้อ${last ? ' · บันทึกล่าสุด ' + fmtDT(last) + ' น.' : ''}</small></div>`;
    w.innerHTML = txt + go + '<button class="x" id="wx" aria-label="ปิด">×</button>';
    w.hidden = false;
    $('wx').onclick = () => { w.hidden = true; };
    if ($('resume')) $('resume').onclick = () => goTo(nx.code);
  }

  // ======================================================================= แสดงผล
  function goTo(code) { state.code = code; const g = (LIST[idxOf(code)] || {}).sysName; if (state.fold && g) state.fold[g] = false; persist(); closeSide(); render(); window.scrollTo({ top: 0 }); }
  function renderTop() {
    const n = counts(), done = LIST.length - n.todo;
    $('progText').textContent = `บันทึกผลแล้ว ${done} / ${LIST.length} ข้อ`;
    $('menuCount').textContent = `${done}/${LIST.length}`;
    $('meter').style.width = (done / LIST.length * 100) + '%';
    renderNet();
  }
  function renderNet() {
    const el = $('net');
    const anySaved = state && Object.keys(state.res).some(k => state.res[k].t);
    if (!outbox.length) { el.className = 'net ok'; el.hidden = !anySaved; el.innerHTML = '✓ <span class="txt">บันทึกเข้าระบบแล้ว</span>'; return; }
    el.hidden = false;
    if (netDown) { el.className = 'net down'; el.innerHTML = `⚠ <span class="txt">ออฟไลน์ · </span>รอส่ง ${outbox.length}`; }
    else { el.className = 'net wait'; el.innerHTML = `⏳ <span class="txt">กำลังส่ง </span>${outbox.length}`; }
  }
  // แถบรายการข้อ: ย่อ/ขยายตามระบบ และกรองตามวันหรือสถานะ
  const CHEV = '<svg class="chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
  function matches(x) {
    const q = query.trim().toLowerCase(), r = state.res[x.code] || {}, f = state.filter || {};
    if (q && (x.code + ' ' + x.task + ' ' + x.menu).toLowerCase().indexOf(q) < 0) return false;
    if (f.day && (x.slot || '').indexOf(f.day) !== 0) return false;
    if (f.st === 'todo' && r.v) return false;
    if (f.st === 'done' && !r.v) return false;
    if (f.st === 'bad' && r.v !== 'fail' && r.v !== 'block') return false;
    return true;
  }
  function renderToc() {
    const c = cur(), f = state.filter || {}, filtering = !!(query.trim() || f.day || f.st);
    if (!state.fold) {                            // ครั้งแรก: ขยายเฉพาะระบบของข้อที่กำลังทำ
      state.fold = {}; LIST.forEach(x => { if (x.sysName !== c.sysName) state.fold[x.sysName] = true; });
    }
    const groups = LIST.map(x => x.sysName).filter((g, i, a) => a.indexOf(g) === i);
    const html = groups.map(g => {
      const items = LIST.filter(x => x.sysName === g), shown = items.filter(matches);
      if (filtering && !shown.length) return '';
      const done = items.filter(x => (state.res[x.code] || {}).v).length;
      const open = filtering || !state.fold[g];
      return `<button class="grp" data-g="${esc(g)}" aria-expanded="${open}">${CHEV}<span class="gn">${esc(g)}</span>`
        + (filtering ? `<span class="gm">${shown.length} ข้อ</span>` : '') + `<span class="gc">${done}/${items.length}</span></button>`
        + (open ? shown.map(x => {
          const r = state.res[x.code] || {};
          return `<button class="it" data-code="${esc(x.code)}" aria-current="${x === c}" title="${esc(x.task)}"><span class="dot ${r.v || ''} ${pending(x.code) ? 'pend' : ''}"></span><span class="c">${esc(x.code)}</span><span class="tk">${esc(x.task)}${r.v ? `<small class="rs ${r.v}">${SHORT[r.v]}${r.day ? ' · ' + esc(r.day) : ''}${r.ver ? ' · ' + esc(r.ver) : ''}</small>` : ''}</span></button>`;
        }).join('') : '');
    }).join('');
    $('toc').innerHTML = html || '<div class="muted" style="padding:10px 14px">ไม่พบข้อที่ตรงกับเงื่อนไข</div>';
    $('toc').querySelectorAll('.it').forEach(b => b.onclick = () => goTo(b.dataset.code));
    $('toc').querySelectorAll('.grp').forEach(b => b.onclick = () => {
      if (filtering) return;
      state.fold[b.dataset.g] = b.getAttribute('aria-expanded') === 'true'; persist(); renderToc();
    });
    const admin = session.user.role === 'admin', days = admin ? TEST_DAYS : openDays();
    $('fDay').innerHTML = '<option value="">' + (admin || days.length > 1 ? 'ทุกวัน' : 'วันที่เปิดทดสอบ') + '</option>' + days.map(d => `<option>${d}</option>`).join('');
    $('fDay').value = days.indexOf(f.day) >= 0 ? f.day : ''; $('fSt').value = f.st || '';
    const closed = TEST_DAYS.filter(d => openDays().indexOf(d) < 0);
    $('closedNote').hidden = admin || !closed.length;
    $('closedNote').textContent = 'ข้อของวันที่ ' + closed.map(d => d.replace(' 2569', '')).join(' และ ') + ' จะเปิดให้ทดสอบตามกำหนดการ';
    const a = $('toc').querySelector('[aria-current=true]');
    if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest' });
  }
  const itemsT = it => `<div class="scroll"><table><thead><tr>${it.head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>
    ${it.rows.map(r => `<tr>${r.map((v, i) => `<td class="${i >= 2 ? 'n' : ''}">${esc(v)}</td>`).join('')}</tr>`).join('')}
    ${it.foot.map(([k, v]) => `<tr class="foot"><td colspan="${it.head.length - 1}">${esc(k)}</td><td class="n">${esc(v)}</td></tr>`).join('')}</tbody></table></div>`;
  const jeT = j => `<div class="scroll"><table><thead><tr><th>บัญชี</th><th class="n" style="width:18%">เดบิต (บาท)</th><th class="n" style="width:18%">เครดิต (บาท)</th></tr></thead><tbody>
    ${j.lines.map(([a, d, c]) => `<tr><td>${c ? '<span class="cr">' + esc(a) + '</span>' : esc(a)}</td><td class="n">${d}</td><td class="n">${c}</td></tr>`).join('')}
    <tr class="foot"><td style="text-align:right">รวม (เดบิต = เครดิต)</td><td class="n">${j.total}</td><td class="n">${j.total}</td></tr></tbody></table></div>`;
  const sampleHead = c => c.type === 'Negative' ? 'สิ่งที่ต้องลองทำ' : 'ตัวอย่างข้อมูลที่บันทึก';

  function render() {
    renderTop(); renderToc();
    const c = cur(), r = state.res[c.code] || {}, i = idxOf(c.code), ti = TYPE_INFO[c.type] || TYPE_INFO.Positive;
    const row = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;
    const day = r.day || defaultDay(c), ver = r.ver || state.current.ver || '';
    $('sheet').innerHTML = `
      <div class="sh-hd"><span>${esc(c.sysName)} · ${esc(c.sec)}</span><span>${esc(c.slot)}</span></div>
      <h1><span class="code">${esc(c.code)}</span>${esc(c.task)}</h1>
      ${c.img ? `<figure><img src="${esc(c.img)}" alt="${esc(c.shotCap)}" data-zoom="1" loading="lazy"><figcaption>${ICON.zoom} ${esc(c.shotCap)} · คลิกที่ภาพเพื่อขยาย</figcaption></figure>` : ''}
      <table class="doc"><tbody>
        ${row('ประเภทโจทย์', `<div class="typ"><span class="tag ${c.type}">${esc(c.type)}</span><span>${esc(ti.what)}</span></div>`)}
        ${row('เมนู', esc(c.menu))}
        ${c.pre ? row('เงื่อนไขก่อนเริ่ม', esc(c.pre)) : ''}
        ${row(c.type === 'E2E' ? 'ขั้นตอนทดสอบ (ทำต่อเนื่องทั้งวงจร)' : 'ขั้นตอนทดสอบ', `<ol>${c.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>`)}
        ${c.data && c.data !== '-' ? row('ข้อมูลทดสอบ (ตามโจทย์)', esc(c.data)) : ''}
        ${c.sample.length ? row(sampleHead(c), c.sample.map(([k, v]) => `<b>${esc(k)}:</b> ${esc(v)}`).join('<br>')) : ''}
        ${row('ผลที่คาดหวัง', esc(c.expect))}
        ${c.note ? row('ข้อควรทราบ', esc(c.note)) : ''}
      </tbody></table>
      ${c.items ? `<div class="cap">รายการในเอกสาร (${esc(c.code)})</div>${itemsT(c.items)}` : ''}
      ${c.jes.map(j => `<div class="cap">ตัวอย่างการบันทึกบัญชี: ${esc(j.title)}</div>${jeT(j)}`).join('')}
      <section class="form" id="form"><div class="cap">บันทึกผลการทดสอบ ${esc(c.code)}</div>
        <table class="rt"><tbody>
          ${row('ผลทดสอบ', `<div class="checks" role="radiogroup" aria-label="ผลทดสอบ">${['pass', 'fail', 'block'].map(v =>
            `<label class="ck ${v} ${r.v === v ? 'on' : ''}"><input type="radio" name="res" value="${v}" ${r.v === v ? 'checked' : ''}><span class="box">${ICON.check}</span>${LABEL[v]}</label>`).join('')}</div>
            <div class="hint" style="margin-top:4px"><b>ผ่าน</b> = ${esc(ti.pass)} · <b>ไม่ผ่าน</b> = ${esc(ti.fail)} · <b>ติดปัญหา</b> = ${esc(BLOCK_INFO)}</div>`)}
          ${row('ผลที่ได้จริง / ปัญหาที่พบ', `<textarea id="note" placeholder="${c.type === 'Negative' ? 'เช่น ระบบแจ้งเตือนว่ารายการนี้บันทึกไปแล้ว และไม่ให้บันทึกซ้ำ' : 'เช่น บันทึกได้ เลขที่เอกสาร ... ยอดตรงตามที่คาด'}">${esc(r.note)}</textarea>`)}
          ${row('ภาพหน้าจอประกอบ', `<label class="att">${ICON.clip} แนบภาพ<input type="file" accept="image/*" id="file"></label>
            <span class="hint">· ถ้าใช้คอมพิวเตอร์ กด Print Screen แล้วกด Ctrl+V ในหน้านี้ได้เลย</span><div class="atts" id="atts"></div>`)}
          ${row('ผู้ทดสอบ', 'ลงชื่อ ' + esc(session.user.full))}
          ${row('วันที่ทดสอบ / รุ่นโปรแกรม', `<div class="dv"><select id="day" aria-label="วันที่ทดสอบ">${DAYS.map(d => `<option ${d === day ? 'selected' : ''}>${d}</option>`).join('')}</select>
            <input id="ver" value="${esc(ver)}" placeholder="เช่น v1.178.0" aria-label="รุ่นโปรแกรม"></div>
            <div class="hint">บันทึกแยกทุกข้อ ค่าเริ่มต้นคือรุ่นที่ผู้ดูแลระบบกำหนด ถ้าหน้าจอระบบแสดงรุ่นอื่นให้แก้ตามหน้าจอ</div>`)}
        </tbody></table>
        <div class="saved" id="saved"></div>
      </section>`;
    $('pos').textContent = `ข้อ ${i + 1} / ${LIST.length}`;
    $('prev').disabled = i <= 0; $('next').disabled = i >= LIST.length - 1;
    renderAtts(c.code); paintStatus(c.code);
    $('sheet').querySelectorAll('.ck').forEach(l => l.onclick = e => {
      e.preventDefault();
      const rr = res(c.code), v = l.querySelector('input').value;
      rr.v = rr.v === v ? '' : v;                  // กดซ้ำเพื่อยกเลิก
      stamp(c.code); queueSave(c.code);
      $('sheet').querySelectorAll('.ck').forEach(x => x.classList.toggle('on', rr.v === x.querySelector('input').value));
      renderTop(); renderToc();
    });
    $('note').oninput = e => {
      res(c.code).note = e.target.value; stamp(c.code); persist();
      setSaved('wait', '… กำลังพิมพ์ (จะบันทึกเมื่อหยุดพิมพ์)');
      clearTimeout(noteTimer); noteTimer = setTimeout(() => { noteTimer = 0; queueSave(c.code); }, 3000);
    };
    $('note').onblur = () => { if (noteTimer) { clearTimeout(noteTimer); noteTimer = 0; const rr = state.res[c.code]; if (rr && !pending(c.code) && rr._dirty) queueSave(c.code); } };
    $('day').onchange = e => { res(c.code).day = e.target.value; queueSave(c.code); };
    $('ver').onchange = e => { res(c.code).ver = e.target.value.trim(); queueSave(c.code); };
    $('file').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) attach(c.code, f); };
  }
  // ข้อที่เริ่มบันทึก: เก็บวันที่และรุ่นโปรแกรม ณ ตอนที่ทดสอบ
  function stamp(code) {
    const rr = res(code), c = LIST[idxOf(code)];
    if (!rr.day) rr.day = $('day') ? $('day').value : defaultDay(c);
    if (!rr.ver) rr.ver = ($('ver') && $('ver').value.trim()) || state.current.ver || '';
    rr._dirty = true;
  }
  function setSaved(cls, txt) { const el = $('saved'); if (el) { el.className = 'saved ' + cls; el.textContent = txt; } }
  function paintStatus(code) {
    if (cur().code !== code) return;
    const r = state.res[code] || {};
    if (pending(code)) setSaved('wait', netDown ? '⏳ รอส่ง · ยังเชื่อมต่อระบบไม่ได้ ผลเก็บไว้ในเครื่องแล้ว จะส่งให้อัตโนมัติ' : '⏳ กำลังบันทึกเข้าระบบ…');
    else if (r.t) setSaved('ok', '✓ บันทึกเข้าระบบแล้ว ' + fmtTime(r.t) + ' น. · วันที่ ' + (r.day || '-') + ' · รุ่น ' + (r.ver || '-'));
    else setSaved('', 'ผลจะบันทึกเข้าระบบอัตโนมัติเมื่อเลือกผลหรือพิมพ์ข้อความ');
  }
  function renderAtts(code) {
    const el = $('atts'); if (!el) return;
    const r = state.res[code] || {}, loc = localShots[code] || [];
    el.innerHTML = loc.map(s => `<img src="${s.src}" alt="ภาพที่แนบ" data-zoom="1" title="${esc(s.state)}">`).join('')
      + (r.img || []).map((u, k) => `<a href="${esc(u)}" target="_blank" rel="noopener">ภาพที่ ${k + 1} (Google Drive)</a>`).join(' · ')
      + loc.filter(s => s.state !== 'ok').map(s => `<span class="hint">${esc(s.state)}</span>`).join('');
  }

  // ======================================================================= บันทึกผล (คิวส่ง)
  function queueSave(code) {
    const r = res(code); delete r._dirty;
    outbox = outbox.filter(o => o.code !== code);
    outbox.push({ code, v: r.v || '', note: r.note || '', day: r.day || '', ver: r.ver || '', seq: Date.now() });
    persist(); paintStatus(code); renderNet(); renderToc();
    flush();
  }
  async function flush() {
    if (sending || !outbox.length || !session) return;
    const item = sending = outbox[0];
    try {
      const j = await call('save', Object.assign({ token: session.token }, item));
      outbox = outbox.filter(o => o !== item);
      if (!pending(item.code)) res(item.code).t = j.t;
      netDown = false; retryMs = 0; sending = null;
      persist(); paintStatus(item.code); renderNet(); renderToc();
      flush();
    } catch (e) {
      sending = null;
      if (e.code === 'AUTH') { persist(); return expire(e.message); }
      if (e.code === 'INPUT') {                   // ข้อมูลไม่ถูกต้อง ส่งซ้ำก็ไม่ผ่าน
        outbox = outbox.filter(o => o !== item); persist();
        toast('บันทึก ' + item.code + ' ไม่สำเร็จ: ' + e.message); paintStatus(item.code); renderNet(); flush(); return;
      }
      netDown = true; retryMs = Math.min(retryMs ? retryMs * 2 : 3000, 30000);
      paintStatus(item.code); renderNet(); renderToc();
      clearTimeout(retryTimer); retryTimer = setTimeout(flush, retryMs);
    }
  }
  window.addEventListener('online', () => { retryMs = 0; flush(); });
  window.addEventListener('beforeunload', e => {
    if (noteTimer && state) { clearTimeout(noteTimer); const c = cur(); queueSave(c.code); }
    if (outbox.length) { e.preventDefault(); e.returnValue = ''; }
  });

  // ======================================================================= แนบภาพ
  function shrink(file) {
    return new Promise((ok, bad) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        const s = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.naturalWidth * s); cv.height = Math.round(img.naturalHeight * s);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url); ok(cv.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); bad(new Error('เปิดไฟล์ภาพไม่ได้')); };
      img.src = url;
    });
  }
  async function attach(code, file) {
    if (!/^image\//.test(file.type)) return toast('แนบได้เฉพาะไฟล์ภาพ');
    let data;
    try { data = await shrink(file); } catch (e) { return toast(e.message); }
    const shot = { src: data, state: 'กำลังอัปโหลดภาพ…' };
    (localShots[code] = localShots[code] || []).push(shot);
    renderAtts(code);
    try {
      const j = await call('upload', { token: session.token, code, data });
      shot.state = 'ok';
      const r = res(code); r.img = (r.img || []).concat([j.url]); persist();
      toast('แนบภาพ ' + code + ' แล้ว');
    } catch (e) {
      if (e.code === 'AUTH') return expire(e.message);
      shot.state = 'อัปโหลดภาพไม่สำเร็จ (' + errText(e) + ') กรุณาแนบใหม่';
    }
    if (cur().code === code) renderAtts(code);
  }
  document.addEventListener('paste', e => {
    if ($('app').hidden || !session) return;
    const item = [...(e.clipboardData || {}).items || []].find(x => x.kind === 'file' && /^image\//.test(x.type));
    if (!item) return;
    e.preventDefault(); attach(cur().code, item.getAsFile());
  });

  // ======================================================================= ขยายภาพ / แถบข้อทดสอบ / อื่น ๆ
  document.addEventListener('click', e => {
    const img = e.target.closest && e.target.closest('img[data-zoom]');
    if (!img) return;
    const z = $('zoom'); z.querySelector('img').src = img.src; z.hidden = false; z.classList.remove('full');
  });
  $('zoom').onclick = e => {
    // ภาพขยายพอดีจอ · คลิกที่ภาพสลับเป็นขนาดจริง (เลื่อนดูได้) · คลิกพื้นหลังหรือปุ่ม × เพื่อปิด
    const z = $('zoom');
    if (e.target.tagName === 'IMG') { z.classList.toggle('full'); return; }
    z.hidden = true;
  };
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { $('zoom').hidden = true; closeSide(); }
    if ($('app').hidden || /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '')) return;
    if (e.key === 'ArrowRight' && !$('next').disabled) $('next').click();
    if (e.key === 'ArrowLeft' && !$('prev').disabled) $('prev').click();
  });
  function openSide() { $('side').classList.add('open'); $('scrim').classList.add('open'); $('menuBtn').setAttribute('aria-expanded', 'true'); }
  function closeSide() { $('side').classList.remove('open'); $('scrim').classList.remove('open'); $('menuBtn').setAttribute('aria-expanded', 'false'); }
  $('menuBtn').onclick = () => ($('side').classList.contains('open') ? closeSide() : openSide());
  $('scrim').onclick = closeSide;
  $('q').oninput = e => { query = e.target.value; renderToc(); };
  $('fDay').onchange = e => { state.filter = Object.assign({}, state.filter, { day: e.target.value }); persist(); renderToc(); };
  $('fSt').onchange = e => { state.filter = Object.assign({}, state.filter, { st: e.target.value }); persist(); renderToc(); };
  $('foldAll').onclick = () => { state.fold = {}; LIST.forEach(x => { state.fold[x.sysName] = true; }); persist(); renderToc(); };
  $('openAll').onclick = () => { state.fold = {}; LIST.forEach(x => { state.fold[x.sysName] = false; }); persist(); renderToc(); };
  $('prev').onclick = () => { const i = idxOf(cur().code); if (i > 0) goTo(LIST[i - 1].code); };
  $('next').onclick = () => { const i = idxOf(cur().code); if (i < LIST.length - 1) goTo(LIST[i + 1].code); };
  let toastTimer = 0;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500); }

  // ======================================================================= แดชบอร์ด (ผู้ดูแล)
  let dash = null, dashTimer = 0;
  async function showDash() {
    closeSide();
    document.querySelector('.layout').hidden = true; $('dash').hidden = false; $('dashBtn').classList.add('on');
    window.scrollTo({ top: 0 });
    await loadDash();
    clearInterval(dashTimer); dashTimer = setInterval(() => { if (!$('dash').hidden && !document.hidden) loadDash(); }, 60000);
  }
  function hideDash() {
    clearInterval(dashTimer);
    $('dash').hidden = true; document.querySelector('.layout').hidden = false; $('dashBtn').classList.remove('on');
  }
  let dashLoading = false;
  async function loadDash() {
    if (dashLoading) return;            // กำลังโหลดอยู่: ไม่ส่งคำขอซ้อน (กันระบบหลังบ้านรับคำขอเกิน)
    dashLoading = true;
    try { await loadDashOnce(); } finally { dashLoading = false; }
  }
  async function loadDashOnce() {
    $('dTime').textContent = dash ? 'กำลังโหลดข้อมูลล่าสุด…' : 'กำลังโหลด…';
    try {
      dash = await call('dashboard', { token: session.token });
      $('dErr').hidden = true; if (!ansEdit) renderDash(); else $('dTime').textContent = 'ข้อมูลล่าสุด ' + fmtDT(dash.time) + ' น.';
    } catch (e) {
      if (e.code === 'AUTH') return expire(e.message);
      $('dErr').textContent = 'โหลดข้อมูลไม่ได้: ' + errText(e); $('dErr').hidden = false;
      $('dTime').textContent = dash ? 'ข้อมูลล่าสุด ' + fmtDT(dash.time) + ' น.' : '';
    }
  }
  function renderDash() {
    // นับเฉพาะข้อของวันที่เปิดให้ทดสอบ
    const d = dash, od = (d.current.days && d.current.days.length) ? d.current.days : TEST_DAYS.slice(0, 1);
    const cases = d.cases.filter(c => c.show && (!c.slot || od.some(x => c.slot.indexOf(x) >= 0))), codes = {}, names = {};
    cases.forEach(c => { codes[c.code] = c; });
    d.testers.forEach(t => { names[t.username] = t.full; });
    const results = d.results.filter(r => codes[r.code]);
    const has = {}; results.forEach(r => { if (r.v) has[r.user] = true; });
    const people = d.testers.filter(t => t.role === 'tester' || has[t.username]);
    const R = {}; results.forEach(r => { (R[r.user] = R[r.user] || {})[r.code] = r; });
    const cnt = (list, v) => list.filter(r => r.v === v).length;
    const all = results.filter(r => r.v && people.some(p => p.username === r.user));
    const total = people.length * cases.length;
    $('dTime').textContent = 'ข้อมูลล่าสุด ' + fmtDT(d.time) + ' น. · รีเฟรชอัตโนมัติทุก 1 นาที · นับเฉพาะข้อของวันที่เปิดให้ทดสอบ (' + od.map(x => x.replace(' 2569', '')).join(', ') + ')';
    $('dSheet').href = d.sheetUrl;
    if (document.activeElement !== $('dVer')) $('dVer').value = d.current.ver || '';
    $('dDays').innerHTML = 'เปิดให้ทดสอบ ' + TEST_DAYS.map(x => `<label class="dck"><input type="checkbox" value="${x}" ${od.indexOf(x) >= 0 ? 'checked' : ''}>${x.replace(' 2569', '')}</label>`).join('')
      + '<button class="btn" id="dDaysSave">บันทึกวัน</button>';
    $('dDaysSave').onclick = saveDays;
    $('dKpi').innerHTML = [['ผู้ทดสอบ', people.length + ' ท่าน', ''], ['บันทึกผลแล้ว', `${all.length} / ${total}` + (total ? ` (${Math.round(all.length / total * 100)}%)` : ''), ''],
      ['ผ่าน', cnt(all, 'pass'), 'pass'], ['ไม่ผ่าน', cnt(all, 'fail'), 'fail'], ['ติดปัญหา', cnt(all, 'block'), 'block']]
      .map(([k, v, c]) => `<div class="kpi ${c}"><small>${k}</small><b>${v}</b></div>`).join('');
    const bar = (p, f, b, n) => `<div class="bar2" title="ผ่าน ${p} · ไม่ผ่าน ${f} · ติดปัญหา ${b} · จาก ${n}"><i class="p" style="width:${p / n * 100}%"></i><i class="f" style="width:${f / n * 100}%"></i><i class="b" style="width:${b / n * 100}%"></i></div>`;
    $('dTesters').innerHTML = people.length ? `<table><thead><tr><th class="n">ลำดับ</th><th>ผู้ทดสอบ</th><th>ความคืบหน้า</th><th class="n">ทำแล้ว</th><th class="n">ผ่าน</th><th class="n">ไม่ผ่าน</th><th class="n">ติดปัญหา</th><th>บันทึกล่าสุด</th></tr></thead><tbody>`
      + people.map((t, ti) => {
        const mine = Object.values(R[t.username] || {}).filter(r => r.v), last = Math.max(0, ...Object.values(R[t.username] || {}).map(r => r.t));
        return `<tr><td class="n">${ti + 1}</td><td><b>${esc(t.full)}</b>${t.role === 'admin' ? ' <span class="muted">(ผู้ดูแล)</span>' : ''}<br><span class="muted">${esc(t.org || t.username)}</span></td>
          <td>${bar(cnt(mine, 'pass'), cnt(mine, 'fail'), cnt(mine, 'block'), cases.length)}</td><td class="n">${mine.length}/${cases.length}</td>
          <td class="n">${cnt(mine, 'pass')}</td><td class="n">${cnt(mine, 'fail')}</td><td class="n">${cnt(mine, 'block')}</td><td>${last ? fmtDT(last) : '-'}</td></tr>`;
      }).join('') + '</tbody></table>' : '<span class="muted">ยังไม่มีผู้ทดสอบสมัครสมาชิก</span>';
    const sysNames = cases.map(c => c.sysName).filter((g, i, a) => a.indexOf(g) === i);
    $('dSys').innerHTML = `<table><thead><tr><th>ระบบ</th><th class="n">ข้อ</th><th class="n">ผ่าน</th><th class="n">ไม่ผ่าน</th><th class="n">ติดปัญหา</th><th class="n">ยังไม่ทำ</th></tr></thead><tbody>`
      + sysNames.map(g => {
        const cs = cases.filter(c => c.sysName === g), rs = all.filter(r => codes[r.code].sysName === g);
        return `<tr><td>${esc(g)}</td><td class="n">${cs.length}</td><td class="n">${cnt(rs, 'pass')}</td><td class="n">${cnt(rs, 'fail')}</td><td class="n">${cnt(rs, 'block')}</td><td class="n">${people.length * cs.length - rs.length}</td></tr>`;
      }).join('') + '</tbody></table>';
    const issues = all.filter(r => r.v === 'fail' || r.v === 'block').sort((a, b) => b.t - a.t);
    // แยกตามระบบ (เรียงตามลำดับระบบในข้อทดสอบ) และเลือกดูทีละระบบได้
    const sysOrder = d.cases.map(c => c.sysName).filter((g, i, a) => a.indexOf(g) === i);
    const isys = sysOrder.filter(g => issues.some(r => codes[r.code].sysName === g));
    const pw = $('dPrintWho'), pwk = pw.value;   // แถบพิมพ์ผลรายบุคคล: ผู้ทดสอบ + ระบบ
    pw.innerHTML = people.map(t => `<option value="${esc(t.username)}" ${t.username === pwk ? 'selected' : ''}>${esc(t.full)}</option>`).join('');
    const psel = $('dPrintSys'), pkeep = psel.value;
    psel.innerHTML = '<option value="">พิมพ์ทุกระบบ</option>' + sysOrder.map(g => `<option value="${esc(g)}" ${g === pkeep ? 'selected' : ''}>${esc(g)}</option>`).join('');
    const isel = $('dIssueSys'), ikeep = isel.value;
    isel.innerHTML = '<option value="">ทุกระบบ</option>' + isys.map(g => `<option value="${esc(g)}" ${g === ikeep ? 'selected' : ''}>${esc(g)} (${issues.filter(r => codes[r.code].sysName === g).length})</option>`).join('');
    const AK = {}; (d.answers || []).forEach(a => { AK[a.user + '|' + a.code] = a; });
    const dr = $('ansTxt'); if (dr) ansDraft = dr.value;   // เก็บข้อความที่กำลังพิมพ์ไว้ ถ้ามีการวาดใหม่
    const ansCell = r => {
      const k = r.user + '|' + r.code, a = AK[k];
      if (ansEdit === k) return `<div class="ans-ed"><textarea id="ansTxt" rows="3" placeholder="เช่น ระบบทำได้ โดยเข้าเมนู … / วิธีดูข้อมูลที่ถูกต้องคือ … / แก้ไขแล้วในรุ่น …">${esc(ansDraft)}</textarea>
        <div><button class="btn primary sm" data-ans-save="${esc(k)}">บันทึกคำชี้แจง</button> <button class="btn sm" data-ans-cancel="1">ยกเลิก</button></div></div>`;
      return a ? `<div class="ans"><b>คำชี้แจงผู้ดูแล:</b> ${esc(a.text).replace(/\n/g, '<br>')}<small>${esc(a.by)} · ${fmtDT(a.t)} น. <button class="ans-btn" data-ans="${esc(k)}">แก้ไข</button></small></div>`
               : `<div><button class="ans-btn" data-ans="${esc(k)}">+ เพิ่มคำชี้แจง / วิธีที่ถูกต้อง</button></div>`;
    };
    let ino = 0;
    $('dIssueN').textContent = issues.length ? `(${issues.length} รายการ)` : '';
    $('dIssues').innerHTML = issues.length ? `<table><thead><tr><th class="n">ลำดับ</th><th>เวลา</th><th>ผู้ทดสอบ</th><th>ข้อ</th><th>โจทย์</th><th>ผล</th><th>ผลที่ได้จริง / ปัญหาที่พบ</th><th>วันที่ / รุ่น</th><th>ภาพ</th></tr></thead><tbody>`
      + (isel.value ? [isel.value] : isys).map(g => {
        const rs = issues.filter(r => codes[r.code].sysName === g);
        return `<tr class="igrp"><td colspan="9">${esc(g)} · ${rs.length} รายการ</td></tr>` + rs.map(r => `<tr><td class="n">${++ino}</td><td>${fmtDT(r.t)}</td><td>${esc(names[r.user] || r.user)}</td><td><b>${esc(r.code)}</b></td><td>${esc(codes[r.code].task)}</td>
          <td><span class="pill ${r.v}">${SHORT[r.v]}</span></td><td>${esc(r.note) || '<span class="muted">-</span>'}${ansCell(r)}</td><td>${esc(r.day)}<br>${esc(r.ver)}</td>
          <td>${r.img.map((u, k) => `<a href="${esc(u)}" target="_blank" rel="noopener">${k + 1}</a>`).join(' ') || '-'}</td></tr>`).join('');
      }).join('') + '</tbody></table>'
      : '<span class="muted">ยังไม่มีข้อที่ไม่ผ่านหรือติดปัญหา</span>';
    const sel = $('dSysF'), keep = sel.value;
    // ตัวเลือกระบบแสดงทุกระบบ รวมระบบที่ยังไม่ถึงวันเปิดทดสอบ (เช่น Herbal ERP วันที่ 8)
    const allCases = d.cases.filter(c => c.show), allSys = allCases.map(c => c.sysName).filter((g, i, a) => a.indexOf(g) === i);
    sel.innerHTML = '<option value="">ทุกระบบ</option>' + allSys.map(g => `<option value="${esc(g)}" ${g === keep ? 'selected' : ''}>${esc(g)}${sysNames.indexOf(g) < 0 ? ' (ยังไม่เปิดให้ทดสอบ)' : ''}</option>`).join('');
    const mcases = sel.value ? allCases.filter(c => c.sysName === sel.value) : cases;
    const sym = { pass: '✓', fail: '✗', block: '!' };
    $('dMatrix').innerHTML = people.length ? `<table class="mx"><thead><tr><th class="n">ลำดับ</th><th class="l">ข้อทดสอบ</th>${people.map(t => `<th class="u">${esc(t.full)}</th>`).join('')}</tr></thead><tbody>`
      + mcases.map((c, ci) => `<tr><td class="n">${ci + 1}</td><td class="l"><b>${esc(c.code)}</b> ${esc(c.task)}</td>` + people.map(t => {
        const r = (R[t.username] || {})[c.code] || {};
        const tip = r.v ? `${SHORT[r.v]} · ${r.day || ''} · ${r.ver || ''}${r.note ? '\n' + r.note : ''}` : 'ยังไม่ทำ';
        return `<td title="${esc(tip)}"><b class="m ${r.v || ''}">${sym[r.v] || '·'}</b></td>`;
      }).join('') + '</tr>').join('') + '</tbody>'
      // แถวสรุปของแต่ละผู้ทดสอบ นับเฉพาะข้อที่แสดงในตาราง (ตามระบบที่เลือก)
      + `<tfoot><tr><td class="l" colspan="2">สรุป</td>` + people.map(t => {
        const mine = mcases.map(c => ((R[t.username] || {})[c.code] || {}).v).filter(Boolean), k = v => mine.filter(x => x === v).length;
        return `<td><span class="ms done">ทำแล้ว ${mine.length}/${mcases.length}</span><span class="ms pass">ผ่าน ${k('pass')}</span>`
          + `<span class="ms fail">ไม่ผ่าน ${k('fail')}</span><span class="ms block">ติดปัญหา ${k('block')}</span><span class="ms todo">ยังไม่ทำ ${mcases.length - mine.length}</span></td>`;
      }).join('') + '</tr></tfoot></table>' : '';
    $('dLog').innerHTML = d.log.length ? `<table><thead><tr><th class="n">ลำดับ</th><th>เวลา</th><th>ผู้ใช้</th><th>รายการ</th><th>ข้อ</th><th>ผล</th><th>ข้อความ</th></tr></thead><tbody>`
      + d.log.map((l, li) => `<tr><td class="n">${li + 1}</td><td>${fmtDT(l.t)}</td><td>${esc(l.full || l.user)}</td><td>${esc(l.what)}</td><td>${esc(l.code)}</td><td>${l.from || l.to ? esc(l.from || '-') + ' → ' + esc(l.to || '-') : ''}</td><td>${esc(l.note)}</td></tr>`).join('') + '</tbody></table>'
      : '<span class="muted">ยังไม่มีกิจกรรม</span>';
  }
  $('dashBtn').onclick = () => ($('dash').hidden ? showDash() : hideDash());
  $('dBack').onclick = hideDash;
  $('dRefresh').onclick = loadDash;
  const stamp8 = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear() + 543}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
  $('dPdf').onclick = () => {
    if (!dash) return toast('ยังไม่มีข้อมูล');
    document.body.classList.add('print-dash');
    const title = document.title; document.title = 'แดชบอร์ดสรุปผลการทดสอบ-' + stamp8();
    const done = () => { document.body.classList.remove('print-dash'); document.title = title; window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print(); setTimeout(done, 1500);
  };
  function loadScript(src) {
    return new Promise((ok, bad) => { if (window.htmlToImage) return ok(); const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => bad(new Error('โหลดเครื่องมือสร้างรูปไม่ได้')); document.head.appendChild(s); });
  }
  $('dImg').onclick = async () => {
    if (!dash) return toast('ยังไม่มีข้อมูล');
    const btn = $('dImg'); btn.disabled = true; toast('กำลังสร้างรูปภาพ…');
    try {
      // html-to-image วาดผ่านเบราว์เซอร์เอง (รองรับฟอนต์ไทยและสีแบบ color-mix)
      await loadScript('https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.js');
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      const el = $('dash');
      document.body.classList.add('snap-dash'); await new Promise(r => requestAnimationFrame(() => setTimeout(r, 50)));
      const url = await window.htmlToImage.toPng(el, { pixelRatio: 2, backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff', style: { margin: '0' }, width: el.offsetWidth,
        filter: n => !(n.classList && (n.classList.contains('dash-act') || n.id === 'dErr')) });
      const a = document.createElement('a'); a.download = 'แดชบอร์ดสรุปผลการทดสอบ-' + stamp8() + '.png';
      document.body.classList.remove('snap-dash');
      a.href = url; document.body.appendChild(a); a.click(); a.remove();
      toast('บันทึกรูปภาพแล้ว (ดูในโฟลเดอร์ดาวน์โหลด)');
    } catch (e) { document.body.classList.remove('snap-dash'); toast('สร้างรูปภาพไม่สำเร็จ: ' + e.message); }
    btn.disabled = false;
  };
  async function saveDays() {
    const days = [...document.querySelectorAll('#dDays input:checked')].map(i => i.value);
    if (!days.length) return toast('เลือกอย่างน้อย 1 วัน');
    try {
      await call('setOpenDays', { token: session.token, days });
      toast('เปิดให้ทดสอบ: ' + days.join(', ') + ' ผู้ทดสอบเห็นเมื่อรีเฟรชหน้าเว็บ');
      await loadDash();
    } catch (e) { if (e.code === 'AUTH') return expire(e.message); toast('บันทึกไม่สำเร็จ: ' + errText(e)); }
  }
  $('dVerSave').onclick = async () => {
    const ver = $('dVer').value.trim();
    if (!ver) return toast('กรุณากรอกรุ่นโปรแกรม');
    const btn = $('dVerSave'); btn.disabled = true;
    try {
      await call('setCurrent', { token: session.token, ver });
      toast('ตั้งรุ่นโปรแกรมปัจจุบันเป็น ' + ver + ' แล้ว ข้อที่ทดสอบหลังจากนี้จะใช้รุ่นนี้');
      await loadDash();
    } catch (e) { if (e.code === 'AUTH') return expire(e.message); toast('บันทึกรุ่นไม่สำเร็จ: ' + errText(e)); }
    btn.disabled = false;
  };
  $('dSysF').onchange = () => { if (dash) renderDash(); };
  $('dIssueSys').onchange = () => { if (dash) renderDash(); };
  // คำชี้แจงของผู้ดูแลต่อข้อที่ไม่ผ่าน/ติดปัญหา (ผู้ทดสอบอาจไม่ทราบวิธีดูข้อมูลที่ถูกต้อง)
  let ansEdit = null, ansDraft = '';
  $('dIssues').onclick = async e => {
    const b = e.target.closest('button');
    if (!b || !dash) return;
    if (b.dataset.ans) {
      const a = (dash.answers || []).find(x => x.user + '|' + x.code === b.dataset.ans);
      ansEdit = b.dataset.ans; ansDraft = a ? a.text : ''; renderDash();
      const t = $('ansTxt'); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
    } else if (b.dataset.ansCancel) {
      ansEdit = null; ansDraft = ''; renderDash();
    } else if (b.dataset.ansSave) {
      const k = b.dataset.ansSave, i = k.indexOf('|'), user = k.slice(0, i), code = k.slice(i + 1), text = ($('ansTxt').value || '').trim();
      b.disabled = true;
      try {
        const j = await call('answer', { token: session.token, user, code, text });
        dash.answers = (dash.answers || []).filter(x => !(x.user === user && x.code === code));
        if (text) dash.answers.push(j.answer);
        ansEdit = null; ansDraft = ''; renderDash();
        toast(text ? 'บันทึกคำชี้แจงแล้ว' : 'ลบคำชี้แจงแล้ว');
      } catch (er) { if (er.code === 'AUTH') return expire(er.message); b.disabled = false; toast('บันทึกไม่สำเร็จ: ' + errText(er)); }
    }
  };
  // ผู้ดูแลพิมพ์สรุปผล / ทั้งเล่มของผู้ทดสอบแต่ละท่าน (ใช้ผลจากแดชบอร์ด)
  function printTester(mode) {
    const t = dash && dash.testers.find(x => x.username === $('dPrintWho').value);
    if (!t) return toast('เลือกผู้ทดสอบก่อน');
    const res = {}; dash.results.filter(r => r.user === t.username).forEach(r => { res[r.code] = r; });
    const od = (dash.current.days && dash.current.days.length) ? dash.current.days : TEST_DAYS.slice(0, 1);
    const list = LIST.filter(c => !c.slot || od.some(x => c.slot.indexOf(x) >= 0) || (res[c.code] || {}).v);
    const answers = {}; (dash.answers || []).filter(x => x.user === t.username).forEach(x => { answers[x.code] = x; });
    doPrint(mode, { u: t, res, list, shots: {}, answers, sys: $('dPrintSys').value });
  }
  $('dPrintSum').onclick = () => printTester('summary');
  $('dPrintAll').onclick = () => printTester('full');

  // ======================================================================= ฉบับพิมพ์
  // who = ผลของผู้ทดสอบที่จะพิมพ์ (ค่าเริ่มต้น = ผู้ใช้ที่เข้าระบบ) · who.sys = พิมพ์เฉพาะระบบ (ว่าง = ทุกระบบ)
  // who.answers = คำชี้แจง / แนวทางแก้ไขของผู้ดูแลระบบ แยกตามรหัสข้อ
  function buildPrint(mode, who) {
    who = who || { u: session.user, res: state.res, list: LIST, shots: localShots, answers: myAnswers, sys: $('printSys').value };
    const u = who.u, RES = who.res, ANS = who.answers || {}, PL = who.sys ? who.list.filter(c => c.sysName === who.sys) : who.list;
    const hd = s => `<div class="p-hd"><span>เอกสารประกอบการทดสอบระบบ BMS Smart Accounting · ${esc(s)}</span><span>ผู้ทดสอบ: ${esc(u.full)}</span></div>`;
    const mark = (r, v) => `<span class="mark">${r.v === v ? '☑' : '☐'} ${LABEL[v]}</span>`;
    const row = (k, html) => `<tr><th class="l">${k}</th><td>${html}</td></tr>`;
    const blk = (cap, inner) => `<div class="blk"><div class="cap">${cap}</div>${inner}</div>`;
    const ans = code => ANS[code] && ANS[code].text ? esc(ANS[code].text).replace(/\n/g, '<br>') : '';
    const pages = mode !== 'full' ? [] : PL.map((c, k) => {
      const r = RES[c.code] || {}, ti = TYPE_INFO[c.type] || TYPE_INFO.Positive;
      return `<div class="p-page p">${hd(c.sysName)}
        <div class="p-title">${esc(c.code)} &nbsp;${esc(c.task)}</div>
        ${c.img ? `<figure><img src="${esc(c.img)}" alt=""><figcaption>ภาพที่ ${k + 1} ${esc(c.shotCap)}</figcaption></figure>` : ''}
        <table>
          ${row('ประเภทโจทย์', `<span class="tag ${c.type}">${esc(c.type)}</span> ${esc(ti.what)}`)}
          ${row('ช่วงเวลา', esc(c.slot))}${row('เมนู', esc(c.menu))}
          ${c.pre ? row('เงื่อนไขก่อนเริ่ม', esc(c.pre)) : ''}
          ${row('ขั้นตอนทดสอบ', `<ol>${c.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>`)}
          ${c.data && c.data !== '-' ? row('ข้อมูลทดสอบ (ตามโจทย์)', esc(c.data)) : ''}
          ${c.sample.length ? row(sampleHead(c), c.sample.map(([kk, v]) => `<b>${esc(kk)}:</b> ${esc(v)}`).join('<br>')) : ''}
          ${row('ผลที่คาดหวัง', esc(c.expect))}${c.note ? row('ข้อควรทราบ', esc(c.note)) : ''}
        </table>
        ${c.items ? blk(`รายการในเอกสาร (${esc(c.code)})`, itemsT(c.items).replace(/<\/?div[^>]*>/g, '')) : ''}
        ${c.jes.map(j => blk(`ตัวอย่างการบันทึกบัญชี ${esc(c.code)}: ${esc(j.title)}`, jeT(j).replace(/<\/?div[^>]*>/g, ''))).join('')}
        <div class="box"><div class="cap">บันทึกผลการทดสอบ ${esc(c.code)}</div><table>
          ${row('ผลทดสอบ', mark(r, 'pass') + mark(r, 'fail') + mark(r, 'block'))}
          <tr><th class="l">ผลที่ได้จริง / ปัญหาที่พบ</th><td style="height:16mm">${esc(r.note).replace(/\n/g, '<br>')}</td></tr>
          ${ans(c.code) ? row('คำชี้แจง / แนวทางแก้ไข (ผู้ดูแลระบบ)', ans(c.code)) : ''}
          ${(r.img || []).length ? row('ภาพหน้าจอประกอบ', `${r.img.length} ภาพ (เก็บใน Google Drive ของทีม BMS)`) : ''}
          ${row('ผู้ทดสอบ', 'ลงชื่อ ' + esc(u.full))}
          ${row('วันที่ / รุ่นโปรแกรม', r.v || r.note ? `วันที่ ${esc(r.day || '-')} &emsp;&emsp; รุ่นโปรแกรม ${esc(r.ver || '-')}` : '<span class="dots">&nbsp;</span>')}
        </table></div>
        ${(who.shots[c.code] || []).map(s => `<figure><img src="${s.src}" alt=""><figcaption>ภาพหน้าจอที่ผู้ทดสอบแนบ</figcaption></figure>`).join('')}
      </div>`;
    });
    const n = { pass: 0, fail: 0, block: 0, todo: 0 }; PL.forEach(c => { n[(RES[c.code] || {}).v || 'todo']++; });
    const bySys = PL.map(c => c.sysName).filter((g, i, a) => a.indexOf(g) === i).map(g => {
      const items = PL.filter(c => c.sysName === g), k = v => items.filter(c => ((RES[c.code] || {}).v || 'todo') === v).length;
      return `<tr><td>${esc(g)}</td><td class="n">${items.length}</td><td class="n">${k('pass')}</td><td class="n">${k('fail')}</td><td class="n">${k('block')}</td><td class="n">${k('todo')}</td></tr>`;
    }).join('');
    const summary = `<div class="p-page p">${hd(who.sys || 'สรุปผล')}
      <div class="p-title">สรุปผลการทดสอบระบบ BMS Smart Accounting${who.sys ? ' · ' + esc(who.sys) : ''}</div>
      <table><tr><th class="l">ผู้ทดสอบ</th><td>${esc(u.full)}${u.org ? ' · ' + esc(u.org) : ''}</td></tr>
        <tr><th class="l">ระบบที่พิมพ์</th><td>${who.sys ? esc(who.sys) : 'ทุกระบบ'}</td></tr>
        <tr><th class="l">พิมพ์เมื่อ</th><td>${esc(new Date().toLocaleString('th-TH', { dateStyle: 'long', timeStyle: 'short' }))} น.</td></tr></table>
      <table><thead><tr><th>ระบบ</th><th class="n">จำนวนข้อ</th><th class="n">ผ่าน</th><th class="n">ไม่ผ่าน</th><th class="n">ติดปัญหา</th><th class="n">ยังไม่ทดสอบ</th></tr></thead>
        ${bySys}<tr class="foot"><td>รวม</td><td class="n">${PL.length}</td><td class="n">${n.pass}</td><td class="n">${n.fail}</td><td class="n">${n.block}</td><td class="n">${n.todo}</td></tr></table>
      <table class="sum"><thead><tr><th style="width:5%">#</th><th style="width:10%">ข้อ</th><th>โจทย์</th><th style="width:9%">ประเภท</th><th style="width:10%">ผล</th><th style="width:16%">วันที่ / รุ่น</th><th style="width:28%">ผลที่ได้จริง / ปัญหาที่พบ</th></tr></thead>
        ${PL.map((c, k) => { const r = RES[c.code] || {}; return `<tr><td>${k + 1}</td><td>${esc(c.code)}</td><td>${esc(c.task)}</td><td>${esc(c.type)}</td><td>${r.v ? SHORT[r.v] : '-'}</td><td>${r.v ? esc((r.day || '') + ' · ' + (r.ver || '')) : ''}</td><td>${esc(r.note)}${ans(c.code) ? `<div class="p-ans"><b>แนวทางแก้ไข (ผู้ดูแลระบบ):</b> ${ans(c.code)}</div>` : ''}</td></tr>`; }).join('')}
      </table>
      <div class="sign">
        <div>ลงชื่อ <span class="dots">&nbsp;</span><br>(${esc(u.full)})<br>ผู้ทดสอบ<br>วันที่ <span class="dots" style="min-width:35%">&nbsp;</span></div>
        <div>ลงชื่อ <span class="dots">&nbsp;</span><br>(<span class="dots">&nbsp;</span>)<br>ผู้รับรองผลการทดสอบ<br>วันที่ <span class="dots" style="min-width:35%">&nbsp;</span></div>
      </div></div>`;
    $('print-area').innerHTML = pages.join('') + summary;
    return who;
  }
  async function doPrint(mode, who) {
    who = buildPrint(mode, who);
    const title = document.title;   // ชื่อไฟล์ PDF ตามผู้ทดสอบและระบบ
    document.title = (mode === 'full' ? 'ผลการทดสอบทั้งเล่ม-' : 'สรุปผลการทดสอบ-') + who.u.full + (who.sys ? '-' + who.sys : '');
    window.addEventListener('afterprint', function back() { document.title = title; window.removeEventListener('afterprint', back); });
    const imgs = [...$('print-area').querySelectorAll('img')];
    if (imgs.length) {
      toast('กำลังเตรียมเอกสาร…');
      await Promise.all(imgs.map(i => (i.complete ? Promise.resolve() : new Promise(r => { i.onload = i.onerror = r; }))));
    }
    window.print();
  }
  $('printSum').onclick = () => doPrint('summary');
  $('printAll').onclick = () => doPrint('full');
  window.addEventListener('beforeprint', () => { if (session && !$('print-area').innerHTML) buildPrint('summary'); });
  window.addEventListener('afterprint', () => { $('print-area').innerHTML = ''; });

  // ======================================================================= สีธีม
  const THEMES = [['', 'ไม่มีสี (โทนเทา)', '#4b5563'], ['teal', 'เขียวน้ำทะเล', '#0f766e'], ['navy', 'น้ำเงิน', '#1f4e8c'],
                  ['green', 'เขียว', '#2e7d4f'], ['plum', 'ม่วง', '#6b4f8a'], ['bronze', 'น้ำตาลทอง', '#8a6a3d']];
  function setTheme(t) {
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    store.set('sa-theme', t || '');
    const th = THEMES.find(x => x[0] === (t || '')) || THEMES[0];
    $('themeColor').setAttribute('content', th[2]);
    paintThemes();
  }
  function paintThemes() {
    const curT = document.documentElement.dataset.theme || '';
    $('themeList').innerHTML = THEMES.map(([k, n, c]) => `<button class="sw" data-t="${k}" aria-pressed="${k === curT}"><i style="background:${c}"></i>${n}</button>`).join('');
    $('authTheme').innerHTML = 'สีธีม: ' + THEMES.map(([k, n, c]) => `<button class="dot2" data-t="${k}" title="${n}" aria-label="สีธีม ${n}" aria-pressed="${k === curT}" style="background:${c}"></button>`).join('');
    document.querySelectorAll('#themeList .sw, #authTheme .dot2').forEach(b => b.onclick = e => { e.stopPropagation(); setTheme(b.dataset.t); });
  }
  $('themeBtn').onclick = e => { e.stopPropagation(); const pop = $('themePop'); pop.hidden = !pop.hidden; $('themeBtn').setAttribute('aria-expanded', String(!pop.hidden)); };
  document.addEventListener('click', e => { if (!$('themePop').hidden && !e.target.closest('.theme')) { $('themePop').hidden = true; $('themeBtn').setAttribute('aria-expanded', 'false'); } });
  setTheme(store.get('sa-theme', ''));

  // ======================================================================= เริ่มต้น
  if (session && session.token && session.user) enterApp(false); else showAuth('login');
  window.SA_DEBUG = { get state() { return state; }, get outbox() { return outbox; }, get list() { return LIST; } };
})();
