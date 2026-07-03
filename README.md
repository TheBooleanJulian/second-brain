# Second Brain

A single-page interview app that builds a personal "second brain" document across ten life domains, visualized as a constellation.

## Structure

- `index.html` — redirects to `second-brain.html` (entry point for static hosting)
- `second-brain.html` — the app
- `second-brain.md` — the compiled document; fetched live by the app's document viewer

## Local development

Serve the folder over HTTP (fetching `second-brain.md` requires it — opening `second-brain.html` via `file://` will fail due to browser CORS restrictions):

```
npx serve .
```

## Hosting

Static site, no build step. Works as-is on GitHub Pages and Zeabur (`zbpack.json` marks this as a static deploy).
