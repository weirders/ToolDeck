# Offline — every tool ships its own `sw.js`

A service worker only controls pages inside its own folder. ToolDeck's `sw.js` (scope `/ToolDeck/`) therefore
caches the deck, but **not** the tools in its iframe: `/FloorplanWeb/` etc. are separate scopes. Without their
own worker, a tool opened offline depends on the browser's HTTP cache, which GitHub Pages marks stale after
10 minutes and the browser may evict at any time. So each tool repo carries a small `sw.js` of its own.

## What the worker does
- **Same-origin GETs** (the tool page, `ToolDeck/sync.v1.js`): network-first, so online you always get the
  latest; after 4 s without an answer (bad Wi-Fi) or offline, the cached copy is used. Both are pre-cached on install.
- **CDN scripts / styles / fonts / workers** (cdnjs, jsdelivr, unpkg, Google Fonts): cache-first (URLs are versioned).
- **Everything else** (APIs, model downloads, POSTs) passes through untouched.
- Cache Storage is **shared by every tool on weirders.github.io**, so a worker only deletes caches starting
  with its own prefix (`<app>-shell-`). Never delete caches you don't own (VoiceFlowWeb keeps its speech models there).

The sync layer and photo editor stay single-source: the worker caches the live `ToolDeck/sync.v1.js` and
`ToolDeck/photo-editor.v1.js`, it doesn't copy them.

## Adding offline to a new tool
1. Copy [`tool-sw.template.js`](tool-sw.template.js) to the tool repo as `sw.js`.
2. Replace `__NAME__`, `__PREFIX__` (short lowercase app name) and `__EXTRA__`
   (`, 'https://weirders.github.io/ToolDeck/sync.v1.js'` if the tool uses sync, plus
   `, 'https://weirders.github.io/ToolDeck/photo-editor.v1.js'` if it uses the shared photo editor; otherwise empty).
3. Register it once in `index.html`:
   ```html
   <script>if("serviceWorker" in navigator && location.protocol==="https:") navigator.serviceWorker.register("sw.js");</script>
   ```
The tool must be opened online once (standalone or inside ToolDeck) to install its worker.

| tool | cache prefix |
|---|---|
| ToolDeck | `tooldeck-` |
| EHS-Tools-Web | `ehstools-shell-` |
| InspectFlow | `inspectflow-shell-` |
| NewsFlow | `newsflow-shell-` |
| VoiceFlowWeb | `voiceflow-shell-` |
| FloorplanWeb | `floorplan-shell-` |
| SOATWeb | `soat-shell-` |
| ErgoFlow | `ergoflow-shell-` |
