# ProofTrace

Enter a public URL. ProofTrace fetches the page, follows relevant links when needed, finds sustainability claims, checks public evidence, and streams the agents' work and final report on the same page. Models run on Cloudflare Workers AI.

## Run locally

```sh
npm install
cp .env.example .env
npm run dev
```

Open the URL printed by Vite. The Worker uses remote Cloudflare bindings configured in `wrangler.jsonc`; authenticate locally with `npx wrangler login` if needed. Keep API keys and tokens only in `.env`, which Git ignores. `BRAVE_SEARCH_API_KEY` is optional: without it, the report labels search as limited and collects candidate pages from site links and the built-in official-source directory. A search result is never used as evidence until ProofTrace fetches its page.

## Verify and deploy

```sh
npm run typecheck
npm test
npm run build
BASE_URL=http://127.0.0.1:5173 npm run e2e
npm run deploy
BASE_URL=https://prooftrace.aonishchenko33.workers.dev npm run e2e
```

The end-to-end test submits `https://www.garnier.pt/` by default and requires a verdict on a measurable sustainability claim. Set `INPUT_URL` to try another site. New Cloudflare environments need `npm run db:migrate` and `npm run db:seed` before deployment. For a deployed Worker, set the optional search key as a Worker secret using `npx wrangler secret put BRAVE_SEARCH_API_KEY`; local `.env` values are never committed.

See [architecture](docs/ARCHITECTURE.md) and [demo plan](docs/PLAN.md).
