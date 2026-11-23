/* MOCK tests for va-piper.js. These prove the JS control flow only (fallback order, interrupt never hangs, one warning,
   per-language voice, transliteration rules). They do NOT prove that the native plugin or the Hindi voice works on a phone. */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m); } };

function world(plugin, prefs) {
  const calls = [], bubbles = [], emits = [];
  const tts = {
    speak: async (t, l) => { calls.push(['prev', t, l]); return true; },
    stop: () => { calls.push(['prevStop']); },
    speaking: () => false,
    phoneSpeak: async (t, l) => { calls.push(['phone', t, l]); return true; },
    check: async () => ({ ok: true, engine: 'mock', voice: 'm' })
  };
  const VA = { prefs: Object.assign({ rate: 1 }, prefs || {}), tts, emit: (e, v) => emits.push([e, v]), savePrefs() {}, ui: { addAssistant: (t) => bubbles.push(t) } };
  const win = { VA, Capacitor: plugin ? { isNativePlatform: () => true, Plugins: { SherpaTts: plugin } } : { isNativePlatform: () => false, Plugins: {} } };
  win.window = win;
  const ctx = vm.createContext(Object.assign(win, { console, setTimeout: () => 0, clearTimeout() {}, document: { readyState: 'loading', addEventListener() {}, getElementById: () => null, body: { appendChild() {} } }, navigator: {}, Date, Promise, String, Math, Object, Array, JSON, Error, Number }));
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'va-piper.js'), 'utf8'), ctx);
  return { VA, tts, calls, bubbles, emits };
}

(async () => {
  console.log('transliteration');
  const w0 = world(null);
  const d = w0.VA.toDeva;
  ok(d('XAUUSD') === 'एक्स ए यू यू एस डी', 'acronym is spelled letter by letter: ' + d('XAUUSD'));
  ok(d('win rate 45 percent') === 'विन रेट 45 प्रतिशत', 'dictionary words + digits kept: ' + d('win rate 45 percent'));
  ok(/^[\u0900-\u097F ]+$/.test(d('Rohan journal backup')), 'unknown words become Devanagari only: ' + d('Rohan journal backup'));
  ok(d('नमस्ते Rohan ji') .startsWith('नमस्ते '), 'existing Devanagari untouched');

  console.log('engine chain');
  let spoken = [];
  const good = { speak: async (o) => { spoken.push(o); return { ok: true, interrupted: false, firstAudioMs: 120, totalMs: 900, chunks: 1 }; }, stop: async () => {}, preload: async () => ({}) };
  let w = world(good);
  await w.tts.speak('आज का प्रॉफिट', 'hi'); await w.tts.speak('Hello there', 'en');
  ok(spoken[0].voice === 'hi_IN-priyamvada-medium' && spoken[1].voice === 'en_US-amy-medium', 'voice chosen per reply language');
  ok(!w.calls.some(c => c[0] === 'prev' && c[0] !== 'prevStop' && c[1]), 'no fallback when Piper works');

  const broken = { speak: async () => { const e = new Error('voices/hi_IN-priyamvada-medium/x.onnx'); e.code = 'NO_ASSET'; throw e; }, stop: async () => {} };
  w = world(broken);
  const r1 = await w.tts.speak('नमस्ते', 'hi'); await w.tts.speak('दोबारा', 'hi');
  ok(w.calls.filter(c => c[0] === 'prev' && c[1]).length === 2, 'falls back to the next engine every time (never silent)');
  ok(w.bubbles.length === 1 && /APK/.test(w.bubbles[0]) && /onnx/.test(w.bubbles[0]), 'Hindi error shown ONCE with the real cause: ' + (w.bubbles[0] || '').slice(0, 70));

  console.log('interrupt never hangs');
  let release;
  const slow = { speak: () => new Promise((res) => { release = res; }), stop: async () => { if (release) release({ ok: true, interrupted: true }); } };
  w = world(slow);
  const p = w.tts.speak('लंबा जवाब', 'hi');
  await new Promise(r => setImmediate(r));
  w.tts.stop();
  const res = await Promise.race([p, new Promise(r => setTimeout(() => r('HUNG'), 300))]);
  ok(res === false, 'stop() resolves the pending speak() with false');
  ok(w.emits.filter(e => e[0] === 'speaking').pop()[1] === false, 'speaking=false emitted after stop');

  console.log('engine selection');
  w = world(good, { engine: 'phone' }); await w.tts.speak('x', 'hi');
  ok(w.calls.some(c => c[0] === 'phone') && spoken.length === 2, 'engine=phone uses phone voice only');
  w = world(good, { engine: 'eleven' }); await w.tts.speak('x', 'hi');
  ok(w.calls.some(c => c[0] === 'prev' && c[1] === 'x'), 'engine=eleven goes to the ElevenLabs chain');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
