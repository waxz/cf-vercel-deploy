Deploy project to cloudflare workers/pages and vercel

## cloudflare

- https://github.com/cloudflare/wrangler-action
- https://github.com/marketplace/actions/deploy-to-cloudflare-workers-with-wrangler

1. set cloudflare token



## vercel

1. set vercel_token, team id, project_id


## project
- [lobe-chat](https://github.com/waxz/lobe-chat) on vercel
- [gemini-openai-proxy](https://github.com/waxz/gemini-openai-proxy) on cloudflare workers/pages
- [gemini-cli-openai](https://github.com/waxz/gemini-cli-openai) on cloudflare workers/pages
- [md4c blog](https://github.com/waxz/md4c/tree/claude/wasm-browser-blog/wasm) on cloudflare R2 + workers (admin)

## md4c blog

Workflow: [deploy-waxz-md4c-blog.yaml](.github/workflows/deploy-waxz-md4c-blog.yaml), run it from
*Actions → deploy-waxz/md4c-blog → Run workflow*. It:

1. builds md4c.wasm, the static site and the admin app from `waxz/md4c` (input `md4c_ref`) and runs the tests;
2. creates the R2 buckets if needed, and connects `BLOG_DOMAIN` to the public bucket;
3. publishes the site code and rebuilds the pages from the posts already in the bucket
   (posts written in the admin are kept; tick `seed_samples` on the first run for example posts);
4. deploys the admin Worker on `ADMIN_DOMAIN`, behind Cloudflare Access.

Secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The token needs these permissions:
- Account: *Workers Scripts: Edit* and *Workers R2 Storage: Edit*;
- Zone: *Workers Routes: Edit* and *DNS: Edit*, for the custom domains.

The R2 S3 keys the publish step needs are derived from the token (Access Key ID = token id,
secret = SHA-256 of the token). Set `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` secrets to use separate keys.

Variables (*Settings → Secrets and variables → Actions → Variables*):

| Variable | Example | Needed for |
|---|---|---|
| `BLOG_BUCKET` | `md4c-blog` (default) | site |
| `BLOG_DRAFTS_BUCKET` | `md4c-blog-drafts` (default) | admin, keep it private |
| `BLOG_DOMAIN`, `BLOG_ZONE_ID` | `blog.example.com`, zone id | public URL of the blog |
| `ADMIN_DOMAIN` | `admin.blog.example.com` | admin |
| `BLOG_ACCESS_TEAM_DOMAIN` | `https://myteam.cloudflareaccess.com` | admin |
| `BLOG_ACCESS_AUD` | Access application AUD tag (or a secret) | admin |
| `BLOG_ADMIN_EMAILS` | `me@example.com` | admin (optional allowlist) |
| `BLOG_DRAFT_STORES` | JSON, e.g. adding a WebDAV store | admin (optional) |
| `BLOG_SITE_JSON` | `{"title": "…", "url": "https://blog.example.com/"}` | optional; overrides the admin's site settings on every run |

Before the first admin deploy, create a Cloudflare Access application (self-hosted) for
`ADMIN_DOMAIN` with an *Allow* policy for your email. The workflow refuses to deploy the admin
without the Access settings. WebDAV store passwords are Worker secrets: set them once with
`npx wrangler secret put NAS_PASSWORD --name md4c-blog-admin`.

