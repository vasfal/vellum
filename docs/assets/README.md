# README assets

The main README references two images that live here. They're the highest-leverage
thing on the repo page — a design tool with no visual reads as dead — so they're
worth capturing well.

## `hero-light.png` / `hero-dark.png` (required)

A single still of the payoff: the **report / review view** with real extracted
tasks, a timestamp, and a screenshot visible — one shot per theme. The README
uses a `<picture>` element so GitHub serves the dark shot to dark-theme readers
and the light shot to light-theme readers. Crop to the content; no browser chrome.

## `demo.gif` (recommended)

A short (~10–20s) loop of the core loop: start a recording → talk → stop →
Analyze → report appears. Keep it small (< a few MB) — trim, cap width ~1000px.

Once both exist, replace the placeholder blockquote near the top of `../../README.md`
with:

```markdown
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hero-dark.png">
  <img alt="Vellum report view" src="docs/assets/hero-light.png">
</picture>

![Vellum demo](docs/assets/demo.gif)
```
