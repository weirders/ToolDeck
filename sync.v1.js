/* =====================================================================
   sfha-sync  v1  —  shared local-first sync layer for single-file HTML apps
   https://weirders.github.io/ToolDeck/sync.v1.js

   Every app on weirders.github.io/<repo>/ shares ONE origin, therefore ONE
   IndexedDB ('sfha-sync') and ONE BroadcastChannel ('sfha-sync').

   - records : {id, app, coll, updatedAt (ISO), deleted, payload}  (index appColl)
   - assets  : {hash, blob, mime, size}  content-addressed, SHA-256
   - contacts: {peerId, label, lastSeen, lastSync}
   - meta    : {key, ...}  (peerId, settings)

   Leader rule: exactly one window per origin registers the PeerJS peer,
   dials contacts every 30 s and answers incoming connections. Elected via
   navigator.locks ('sfha-sync-leader'); heartbeat fallback without Web Locks.
   All other windows only use the DB and receive 'changed' over the channel.

   Wire protocol per connection (unchanged from FloorplanWeb):
     manifest -> want -> records + asset/chunk (64 KB) -> done
   Last-write-wins per record on updatedAt. Tombstones are never removed.
   ===================================================================== */
(function () {
  'use strict';
  if (window.SfhaSync) return;

  const DB_NAME = 'sfha-sync', DB_VERSION = 1, CHANNEL = 'sfha-sync', LOCK = 'sfha-sync-leader';
  const PEERJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.5/peerjs.min.js';
  const ICE = { iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun.relay.metered.ca:80'] },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ] };
  const CHUNK = 65536, DIAL_MS = 30000, DEBOUNCE_MS = 10000, OPEN_TIMEOUT = 20000, BUFFER_HIGH = 4 * 1048576;
  const HB_MS = 2000, HB_DEAD_MS = 6500, LOG_MAX = 40;

  /* ---------- utils ---------- */
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  const nowIso = () => new Date().toISOString();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const short = id => String(id || '').slice(0, 8);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isHash = h => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);
  const validId = id => /^[A-Za-z0-9_-]{8,64}$/.test(id);
  async function sha256(bufOrBlob) {
    const buf = bufOrBlob instanceof Blob ? await bufOrBlob.arrayBuffer() : bufOrBlob;
    const h = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /* ---------- state ---------- */
  let db = null, bc = null, appName = null, myId = null, initPromise = null;
  const winId = uid();
  let isLeader = false, leaderKnown = false;
  const changeFns = new Set(), statusFns = new Set();

  // leader-only
  let peer = null, broker = 'offline', brokerMsg = '', dialTimer = null, hbTimer = null;
  const conns = new Map();   // peerId -> {conn, dir, state, lastManifest, timer, expect, incoming, stats, lastSyncAt}
  const pending = new Map(); // unknown incoming peers awaiting approval
  let contactsCache = [];
  const logLines = [];
  let lastSync = null;       // {peerId, label, at, records, assets}

  // follower-only mirror of the leader's status
  let mirror = null;

  /* ---------- IndexedDB ---------- */
  function openDb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = e => {
        const d = e.target.result, has = n => d.objectStoreNames.contains(n);
        if (!has('records')) d.createObjectStore('records', { keyPath: 'id' }).createIndex('appColl', ['app', 'coll'], { unique: false });
        if (!has('assets')) d.createObjectStore('assets', { keyPath: 'hash' });
        if (!has('contacts')) d.createObjectStore('contacts', { keyPath: 'peerId' });
        if (!has('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      };
      r.onsuccess = e => { db = e.target.result; db.onversionchange = () => db.close(); res(); };
      r.onerror = e => rej(e.target.error);
      r.onblocked = () => rej(new Error('sfha-sync: database upgrade blocked by another tab'));
    });
  }
  function tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode); const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req && req.result); t.onerror = e => rej(e.target.error); t.onabort = e => rej(e.target.error);
    });
  }
  const dbGetAll = s => tx(s, 'readonly', o => o.getAll());
  const dbGetAllKeys = s => tx(s, 'readonly', o => o.getAllKeys());
  const dbGet = (s, k) => tx(s, 'readonly', o => o.get(k));
  const dbHas = (s, k) => tx(s, 'readonly', o => o.getKey(k)).then(k2 => k2 !== undefined);
  const dbPut = (s, v) => tx(s, 'readwrite', o => o.put(v));
  const dbDel = (s, k) => tx(s, 'readwrite', o => o.delete(k));
  const dbIndex = (s, idx, key) => tx(s, 'readonly', o => o.index(idx).getAll(key));
  const ready = () => { if (!db) throw new Error('sfha-sync: call SfhaSync.init({app}) first'); };

  /* ---------- log / status ---------- */
  const log = msg => { logLines.push(new Date().toLocaleTimeString() + ' ' + msg); if (logLines.length > LOG_MAX) logLines.shift(); pushStatus(); };
  function snapshot() {
    return {
      leader: isLeader, leaderPresent: true, app: appName, myId, broker, brokerMsg,
      connections: [...conns.values()].map(e => ({ peerId: e.conn.peer, dir: e.dir, state: e.state, syncing: !!e.expect, lastSyncAt: e.lastSyncAt || 0 })),
      pending: [...pending.keys()], lastSync, log: logLines.slice(),
    };
  }
  let statusTimer = null;
  function pushStatus() {
    if (!isLeader) return;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { const s = snapshot(); try { bc && bc.postMessage({ t: 'status', s }); } catch {} fireStatus(s); }, 30);
  }
  function fireStatus(s) { for (const fn of statusFns) { try { fn(s); } catch (e) { console.error(e); } } if (panel) renderPanel(); }
  function status() {
    if (isLeader) return snapshot();
    if (mirror) return { ...mirror, leader: false, leaderPresent: true };
    return { leader: false, leaderPresent: leaderKnown, app: appName, myId, broker: 'offline', brokerMsg: '', connections: [], pending: [], lastSync: null, log: [] };
  }

  /* ---------- records ---------- */
  function fireChange(ev) { for (const fn of changeFns) { try { fn(ev); } catch (e) { console.error(e); } } }
  function emitChange(app, coll, ids) {
    const ev = { app, coll, ids };
    fireChange(ev);
    try { bc && bc.postMessage({ t: 'changed', ...ev }); } catch {}
    if (isLeader) notifyChanged();
  }
  function normalize(app, coll, record, keepStamp) {
    if (!record || typeof record !== 'object') throw new Error('sfha-sync: record must be an object');
    let payload;
    if ('payload' in record) payload = record.payload;
    else { payload = { ...record }; delete payload.id; delete payload.app; delete payload.coll; delete payload.updatedAt; delete payload.deleted; }
    return {
      id: record.id || uid(), app, coll,
      updatedAt: keepStamp && record.updatedAt ? record.updatedAt : nowIso(),
      deleted: record.deleted === undefined ? false : !!record.deleted,
      payload: payload === undefined ? {} : payload,
    };
  }
  async function list(app, coll, opts = {}) {
    ready(); const all = await dbIndex('records', 'appColl', [app, coll]);
    return opts.includeDeleted ? all : all.filter(r => !r.deleted);
  }
  async function get(app, coll, id) {
    ready(); const r = await dbGet('records', id);
    return r && r.app === app && r.coll === coll ? r : undefined;
  }
  async function put(app, coll, record, opts = {}) {
    ready(); const rec = normalize(app, coll, record, opts.keepStamp);
    await dbPut('records', rec);
    if (!opts.silent) emitChange(app, coll, [rec.id]);
    return rec;
  }
  async function del(app, coll, id) {
    ready(); const r = await dbGet('records', id);
    if (!r || r.app !== app || r.coll !== coll) return null;
    r.deleted = true; r.updatedAt = nowIso();
    await dbPut('records', r); emitChange(app, coll, [id]);
    return r;
  }
  /** Last-write-wins merge of remote records. Returns number applied; emits grouped change events. */
  async function mergeRecords(recs) {
    let n = 0; const groups = new Map();
    for (const r of recs || []) {
      if (!r || typeof r.id !== 'string' || typeof r.app !== 'string' || typeof r.coll !== 'string' || typeof r.updatedAt !== 'string') continue;
      const local = await dbGet('records', r.id);
      if (local && local.updatedAt >= r.updatedAt) continue;
      await dbPut('records', { id: r.id, app: r.app, coll: r.coll, updatedAt: r.updatedAt, deleted: !!r.deleted, payload: r.payload === undefined ? {} : r.payload });
      const k = r.app + '\u0000' + r.coll; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r.id); n++;
    }
    for (const [k, ids] of groups) { const [app, coll] = k.split('\u0000'); const ev = { app, coll, ids }; fireChange(ev); try { bc.postMessage({ t: 'changed', ...ev }); } catch {} }
    return n;
  }

  /* ---------- assets ---------- */
  async function putAsset(blob) {
    ready(); if (!(blob instanceof Blob)) throw new Error('sfha-sync: putAsset expects a Blob');
    const hash = await sha256(blob);
    if (!(await dbHas('assets', hash))) await dbPut('assets', { hash, blob, mime: blob.type, size: blob.size });
    return hash;
  }
  async function getAsset(hash) { ready(); const a = await dbGet('assets', hash); return a ? a.blob : null; }
  async function hasAsset(hash) { ready(); return dbHas('assets', hash); }

  /** Every hash referenced by any live record: `hash` fields anywhere in the payload, plus `hashes` arrays. */
  function collectHashes(node, out, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) { for (const v of node) collectHashes(v, out, depth + 1); return; }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'hash' && isHash(v)) out.add(v);
      else if (k === 'hashes' && Array.isArray(v)) { for (const h of v) if (isHash(h)) out.add(h); }
      else if (v && typeof v === 'object') collectHashes(v, out, depth + 1);
    }
  }

  /* ---------- leader election ---------- */
  function startElection() {
    if (navigator.locks && navigator.locks.request) {
      navigator.locks.request(LOCK, async () => { await becomeLeader(); await new Promise(() => {}); }).catch(e => log('lock error: ' + (e.message || e)));
    } else {
      // Fallback: heartbeat election over the BroadcastChannel
      let lastBeat = 0; leaderKnown = false;
      const onBeat = () => { lastBeat = Date.now(); leaderKnown = true; };
      window.__sfhaOnBeat = onBeat;
      const check = async () => {
        if (isLeader) return;
        if (Date.now() - lastBeat < HB_DEAD_MS) return;
        await sleep(Math.random() * 1500);
        if (isLeader || Date.now() - lastBeat < HB_DEAD_MS) return;
        await becomeLeader();
      };
      setTimeout(check, 500 + Math.random() * 500);
      setInterval(check, HB_DEAD_MS);
    }
  }
  async function becomeLeader() {
    if (isLeader) return;
    isLeader = true; leaderKnown = true; mirror = null;
    contactsCache = await dbGetAll('contacts');
    if (!navigator.locks) { clearInterval(hbTimer); hbTimer = setInterval(() => { try { bc.postMessage({ t: 'hb', winId }); } catch {} }, HB_MS); try { bc.postMessage({ t: 'hb', winId }); } catch {} }
    log('this window is now the sync leader');
    if (!window.Peer) {
      await new Promise(res => { const s = document.createElement('script'); s.src = PEERJS_URL; s.onload = res; s.onerror = () => res(); document.head.appendChild(s); });
    }
    if (!window.Peer) { broker = 'disabled'; brokerMsg = 'PeerJS could not be loaded'; pushStatus(); return; }
    await createPeer();
    const bye = () => { if (peer) { try { peer.destroy(); } catch {} } };
    window.addEventListener('pagehide', bye); window.addEventListener('beforeunload', bye);
    pushStatus();
  }
  function stepDown(reason) {
    // Used by the heartbeat fallback when two windows collided on the peer ID.
    log('stepping down: ' + reason);
    isLeader = false; clearInterval(dialTimer); clearInterval(hbTimer);
    for (const e of conns.values()) { try { e.conn.close(); } catch {} } conns.clear();
    if (peer) { try { peer.destroy(); } catch {} peer = null; }
    broker = 'offline';
  }

  /* ---------- broker ---------- */
  async function createPeer() {
    let opts = { debug: 0, config: ICE };
    const settings = (await dbGet('meta', 'settings')) || {};
    const ps = settings.peerServer || (await dbGet('meta', 'peerServer'));
    if (ps && ps.host) opts = { ...opts, host: ps.host, port: ps.port, path: ps.path || '/', secure: ps.secure !== false };
    broker = 'connecting'; pushStatus();
    peer = new Peer(myId, opts);
    peer.on('open', () => { broker = 'online'; brokerMsg = ''; log('broker: online as ' + short(myId)); pushStatus(); dialAll(); });
    peer.on('connection', handleIncoming);
    peer.on('disconnected', () => { if (broker === 'id-taken') return; broker = 'offline'; pushStatus(); setTimeout(() => { if (peer && !peer.destroyed && broker === 'offline') { broker = 'connecting'; pushStatus(); peer.reconnect(); } }, 5000); });
    peer.on('close', () => { if (broker !== 'id-taken') broker = 'offline'; pushStatus(); });
    peer.on('error', err => {
      const type = err.type || '';
      if (type === 'unavailable-id') {
        broker = 'id-taken'; log('broker: ID already in use elsewhere'); try { peer.destroy(); } catch {}
        if (!navigator.locks) stepDown('peer ID collision'); // another window is the real leader
        pushStatus(); return;
      }
      if (type === 'peer-unavailable') return; // contact is simply offline
      if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(type)) { broker = 'offline'; brokerMsg = err.message || type; pushStatus(); setTimeout(() => { if (isLeader && broker === 'offline') { try { peer.destroy(); } catch {} createPeer(); } }, 15000); return; }
      log('error: ' + type + ' ' + (err.message || '')); brokerMsg = err.message || type; pushStatus();
    });
    clearInterval(dialTimer); dialTimer = setInterval(dialAll, DIAL_MS);
  }

  /* ---------- dialling & dedupe ---------- */
  const contact = pid => contactsCache.find(c => c.peerId === pid);
  function dialAll() {
    if (!isLeader || broker !== 'online' || !peer || peer.destroyed || peer.disconnected) return;
    for (const c of contactsCache) if (!conns.has(c.peerId)) dial(c.peerId);
  }
  function dial(pid) {
    let conn; try { conn = peer.connect(pid, { reliable: true }); } catch { return; }
    if (!conn) return;
    setupConn(conn, 'out');
    setTimeout(() => { const e = conns.get(pid); if (e && e.conn === conn && e.state !== 'open') { try { conn.close(); } catch {} if (conns.get(pid) === e) conns.delete(pid); pushStatus(); } }, OPEN_TIMEOUT);
  }
  function handleIncoming(conn) {
    const pid = conn.peer;
    if (contact(pid)) return adopt(conn, 'in');
    if (pending.has(pid)) { try { conn.close(); } catch {} return; }
    pending.set(pid, conn); pushStatus();
    conn.on('close', () => { if (pending.get(pid) === conn) { pending.delete(pid); pushStatus(); } });
    promptUnknown(pid, async label => {
      pending.delete(pid);
      if (label === null) { try { conn.close(); } catch {} pushStatus(); return; }
      await addContact(pid, label, { noDial: true });
      adopt(conn, 'in');
    });
  }
  /** Both sides may dial at once: the peer with the lexically lower ID keeps its outgoing connection. */
  function adopt(conn, dir) {
    const pid = conn.peer, existing = conns.get(pid);
    if (existing && existing.conn !== conn) {
      const keep = myId < pid ? 'out' : 'in';
      if (dir !== keep) { log('dedupe: dropping duplicate ' + dir + ' from ' + short(pid)); try { conn.close(); } catch {} return; }
      log('dedupe: replacing ' + existing.dir + ' with ' + dir + ' for ' + short(pid));
      const old = existing.conn; conns.delete(pid); try { old.close(); } catch {}
    }
    setupConn(conn, dir);
  }
  function setupConn(conn, dir) {
    const pid = conn.peer;
    const entry = { conn, dir, state: 'connecting', lastManifest: 0, timer: null, expect: null, incoming: {}, stats: null, lastSyncAt: 0 };
    conns.set(pid, entry); pushStatus();
    const onOpen = () => {
      if (conns.get(pid) !== entry) return;
      entry.state = 'open'; log((dir === 'out' ? '→ ' : '← ') + 'connected ' + short(pid));
      const c = contact(pid); if (c) { c.lastSeen = Date.now(); dbPut('contacts', c); }
      pushStatus(); requestSync(pid);
    };
    conn.on('open', onOpen);
    conn.on('data', data => onData(entry, data).catch(e => log('error: ' + (e.message || e))));
    const gone = () => { if (conns.get(pid) === entry) { conns.delete(pid); clearTimeout(entry.timer); log('closed ' + short(pid)); pushStatus(); } };
    conn.on('close', gone); conn.on('error', e => { log('conn error ' + short(pid) + ': ' + (e.message || e.type || e)); gone(); });
    if (conn.open) onOpen();
  }

  /* ---------- protocol ---------- */
  async function buildManifest() {
    const recs = await dbGetAll('records');
    const have = new Set(await dbGetAllKeys('assets'));
    const hashes = new Set();
    for (const r of recs) if (!r.deleted) collectHashes(r.payload, hashes);
    return { t: 'manifest', v: 1, records: recs.map(r => [r.id, r.updatedAt, r.deleted ? 1 : 0]), assets: [...hashes].filter(h => have.has(h)) };
  }
  /** Send our manifest to a peer, at most once per 10 s per peer (later calls coalesce into one delayed send). */
  function requestSync(pid, force) {
    const e = conns.get(pid); if (!e || e.state !== 'open') return;
    if (force) { e.lastManifest = 0; clearTimeout(e.timer); e.timer = null; }
    const wait = DEBOUNCE_MS - (Date.now() - e.lastManifest);
    if (wait > 0) { if (!e.timer) e.timer = setTimeout(() => { e.timer = null; requestSync(pid); }, wait); return; }
    e.lastManifest = Date.now();
    buildManifest().then(m => { if (conns.get(pid) === e && e.state === 'open') e.conn.send(m); }).catch(err => log('manifest error: ' + (err.message || err)));
  }
  async function onData(entry, msg) {
    const pid = entry.conn.peer; if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'manifest': {
        const local = new Map((await dbGetAll('records')).map(r => [r.id, r.updatedAt]));
        const have = new Set(await dbGetAllKeys('assets'));
        const wantRecords = (msg.records || []).filter(([id, upd]) => !local.has(id) || local.get(id) < upd).map(([id]) => id);
        const wantAssets = (msg.assets || []).filter(h => isHash(h) && !have.has(h));
        entry.expect = { assets: new Set(wantAssets), done: false }; entry.stats = { records: 0, assets: 0 };
        if (wantRecords.length || wantAssets.length) log('← ' + short(pid) + ': requesting ' + wantRecords.length + ' records, ' + wantAssets.length + ' files');
        entry.conn.send({ t: 'want', v: 1, records: wantRecords, assets: wantAssets }); pushStatus(); break;
      }
      case 'want': {
        const ids = new Set(Array.isArray(msg.records) ? msg.records : Object.values(msg.records || {}).flat());
        const records = ids.size ? (await dbGetAll('records')).filter(r => ids.has(r.id)) : [];
        entry.conn.send({ t: 'records', v: 1, records });
        for (const hash of msg.assets || []) { const blob = await getAsset(hash); if (blob) await sendAsset(entry.conn, hash, blob); }
        entry.conn.send({ t: 'done', v: 1 }); break;
      }
      case 'records': {
        const n = await mergeRecords(msg.records || []);
        if (entry.stats) entry.stats.records += n;
        if (n) afterRemoteChange(); break;
      }
      case 'asset': entry.incoming[msg.hash] = { size: msg.size, mime: msg.mime, parts: [], got: 0 }; break;
      case 'chunk': {
        const inc = entry.incoming[msg.hash]; if (!inc) break;
        const part = msg.data instanceof ArrayBuffer ? new Uint8Array(msg.data) : new Uint8Array(msg.data.buffer || msg.data);
        inc.parts.push(part); inc.got += part.byteLength;
        if (inc.got >= inc.size) {
          delete entry.incoming[msg.hash];
          const blob = new Blob(inc.parts, { type: inc.mime });
          const h = await sha256(blob);
          if (h === msg.hash) {
            if (!(await dbHas('assets', h))) await dbPut('assets', { hash: h, blob, mime: inc.mime, size: blob.size });
            if (entry.stats) entry.stats.assets++;
            try { bc.postMessage({ t: 'asset', hash: h }); } catch {}
            fireChange({ app: '*', coll: '*', ids: [], asset: h });
            afterRemoteChange();
          } else log('hash mismatch for file from ' + short(pid) + ' — discarded');
          if (entry.expect) { entry.expect.assets.delete(msg.hash); checkFinished(entry); }
        }
        break;
      }
      case 'done': if (entry.expect) { entry.expect.done = true; checkFinished(entry); } break;
    }
  }
  async function sendAsset(conn, hash, blob) {
    const buf = await blob.arrayBuffer();
    conn.send({ t: 'asset', hash, size: buf.byteLength, mime: blob.type });
    for (let off = 0; off < buf.byteLength; off += CHUNK) {
      conn.send({ t: 'chunk', hash, data: buf.slice(off, Math.min(off + CHUNK, buf.byteLength)) });
      while (conn.dataChannel && conn.dataChannel.bufferedAmount > BUFFER_HIGH) await sleep(30);
    }
  }
  function checkFinished(entry) {
    if (!entry.expect || !entry.expect.done || entry.expect.assets.size) return;
    const pid = entry.conn.peer, st = entry.stats || { records: 0, assets: 0 }; entry.expect = null; entry.lastSyncAt = Date.now();
    const c = contact(pid); if (c) { c.lastSeen = Date.now(); c.lastSync = Date.now(); dbPut('contacts', c); }
    lastSync = { peerId: pid, label: c ? c.label : short(pid), at: Date.now(), records: st.records, assets: st.assets };
    log('sync with ' + short(pid) + ' done: ' + st.records + ' records, ' + st.assets + ' files'); pushStatus();
  }
  let relayTimer = null;
  /** After merging remote data: relay to the other connected peers (they request only what they lack, so this terminates). */
  function afterRemoteChange() { clearTimeout(relayTimer); relayTimer = setTimeout(notifyChanged, 150); }
  /** Offer our manifest to every connected peer (debounced per peer). */
  function notifyChanged() { if (!isLeader) return; for (const pid of conns.keys()) requestSync(pid); }

  /* ---------- contacts ---------- */
  async function listContacts() { ready(); return dbGetAll('contacts'); }
  async function addContact(pid, label, opts = {}) {
    ready(); pid = String(pid || '').trim();
    if (!validId(pid)) throw new Error('Invalid peer ID');
    if (pid === myId) throw new Error('That is your own ID');
    let c = await dbGet('contacts', pid);
    if (c) c.label = label || c.label; else c = { peerId: pid, label: label || short(pid), lastSeen: 0, lastSync: 0 };
    await dbPut('contacts', c);
    await contactsChanged(); try { bc.postMessage({ t: 'contacts' }); } catch {}
    if (isLeader && !opts.noDial && broker === 'online' && !conns.has(pid)) dial(pid);
    return c;
  }
  async function removeContact(pid) {
    ready(); await dbDel('contacts', pid);
    await contactsChanged(); try { bc.postMessage({ t: 'contacts' }); } catch {}
  }
  async function contactsChanged() {
    if (!isLeader) { if (panel) renderPanel(); return; }
    contactsCache = await dbGetAll('contacts');
    for (const [pid, e] of conns) if (!contact(pid)) { conns.delete(pid); try { e.conn.close(); } catch {} }
    pushStatus(); dialAll();
  }
  function syncNow(pid) {
    if (isLeader) { if (pid) requestSync(pid, true); else for (const p of conns.keys()) requestSync(p, true); dialAll(); }
    else { try { bc.postMessage({ t: 'syncNow', peerId: pid || null }); } catch {} }
  }
  async function setPeerServer(ps) {
    ready(); const s = (await dbGet('meta', 'settings')) || { key: 'settings' };
    if (ps) s.peerServer = ps; else delete s.peerServer;
    await dbPut('meta', s);
    if (isLeader && peer) { try { peer.destroy(); } catch {} await createPeer(); }
  }
  /** Run `fn` once per app+name (flag stored in meta). Use it for the one-time migration of old storage. */
  async function migrate(name, fn) {
    ready(); const key = 'migrated:' + appName + ':' + name;
    if (await dbGet('meta', key)) return false;
    await fn(); await dbPut('meta', { key, at: nowIso() }); return true;
  }

  /* ---------- BroadcastChannel ---------- */
  function onMessage(ev) {
    const m = ev.data; if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'changed': fireChange({ app: m.app, coll: m.coll, ids: m.ids }); if (isLeader) notifyChanged(); break;
      case 'asset': fireChange({ app: '*', coll: '*', ids: [], asset: m.hash }); break;
      case 'contacts': contactsChanged(); break;
      case 'syncNow': if (isLeader) syncNow(m.peerId); break;
      case 'status': if (!isLeader) { mirror = m.s; leaderKnown = true; fireStatus(status()); } break;
      case 'status?': if (isLeader) pushStatus(); break;
      case 'hb': if (window.__sfhaOnBeat) window.__sfhaOnBeat(); if (isLeader && !navigator.locks && m.winId !== winId && m.winId < winId) stepDown('duplicate leader'); break;
    }
  }

  /* ---------- init ---------- */
  function init(opts = {}) {
    if (initPromise) return initPromise;
    appName = String(opts.app || 'app');
    initPromise = (async () => {
      await openDb();
      const m = await dbGet('meta', 'peerId');
      myId = m ? m.id : uid();
      if (!m) await dbPut('meta', { key: 'peerId', id: myId });
      bc = new BroadcastChannel(CHANNEL); bc.onmessage = onMessage;
      startElection();
      try { bc.postMessage({ t: 'status?' }); } catch {}
      return api;
    })();
    return initPromise;
  }

  /* ---------- Sync panel UI (self-contained) ---------- */
  let panel = null, cssDone = false;
  function injectCss() {
    if (cssDone) return; cssDone = true;
    const s = document.createElement('style'); s.textContent = `
.sfha-bg{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:99999;padding:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.sfha-m{background:var(--sfha-panel,#161b22);color:var(--sfha-text,#e6edf3);border:1px solid var(--sfha-border,#30363d);border-radius:12px;width:min(560px,100%);max-height:92vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.5);font-size:14px}
.sfha-h{display:flex;align-items:center;padding:12px 16px;border-bottom:1px solid var(--sfha-border,#30363d);font-weight:600;font-size:15px}
.sfha-h .sfha-x{margin-left:auto;background:none;border:0;color:inherit;font-size:18px;cursor:pointer;opacity:.7}.sfha-h .sfha-x:hover{opacity:1}
.sfha-b{padding:14px 16px;overflow:auto}
.sfha-f{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.06em;opacity:.65;margin:14px 0 6px}.sfha-f:first-child{margin-top:0}
.sfha-id{display:flex;gap:6px;align-items:center;background:var(--sfha-panel2,#0d1117);border:1px solid var(--sfha-border,#30363d);border-radius:8px;padding:8px 10px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;word-break:break-all}
.sfha-id span{flex:1}
.sfha-btn{background:var(--sfha-panel2,#1c2128);border:1px solid var(--sfha-border,#30363d);color:inherit;border-radius:8px;padding:6px 11px;font-size:13px;cursor:pointer;white-space:nowrap}.sfha-btn:hover{border-color:var(--sfha-accent,#58a6ff)}
.sfha-btn.pri{background:var(--sfha-accent,#58a6ff);border-color:var(--sfha-accent,#58a6ff);color:#0d1117;font-weight:600}.sfha-btn.dng{color:#f85149}.sfha-btn:disabled{opacity:.4;cursor:default}
.sfha-dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#6e7681;margin-right:6px;vertical-align:middle}.sfha-dot.on{background:#3fb950}.sfha-dot.busy{background:#d29922}.sfha-dot.err{background:#f85149}
.sfha-c{display:flex;gap:10px;align-items:center;padding:9px 0;border-bottom:1px solid var(--sfha-border,#30363d)}.sfha-c:last-child{border-bottom:0}
.sfha-c .sfha-g{flex:1;min-width:0}.sfha-c .n{font-weight:600}.sfha-c .i{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;opacity:.6;word-break:break-all}.sfha-c .s{font-size:12px;opacity:.8;margin-top:2px}
.sfha-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.sfha-row input{flex:1;min-width:150px;background:var(--sfha-panel2,#0d1117);border:1px solid var(--sfha-border,#30363d);color:inherit;border-radius:8px;padding:7px 10px;font-size:13px}
.sfha-small{font-size:12px;opacity:.7;line-height:1.45;margin-top:8px}
.sfha-log{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;background:#0d1117;color:#d1d5db;border:1px solid var(--sfha-border,#30363d);border-radius:8px;padding:8px;max-height:150px;overflow:auto;white-space:pre-wrap;margin-top:10px}
.sfha-tag{font-size:11px;padding:2px 7px;border-radius:99px;background:var(--sfha-panel2,#0d1117);border:1px solid var(--sfha-border,#30363d);opacity:.85;margin-left:8px}
.sfha-ft{padding:10px 16px;border-top:1px solid var(--sfha-border,#30363d);display:flex;justify-content:flex-end;gap:8px}`;
    document.head.appendChild(s);
  }
  function modal(title, bodyHtml, footHtml) {
    injectCss();
    const bg = document.createElement('div'); bg.className = 'sfha-bg';
    bg.innerHTML = `<div class="sfha-m" role="dialog"><div class="sfha-h"><span>${esc(title)}</span><button class="sfha-x" aria-label="Close">✕</button></div><div class="sfha-b">${bodyHtml}</div>${footHtml ? `<div class="sfha-ft">${footHtml}</div>` : ''}</div>`;
    document.body.appendChild(bg);
    const close = () => bg.remove();
    bg.querySelector('.sfha-x').onclick = close;
    bg.addEventListener('click', e => { if (e.target === bg) close(); });
    return { el: bg, close };
  }
  function brokerText(s) {
    return s.broker === 'online' ? 'Online' : s.broker === 'connecting' ? 'Connecting to signalling server…' : s.broker === 'id-taken' ? 'This ID is already in use in another tab or window' : s.broker === 'disabled' ? 'Sync unavailable (PeerJS could not be loaded)' : s.broker === 'error' ? 'Error: ' + s.brokerMsg : 'Offline' + (s.brokerMsg ? ' (' + s.brokerMsg + ')' : '');
  }
  async function renderPanel() {
    if (!panel || !document.body.contains(panel.el)) { panel = null; return; }
    const s = status(), contacts = await listContacts();
    if (!panel || !document.body.contains(panel.el)) return;
    const body = panel.el.querySelector('#sfhaBody');
    const fmt = ts => ts ? new Date(ts).toLocaleString() : 'never';
    const cm = new Map(s.connections.map(c => [c.peerId, c]));
    const dotCls = s.broker === 'online' ? 'on' : s.broker === 'connecting' ? 'busy' : ['id-taken', 'error', 'disabled'].includes(s.broker) ? 'err' : '';
    body.innerHTML = `
      <label class="sfha-f">My device ID</label>
      <div class="sfha-id"><span>${esc(s.myId || '…')}</span><button class="sfha-btn" id="sfhaCopy">Copy</button></div>
      <div class="sfha-small"><span class="sfha-dot ${s.leaderPresent ? dotCls : 'err'}"></span>${esc(s.leaderPresent ? brokerText(s) : 'No sync leader yet')}
        <span class="sfha-tag">${s.leader ? 'this window drives sync' : s.leaderPresent ? 'driven by another window' : 'electing…'}</span></div>
      ${s.pending && s.pending.length ? `<div class="sfha-small" style="color:#d29922">${s.pending.length} unknown device(s) waiting for approval${s.leader ? '' : ' in the leader window'}</div>` : ''}
      <label class="sfha-f">Paired devices</label>
      <div id="sfhaContacts">${contacts.length ? contacts.map(c => { const e = cm.get(c.peerId); const st = e && e.state === 'open' ? (e.syncing ? 'Syncing…' : 'Connected') : e ? 'Connecting…' : 'Offline';
        return `<div class="sfha-c" data-id="${esc(c.peerId)}"><span class="sfha-dot ${e && e.state === 'open' ? (e.syncing ? 'busy' : 'on') : e ? 'busy' : ''}"></span><div class="sfha-g"><div class="n">${esc(c.label)}</div><div class="i">${esc(c.peerId)}</div><div class="s">${st} · last sync: ${esc(fmt(c.lastSync))}</div></div><button class="sfha-btn sfha-now" ${e && e.state === 'open' ? '' : 'disabled'} title="Sync now">⟳</button><button class="sfha-btn dng sfha-del" title="Unpair">✕</button></div>`; }).join('') : `<div class="sfha-small">No devices paired yet. Paste another device's ID below.</div>`}</div>
      <div class="sfha-row"><input type="text" id="sfhaPeer" placeholder="Other device's ID" autocomplete="off"><input type="text" id="sfhaLabel" placeholder="Name (e.g. Jelle's phone)" style="max-width:170px"><button class="sfha-btn pri" id="sfhaAdd">Pair</button></div>
      <p class="sfha-small">Both devices need any of the tools open. Pair each other by ID; they then connect automatically and exchange changes for all tools (last write wins). Files go directly from device to device.</p>
      <label class="sfha-f">Last sync</label>
      <div class="sfha-small">${s.lastSync ? `${esc(s.lastSync.label)} · ${esc(fmt(s.lastSync.at))} · ${s.lastSync.records} records, ${s.lastSync.assets} files received` : 'never'}</div>
      <div class="sfha-log">${s.log && s.log.length ? s.log.map(esc).join('\n') : '—'}</div>`;
    body.querySelector('#sfhaCopy').onclick = async () => { try { await navigator.clipboard.writeText(s.myId); body.querySelector('#sfhaCopy').textContent = 'Copied'; } catch { const r = document.createRange(); r.selectNodeContents(body.querySelector('.sfha-id span')); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); } };
    body.querySelector('#sfhaAdd').onclick = async () => { try { await addContact(body.querySelector('#sfhaPeer').value, body.querySelector('#sfhaLabel').value.trim()); renderPanel(); } catch (e) { alert(e.message || e); } };
    body.querySelectorAll('.sfha-c').forEach(row => {
      const pid = row.dataset.id;
      row.querySelector('.sfha-now').onclick = () => syncNow(pid);
      row.querySelector('.sfha-del').onclick = async () => { const c = contacts.find(x => x.peerId === pid); if (confirm(`Unpair device "${c ? c.label : pid}"?`)) { await removeContact(pid); renderPanel(); } };
    });
    const logEl = body.querySelector('.sfha-log'); logEl.scrollTop = logEl.scrollHeight;
  }
  function openPanel() {
    if (panel && document.body.contains(panel.el)) return;
    panel = modal('Sync', `<div id="sfhaBody">…</div>`, `<button class="sfha-btn" id="sfhaClose">Close</button>`);
    panel.el.querySelector('#sfhaClose').onclick = panel.close;
    renderPanel();
    if (isLeader) dialAll(); else { try { bc && bc.postMessage({ t: 'status?' }); } catch {} }
  }
  function promptUnknown(pid, cb) {
    const m = modal('Unknown device wants to connect', `<div class="sfha-id"><span>${esc(pid)}</span></div><p class="sfha-small">Add it to sync with it, or decline.</p><label class="sfha-f">Name</label><div class="sfha-row"><input type="text" id="sfhaUpLabel" placeholder="Name (e.g. Jelle's phone)"></div>`,
      `<button class="sfha-btn" id="sfhaUpNo">Decline</button><button class="sfha-btn pri" id="sfhaUpYes">Add</button>`);
    let answered = false; const answer = v => { if (answered) return; answered = true; m.close(); cb(v); };
    m.el.querySelector('#sfhaUpYes').onclick = () => answer(m.el.querySelector('#sfhaUpLabel').value.trim() || short(pid));
    m.el.querySelector('#sfhaUpNo').onclick = () => answer(null);
    m.el.querySelector('.sfha-x').onclick = () => answer(null);
  }

  /* ---------- public API ---------- */
  const api = {
    version: 1,
    init, list, get, put, del,
    putAsset, getAsset, hasAsset,
    onChange(fn) { changeFns.add(fn); return () => changeFns.delete(fn); },
    onStatus(fn) { statusFns.add(fn); return () => statusFns.delete(fn); },
    contacts: { list: listContacts, add: addContact, remove: removeContact },
    myId: () => myId, isLeader: () => isLeader, status, openPanel, syncNow, setPeerServer, migrate,
    util: { uid, sha256, nowIso },
  };
  window.SfhaSync = api;
})();
