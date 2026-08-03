# 🧰 ToolDeck

All of my single-file HTML tools, wrapped in **one** file — no code copied, no duplication.

Each tool stays in its own repo and keeps running live from its own GitHub Pages site. ToolDeck is just a **shell**: a registry of cards that launch each tool inside a full-screen iframe. When you update a tool in its source repo, the deck picks it up automatically.

**Live:** https://weirders.github.io/ToolDeck/

## Included tools

- 🦺 **EHS-Tools-Web** — EHS visual analysis suite (5-Why / fishbone tree, ABC behaviour analysis)
- 🔍 **InspectFlow** — inspection & checklist workbench (templates, inspections, archive, reports)
- 📰 **NewsFlow** — news reader & aggregator
- 🎙️ **VoiceFlowWeb** — voice dictation with live word count & session timer

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

## Development

The whole thing is one file — open `index.html` directly in a browser, or serve it:

```bash
python3 -m http.server 8000   # then visit http://localhost:8000
```

Repo: [github.com/weirders/ToolDeck](https://github.com/weirders/ToolDeck)
