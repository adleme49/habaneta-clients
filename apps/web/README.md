# Habaneta

A tile mosaic design tool — pick a tile, recolor its layers, see it rendered as a patterned floor, export the result. Inspired by the encaustic cement tiles of Havana and the Valencian mosaics of the Spanish Mediterranean.

## Tech stack

- **Vite 5** — dev server and build tool
- **React 18 + TypeScript 5** — UI
- **Tailwind CSS v4** + **shadcn/ui** — styling and components
- **react-router-dom 5** — routing (temporary; may migrate to TanStack Router)
- Single `useStore()` hook (`src/store/store.tsx`) — app state, backed by `useState` + `useReducer`
- **Playwright** — headless smoke checks at the repo root (`check-*.mjs`) for fast iteration

## Running locally

```bash
npm install
npm run dev    # http://localhost:3000
```

```bash
npm run build      # type-check + production build
npm run preview    # serve the build locally
```

### Backend

The image-import flow ("Import image" in the library) talks to a separate Rust service — `habaneta-backend` (`~/projects/habaneta/repos/backend`). The frontend reaches it at `http://localhost:8080` by default and falls back to that when the env var is unset.

Override with `VITE_HABANETA_API` to point at a different host, e.g. for staging or a remote dev box. See `.env.example`.

If the backend is unreachable when the import dialog opens, the dialog surfaces a banner instead of the file picker — start the service and retry.

## Smoke tests

The `check-*.mjs` scripts at the repo root launch a headless Chromium against a running dev server and capture screenshots + console errors. They're used during development instead of manual browser refreshes.

```bash
npm run dev &          # start the dev server in the background
node check-app.mjs            # loads the app, reports errors + saves screenshot
node check-flow.mjs           # full tile selection flow
node check-multi-save.mjs     # regression: floor + border save
node check-gallery.mjs        # gallery carousel
node check-responsive.mjs     # flow at 4 viewport sizes
```

## Project structure

```
src/
├── App.tsx                  # routes + global providers
├── index.tsx                # React 18 createRoot entry
├── pages/Home.tsx           # the editor page
├── store/store.tsx          # useStore() hook (app state)
├── lib/utils.ts             # cn() helper
├── components/
│   ├── ui/                  # shadcn primitives (button, etc.)
│   ├── layout/              # page layout shells
│   ├── browser/             # tile category + selector
│   ├── editor/              # color palette + tile painter
│   ├── preview/             # recent slots, floor grid, ambient/save modals
│   └── common/              # shared (SVG rendering, modal wrapper)
├── context/
│   ├── seed.tsx             # hardcoded tile catalog (will move to JSON)
│   └── interfaces.tsx       # domain types
├── constants/floor.tsx      # grid rotation presets
└── helpers/                 # SVG layer manipulation

public/
└── assets/                  # tile SVGs, borders, gallery images, ambients
```

## Roadmap

Habaneta is under active redesign. The current iteration is the tile designer tool; the product direction is a shared gallery where users can publish and discover tile designs from the community.

Near-term work lives on feature branches targeting `develop`. The current phase focuses on:

1. **Data model** — split `TileSource` (catalog entry) from `TileInstance` (user customization) from `Design` (composed layout)
2. **Input module** — a library admin page backed by TanStack Table + Form, with SVG upload and layer auto-detection
3. **Browsing + editing** — virtualized tile grid, better color palette, undo/redo
4. **Visualization** — configurable grid sizes, multiple ambient scenes, higher-quality export

Social features (auth, publishing, likes, shared URLs) come after the core modules are solid.

## Monorepo intent

This repo will eventually become a Turborepo monorepo (`apps/web`, `packages/core`, `packages/ui`). For now it stays flat — the restructure lands when we add a second app or extract shared packages.

## License

TBD
