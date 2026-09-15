# Habaneta clients

Monorepo for Habaneta's web and mobile clients. The Rust backend (`habaneta-backend`) and the Terraform/IaC project (`habaneta-infra`) live in sibling repos.

## Layout

```
apps/
  web/          # Vite + React tile editor (current production app)
  mobile/       # Expo + React Native pattern-hunter app  (added in v1)
packages/
  api-types/    # Wire contract, GENERATED from the backend's OpenAPI document
```

## The wire contract

`packages/api-types` is **generated**, not hand-written. The backend emits an
OpenAPI document from its own Rust types; `openapi.json` is vendored here and
`src/generated.ts` is produced from it. Never re-declare a request or response
shape in an app — import it from `@habaneta/api-types`.

```bash
pnpm gen:api          # regenerate from the sibling checkout at ../backend
pnpm gen:api --staging  # or from the deployed staging backend
pnpm gen:api:check    # verify the committed output is current (CI runs this)
```

`src/index.ts` is the curated surface: readable aliases over the generated
tree. Two are worth knowing about. `JobParams` is the *stored* form, with every
field present, and `JobParamsInput` is what a client sends, where every knob is
optional so server defaults survive.

## Tooling

- **pnpm workspaces** — strict, fast, plays well with Expo/Metro hoisting.
- **TypeScript** everywhere.
- Each workspace member owns its own scripts; the root `package.json` is a thin orchestration layer.

## Common commands

```bash
pnpm install                  # install all workspaces

pnpm dev:web                  # vite dev server for the web app
pnpm dev:mobile               # expo start (mobile)
pnpm build:web                # type-check + vite production build
pnpm build:types              # tsc on the shared api-types package
pnpm test:smoke               # web app's playwright smoke suite
```

## Backend

The image-processing service (`habaneta-backend`) and the cloud infra (`habaneta-infra`) are separate repos. The web and mobile apps reach the backend via `VITE_HABANETA_API` (web) / `expo-constants extra.HABANETA_API` (mobile). See `apps/web/.env.example`.
