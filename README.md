# Gementar Clinic Care

Monorepo using npm workspaces.

```
apps/
  web/   Next.js 16 (App Router, TypeScript, Tailwind v4, ESLint)  -> http://localhost:3000
  api/   NestJS 12 (TypeScript, Vitest, oxlint)                    -> http://localhost:3001
```

## Setup

```bash
npm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
```

## Development

```bash
npm run dev:web     # Next.js dev server
npm run dev:api     # Nest watch mode
```

## Other scripts

```bash
npm run build       # build every workspace
npm run lint        # lint every workspace
npm run test        # test every workspace
```
