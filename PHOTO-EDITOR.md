# sfha photo editor v1 — contract for every tool

**Load:** `<script src="https://weirders.github.io/ToolDeck/photo-editor.v1.js"></script>` (or lazy-load it when the
editor is first opened). Global: `window.SfhaPhotoEditor`. Add the URL to the tool's `sw.js` `PRECACHE` so it works offline
(see [OFFLINE.md](OFFLINE.md)).

Used by: **InspectFlow**, **ErgoFlow**, **CheckFlow** (repo SOATWeb).

## What it does
Full-screen markup of one photo: **arrow, circle, text, blur, measure (ruler), angle, erase**. Markings stay *data* on
top of an unannotated image, so a photo can be re-edited later without stacking arrows on arrows. The editor never
touches storage — the tool decides how to keep the blobs.

Two blur modes:
- **default** — blur is burned into the returned `base`; everything else is data.
- **`blurData: true`** (CheckFlow) — blur is a `{t:'blur', a, b}` annotation too, so *every* step is data over the
  untouched original. Keep the original, sync `ann`, and any device can undo or erase any step, then re-render.

Every loaded annotation is on the Undo stack, so steps from an earlier session or another device can be undone.
**Erase** removes the marking you tap, wherever it sits in the stack (undoable).

## API
```js
SfhaPhotoEditor.open({
  src,                 // Blob | URL | <img> | <canvas> — pass the BASE if you have one, else the photo
  ann, scale,          // earlier annotations + cm-per-pixel (both optional)
  lang: 'en' | 'nl',
  tools: ['arrow','circle','text','blur','ruler','angle','erase'],   // subset + order; first one is selected
  blurData,            // true → blur stays an annotation; r.base is null (keep your own original)
  caption,             // string → shows a caption field; omit to hide it
  captionPlaceholder,
  onSave: async r => {},   // r = {full:Blob, base:Blob, thumb:dataUrl, ann, scale, width, height, caption}
  onDelete: async () => {},// optional → shows a Delete button
  onClose: () => {},       // after every close (save, close, delete, Back)
  backTrap,            // optional {push(close)->handle, release(handle)} if the tool has its own Back stack
  hint: (tool, {step, hasScale}) => string|null,  // optional per-tool hint override
  fmtNum, accent, maxSize, quality, baseQuality, thumbSize, thumbQuality
});
SfhaPhotoEditor.paint(ctx, ann, scale, {color, fmtNum});  // re-render annotations on a base-sized canvas
SfhaPhotoEditor.isOpen();
```
Default mode: store **both** `full` (annotated, for reports/exports) and `base` (for re-editing).
`blurData` mode: store `full` plus `ann`/`scale`; pass your untouched original as `src` next time. Defaults: base max 4000 px,
JPEG 0.86 full / 0.9 base, 320 px thumb.

## Rules (v1)
- The annotation format only **gains** fields or types; nothing is renamed or removed:
  `{t:'arrow'|'circle'|'ruler', a:{x,y}, b:{x,y}, cm?}` · `{t:'text', a, s}` · `{t:'angle', p:[{x,y}×3]}` ·
  `{t:'blur', a, b}` (blurData only; `paint()` pixelates it from the canvas) — base-image pixels.
- A breaking change becomes `photo-editor.v2.js`; v1 stays online.
- A change here reaches every tool at once: check it in each tool listed above before pushing.
- Privacy (default mode): blurring a photo that was stored and synced before leaves the earlier unblurred copy on devices that
  already had it (the sync layer cannot delete assets). Blur before the first save where possible.
  With `blurData` the unblurred original is kept and synced on purpose; blur protects what leaves the app (reports, exports of the rendered photo).
