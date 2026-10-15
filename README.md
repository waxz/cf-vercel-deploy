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

Workflow: [deploy-waxz-md4c-blog.yaml](.github/workflows/deploy-waxz-md4c-blog.yaml).
It needs only the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets; no variables.

**One-time setup**

1. Give the API token these permissions:
   - Account → *Workers Scripts: Edit*
   - Account → *Workers R2 Storage: Edit*
   - Account → *Access: Apps and Policies: Edit*
   - Account → *Access: Organizations, Identity Providers, and Groups: Read*
   - Account → *Workers KV Storage: Edit* (optional: lets storage added on the admin's Storage page
     be used from every device; without it, that storage is kept in each browser)
   - *only if you use custom domains*: Zone → *Zone: Read*, *Workers Routes: Edit*, *DNS: Edit*
2. Open **Zero Trust** in the Cloudflare dashboard once, and choose a team name and the Free plan.
   The workflow needs that team to create the admin's login.

**Deploy:** *Actions → deploy-waxz/md4c-blog → Run workflow*. On the first run, enter your email in
**admin_email** and tick **seed_samples** if you want example posts. Later runs can leave both empty.

The workflow, via [md4c-blog-cloudflare.mjs](.github/scripts/md4c-blog-cloudflare.mjs):
- creates the R2 buckets `md4c-blog` (public) and `md4c-blog-drafts` (private);
- publishes the blog on the bucket's `r2.dev` URL, or on **blog_domain** if given;
- creates a Cloudflare Access application and policy for the admin, allowing only **admin_email**;
- creates the KV namespace `md4c-blog-admin-settings` for the admin's Storage page;
- builds md4c.wasm, the site and the admin app from `waxz/md4c`, publishes the site, and deploys
  the admin Worker on `md4c-blog-admin.<your-subdomain>.workers.dev`, or on **admin_domain** if given.

Posts you write in the admin are never overwritten by a deploy. The run summary shows the blog and
admin URLs.
