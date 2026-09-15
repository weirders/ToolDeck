# sfha-sync v1 — contract for every tool

**Load:** `<script src="https://weirders.github.io/ToolDeck/sync.v1.js"></script>` (same origin as all tools → shared IndexedDB `sfha-sync` v1 and BroadcastChannel `sfha-sync`). PeerJS is loaded from cdnjs by the leader only. Global: `window.SfhaSync`.

## Record shape
```js
{ id, app, coll, updatedAt /* ISO string */, deleted /* bool */, payload /* your object */ }
```
- `id` is the IndexedDB key across **all** apps → use UUIDs (`SfhaSync.util.uid()`).
- `app` = your app name (lowercase, e.g. `floorplan`), `coll` = collection (e.g. `markers`). Index `appColl` on `[app, coll]`.
- Files are **assets** `{hash, blob, mime, size}` (SHA-256 hex). Reference them from the payload with a `hash` field (any depth) or a `hashes: [..]` array — the manifest finds them automatically.
- Merge rule: last write wins on `updatedAt`. Deletes are tombstones (`deleted:true`); never physically remove a record.
- Contacts `{peerId, label, lastSeen, lastSync}` and meta (`peerId`, `settings {peerServer, iceServers}`) are shared by all apps.

## API (all async unless noted)
| call | behaviour |
|---|---|
| `init({app})` | opens DB, joins channel, starts leader election. Await before anything else. |
| `list(app, coll, {includeDeleted})` | records of one collection; tombstones excluded by default |
| `get(app, coll, id)` | one record or `undefined` |
| `put(app, coll, {id?, payload, deleted?})` | stamps `updatedAt`, `deleted=false` if absent, generates `id` if absent, broadcasts `changed`. Returns the stored record. |
| `del(app, coll, id)` | tombstone + broadcast |
| `putAsset(blob) → hash`, `getAsset(hash) → blob|null`, `hasAsset(hash)` | content-addressed files |
| `onChange(fn)` (sync) | `fn({app, coll, ids})` after local puts **and** after a remote merge — in every window on the origin. Asset arrivals fire `{app:'*', coll:'*', ids:[], asset:hash}`. Returns an unsubscribe fn. |
| `contacts.list/add(peerId,label)/remove(peerId)` | paired devices |
| `myId()`, `isLeader()`, `status()` (sync) | `status()` → `{leader, leaderPresent, broker, myId, connections[], pending[], lastSync, log[]}` |
| `onStatus(fn)`, `openPanel()`, `syncNow(peerId?)` | UI hooks — `openPanel()` is the full Sync panel, free for every app |
| `migrate(name, fn)` | runs `fn` once per app+name (flag in meta) |
| `settings.get()` / `settings.save({iceServers, peerServer})` | shared connection settings in meta: `iceServers` (RTCIceServer array — add your own TURN on `turns:…:443?transport=tcp` for corporate networks) and `peerServer` `{host,port,path,secure}`; `null` = built-in defaults. Also editable in the Sync panel. |

Only call `onChange` handlers to re-read from `SfhaSync` — the DB is the single source of truth; keep no second copy that can diverge.

## Message types
**Wire (peer ↔ peer, PeerJS reliable channel):** `manifest {records:[[id,updatedAt,del]], assets:[hash]}` → `want {records:[id], assets:[hash]}` → `records {records:[full record]}` + `asset {hash,size,mime}` / `chunk {hash,data}` (64 KB, back-pressure at 4 MB) → `done`. Receiver verifies SHA-256 before storing. Manifest sent at most once per 10 s per peer (debounced); after a remote merge the leader re-offers to its other peers (relay).
**Channel (window ↔ window, BroadcastChannel `sfha-sync`):** `changed {app,coll,ids}`, `asset {hash}`, `contacts`, `syncNow {peerId}`, `status {s}`, `status?`, `hb {winId}` (fallback election only).

## Leader rule
Exactly one window per origin owns the PeerJS peer. Election: `navigator.locks.request('sfha-sync-leader', …)` — holder = leader; it registers `myId` with the broker, dials every contact every 30 s (both sides may dial; lexically lower ID keeps its outgoing connection), answers incoming connections, and asks the user to approve unknown peers. Everyone else only reads/writes the DB and receives `changed` over the channel. When the leader closes, the lock is released and the next window takes over automatically. Without Web Locks: heartbeat election over the channel; a peer-ID collision makes the loser step down. Result: ToolDeck is leader when a tool runs inside it; a standalone tool is its own leader; tabs never collide. The manifest covers **every** record regardless of app, so any device relays for apps it never opened.

## Migration rule
On first load, copy your old storage (localStorage / your own IndexedDB) into `sfha-sync` under your app name, then read **only** from `sfha-sync`:
```js
await SfhaSync.init({app:'myapp'});
await SfhaSync.migrate('v1', async () => {
  for (const r of oldRecords) await SfhaSync.put('myapp','notes', {id:r.id, payload:r, deleted:!!r.deleted, updatedAt:r.updatedAt}, {keepStamp:true, silent:true});
  for (const b of oldBlobs)   await SfhaSync.putAsset(b);   // then store the returned hash in the owning record's payload
});
```
Give migrated records an old timestamp (`keepStamp:true` keeps `updatedAt` if present; otherwise use `new Date(0).toISOString()`) so any real edit on another device wins. Leave the old store in place but never read from it again.
