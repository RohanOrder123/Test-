/* va-piper.js - offline Piper voice (native sherpa-onnx plugin "SherpaTts") + Self-check screen.
   Engine order: Piper (default) -> ElevenLabs (if key set) -> Android phone voice. A failure is shown ONCE in Hindi, then the next engine speaks.
   Loaded AFTER va-pro.js so it wraps the ElevenLabs/phone chain without touching it. */
(function () {
  'use strict';
  const VA = window.VA = window.VA || {};
  const pr = VA.prefs, tts = VA.tts;
  if (!pr.engine) pr.engine = 'piper';                 /* 'piper' | 'eleven' | 'phone' */
  const VOICES = { hi: 'hi_IN-priyamvada-medium', en: 'en_US-amy-medium' };

  /* ---------- tiny log ring (shown in Self-check) ---------- */
  const LOG = [];
  function log(s) { LOG.push(new Date().toTimeString().slice(0, 8) + ' ' + s); if (LOG.length > 200) LOG.shift(); }
  VA.piperLog = log;

  const isNative = function () { const C = window.Capacitor; return !!(C && C.isNativePlatform && C.isNativePlatform()); };
  const P = function () { return isNative() && window.Capacitor.Plugins && window.Capacitor.Plugins.SherpaTts || null; };
  const rate = function () { return Math.min(1.4, Math.max(0.7, pr.rate || 1)); };

  /* ---------- Roman / English words -> Devanagari for the Hindi voice (approximate, UNVERIFIED by ear) ---------- */
  const LET = { A: 'ए', B: 'बी', C: 'सी', D: 'डी', E: 'ई', F: 'एफ', G: 'जी', H: 'एच', I: 'आई', J: 'जे', K: 'के', L: 'एल', M: 'एम', N: 'एन', O: 'ओ', P: 'पी', Q: 'क्यू', R: 'आर', S: 'एस', T: 'टी', U: 'यू', V: 'वी', W: 'डब्ल्यू', X: 'एक्स', Y: 'वाई', Z: 'ज़ेड' };
  const WORDS = { win: 'विन', loss: 'लॉस', profit: 'प्रॉफिट', rate: 'रेट', trade: 'ट्रेड', trades: 'ट्रेड्स', pair: 'पेयर', pairs: 'पेयर्स', buy: 'बाय', sell: 'सेल', lot: 'लॉट', lots: 'लॉट्स', stop: 'स्टॉप', take: 'टेक', entry: 'एंट्री', exit: 'एग्ज़िट', dashboard: 'डैशबोर्ड', journal: 'जर्नल', backup: 'बैकअप', export: 'एक्सपोर्ट', import: 'इम्पोर्ट', ok: 'ओके', news: 'न्यूज़', high: 'हाई', impact: 'इम्पैक्ट', gold: 'गोल्ड', dollar: 'डॉलर', fed: 'फेड', app: 'ऐप', mic: 'माइक', voice: 'वॉइस', pips: 'पिप्स', pip: 'पिप', sir: 'सर', hello: 'हैलो', test: 'टेस्ट', error: 'एरर', internet: 'इंटरनेट', settings: 'सेटिंग्स', tab: 'टैब', add: 'ऐड', delete: 'डिलीट', edit: 'एडिट', save: 'सेव', balance: 'बैलेंस', risk: 'रिस्क', reward: 'रिवॉर्ड', ratio: 'रेशियो', total: 'टोटल', average: 'एवरेज', net: 'नेट', pnl: 'पी एन एल', percent: 'प्रतिशत' };
  const CONS = { b: 'ब', c: 'क', d: 'ड', f: 'फ', g: 'ग', h: 'ह', j: 'ज', k: 'क', l: 'ल', m: 'म', n: 'न', p: 'प', q: 'क', r: 'र', s: 'स', t: 'ट', v: 'व', w: 'व', x: 'क्स', y: 'य', z: 'ज़' };
  const DI = { sh: 'श', ch: 'च', th: 'थ', ph: 'फ', kh: 'ख', gh: 'घ', dh: 'ध', bh: 'भ', ck: 'क', tt: 'ट', ss: 'स', ll: 'ल', ff: 'फ' };
  const VOWI = { a: 'अ', e: 'ए', i: 'इ', o: 'ओ', u: 'उ' };
  const MATRA = { a: '', e: 'े', i: 'ि', o: 'ो', u: 'ु' };
  const VDI = { aa: ['आ', 'ा'], ee: ['ई', 'ी'], oo: ['ऊ', 'ू'], ai: ['ऐ', 'ै'], au: ['औ', 'ौ'], ou: ['औ', 'ौ'], ei: ['ए', 'े'] };
  function wordToDeva(w) {
    let s = w.toLowerCase().replace(/['’]/g, '');
    if (s.length > 3 && /[^aeiou]e$/.test(s)) s = s.slice(0, -1);       /* silent final e */
    let out = '', i = 0, lastCons = false;
    while (i < s.length) {
      const d = s.substr(i, 2), ch = s[i];
      if (VDI[d]) { out += lastCons ? VDI[d][1] : VDI[d][0]; lastCons = false; i += 2; continue; }
      if (VOWI[ch] !== undefined) { out += lastCons ? MATRA[ch] : VOWI[ch]; lastCons = false; i++; continue; }
      if (ch === 'y' && lastCons && i === s.length - 1) { out += 'ी'; lastCons = false; i++; continue; }
      let g = DI[d], adv = 2;
      if (!g) { g = CONS[ch]; adv = 1; }
      if (!g) { i++; continue; }
      if (lastCons) out += '्';
      out += g; lastCons = true; i += adv;
    }
    return out;
  }
  function toDeva(text) {
    return String(text).replace(/[A-Za-z][A-Za-z'’]*/g, function (tok) {
      const lo = tok.toLowerCase();
      if (WORDS[lo]) return WORDS[lo];
      if (tok.length >= 2 && tok.length <= 7 && tok === tok.toUpperCase()) return tok.split('').map(function (c) { return LET[c] || c; }).join(' ');
      return wordToDeva(tok);
    });
  }
  VA.toDeva = toDeva;

  /* ---------- errors: short Hindi message with the real cause ---------- */
  function hiMsg(e) {
    const c = (e && e.code) || '', d = (e && e.message) ? ' (' + e.message + ')' : '';
    if (c === 'NO_ASSET') return 'Piper की आवाज़ की फ़ाइल इस APK में नहीं मिली' + d + '। नया APK बनाकर इंस्टॉल करें। अभी दूसरी आवाज़ चल रही है।';
    if (c === 'NATIVE_LIB') return 'Piper का इंजन इस फ़ोन पर लोड नहीं हुआ' + d + '। अभी दूसरी आवाज़ चल रही है।';
    if (c === 'INIT_FAIL') return 'Piper की आवाज़ शुरू नहीं हो पाई' + d + '। अभी दूसरी आवाज़ चल रही है।';
    if (c === 'NO_AUDIO') return 'Piper ने कोई आवाज़ नहीं बनाई। अभी दूसरी आवाज़ चल रही है।';
    if (c === 'UNIMPLEMENTED' || /not implemented|not available/i.test(String(e && e.message))) return 'इस ऐप में Piper प्लगइन नहीं है (पुराना APK?)। नया APK इंस्टॉल करें। अभी दूसरी आवाज़ चल रही है।';
    return 'Piper आवाज़ में गड़बड़' + d + '। अभी दूसरी आवाज़ चल रही है।';
  }
  const warned = {};
  function note(e) {                                    /* once per distinct problem; addAssistant never stops the live loop */
    const m = hiMsg(e), k = (e && e.code || '') + (e && e.message || '');
    if (warned[k]) return; warned[k] = 1;
    if (VA.ui && VA.ui.addAssistant) VA.ui.addAssistant('⚠ ' + m, 'hi');
  }

  /* ---------- engine chain ---------- */
  const prevSpeak = tts.speak, prevStop = tts.stop, prevSpeaking = tts.speaking;
  let gen = 0, speaking = false;
  const last = { engine: '-', ms: 0, err: '' };
  VA.piperLast = last;

  tts.speak = async function (text, l) {
    const eng = pr.engine || 'piper';
    if (eng === 'eleven') { last.engine = 'elevenlabs'; return prevSpeak.call(tts, text, l); }
    if (eng === 'phone') { last.engine = 'phone'; return (tts.phoneSpeak || prevSpeak).call(tts, text, l); }
    text = String(text || '').trim(); if (!text) return false;
    const code = l === 'en' ? 'en' : 'hi', pl = P();
    if (!pl) {
      log('piper: no native plugin (' + (isNative() ? 'app is native but plugin missing' : 'running in a browser') + ')');
      if (isNative()) note({ code: 'UNIMPLEMENTED' });
      last.engine = 'fallback'; return prevSpeak.call(tts, text, l);
    }
    prevStop.call(tts);                                /* stop ElevenLabs / phone voice if they were talking */
    const my = ++gen; speaking = true; VA.emit('speaking', true);
    const t0 = Date.now();
    try {
      const r = await pl.speak({ text: code === 'hi' ? toDeva(text) : text, voice: VOICES[code], speed: rate() });
      if (my === gen) { speaking = false; VA.emit('speaking', false); }
      last.engine = 'piper-' + code; last.ms = Date.now() - t0; last.err = '';
      log('piper ' + code + ' ok ' + (r && r.interrupted ? '(interrupted) ' : '') + 'first=' + (r && r.firstAudioMs) + 'ms total=' + (r && r.totalMs) + 'ms chunks=' + (r && r.chunks));
      return my === gen && !(r && r.interrupted);
    } catch (e) {
      if (my !== gen) return false;                    /* we were interrupted, not broken */
      speaking = false; VA.emit('speaking', false);
      last.engine = 'fallback'; last.err = (e && e.code || '') + ' ' + (e && e.message || '');
      log('piper ' + code + ' FAILED ' + last.err);
      note(e);
      return prevSpeak.call(tts, text, l);             /* never stay silent: ElevenLabs if configured, else phone voice */
    }
  };
  tts.stop = function () {
    gen++;
    if (speaking) { speaking = false; VA.emit('speaking', false); }
    const pl = P(); if (pl) { try { pl.stop().catch(function () { /* ignore */ }); } catch (e) { /* ignore */ } }
    return prevStop.apply(tts, arguments);
  };
  tts.speaking = function () { return speaking || prevSpeaking.call(tts); };

  /* ================= Self-check screen ================= */
  const MB = function (n) { return n > 0 ? (n / 1048576).toFixed(1) + ' MB' : String(n); };
  let lastReport = '';
  async function withTimeout(p, ms, what) { let t; return Promise.race([p, new Promise(function (_, rej) { t = setTimeout(function () { rej(new Error(what + ' timeout ' + ms + 'ms')); }, ms); })]).finally(function () { clearTimeout(t); }); }

  async function runReport(setSt) {
    const out = [], ok = function (s) { out.push('OK    ' + s); }, bad = function (s) { out.push('FAIL  ' + s); }, info = function (s) { out.push('      ' + s); };
    const pl = P();
    out.push('RC Voice Self-check  ' + new Date().toISOString());
    info('engine pref: ' + pr.engine + ' | last used: ' + last.engine + (last.err ? ' | last error: ' + last.err : ''));
    out.push('');
    out.push('[1] Network path');
    info('native app: ' + isNative() + ' | CapacitorWebFetch: ' + (window.CapacitorWebFetch ? 'present' : 'absent'));
    info('window.fetch patched: ' + (String(window.fetch).indexOf('[native code]') === -1) + ' | XHR.open patched: ' + (String(window.XMLHttpRequest && XMLHttpRequest.prototype.open).indexOf('[native code]') === -1));
    ok('Piper uses NO network (models inside the APK, native player). Network is only for ElevenLabs / news.');
    out.push('');
    out.push('[2] Plugin / native engine / storage');
    if (!pl) { bad('SherpaTts plugin not found (' + (isNative() ? 'native app but plugin missing - old APK?' : 'running in a browser, Piper works only in the APK') + ')'); }
    else {
      try {
        const s = await withTimeout(pl.status(), 8000, 'status');
        info('CPU ABI list: ' + s.abis);
        s.nativeOk ? ok('sherpa-onnx native library loaded (ONNX Runtime is inside it)') : bad('native library NOT loaded: ' + s.nativeError);
        info('storage: ' + s.storage);
        s.espeakInApk ? ok('espeak-ng-data present in APK') : bad('espeak-ng-data MISSING in APK');
        info('espeak-ng-data copied to app files dir: ' + s.espeakCopied + ' (stays after closing the app)');
        const ids = Object.keys(s.voices || {});
        if (!ids.length) bad('no voice folders in APK assets');
        ids.forEach(function (id) { const v = s.voices[id]; (v.onnx > 1000000 && v.tokens > 0 ? ok : bad)('voice ' + id + ': model ' + MB(v.onnx) + ', tokens ' + v.tokens + ' B, in memory: ' + v.loaded); });
      } catch (e) { bad('status() failed: ' + (e && e.message || e)); }
    }
    out.push('');
    out.push('[3] Test synthesis (no sound, timings)');
    for (const c of ['hi', 'en']) {
      if (!pl) break;
      setSt('Self-check: ' + c.toUpperCase() + ' test...');
      try {
        const r = await withTimeout(pl.selfTest({ voice: VOICES[c], text: c === 'hi' ? 'नमस्ते रोहन जी, मैं वेदा हूँ। आपकी आवाज़ की जाँच हो रही है।' : 'Hello Rohan ji, this is a voice check.' }), 60000, c);
        (r.ok ? ok : bad)(VOICES[c] + ': init ' + r.initMs + ' ms, synth ' + r.synthMs + ' ms, audio ' + r.audioSec + ' s, RTF ' + r.rtf + ', peak ' + r.peak + ', ' + r.sampleRate + ' Hz' + (r.ok ? '' : '  (silent or empty audio!)'));
      } catch (e) { bad(VOICES[c] + ': ' + (e && e.code || '') + ' ' + (e && e.message || e)); }
    }
    out.push('');
    out.push('[4] Other engines');
    try { const t = await withTimeout(tts.check('hi'), 8000, 'phone'); (t.ok ? ok : bad)('phone TTS Hindi: engine=' + t.engine + ' voice=' + (t.voice || '-')); } catch (e) { bad('phone TTS check failed: ' + (e && e.message)); }
    info('ElevenLabs key set: ' + !!pr.elKey + ' | switched off: ' + !!pr.elOff);
    out.push('');
    out.push('[5] Last 20 log lines');
    LOG.slice(-20).forEach(function (x) { info(x); });
    if (!LOG.length) info('(empty)');
    lastReport = out.join('\n');
    return lastReport;
  }

  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; } catch (e) { /* try fallback */ }
    try { const a = document.createElement('textarea'); a.value = t; a.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(a); a.select(); const r = document.execCommand('copy'); a.remove(); return r; } catch (e) { return false; }
  }

  function sheet() {
    let d = document.getElementById('va-pc-sheet');
    if (d) { d.style.display = 'flex'; return; }
    d = document.createElement('div'); d.id = 'va-pc-sheet';
    d.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.55)';
    d.innerHTML = '<div style="width:100%;max-width:520px;max-height:90vh;overflow:auto;background:var(--card,#111827);color:var(--tx,#e5e7eb);border-radius:18px 18px 0 0;padding:16px;font:14px system-ui">' +
      '<b style="font-size:16px">आवाज़ / Voice Self-check</b>' +
      '<label style="display:block;margin-top:10px">Voice engine</label><select id="pc-eng" style="width:100%;padding:10px;margin:4px 0 8px;border-radius:10px"><option value="piper">Piper (offline, default)</option><option value="eleven">ElevenLabs (premium)</option><option value="phone">Phone voice only</option></select>' +
      '<div style="display:flex;gap:8px;margin:6px 0"><button id="pc-hi" style="flex:1;padding:12px;border-radius:10px">Test Hindi</button><button id="pc-en" style="flex:1;padding:12px;border-radius:10px">Test English</button></div>' +
      '<div style="display:flex;gap:8px;margin:6px 0"><button id="pc-chk" style="flex:1;padding:12px;border-radius:10px;font-weight:700">Self-check</button><button id="pc-copy" style="flex:1;padding:12px;border-radius:10px">Copy report</button><button id="pc-x" style="padding:12px;border-radius:10px">Close</button></div>' +
      '<div id="pc-st" style="min-height:20px;margin:8px 0;font-weight:600"></div>' +
      '<pre id="pc-rep" style="white-space:pre-wrap;word-break:break-word;font:11px/1.4 ui-monospace,monospace;margin:0;opacity:.9"></pre></div>';
    document.body.appendChild(d);
    const $ = function (i) { return d.querySelector('#' + i); };
    const st = function (t, isErr) { const e = $('pc-st'); e.textContent = t; e.style.color = isErr ? '#ef4444' : ''; };
    $('pc-eng').value = pr.engine || 'piper';
    $('pc-eng').onchange = function () { pr.engine = $('pc-eng').value; VA.savePrefs(); st('Engine: ' + pr.engine); };

    async function testVoice(c) {                      /* calls Piper directly so a failure is visible, not hidden by a fallback */
      const pl = P(); if (!pl) return st('Piper plugin इस ऐप में नहीं है' + (isNative() ? ' (पुराना APK?)' : ' (ब्राउज़र में Piper नहीं चलता)'), true);
      tts.stop(); st((c === 'hi' ? 'Hindi' : 'English') + ' आवाज़ बन रही है...');
      const my = ++gen; speaking = true; VA.emit('speaking', true);
      try {
        const r = await pl.speak({ text: c === 'hi' ? toDeva('नमस्ते ' + (pr.addr || 'रोहन जी') + ', मैं ' + (pr.name || 'वेदा') + ' हूँ। अब मेरी आवाज़ कैसी लग रही है?') : 'Hello ' + (pr.addr || 'Rohan ji') + ', I am ' + (pr.name || 'Veda') + '. How does my voice sound now?', voice: VOICES[c], speed: rate() });
        if (my === gen) { speaking = false; VA.emit('speaking', false); }
        log('test ' + c + ' ok first=' + (r && r.firstAudioMs) + 'ms');
        st(r && r.interrupted ? 'रोक दिया गया।' : '✓ चली: शुरू होने में ' + (r.firstAudioMs) + ' ms, कुल ' + (r.totalMs) + ' ms');
      } catch (e) {
        if (my === gen) { speaking = false; VA.emit('speaking', false); }
        log('test ' + c + ' FAILED ' + (e && e.code) + ' ' + (e && e.message));
        st('✗ ' + hiMsg(e).replace(' अभी दूसरी आवाज़ चल रही है।', ''), true);
      }
    }
    $('pc-hi').onclick = function () { testVoice('hi'); };
    $('pc-en').onclick = function () { testVoice('en'); };
    $('pc-chk').onclick = async function () {
      st('Self-check चल रहा है... (30 सेकंड तक लग सकते हैं)'); $('pc-rep').textContent = '';
      try { const r = await runReport(function (t) { st(t); }); $('pc-rep').textContent = r; st(/FAIL/.test(r) ? '✗ कुछ जाँचें फेल हुईं। Copy report दबाकर Claude को भेजें।' : '✓ सब जाँचें पास।', /FAIL/.test(r)); }
      catch (e) { st('Self-check खुद फेल हुआ: ' + (e && e.message), true); }
    };
    $('pc-copy').onclick = async function () {
      if (!lastReport) return st('पहले Self-check चलाइए।', true);
      (await copyText(lastReport)) ? st('✓ रिपोर्ट कॉपी हो गई। अब चैट में paste करें।') : st('कॉपी नहीं हुआ। नीचे का टेक्स्ट दबाकर रोके रखें और कॉपी करें।', true);
    };
    $('pc-x').onclick = function () { d.style.display = 'none'; };
  }
  VA.piperSheet = sheet;
  function btn() {
    if (document.getElementById('va-pc-btn')) return;
    const b = document.createElement('button'); b.id = 'va-pc-btn'; b.textContent = '\uD83D\uDD0A'; b.setAttribute('aria-label', 'Voice self-check');
    b.style.cssText = 'position:fixed;left:52px;bottom:calc(76px + env(safe-area-inset-bottom,0px));width:34px;height:34px;border-radius:50%;border:0;z-index:9990;opacity:.55;font-size:16px;background:#1f2937;color:#e5e7eb';
    b.onclick = sheet; document.body.appendChild(b);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', btn); else btn();

  /* warm up the Hindi voice shortly after start so the first reply is fast */
  setTimeout(function () { const pl = P(); if (pl && pl.preload && (pr.engine || 'piper') === 'piper') pl.preload({ voice: VOICES.hi }).catch(function (e) { log('preload hi FAILED ' + (e && e.code) + ' ' + (e && e.message)); }); }, 2500);
})();
