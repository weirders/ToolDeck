/* sfha photo editor v1 — shared photo markup for every SFHA tool (ErgoFlow, InspectFlow, CheckFlow, ...).
   Load:   <script src="https://weirders.github.io/ToolDeck/photo-editor.v1.js"></script>
   Global: window.SfhaPhotoEditor  — see PHOTO-EDITOR.md for the contract.

   The editor is storage-agnostic: it takes an image plus earlier markup and hands back blobs and
   data; every tool stores them its own way. Annotations stay data on top of an unannotated base
   (blur is burned into the base), so a photo can be re-edited later without stacking arrows.

   v1 rule: the annotation format below only ever gains fields/types — never renamed or removed.
     {t:'arrow'|'circle'|'ruler', a:{x,y}, b:{x,y}, cm?}   {t:'text', a:{x,y}, s}   {t:'angle', p:[{x,y},{x,y},{x,y}]}
     {t:'blur', a:{x,y}, b:{x,y}}   — only with opts.blurData (otherwise blur is burned into the base)
   Coordinates are pixels in the base image. `scale` = cm per base pixel (set by the first ruler).
   With blurData every step is data over an untouched original, so any device can undo or erase any step. */
(function(){
  'use strict';
  if (window.SfhaPhotoEditor) return;
  const ALL_TOOLS = ['arrow','circle','text','blur','ruler','angle','erase'];
  const STR = {
    en:{close:'✕<i> Close</i>',undo:'↶<i> Undo</i>',save:'✓ Save',saving:'Saving…',del:'🗑<i> Delete</i>',cap:'Caption',discard:'Discard changes to this photo?',delq:'Delete this photo?',
        load:'This photo could not be loaded for editing.',fail:'Saving the photo failed: ',refq:'Real length of this line in cm (reference)',text:'Text',
        tools:{arrow:'➚ Arrow',circle:'◯ Circle',text:'T Text',blur:'▦ Blur',ruler:'📏 Measure',angle:'∠ Angle',erase:'⌫ Erase'},
        hint:{arrow:'Drag to draw an arrow',circle:'Drag to circle something',text:'Tap where the text should go',blur:'Drag over faces, name tags or plates — burned into the photo',blurData:'Drag over faces, name tags or plates',erase:'Tap a marking to remove it',
              ruler:['First drag along a known length as reference','Drag to measure a distance'],angle:['Tap the first point','Tap the corner point','Tap the third point']}},
    nl:{close:'✕<i> Sluit</i>',undo:'↶<i> Herstel</i>',save:'✓ Bewaar',saving:'Bewaren…',del:'🗑<i> Verwijder</i>',cap:'Bijschrift',discard:'Wijzigingen aan deze foto niet bewaren?',delq:'Deze foto verwijderen?',
        load:'Deze foto kon niet worden geladen.',fail:'Bewaren van de foto mislukt: ',refq:'Werkelijke lengte van deze lijn in cm (referentie)',text:'Tekst',
        tools:{arrow:'➚ Pijl',circle:'◯ Cirkel',text:'T Tekst',blur:'▦ Vervaag',ruler:'📏 Maat',angle:'∠ Hoek',erase:'⌫ Wis'},
        hint:{arrow:'Sleep om een pijl te tekenen',circle:'Sleep om iets te omcirkelen',text:'Tik waar de tekst moet komen',blur:'Sleep over gezichten, naamkaartjes of kentekens; dit wordt in de foto gebrand',blurData:'Sleep over gezichten, naamkaartjes of kentekens',erase:'Tik op een markering om die te verwijderen',
              ruler:['Sleep eerst over een bekende lengte als referentie','Sleep om een afstand te meten'],angle:['Tik het eerste punt','Tik het hoekpunt','Tik het derde punt']}}
  };
  const CSS = `
#sfha-pe{position:fixed;inset:0;z-index:2147483000;background:#0d1419;display:flex;flex-direction:column;color:#fff;touch-action:none;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
#sfha-pe *{box-sizing:border-box}
#sfha-pe .pe-top,#sfha-pe .pe-tools{display:flex;align-items:center;gap:6px;padding:8px;flex:none}
#sfha-pe .pe-top{padding-top:calc(8px + env(safe-area-inset-top,0px));flex-wrap:wrap}
#sfha-pe .pe-tools{padding-bottom:calc(8px + env(safe-area-inset-bottom,0px));justify-content:center;flex-wrap:wrap}
#sfha-pe button{background:#1d2a33;color:#fff;border:1px solid #33434f;border-radius:10px;height:42px;padding:0 12px;font:inherit;font-size:15px;font-weight:700;white-space:nowrap;cursor:pointer}
#sfha-pe button[aria-pressed=true],#sfha-pe .pe-save{background:var(--pe-accent);color:#111;border-color:var(--pe-accent)}
#sfha-pe button:disabled{opacity:.6}
#sfha-pe button i{font-style:normal}
@media (max-width:480px) and (orientation:portrait){#sfha-pe .pe-top button i{display:none}#sfha-pe .pe-top button{min-width:46px}}
#sfha-pe .pe-sp{flex:1}
#sfha-pe .pe-cap{flex:1 1 100%;order:9;min-width:0;height:40px;background:#1d2a33;border:1px solid #33434f;border-radius:10px;color:#fff;padding:0 10px;font:inherit;font-size:15px}
#sfha-pe .pe-stage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;position:relative}
#sfha-pe canvas{max-width:100%;max-height:100%;touch-action:none}
#sfha-pe .pe-ask{position:absolute;left:50%;top:12px;transform:translateX(-50%);background:#1d2a33;border:1px solid #33434f;border-radius:10px;padding:8px;display:none;gap:6px;align-items:center;width:min(92%,420px)}
#sfha-pe .pe-ask.on{display:flex}
#sfha-pe .pe-ask input{flex:1;min-width:0;height:38px;border-radius:8px;border:0;padding:0 8px;font:inherit;color:#111;background:#fff}
#sfha-pe .pe-hint{position:absolute;bottom:8px;left:0;right:0;text-align:center;font-size:13px;color:#c8d3db;pointer-events:none;text-shadow:0 1px 2px #000;padding:0 8px}
@media (min-width:700px){#sfha-pe .pe-cap{flex:1 1 200px;order:0}}
@media (orientation:landscape) and (max-height:540px){
  #sfha-pe{flex-direction:row}
  #sfha-pe .pe-top,#sfha-pe .pe-tools{flex-direction:column;flex-wrap:nowrap;overflow-y:auto;overflow-x:hidden;width:150px;padding:8px}
  #sfha-pe .pe-top{order:2;padding-right:calc(8px + env(safe-area-inset-right,0px))}
  #sfha-pe .pe-tools{order:0;padding-left:calc(8px + env(safe-area-inset-left,0px));justify-content:flex-start}
  #sfha-pe .pe-stage{order:1}
  #sfha-pe .pe-top button,#sfha-pe .pe-tools button,#sfha-pe .pe-cap{width:100%;flex:none;order:0}
  #sfha-pe .pe-sp{display:none}
}
@media print{#sfha-pe{display:none!important}}`;

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function injectCss(){ if (document.getElementById('sfha-pe-style')) return; const st = document.createElement('style'); st.id = 'sfha-pe-style'; st.textContent = CSS; document.head.appendChild(st); }
  async function toDrawable(src){
    if (src instanceof HTMLCanvasElement || (typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap) || src instanceof HTMLImageElement) return src;
    const isBlob = src instanceof Blob, url = isBlob ? URL.createObjectURL(src) : String(src);
    try { return await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; }); }
    finally { if (isBlob) setTimeout(() => URL.revokeObjectURL(url), 0); }
  }
  function scaled(src, max){ const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height, k = Math.min(1, max / Math.max(w, h)), c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k); c.getContext('2d').drawImage(src, 0, 0, c.width, c.height); return c; }
  const toBlob = (c, q) => new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('encode failed')), 'image/jpeg', q));
  const unit = c => Math.max(c.width, c.height) / 420;

  /* Draw annotations onto a 2D context whose canvas has the base's pixel size. Exposed as SfhaPhotoEditor.paint. */
  function paint(c, anns, scale, opt){
    opt = opt || {}; const u = unit(c.canvas), Y = opt.color || '#F2C200', K = 'rgba(10,16,20,.85)', fmt = opt.fmtNum || (n => String(n));
    c.lineCap = 'round'; c.lineJoin = 'round';
    const line = (a, b) => { c.strokeStyle = K; c.lineWidth = u * 3.2; c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke(); c.strokeStyle = Y; c.lineWidth = u * 1.6; c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke(); };
    const label = (s, x, y) => { c.font = `600 ${u * 9}px system-ui,sans-serif`; const w = c.measureText(s).width + u * 8, h = u * 14; x = Math.min(Math.max(x - w / 2, 2), c.canvas.width - w - 2); y = Math.min(Math.max(y - h / 2, 2), c.canvas.height - h - 2); c.fillStyle = K; c.beginPath(); c.roundRect ? c.roundRect(x, y, w, h, u * 3) : c.rect(x, y, w, h); c.fill(); c.fillStyle = Y; c.textBaseline = 'middle'; c.fillText(s, x + u * 4, y + h / 2 + u * .5); };
    for (const a of anns || []) if (a.t === 'blur') pixelate(c, a);
    for (const a of anns || []) {
      if (a.t === 'arrow') { const ang = Math.atan2(a.b.y - a.a.y, a.b.x - a.a.x), hl = u * 9; line(a.a, a.b); line(a.b, {x:a.b.x - hl * Math.cos(ang - .45), y:a.b.y - hl * Math.sin(ang - .45)}); line(a.b, {x:a.b.x - hl * Math.cos(ang + .45), y:a.b.y - hl * Math.sin(ang + .45)}); }
      else if (a.t === 'circle') { const cx = (a.a.x + a.b.x) / 2, cy = (a.a.y + a.b.y) / 2, rx = Math.max(1, Math.abs(a.b.x - a.a.x) / 2), ry = Math.max(1, Math.abs(a.b.y - a.a.y) / 2); [[K, 3.2], [Y, 1.6]].forEach(([col, lw]) => { c.strokeStyle = col; c.lineWidth = u * lw; c.beginPath(); c.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); c.stroke(); }); }
      else if (a.t === 'ruler') { const ang = Math.atan2(a.b.y - a.a.y, a.b.x - a.a.x) + Math.PI / 2, k = u * 4, tick = q => line({x:q.x - k * Math.cos(ang), y:q.y - k * Math.sin(ang)}, {x:q.x + k * Math.cos(ang), y:q.y + k * Math.sin(ang)}); line(a.a, a.b); tick(a.a); tick(a.b);
        const px = Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y); if (scale || a.cm) label(fmt(Math.round(a.cm || px * scale)) + ' cm', (a.a.x + a.b.x) / 2, (a.a.y + a.b.y) / 2 - u * 10); }
      else if (a.t === 'angle') { const [p1, v, p2] = a.p; line(v, p1); line(v, p2); const a1 = Math.atan2(p1.y - v.y, p1.x - v.x), a2 = Math.atan2(p2.y - v.y, p2.x - v.x); let d = a2 - a1; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
        const rad = Math.min(u * 22, Math.hypot(p1.x - v.x, p1.y - v.y) * .5, Math.hypot(p2.x - v.x, p2.y - v.y) * .5); c.strokeStyle = Y; c.lineWidth = u * 1.2; c.beginPath(); c.arc(v.x, v.y, rad, a1, a2, d < 0); c.stroke(); const mid = a1 + d / 2; label(Math.round(Math.abs(d) * 180 / Math.PI) + '°', v.x + Math.cos(mid) * (rad + u * 14), v.y + Math.sin(mid) * (rad + u * 14)); }
      else if (a.t === 'text') label(a.s, a.a.x, a.a.y);
    }
  }

  /* Pixelate a rectangle of whatever the context's canvas currently shows (used for burned and data blur alike). */
  function pixelate(c, r){
    const cv = c.canvas, x = Math.max(0, Math.round(Math.min(r.a.x, r.b.x))), y = Math.max(0, Math.round(Math.min(r.a.y, r.b.y)));
    const w = Math.min(cv.width - x, Math.round(Math.abs(r.b.x - r.a.x))), h = Math.min(cv.height - y, Math.round(Math.abs(r.b.y - r.a.y)));
    if (w < 2 || h < 2) return;
    const bs = Math.max(10, Math.max(w, h) / 7), tw = Math.max(1, Math.ceil(w / bs)), th = Math.max(1, Math.ceil(h / bs)), tmp = document.createElement('canvas'); tmp.width = tw; tmp.height = th;
    const tc = tmp.getContext('2d'); tc.imageSmoothingEnabled = true; tc.drawImage(cv, x, y, w, h, 0, 0, tw, th);
    const sm = c.imageSmoothingEnabled; c.imageSmoothingEnabled = false; c.drawImage(tmp, 0, 0, tw, th, x, y, w, h); c.imageSmoothingEnabled = sm;
  }
  /* Topmost annotation under point p (base pixels), or -1. */
  function hitAnn(anns, p, u){
    const tol = u * 9, dSeg = (a, b) => { const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy, k = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0; return Math.hypot(p.x - a.x - k * dx, p.y - a.y - k * dy); };
    for (let i = anns.length - 1; i >= 0; i--) { const a = anns[i];
      if (a.t === 'arrow' || a.t === 'ruler') { if (dSeg(a.a, a.b) < tol) return i; }
      else if (a.t === 'angle') { if (dSeg(a.p[1], a.p[0]) < tol || dSeg(a.p[1], a.p[2]) < tol) return i; }
      else if (a.t === 'circle' || a.t === 'blur') { const x0 = Math.min(a.a.x, a.b.x) - tol, x1 = Math.max(a.a.x, a.b.x) + tol, y0 = Math.min(a.a.y, a.b.y) - tol, y1 = Math.max(a.a.y, a.b.y) + tol; if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) return i; }
      else if (a.t === 'text') { const w = String(a.s || '').length * u * 5.5 + u * 8; if (Math.abs(p.x - a.a.x) < w / 2 + tol / 2 && Math.abs(p.y - a.a.y) < u * 7 + tol / 2) return i; }
    }
    return -1;
  }

  /* Back button: by default the editor pushes one history entry and closes on Back. A tool with its
     own back-stack passes opts.backTrap = {push(close) -> handle, release(handle)}. */
  function builtinTrap(){
    return {
      push(close){ const h = {close, on:null, pushed:false}; try { history.pushState({sfhaPhotoEditor:1}, ''); h.pushed = true; } catch(e){}
        h.on = () => { window.removeEventListener('popstate', h.on); h.pushed = false; h.close(); }; window.addEventListener('popstate', h.on); return h; },
      release(h){ if (!h) return; window.removeEventListener('popstate', h.on); if (h.pushed) { h.pushed = false; try { history.back(); } catch(e){} } }
    };
  }

  let cur = null;
  async function open(opts){
    if (cur) return; opts = opts || {}; injectCss();
    const L = STR[opts.lang === 'nl' ? 'nl' : 'en'], tools = (opts.tools || ALL_TOOLS).filter(t => ALL_TOOLS.includes(t)), accent = opts.accent || '#F2C200';
    const fmt = opts.fmtNum || (n => Number(n).toLocaleString(opts.lang === 'nl' ? 'nl-NL' : 'en-GB'));
    let img; try { img = await toDrawable(opts.src); } catch(e) { alert(L.load); return; }
    const base = scaled(img, opts.maxSize || 4000);
    const blurData = !!opts.blurData, ann0 = JSON.parse(JSON.stringify(opts.ann || [])).filter(a => blurData || a.t !== 'blur');
    // every loaded annotation is on the undo stack, so steps made earlier (or on another device) can be taken back
    const E = cur = {base, ann:ann0, scale:opts.scale || null, tool:tools[0] || 'arrow', pts:[], drag:null, undo:ann0.map(() => 'ann'), dirty:false, busy:false};
    const el = document.createElement('div'); el.id = 'sfha-pe'; el.style.setProperty('--pe-accent', accent);
    const hasCap = typeof opts.caption === 'string';
    el.innerHTML = `<div class="pe-top"><button data-a="close">${L.close}</button>${opts.onDelete ? `<button data-a="del">${L.del}</button>` : ''}${hasCap ? `<input class="pe-cap" type="text" placeholder="${esc(opts.captionPlaceholder || L.cap)}" value="${esc(opts.caption)}">` : ''}<span class="pe-sp"></span><button data-a="undo">${L.undo}</button><button data-a="save" class="pe-save">${L.save}</button></div>
      <div class="pe-stage"><canvas></canvas><div class="pe-ask"><input><button data-a="ok">OK</button></div><div class="pe-hint"></div></div>
      <div class="pe-tools">${tools.map(t => `<button data-tool="${t}" aria-pressed="${t === E.tool}">${L.tools[t]}</button>`).join('')}</div>`;
    document.body.appendChild(el);
    const q = s => el.querySelector(s), cv = q('canvas'), ctx = cv.getContext('2d'), ask = q('.pe-ask'), askIn = q('.pe-ask input'), cap = q('.pe-cap');
    cv.width = base.width; cv.height = base.height;
    const trapApi = opts.backTrap || builtinTrap();
    const onBack = () => { E.trap = null; if (E.dirty && !confirm(L.discard)) { E.trap = trapApi.push(onBack); return; } remove(); };
    E.trap = trapApi.push(onBack);
    function remove(){ el.remove(); cur = null; E.base = null; if (opts.onClose) try { opts.onClose(); } catch(e){ console.error(e); } }
    function close(){ const t = E.trap; E.trap = null; if (t) trapApi.release(t); remove(); }
    const U = () => unit(base);
    function hint(){ let h = E.tool === 'blur' && blurData ? L.hint.blurData : L.hint[E.tool]; if (E.tool === 'angle') h = h[E.pts.length] || h[0]; if (E.tool === 'ruler') h = h[E.scale ? 1 : 0];
      if (opts.hint) { const o = opts.hint(E.tool, {step:E.pts.length, hasScale:!!E.scale, lang:opts.lang}); if (o != null) h = o; } q('.pe-hint').textContent = h; }
    function draw(){ ctx.drawImage(base, 0, 0); const tmp = [...E.ann], d = E.drag;
      if (d) { if (E.tool === 'blur') { paint(ctx, tmp, E.scale, {color:accent, fmtNum:fmt}); ctx.save(); ctx.setLineDash([U() * 3, U() * 3]); ctx.lineWidth = U(); ctx.strokeStyle = accent; ctx.strokeRect(d.a.x, d.a.y, d.b.x - d.a.x, d.b.y - d.a.y); ctx.restore(); return; } tmp.push({t:E.tool, a:d.a, b:d.b}); }
      paint(ctx, tmp, E.scale, {color:accent, fmtNum:fmt}); if (E.pts.length) { ctx.fillStyle = accent; E.pts.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, U() * 2.5, 0, 7); ctx.fill(); }); } }
    function askFor(label, type, cb){ askIn.type = type; askIn.value = ''; askIn.placeholder = label; if (type === 'number') askIn.inputMode = 'decimal'; ask.classList.add('on'); askIn.focus();
      const done = () => { ask.classList.remove('on'); cb(askIn.value.trim()); }; q('[data-a=ok]').onclick = done; askIn.onkeydown = e => { if (e.key === 'Enter') done(); }; }
    const pt = ev => { const r = cv.getBoundingClientRect(); return {x:(ev.clientX - r.left) * cv.width / r.width, y:(ev.clientY - r.top) * cv.height / r.height}; };
    cv.onpointerdown = ev => { ev.preventDefault(); if (ask.classList.contains('on')) return; const p = pt(ev);
      if (E.tool === 'erase') { const i = hitAnn(E.ann, p, U()); if (i >= 0) { const item = E.ann.splice(i, 1)[0]; E.undo.push({erase:i, item}); if (item.t === 'ruler' && !E.ann.some(x => x.t === 'ruler')) { E.undo[E.undo.length - 1].scale = E.scale; E.scale = null; } E.dirty = true; hint(); draw(); } }
      else if (E.tool === 'angle') { E.pts.push(p); if (E.pts.length === 3) { E.ann.push({t:'angle', p:E.pts}); E.undo.push('ann'); E.pts = []; E.dirty = true; } hint(); draw(); }
      else if (E.tool === 'text') askFor(L.text, 'text', v => { if (v) { E.ann.push({t:'text', a:p, s:v}); E.undo.push('ann'); E.dirty = true; draw(); } });
      else { E.drag = {a:p, b:p}; cv.setPointerCapture(ev.pointerId); } };
    cv.onpointermove = ev => { if (E.drag) { E.drag.b = pt(ev); draw(); } };
    cv.onpointerup = () => { const d = E.drag; E.drag = null; if (!d) return; const len = Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y); if (len < U() * 6) { draw(); return; }
      if (E.tool === 'arrow' || E.tool === 'circle') { E.ann.push({t:E.tool, a:d.a, b:d.b}); E.undo.push('ann'); }
      else if (E.tool === 'ruler') { const add = () => { E.ann.push({t:'ruler', a:d.a, b:d.b}); E.undo.push('ann'); E.dirty = true; hint(); draw(); };
        if (!E.scale) askFor(L.refq, 'number', v => { const n = parseFloat(String(v).replace(',', '.')); if (n > 0) { E.scale = n / len; add(); } else draw(); }); else add(); return; }
      else if (E.tool === 'blur' && blurData) { E.ann.push({t:'blur', a:{x:Math.min(d.a.x, d.b.x), y:Math.min(d.a.y, d.b.y)}, b:{x:Math.max(d.a.x, d.b.x), y:Math.max(d.a.y, d.b.y)}}); E.undo.push('ann'); }
      else if (E.tool === 'blur') { const x = Math.round(Math.min(d.a.x, d.b.x)), y = Math.round(Math.min(d.a.y, d.b.y)), w = Math.round(Math.abs(d.b.x - d.a.x)), h = Math.round(Math.abs(d.b.y - d.a.y));
        if (w > 4 && h > 4) { const bx = base.getContext('2d'); E.undo.push({x, y, img:bx.getImageData(x, y, w, h)});
          const bs = Math.max(10, Math.max(w, h) / 7), tw = Math.max(1, Math.ceil(w / bs)), th = Math.max(1, Math.ceil(h / bs)), tmp = document.createElement('canvas'); tmp.width = tw; tmp.height = th; const tc = tmp.getContext('2d'); tc.imageSmoothingEnabled = true; tc.drawImage(base, x, y, w, h, 0, 0, tw, th); bx.imageSmoothingEnabled = false; bx.drawImage(tmp, 0, 0, tw, th, x, y, w, h); bx.imageSmoothingEnabled = true; } }
      E.dirty = true; draw(); };
    q('.pe-tools').onclick = ev => { const b = ev.target.closest('[data-tool]'); if (!b) return; E.tool = b.dataset.tool; E.pts = []; el.querySelectorAll('[data-tool]').forEach(x => x.setAttribute('aria-pressed', x === b)); hint(); draw(); };
    if (cap) cap.oninput = () => { E.dirty = true; };
    q('.pe-top').onclick = async ev => { const b = ev.target.closest('[data-a]'); if (!b || E.busy) return; const a = b.dataset.a;
      if (a === 'close') { if (E.dirty && !confirm(L.discard)) return; close(); }
      else if (a === 'undo') { if (E.pts.length) E.pts.pop(); else { const u = E.undo.pop(); if (u === 'ann') { E.ann.pop(); if (!E.ann.some(x => x.t === 'ruler')) E.scale = null; } else if (u && u.erase !== undefined) { E.ann.splice(u.erase, 0, u.item); if (u.scale) E.scale = u.scale; E.dirty = true; } else if (u) base.getContext('2d').putImageData(u.img, u.x, u.y); } hint(); draw(); }
      else if (a === 'del') { if (!confirm(opts.deleteConfirm || L.delq)) return; E.busy = true; try { await opts.onDelete(); close(); } catch(e) { E.busy = false; alert(L.fail + (e.message || e)); } }
      else if (a === 'save') { E.busy = true; b.disabled = true; b.textContent = L.saving;
        try { const out = document.createElement('canvas'); out.width = base.width; out.height = base.height; const oc = out.getContext('2d'); oc.drawImage(base, 0, 0); paint(oc, E.ann, E.scale, {color:accent, fmtNum:fmt});
          const res = {full:await toBlob(out, opts.quality || .86), base:blurData ? null : await toBlob(base, opts.baseQuality || .9), thumb:scaled(out, opts.thumbSize || 320).toDataURL('image/jpeg', opts.thumbQuality || .8),
            ann:E.ann, scale:E.scale, width:out.width, height:out.height, caption:cap ? cap.value : undefined, dirty:E.dirty};
          if (opts.onSave) await opts.onSave(res); close(); }
        catch(e) { E.busy = false; b.disabled = false; b.textContent = L.save; alert(L.fail + (e.message || e)); } } };
    hint(); draw();
  }
  window.SfhaPhotoEditor = {version:'1', tools:ALL_TOOLS.slice(), open, paint, isOpen:() => !!cur};
})();
