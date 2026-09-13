# 🧰 ToolDeck

All of my single-file HTML tools, wrapped in **one** file — no code copied, no duplication.

Each tool stays in its own repo and keeps running live from its own GitHub Pages site. ToolDeck is just a **shell**: a registry of cards that launch each tool inside a full-screen iframe. When you update a tool in its source repo, the deck picks it up automatically.

**Live:** https://weirders.github.io/ToolDeck/

## Included tools

- 🦺 **EHS-Tools-Web** — EHS visual analysis suite (5-Why / fishbone tree, ABC behaviour analysis)
- 🔍 **InspectFlow** — inspection & checklist workbench (templates, inspections, archive, reports)
- 📰 **NewsFlow** — news reader & aggregator
- 🎙️ **VoiceFlowWeb** — voice dictation with live word count & session timer
- 🗺️ **FloorplanWeb** — floor-plan marker tool with photos, numbering and print
- 🧩 **SOATWeb** — SOAT / SCAT incident analysis

## Adding a tool (takes ~30 seconds)

Everything lives in [`index.html`](index.html). Open it, find the `TOOLS` array, and append one object:

```js
{ name:"MyNewTool", url:"https://weirders.github.io/MyNewTool/",
  icon:"✨", desc:"One-line description shown on the card." },
```

Push to `main` — done. See the registry section in `index.html` for all fields.

## How it works

1. **Registry** — a small JS array in `index.html`; `name`, `url`, `icon`, `desc` (+ optional `accent` colour).
2. **Home view** — renders a responsive grid of cards.
3. **Runner view** — full-screen `<iframe>` with back / prev / next and an "Open ↗" link.
4. **Routing** — deep-link any tool via `#tool/<name>` (e.g. `…/ToolDeck/#tool/NewsFlow`).

## Why iframe?

- **Zero code copied** — the deck contains no tool logic, so there's nothing to go stale.
- **Always current** — tools load from their own live Pages URLs.
- **Sandboxed** — the iframe uses a restrictive `sandbox` attribute.

## Sync — one layer for every tool

All tools live on the same origin (`weirders.github.io/<repo>/`), so they share one IndexedDB and one BroadcastChannel. [`sync.v1.js`](sync.v1.js) is the shared peer-to-peer sync layer (PeerJS/WebRTC, extracted from FloorplanWeb): records and files travel device-to-device, only signalling goes through the broker. ToolDeck loads it and shows the **Sync** panel (top bar and home view): your device ID, paired devices with live status, approval of unknown devices, last-sync stats and a log.

The full contract is in [`SYNC-CONTRACT.md`](SYNC-CONTRACT.md). The short version:

### Adopting sync in a tool

```html
<script src="https://weirders.github.io/ToolDeck/sync.v1.js"></script>
<script>
  await SfhaSync.init({app:'myapp'});                    // opens sfha-sync, joins the channel, joins leader election
  const recs = await SfhaSync.list('myapp','notes');     // live (non-deleted) records for one collection
  const rec  = await SfhaSync.put('myapp','notes',{id, payload:{title:'…'}}); // stamps updatedAt, deleted=false
  await SfhaSync.del('myapp','notes', id);               // tombstone — never physically removed
  const hash = await SfhaSync.putAsset(blob);            // SHA-256 content address
  const blob = await SfhaSync.getAsset(hash);
  SfhaSync.onChange(({app,coll,ids}) => rerender());    // fires in every window on the origin, local and remote
  SfhaSync.openPanel();                                  // optional: the same Sync panel ToolDeck shows
</script>
```

Also available: `get(app,coll,id)`, `hasAsset(hash)`, `contacts.list/add/remove`, `myId()`, `status()`, `onStatus(fn)`, `syncNow()`, `migrate(name, fn)` (run something once per app), `setPeerServer({host,port,path,secure})`.

### Record shape

```js
{ id, app, coll, updatedAt /* ISO */, deleted /* bool */, payload /* your object */ }
```

`id` is the key across **all** apps — use UUIDs. Assets are referenced from the payload by `hash` fields (anywhere, nested) or a `hashes` array; the manifest picks them up automatically. Merge rule: last write wins on `updatedAt`.

### Leader rule

Only one window per origin registers the PeerJS peer, dials contacts every 30 s and answers incoming connections. The leader is chosen with `navigator.locks.request('sfha-sync-leader')` (heartbeat fallback without Web Locks): the window that holds the lock is leader, all other windows only use the database and receive `changed` events over the channel. When the leader closes, the lock is released and the next window takes over. In practice: ToolDeck is the leader when a tool runs inside it, a tool opened standalone becomes its own leader, and multiple tabs never collide. Every device syncs **all** records regardless of which apps it has opened, so devices act as relays.

## Development

The whole thing is one file — open `index.html` directly in a browser, or serve it:

```bash
python3 -m http.server 8000   # then visit http://localhost:8000
```

Repo: [github.com/weirders/ToolDeck](https://github.com/weirders/ToolDeck)
