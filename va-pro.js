/* va-pro.js - Phase 2: ElevenLabs voice, answers without AI (knowledge base, calculators, Wikipedia), multi-city weather,
   guided navigation / diary dialog. Every network feature fails soft: if it cannot work, the Android voice / core engine continues. */
(function () {
  'use strict';
  const VA = window.VA = window.VA || {};
  const pr = VA.prefs, A = function () { return VA.A; };
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const L = function () { return VA.rl ? VA.rl() : 'hi'; };
  const R = function (en, hi, x) { return Object.assign({ en: en, hi: hi }, x || {}); };
  const addr = function () { return pr.addr || 'रोहन जी'; };
  if (!pr.home) pr.home = 'Htauk Kyant';
  if (!pr.elModel) pr.elModel = 'eleven_flash_v2_5';
  const HOME = { 'htauk kyant': [17.03, 96.11] };   /* fallback coordinates if geocoding cannot find the town */

  /* ================= ElevenLabs voice ================= */
  const tts = VA.tts, osp = tts.speak, ostop = tts.stop, ospk = tts.speaking;
  let audio = null, gen = 0, elSpeaking = false, elWarned = 0, elRes = null;
  const cache = new Map();
  const DEFVOICE = '21m00Tcm4TlvDq8ikWAM';   /* ElevenLabs premade voice; works without the Voices (read) permission */
  const voiceId = function () { return (pr.elVoice || DEFVOICE).trim(); };
  const cleanKey = function (k) { return String(k || '').replace(/[\s\u200b-\u200d\ufeff"']/g, ''); };
  const elOn = function () { return !!pr.elKey && !pr.elOff && navigator.onLine !== false; };
  function elStop() { gen++; if (audio) { try { audio.pause(); } catch (e) { /* ignore */ } audio = null; } if (elRes) { const r = elRes; elRes = null; r(); } if (elSpeaking) { elSpeaking = false; VA.emit('speaking', false); } }
  /* Audio must arrive as raw bytes. Capacitor's patched fetch can hand back base64 TEXT instead of an MP3, which the
     player rejects ("no supported source"). So: real WebView fetch first, then the patched one, then the native plugin;
     every result is checked for MP3 bytes, and base64 text is decoded when needed. */
  const isMp3 = function (u) { return u && u.length > 200 && ((u[0] === 0x49 && u[1] === 0x44 && u[2] === 0x33) || (u[0] === 0xFF && (u[1] & 0xE0) === 0xE0)); };
  function fromB64(t) { const b = atob(String(t).replace(/^data:[^,]*,/, '').replace(/\s+/g, '')), u = new Uint8Array(b.length); for (let k = 0; k < b.length; k++) u[k] = b.charCodeAt(k); return u; }
  function toAudio(u) {
    if (isMp3(u)) return u;
    try { const t = new TextDecoder().decode(u).trim(); if (t.length > 400 && /^[A-Za-z0-9+/=\s]+$/.test(t)) { const d = fromB64(t); if (isMp3(d)) return d; } } catch (e) { /* not base64 */ }
    return null;
  }
  function apiError(status, u) {
    let d = {}; try { const j = JSON.parse(new TextDecoder().decode(u)); d = j.detail || j; } catch (x) { /* no JSON body */ }
    const e = new Error(typeof d === 'string' ? d : (d.message || d.status || ('HTTP ' + status))); e.status = status; e.code = String(typeof d === 'object' && d.status || ''); return e;
  }
  async function elFetch(text) {
    const key = voiceId() + '|' + pr.elModel + '|' + text;
    if (cache.has(key)) return cache.get(key);
    const url = 'https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(voiceId()) + '?output_format=mp3_44100_64';
    const headers = { 'xi-api-key': cleanKey(pr.elKey), 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' };
    const body = { text: text, model_id: pr.elModel, voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true } };
    const ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, 20000);
    const viaFetch = function (f) { return async function () { const r = await f(url, { method: 'POST', headers: headers, body: JSON.stringify(body), signal: ctl.signal }); return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) }; }; };
    const H = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
    const tries = [];
    if (window.CapacitorWebFetch) tries.push(viaFetch(window.CapacitorWebFetch.bind(window)));
    tries.push(viaFetch(function (a, b) { return fetch(a, b); }));
    if (H && H.request) tries.push(async function () {
      const r = await H.request({ url: url, method: 'POST', headers: headers, data: body, responseType: 'blob' });
      const d = r.data; const u = typeof d === 'string' ? (function () { try { return fromB64(d); } catch (x) { return new TextEncoder().encode(d); } })() : new TextEncoder().encode(JSON.stringify(d || {}));
      return { status: r.status, bytes: u };
    });
    let last = new Error('no response');
    try {
      for (let k = 0; k < tries.length; k++) {
        try {
          const r = await tries[k]();
          if (r.status >= 200 && r.status < 300) { const au = toAudio(r.bytes); if (au) { const b = new Blob([au], { type: 'audio/mpeg' }); cache.set(key, b); if (cache.size > 25) cache.delete(cache.keys().next().value); return b; } last = new Error('audio data was not valid MP3 (path ' + (k + 1) + ')'); }
          else if (r.status) throw apiError(r.status, r.bytes);     /* a real API answer (401, 402, 404...): stop and report it */
        } catch (e) { if (e && e.status) throw e; last = e; }      /* network / CORS / bad audio: try the next path */
      }
      throw last;
    } finally { clearTimeout(timer); }
  }
  function elMsg(e, l) {
    const c = (e && e.code || '') + ' ' + (e && e.message || ''), st = e && e.status, hi = l !== 'en';
    const raw = e && e.message ? ' (' + e.message + ')' : '';
    if (/missing_permissions/.test(c)) return hi ? 'key सही है, पर उसमें Text to Speech की अनुमति चालू नहीं है। ElevenLabs > Developers > API Keys में Text to Speech (और Voices read) चालू करें।' : 'The key is valid but lacks the Text to Speech permission. Enable Text to Speech (and Voices read) under ElevenLabs > Developers > API Keys.';
    if (/unusual|abuse|blocked|vpn|proxy/i.test(c)) return hi ? 'ElevenLabs ने इस अकाउंट को रोका है (अक्सर VPN/प्रॉक्सी या फ्री अकाउंट के दुरुपयोग की जाँच की वजह से)। VPN बंद करें और ElevenLabs का ईमेल देखें।' + raw : 'ElevenLabs blocked this account (often VPN/proxy or free-account abuse checks). Turn off the VPN and check your ElevenLabs email.' + raw;
    if (st === 402 || st === 429 || /quota|limit|credit/i.test(c)) return hi ? 'ElevenLabs की लिमिट या क्रेडिट खत्म है' + raw + '। फ़ोन की आवाज़ चल रही है।' : 'ElevenLabs quota, credits or rate limit reached' + raw + '. Using the phone voice.';
    if (st === 404 || /voice_not_found|voice.*not found/i.test(c)) return hi ? 'यह Voice ID इस अकाउंट में नहीं मिली। Load दबाकर आवाज़ चुनें या दूसरी Voice ID डालें।' : 'This Voice ID was not found on the account. Press Load and pick a voice, or paste another Voice ID.';
    if (st === 401 || /invalid_api_key/.test(c)) return hi ? 'ElevenLabs इस key को नहीं मान रहा' + raw + '। key को पूरा दोबारा कॉपी करें (आम तौर पर sk_ से शुरू), बिना space के।' : 'ElevenLabs does not accept this key' + raw + '. Copy the full key again (usually starts with sk_), with no spaces.';
    return hi ? 'ElevenLabs से कनेक्ट नहीं हो पाया' + raw + '। फ़ोन की आवाज़ चल रही है।' : 'Could not reach ElevenLabs' + raw + '. Using the phone voice.';
  }
  function elWarn(e, l) {
    const k = (e && e.status || '') + (e && e.code || '') + (e && e.message || '');
    if (elWarned === k) return; elWarned = k;
    if (VA.ui && VA.ui.error) VA.ui.error(elMsg(e, l), 'el');
  }
  tts.speak = async function (text, l) {
    if (!elOn()) return osp.call(tts, text, l);
    text = String(text || '').trim(); if (!text) return false;
    ostop.call(tts); elStop();
    const my = ++gen; elSpeaking = true; VA.emit('speaking', true);
    try {
      const blob = await elFetch(text);
      if (my !== gen) return false;
      const url = URL.createObjectURL(blob), a = new Audio(url); a.preload = 'auto'; audio = a;
      a.volume = Math.min(1, pr.volume || 1); a.playbackRate = pr.rate && pr.rate > 0 ? Math.min(1.5, Math.max(0.7, pr.rate)) : 1;
      await new Promise(function (res, rej) { elRes = res; a.onended = res; a.onerror = function () { rej(new Error('play')); }; const p = a.play(); if (p && p.catch) p.catch(rej); });
      URL.revokeObjectURL(url);
      if (my === gen) { elSpeaking = false; audio = null; VA.emit('speaking', false); }
      return my === gen;
    } catch (e) {
      if (my !== gen) return false;
      elSpeaking = false; audio = null; VA.emit('speaking', false);
      elWarn(e, l);
      return osp.call(tts, text, l);          /* never stay silent */
    }
  };
  tts.stop = function () { elStop(); return ostop.apply(tts, arguments); };
  tts.speaking = function () { return elSpeaking || ospk.call(tts); };

  /* ================= weather (any city, several at once) ================= */
  const COUNTRY = { india: 'New Delhi', myanmar: 'Yangon', burma: 'Yangon', thailand: 'Bangkok', china: 'Beijing', japan: 'Tokyo', nepal: 'Kathmandu', pakistan: 'Islamabad', bangladesh: 'Dhaka', usa: 'Washington', america: 'Washington', uk: 'London', dubai: 'Dubai', singapore: 'Singapore' };
  const STOPW = /\b(weather|wealth|whether|mausam|temperature|tapman|ka|ki|ke|kaisa|kaise|hai|aaj|abhi|today|now|in|of|the|batao|bataiye|bolo|me|mein|kya|what|is|how|tell|current|and|aur|also|bhi|please)\b|मौसम|तापमान|का|की|के|कैसा|कैसी|है|आज|अभी|बताओ|बताइए|और|में|क्या/g;
  const WX = function (c) { return c === 0 ? ['clear', 'साफ़'] : c <= 3 ? ['partly cloudy', 'हल्के बादल'] : c <= 48 ? ['foggy', 'कोहरा'] : c <= 67 ? ['rainy', 'बारिश'] : c <= 77 ? ['snowy', 'बर्फ़'] : c <= 82 ? ['showers', 'बौछारें'] : ['stormy', 'तूफ़ान']; };
  async function jget(u) { const c = new AbortController(), t = setTimeout(function () { c.abort(); }, 12000); try { const r = await fetch(u, { signal: c.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); } finally { clearTimeout(t); } }
  async function cityWx(name) {
    const nm = COUNTRY[name.toLowerCase().trim()] || name.replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
    let lat, lon, label = nm;
    try { const g = await jget('https://geocoding-api.open-meteo.com/v1/search?count=1&name=' + encodeURIComponent(nm)); const p = g.results && g.results[0]; if (p) { lat = p.latitude; lon = p.longitude; label = p.name + (p.country ? ', ' + p.country : ''); } } catch (e) { /* fallback below */ }
    if (lat === undefined && HOME[nm.toLowerCase()]) { lat = HOME[nm.toLowerCase()][0]; lon = HOME[nm.toLowerCase()][1]; label = nm; }
    if (lat === undefined) return null;
    const w = await jget('https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon + '&current=temperature_2m,apparent_temperature,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1');
    const c = w.current, d = w.daily, k = WX(c.weather_code);
    return { en: label + ': ' + Math.round(c.temperature_2m) + '°C, feels ' + Math.round(c.apparent_temperature) + ', ' + k[0] + ', high ' + Math.round(d.temperature_2m_max[0]) + ', low ' + Math.round(d.temperature_2m_min[0]) + ', rain chance ' + d.precipitation_probability_max[0] + '%.',
      hi: label + ' में अभी ' + Math.round(c.temperature_2m) + ' डिग्री, महसूस ' + Math.round(c.apparent_temperature) + ', ' + k[1] + ', अधिकतम ' + Math.round(d.temperature_2m_max[0]) + ', न्यूनतम ' + Math.round(d.temperature_2m_min[0]) + ', बारिश की संभावना ' + d.precipitation_probability_max[0] + ' प्रतिशत।' };
  }
  const placesOf = function (n) {
    const parts = n.split(/,|&|\+|\baur\b|\band\b|और/).map(function (s) { return s.replace(STOPW, ' ').replace(/\s+/g, ' ').trim(); }).filter(Boolean);
    return parts.length ? parts : [pr.home];
  };
  async function weatherAnswer(n) {
    const out = await Promise.all(placesOf(n).slice(0, 4).map(function (p) { return cityWx(p).catch(function () { return null; }); }));
    const ok = out.filter(Boolean);
    if (!ok.length) return R('I could not get the weather right now. Check the internet or the city name.', 'अभी मौसम नहीं मिल पाया। इंटरनेट या शहर का नाम जाँचिए।');
    return R(ok.map(function (x) { return x.en; }).join(' '), addr() + ', ' + ok.map(function (x) { return x.hi; }).join(' '));
  }

  /* ================= knowledge base (works with no AI, no internet) ================= */
  const hm = function (h) { const d = new Date(Date.UTC(2026, 0, 5, h, 0)); return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }); };
  const KB = [
    [/\bpips?\b|पिप/, 'A pip is the smallest standard price step in forex: 0.0001 for most pairs and 0.01 for JPY pairs. In gold many brokers call a 0.10 move one pip, but it varies, so check your broker.', 'पिप फॉरेक्स में कीमत का सबसे छोटा स्टैंडर्ड कदम है: ज़्यादातर पेयर में 0.0001 और JPY पेयर में 0.01। गोल्ड में कई ब्रोकर 0.10 की चाल को एक पिप मानते हैं, पर यह ब्रोकर पर निर्भर है।'],
    [/\blot\s*size|\blots?\b.*(kya|what)|लॉट/, 'One standard lot is 100,000 units in forex and 100 ounces in gold. So 0.01 lot of gold is 1 ounce: a one dollar move is about one dollar profit or loss.', 'एक स्टैंडर्ड लॉट फॉरेक्स में 100,000 यूनिट और गोल्ड में 100 औंस होता है। यानी गोल्ड का 0.01 लॉट 1 औंस है: एक डॉलर की चाल पर लगभग एक डॉलर का फ़ायदा या नुकसान।'],
    [/leverage|margin|लीवरेज|मार्जिन/, 'Leverage lets you control a bigger position with less money, and margin is the amount your broker locks for it. Higher leverage means small moves can hurt more, so your risk per trade matters more than the leverage number.', 'लीवरेज से कम पैसे में बड़ी पोज़िशन चलती है और मार्जिन वह रकम है जो ब्रोकर रोक लेता है। लीवरेज ज़्यादा हो तो छोटी चाल भी भारी पड़ती है, इसलिए हर ट्रेड का रिस्क ज़्यादा ज़रूरी है।'],
    [/stop ?loss|\bsl\b.*(kya|what)|स्टॉप ?लॉस/, 'Stop loss closes a trade automatically at a loss you set. Decide it before entry and size the lot from it, so one loss stays within your risk limit, commonly one to two percent of the account.', 'स्टॉप लॉस तय नुकसान पर ट्रेड अपने आप बंद कर देता है। इसे एंट्री से पहले तय करें और उसी से लॉट निकालें, ताकि एक नुकसान आपकी रिस्क सीमा में रहे, आम तौर पर अकाउंट का एक से दो प्रतिशत।'],
    [/take ?profit|\btp\b.*(kya|what)|टेक ?प्रॉफिट/, 'Take profit closes a trade automatically when it reaches your target. Set it from your plan, such as a fixed risk reward, not from hope.', 'टेक प्रॉफिट टारगेट पर पहुँचते ही ट्रेड अपने आप बंद कर देता है। इसे अपने प्लान से तय करें, जैसे तय रिस्क रिवॉर्ड, उम्मीद से नहीं।'],
    [/risk ?reward|\brr\b|रिस्क ?रिवॉर्ड/, 'Risk reward 1 to 2 means risking 1 to make 2. At 1 to 2 you break even at about a 33 percent win rate, before costs.', 'रिस्क रिवॉर्ड 1 अनुपात 2 का मतलब 1 जोखिम पर 2 कमाई। 1 अनुपात 2 में लगभग 33 प्रतिशत जीत पर बराबरी होती है, खर्चे छोड़कर।'],
    [/drawdown|ड्रॉडाउन/, 'Drawdown is the fall from an account peak to a later low. A 20 percent drawdown needs a 25 percent gain to recover, so protect capital first.', 'ड्रॉडाउन अकाउंट के ऊँचे स्तर से बाद के निचले स्तर तक की गिरावट है। 20 प्रतिशत गिरावट वापस पाने के लिए 25 प्रतिशत कमाई चाहिए, इसलिए पहले पूंजी बचाइए।'],
    [/\bspread\b|स्प्रेड/, 'Spread is the gap between the buy and sell price, and it is a cost on every trade. It often widens around big news.', 'स्प्रेड खरीद और बिक्री के भाव का फ़र्क है और हर ट्रेड पर खर्च है। बड़ी खबरों के आसपास यह अक्सर बढ़ जाता है।'],
    [/slippage|स्लिपेज/, 'Slippage is when your order fills at a different price than requested. It is common in fast markets and during news.', 'स्लिपेज वह है जब ऑर्डर माँगे गए भाव से अलग भाव पर भरता है। तेज़ बाज़ार और खबरों के समय यह आम है।'],
    [/\bswap\b|rollover|स्वैप/, 'Swap is the overnight interest charged or paid for holding a position past the daily rollover. In forex it is often tripled on one day, usually Wednesday.', 'स्वैप रात भर पोज़िशन रखने पर लगने या मिलने वाला ब्याज है। फॉरेक्स में यह अक्सर हफ़्ते के एक दिन तीन गुना होता है, आम तौर पर बुधवार को।'],
    [/\bnfp\b|non.?farm|नॉन ?फार्म/, 'Non-Farm Payrolls is the US jobs report, released on the first Friday of most months. It often moves the dollar and gold sharply.', 'नॉन-फार्म पेरोल अमेरिका की रोज़गार रिपोर्ट है, जो ज़्यादातर महीनों के पहले शुक्रवार को आती है। इससे डॉलर और गोल्ड अक्सर तेज़ चलते हैं।'],
    [/\bcpi\b|inflation|महंगाई/, 'CPI is the US inflation report, released monthly. A surprise versus the forecast can move the dollar, yields and gold quickly.', 'CPI अमेरिका की महंगाई रिपोर्ट है जो हर महीने आती है। अनुमान से अलग आंकड़ा आए तो डॉलर, यील्ड और गोल्ड तेज़ी से हिल सकते हैं।'],
    [/fomc|\bfed\b|फेड/, 'FOMC is the US Federal Reserve committee that sets interest rates. It meets eight times a year and its decisions and statements move gold and the dollar.', 'FOMC अमेरिकी फेडरल रिज़र्व की समिति है जो ब्याज दरें तय करती है। यह साल में आठ बार मिलती है और इसके फ़ैसलों से गोल्ड और डॉलर चलते हैं।'],
    [/\bdxy\b|dollar index|डॉलर इंडेक्स/, 'DXY is the US Dollar Index, the dollar against a basket of six major currencies. Gold often moves opposite to it, but not always.', 'DXY डॉलर इंडेक्स है, यानी डॉलर बनाम छह बड़ी करेंसी। गोल्ड अक्सर इसके उलट चलता है, पर हमेशा नहीं।'],
    [/fomo/, 'FOMO is fear of missing out: entering late because the price is already running. Stick to your written entry rules and let that trade go.', 'FOMO यानी छूट जाने का डर: भाव भाग चुका हो तब देर से एंट्री लेना। अपने लिखे एंट्री नियमों पर टिके रहिए और वह ट्रेड जाने दीजिए।'],
    [/revenge|बदला/, 'Revenge trading is trading angrily to win back a loss. A good rule is to stop for the day after a set number of losses or a daily loss limit.', 'रिवेंज ट्रेडिंग यानी नुकसान वापस पाने के गुस्से में ट्रेड करना। अच्छा नियम है कि तय संख्या में नुकसान या डेली लॉस लिमिट के बाद उस दिन रुक जाएँ।']
  ];
  function sessions() {
    const s = [['Tokyo', 0, 9], ['London', 7, 16], ['New York', 12, 21]].map(function (x) { return x[0] + ' ' + hm(x[1]) + ' to ' + hm(x[2]); }).join(', ');
    return R('Approximate market hours in your phone time: ' + s + '. They shift by about an hour with daylight saving. London and New York overlap is usually the most active for gold.', 'आपके फ़ोन के समय में बाज़ार के लगभग घंटे: ' + s + '। डे-लाइट सेविंग से एक घंटा आगे-पीछे होते हैं। गोल्ड में लंदन और न्यूयॉर्क का ओवरलैप आम तौर पर सबसे सक्रिय रहता है।');
  }
  const NUMS = function (s) { return (s.match(/\d+(?:\.\d+)?/g) || []).map(Number); };
  function calc(n) {
    let m;
    if (/lot/.test(n) && /(balance|account|capital)/.test(n) && /risk/.test(n) && /(sl|stop)/.test(n)) {
      const bal = (n.match(/(?:balance|account|capital)\D{0,8}(\d+(?:\.\d+)?)/) || [])[1], rk = (n.match(/risk\D{0,8}(\d+(?:\.\d+)?)/) || [])[1], sl = (n.match(/(?:sl|stop ?loss)\D{0,8}(\d+(?:\.\d+)?)/) || [])[1];
      if (bal && rk && sl && +sl > 0) { const lot = (bal * rk / 100) / (sl * 100), r = Math.max(0.01, Math.floor(lot * 100) / 100);
        return R('Gold lot size: risking ' + rk + '% of ' + bal + ' is $' + (bal * rk / 100).toFixed(2) + '. With a stop of $' + sl + ' (price distance), use about ' + r.toFixed(2) + ' lot. Check your broker contract size.', 'गोल्ड लॉट: ' + bal + ' का ' + rk + ' प्रतिशत यानी ' + (bal * rk / 100).toFixed(2) + ' डॉलर रिस्क। ' + sl + ' डॉलर की स्टॉप दूरी पर लगभग ' + r.toFixed(2) + ' लॉट लें। ब्रोकर का कॉन्ट्रैक्ट साइज़ जाँच लें।'); }
    }
    if ((m = n.match(/(\d+(?:\.\d+)?)\s*(?:%|percent|प्रतिशत)\s*(?:of|ka|का)\s*(\d+(?:\.\d+)?)/))) { const v = m[1] * m[2] / 100; return R(m[1] + ' percent of ' + m[2] + ' is ' + +v.toFixed(4) + '.', m[1] + ' प्रतिशत ' + m[2] + ' का ' + +v.toFixed(4) + ' होता है।'); }
    const e = n.replace(/\b(plus|jod|add)\b/g, '+').replace(/\b(minus|ghata|घटा)\b/g, '-').replace(/\b(times|into|gunaa|guna|multiply|x)\b/g, '*').replace(/\b(divided by|divide|bhaag|by)\b/g, '/').replace(/[^0-9+\-*/.() ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (/\d\s*[+\-*/]\s*\d/.test(e) && /^[0-9+\-*/.() ]+$/.test(e) && e.length < 60) { try { const v = Function('"use strict";return (' + e + ')')(); if (isFinite(v)) return R('That is ' + +v.toFixed(4) + '.', 'जवाब ' + +v.toFixed(4) + ' है।'); } catch (x) { /* not math */ } }
    return null;
  }
  async function wiki(q) {
    const hi = L() === 'hi', host = hi ? 'hi' : 'en';
    const s = await jget('https://' + host + '.wikipedia.org/w/api.php?action=opensearch&limit=1&format=json&origin=*&search=' + encodeURIComponent(q));
    const t = s && s[1] && s[1][0]; if (!t) return null;
    const j = await jget('https://' + host + '.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(t));
    const x = (j && j.extract || '').split(/(?<=[.।!?])\s+/).slice(0, 2).join(' ');
    return x ? R(x, x, { onlyLang: host }) : null;
  }
  const QW = /\b(what|who|why|how|when|where|which|kya|kaun|kyon|kyu|kaise|kab|kahan|kitna|bare mein|baare mein|explain|batao|bataiye|tell me)\b|क्या|कौन|क्यों|कैसे|कब|कहाँ|बारे|बताओ|बताइए/;
  const cleanQ = function (n) { return n.replace(/\b(what is|what are|who is|who was|kya hai|kya hota hai|kaun hai|kaun tha|ke bare mein|ke baare mein|batao|bataiye|tell me about|explain|please)\b|क्या है|कौन है|के बारे में|बताओ|बताइए/g, ' ').replace(/\s+/g, ' ').trim(); };

  VA.fallback = async function (raw, p) {
    const n = String(raw).toLowerCase();
    if (/(who are you|tum kaun ho|aap kaun ho|apna naam|तुम कौन|आप कौन)/.test(n)) return R('I am ' + pr.name + ', your trading journal assistant. I can open screens, add and review trades, check news and weather, and answer questions.', 'मैं ' + pr.name + ' हूँ, आपकी ट्रेडिंग जर्नल असिस्टेंट। मैं स्क्रीन खोल सकती हूँ, ट्रेड जोड़ और देख सकती हूँ, खबर और मौसम बता सकती हूँ, और सवालों के जवाब दे सकती हूँ।');
    if (/(time|samay|waqt|baje|date|tarikh|तारीख|समय|बजे)/.test(n) && QW.test(n)) { const d = new Date(); return R('It is ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) + ' on ' + d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }) + '.', addr() + ', अभी ' + d.toLocaleTimeString('hi-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) + ' हैं, ' + d.toLocaleDateString('hi-IN', { weekday: 'long', day: 'numeric', month: 'long' }) + '।'); }
    if (/(session|market (open|hours|timing)|kab khulta|कब खुलता)/.test(n)) return sessions();
    const c = calc(n); if (c) return c;
    for (let i = 0; i < KB.length; i++) if (KB[i][0].test(n)) return R(KB[i][1], KB[i][2]);
    const hasAI = typeof S !== 'undefined' && S.keys && S.keys[S.ai];
    if (hasAI && A() && A().aiAnswer) { try { const t = await A().aiAnswer(raw); return R(t, t); } catch (e) { /* try Wikipedia next */ } }
    if (QW.test(n)) { try { const w = await wiki(cleanQ(n)); if (w) return w; } catch (e) { /* offline */ } }
    return null;
  };

  /* ================= guided dialog: navigation + diary ================= */
  const TABN = { dash: ['Dashboard', 'डैशबोर्ड'], list: ['Trades', 'ट्रेड्स'], goals: ['Goals', 'गोल्स'], diary: ['Diary', 'डायरी'], cal: ['Insights', 'इनसाइट्स'], tools: ['Tools', 'टूल्स'] };
  const OPEN = /\b(open|go to|goto|show|kholo|khol do|khol|dikhao|dikha do|jao|chalo)\b|खोलो|खोल दो|दिखाओ|जाओ/;
  const NAVS = [['tools', /\btools?\b|setting|backup|टूल/], ['goals', /\bgoals?\b|target|गोल/], ['diary', /diary|डायरी/], ['cal', /insight|calendar|report|कैलेंडर|इनसाइट/], ['dash', /dashboard|\bhome\b|डैशबोर्ड|होम/], ['list', /\btrades\b|history|ट्रेड्स/]];
  const YES = /^(haan|han|ha|yes|yeah|ok|okay|theek hai|save|kar do|kardo|हाँ|हां|जी|ठीक है)/, NO = /^(nahi|nahin|no|cancel|mat|रहने दो|नहीं|ना)/, SKIP = /^(skip|chhodo|next|aage|छोड़ो|आगे)/;
  const STEPS = [['d-good', 'What went well today?', 'आज क्या अच्छा रहा?'], ['d-bad', 'What mistakes happened today?', 'आज क्या गलतियाँ हुईं?'], ['d-less', 'What is the lesson?', 'आज की सीख क्या है?'], ['d-plan', 'What is the plan for tomorrow?', 'कल का प्लान क्या है?']];
  let pend = null;
  const ask = function (en, hi) { return R(en, hi, { listen: true }); };
  async function diaryStart(first) {
    A().goto('diary'); await sleep(200);
    pend = { t: 'diary', i: 0 };
    if (first) { const el = document.querySelector('#' + STEPS[2][0]); if (el) el.value = first; pend.i = 3; return ask('Noted as today\'s lesson. ' + STEPS[3][1] + ' Say skip to leave it.', addr() + ', आज की सीख में लिख लिया। ' + STEPS[3][2] + ' छोड़ना हो तो स्किप कहिए।'); }
    return ask(STEPS[0][1] + ' Say skip to leave any question.', addr() + ', डायरी खुल गई। ' + STEPS[0][2] + ' कोई सवाल छोड़ना हो तो स्किप कहिए।');
  }
  async function dialog(raw, n) {
    if (NO.test(n) && !pend) return null;
    if (pend && /^(cancel|ruko|rehne do|रहने दो|बंद|ruk jao)/.test(n)) { pend = null; return R('Okay, cancelled. Nothing was saved.', 'ठीक है, रद्द किया। कुछ सेव नहीं हुआ।'); }
    if (pend && pend.t === 'diary') {
      if (!SKIP.test(n)) { const el = document.querySelector('#' + STEPS[pend.i][0]); if (el) { el.value = el.value ? el.value + '; ' + raw : raw; el.dispatchEvent(new Event('input', { bubbles: true })); } }
      pend.i++;
      if (pend.i < STEPS.length) return ask(STEPS[pend.i][1], STEPS[pend.i][2]);
      pend = { t: 'diarysave' };
      return ask('Everything is filled in. Shall I save the diary? Say yes or no.', 'सब भर दिया है। क्या डायरी सेव कर दूँ? हाँ या नहीं कहिए।');
    }
    if (pend && pend.t === 'diarysave') {
      if (YES.test(n)) { pend = null; const b = document.querySelector('#d-save'); if (!b) return R('The save button was not found. Please tap Save diary.', 'सेव बटन नहीं मिला। कृपया डायरी सेव बटन दबाइए।'); b.click(); await sleep(300); const m = (document.querySelector('#d-msg') || {}).textContent || ''; return R('Diary saved. ' + m + ' What next?', 'डायरी सेव हो गई। ' + m + ' अब क्या करना है?', { listen: true }); }
      if (NO.test(n)) { pend = null; return R('Okay, not saved. The text is still on the screen.', 'ठीक है, सेव नहीं की। लिखा हुआ स्क्रीन पर है।'); }
      return ask('Please say yes to save or no to leave it.', 'सेव के लिए हाँ, या छोड़ने के लिए नहीं कहिए।');
    }
    let m;
    if ((/(diary|डायरी)/.test(n) && /(likho|likh|write|लिखो|लिख)/.test(n)) && !/(open|kholo)/.test(n.replace(/likh\w*/g, ''))) return diaryStart();
    if ((m = raw.match(/(?:note|नोट)\s*(?:likho|likh do|likh|add karo|write|लिखो|लिख दो)\s*[:,\-]?\s*(.+)/i)) && m[1]) {
      if (A().tab() === 'add') { A().form.fill({ note: m[1].trim() }); return R('Note added to the trade form.', addr() + ', नोट ट्रेड फ़ॉर्म में जोड़ दिया।'); }
      return diaryStart(m[1].trim());
    }
    if (OPEN.test(n) && !/(add|naya|new|nayi)/.test(n)) {
      const hit = NAVS.filter(function (x) { return x[1].test(n); })[0];
      if (hit) { A().goto(hit[0]); const nm = TABN[hit[0]]; return ask(nm[0] + ' is open. What would you like to do next?', 'जी ' + addr() + ', ' + nm[1] + ' खुल गया। अब क्या करना है, बताइए।'); }
    }
    if (/(weather|wealth|whether|mausam|मौसम)/.test(n)) return weatherAnswer(n);
    return null;
  }
  const prev = VA.handle;
  VA.handle = async function (raw, src) {
    raw = String(raw || '').trim(); if (!raw) return;
    const n = raw.toLowerCase().replace(/[.,!?।]+$/g, '').trim();
    let r = null;
    try { if (A() && A().ready()) r = await dialog(raw, n); } catch (e) { console.error(e); r = R('Something went wrong. Nothing was changed.', 'कुछ गड़बड़ हुई। कुछ नहीं बदला।'); pend = null; }
    if (!r) return prev(raw, src);
    const l = L(), text = r[l] || r.en;
    if (VA.ui) { VA.ui.addUser(raw, src); VA.ui.addAssistant(text, l); }
    if (pr.mode !== 'text') await tts.speak(text.length > 600 ? text.slice(0, 600) : text, l);
    if (r.listen && src === 'voice') VA.listenOnce({ auto: true });
  };

  /* ================= settings sheet (key, voice, names) ================= */
  function sheet() {
    if (document.getElementById('va-pro-sheet')) { document.getElementById('va-pro-sheet').style.display = 'flex'; return; }
    const d = document.createElement('div'); d.id = 'va-pro-sheet';
    d.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.55)';
    d.innerHTML = '<div style="width:100%;max-width:520px;max-height:88vh;overflow:auto;background:var(--card,#111827);color:var(--tx,#e5e7eb);border-radius:18px 18px 0 0;padding:16px;font:14px system-ui"><b style="font-size:16px">Voice assistant - Pro settings</b>' +
      '<p style="opacity:.7;margin:6px 0 10px">ElevenLabs key is stored only on this phone.</p>' +
      '<label>ElevenLabs API key</label><input id="vp-key" type="password" autocomplete="off" style="width:100%;padding:10px;margin:4px 0 8px;border-radius:10px">' +
      '<label>Voice ID (optional - leave empty to use the default voice)</label><input id="vp-vid" autocomplete="off" placeholder="e.g. 21m00Tcm4TlvDq8ikWAM" style="width:100%;padding:10px;margin:4px 0 8px;border-radius:10px">' +
      '<label>Or pick from your voices</label><div style="display:flex;gap:6px;margin:4px 0 8px"><select id="vp-voice" style="flex:1;padding:10px;border-radius:10px"></select><button id="vp-load" style="padding:10px;border-radius:10px">Load</button></div>' +
      '<label>Quality</label><select id="vp-model" style="width:100%;padding:10px;margin:4px 0 8px;border-radius:10px"><option value="eleven_flash_v2_5">Fast (Flash v2.5)</option><option value="eleven_multilingual_v2">Best quality (Multilingual v2)</option></select>' +
      '<label><input id="vp-off" type="checkbox"> Use phone voice only</label>' +
      '<label style="display:block;margin-top:8px">Assistant name</label><input id="vp-name" style="width:100%;padding:10px;margin:4px 0 8px;border-radius:10px">' +
      '<label>Call me</label><input id="vp-addr" style="width:100%;padding:10px;margin:4px 0 8px;border-radius:10px">' +
      '<label>Home city for weather</label><input id="vp-home" style="width:100%;padding:10px;margin:4px 0 8px;border-radius:10px">' +
      '<div id="vp-msg" style="min-height:18px;margin:6px 0"></div>' +
      '<div style="display:flex;gap:8px"><button id="vp-test" style="flex:1;padding:12px;border-radius:10px">Test voice</button><button id="vp-save" style="flex:1;padding:12px;border-radius:10px;font-weight:700">Save</button><button id="vp-x" style="padding:12px;border-radius:10px">Close</button></div></div>';
    document.body.appendChild(d);
    const $ = function (i) { return d.querySelector('#' + i); }, msg = function (t) { $('vp-msg').textContent = t; };
    $('vp-key').value = pr.elKey || ''; $('vp-vid').value = pr.elVoice || ''; $('vp-model').value = pr.elModel; $('vp-off').checked = !!pr.elOff;
    $('vp-name').value = pr.name || ''; $('vp-addr').value = pr.addr || ''; $('vp-home').value = pr.home || '';
    const fill = function (list) { $('vp-voice').innerHTML = list.map(function (v) { return '<option value="' + v.voice_id + '">' + v.name + (v.labels && v.labels.gender ? ' (' + v.labels.gender + ')' : '') + '</option>'; }).join(''); if (pr.elVoice) $('vp-voice').value = pr.elVoice; };
    $('vp-load').onclick = async function () {
      const k = cleanKey($('vp-key').value); if (!k) return msg('Enter the API key first.');
      msg('Loading voices...');
      try { const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': k } }); if (!r.ok) { let j = null; try { j = await r.json(); } catch (x) { /* no body */ } const d = (j && (j.detail || j)) || {}; if (r.status === 401 && /missing_permissions/.test(JSON.stringify(d))) throw new Error('KEY OK, but it has no "Voices (read)" permission. Either enable it in ElevenLabs > Developers > API Keys, or just paste a Voice ID above and press Test voice.'); const e = new Error(d.message || d.status || ('HTTP ' + r.status)); e.status = r.status; e.code = String(d.status || ''); throw e; }
        const j = await r.json(), v = (j.voices || []).sort(function (a, b) { return ((b.labels && b.labels.gender === 'female') | 0) - ((a.labels && a.labels.gender === 'female') | 0); });
        if (!v.length) throw new Error('No voices on this account'); fill(v); msg(v.length + ' voices loaded. Pick one, then Test voice.'); }
      catch (e) { msg(/^KEY OK/.test(e && e.message) ? e.message : 'Could not load voices: ' + elMsg(e, 'hi')); }
    };
    const store = function () { pr.elKey = cleanKey($('vp-key').value); pr.elVoice = $('vp-vid').value.trim() || $('vp-voice').value || pr.elVoice || ''; pr.elModel = $('vp-model').value; pr.elOff = $('vp-off').checked; pr.name = $('vp-name').value.trim() || pr.name; pr.addr = $('vp-addr').value.trim() || pr.addr; pr.home = $('vp-home').value.trim() || pr.home; cache.clear(); elWarned = 0; VA.savePrefs(); };
    $('vp-save').onclick = function () { store(); msg('Saved.'); };
    $('vp-test').onclick = async function () {
      store(); if (!pr.elKey) return msg('Enter the API key first.');
      msg('Testing ElevenLabs...');
      try {
        const b = await elFetch(L() === 'hi' ? 'नमस्ते ' + addr() + ', मैं ' + pr.name + ' हूँ। अब मेरी आवाज़ कैसी लग रही है?' : 'Hello ' + addr() + ', I am ' + pr.name + '. How does my voice sound now?');
        const u = URL.createObjectURL(b), a = new Audio(u); await a.play(); msg('ElevenLabs is working. The voice is playing.');
      } catch (e) { msg('Failed: ' + elMsg(e, 'hi')); }
    };
    $('vp-x').onclick = function () { d.style.display = 'none'; };
    if (pr.elVoice) fill([{ voice_id: pr.elVoice, name: 'Saved voice' }]);
  }
  VA.proSettings = sheet;
  function btn() {
    if (document.getElementById('va-pro-btn')) return;
    const b = document.createElement('button'); b.id = 'va-pro-btn'; b.textContent = '\u2699'; b.setAttribute('aria-label', 'Voice Pro settings');
    b.style.cssText = 'position:fixed;left:10px;bottom:calc(76px + env(safe-area-inset-bottom,0px));width:34px;height:34px;border-radius:50%;border:0;z-index:9990;opacity:.55;font-size:18px;background:#1f2937;color:#e5e7eb';
    b.onclick = sheet; document.body.appendChild(b);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', btn); else btn();
})();
