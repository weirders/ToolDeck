# Tool family: shared look

The tools keep their own colours, layouts and character. What they share is small and lives in one clearly marked
block at the end of each app's main `<style>`:

```css
/* ---- Tool family (ToolDeck/STYLE.md): shared UI font, control shape and focus ring. Colours stay per app. ---- */
…
/* ---- end tool family ---- */
```

| | rule |
|---|---|
| **UI font** | `system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif` (Segoe UI on Windows, SF on Apple, Roboto on Android) |
| **Controls** | `button, input, select, textarea { font-family: inherit }` — browsers default buttons to Arial otherwise |
| **Shape** | buttons and inputs 8px radius (tall touch buttons 10–12px, dense toolbars 6px); cards 12–14px |
| **Focus** | `:focus-visible` → 2px outline in the app's own accent, 2px offset (buttons, links, selects, menu items) |
| **Title mark** | a 4px rounded bar before the app title, in the colour of the app's card in ToolDeck (`accent` in the registry). Apps with their own logo tile (InspectFlow, VoiceFlowWeb) use that instead. |
| **Top bar** | ~52px where an app has one |

Per app:

| app | notes |
|---|---|
| ToolDeck | font + focus |
| EHS-Tools-Web | **chrome only**: tab bar, project bar, status bar and ⋯ menu get the UI font; `.btn`, `.proj-btn`, direction select 6px. The body font, the editor and everything in the analysis views (5-Why, fishbone, ABC, map, legend, action panel) are untouched. The toolbar above the canvas keeps its font, because a wider font can wrap it and shrink the canvas. |
| InspectFlow | buttons and fields 10px, cards 14px, keeps its IF logo |
| NewsFlow | controls 8px; title mark hidden under 480px (no room in the header) |
| VoiceFlowWeb | keeps Inter and its serif writing canvas on purpose; buttons inherit Inter |
| FloorplanWeb | controls 8px, title 15px/700 |
| CheckFlow (SOATWeb) | controls 8px, top bar 52px |
| ErgoFlow | already matched; title mark |

**Changing it:** check that no top bar or toolbar starts wrapping at 390, 768 and 1280px wide. Inter, often the
`system-ui` on Linux, is wider than Segoe UI, so test with it as the worst case. For EHS-Tools-Web, compare the
analysis views pixel for pixel before and after.
