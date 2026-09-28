# MetaRoom3D

**Immersive 3D virtual tours for premium real estate.**
🌐 [www.metaroom3d.com](https://www.metaroom3d.com)

MetaRoom3D turns 360° panoramas into walkable, interactive 3D dollhouse tours,
built on accurate floor plans instead of raw photography or flat panoramas.
Buyers navigate a property room-by-room, at their own pace, from any browser.

Built for real estate agents, property developers, architects, and individual
sellers who want to market properties to buyers anywhere in the world.

---

## Features

- **360° Views** — complete panoramic exploration of every room
- **Interactive Hotspots** — click to navigate seamlessly between rooms
- **Multi-floor Support** — explore entire buildings with accurate floor plans
- **AI-Powered Editor** — built-in AI tools in the Room Layout Editor speed up alignment and layout creation
- **GLB Export** — export room layouts for use elsewhere (Professional tier and up)
- **Path Tracer** — in-house WebGL bidirectional path tracer (BVH-accelerated, with denoising) for photoreal daylight/night renders (Studio tier and up)

---

## Sphere (new product)

**Sphere** is a separate tool, not part of the room-tour pipeline: it turns
bracketed chrome-ball photographs into scene-accurate HDRI environment maps —
HDR merge, spherical projection, and seam correction, without the manual
retouch pass the classic VFX workflow requires.

- **DNG & HDR input** — loads camera raw and standard HDR exposure brackets directly
- **HDR bracket merge** — combines multiple exposures into one true HDR capture
- **ACES / OCIO pipeline** — scene-linear color management for VFX-grade delivery
- **OpenEXR export** — lossless, industry-standard HDRI output, keeping full dynamic range recoverable (vs. an 8-bit render, which clips once it blows out or crushes to black)

Works alongside existing HDRI/color pipelines — the site displays compatibility
with OpenEXR, OpenColorIO (OCIO), ACES, Adobe DNG, and Radiance HDR. *(Each of
those is someone else's mark — confirm usage is within their brand/trademark
guidelines before publishing the logo strip.)*

Sphere has its own pricing, separate from the room-tour tiers below: see
[`products.html#sphere`](./products.html#sphere).

---

## Live demo

The homepage loads a live tour straight from this repo:

```html
<div class="demo-frame-wrap" data-src="3DViewer_v1_5_3/index.html?taskId=TaskID_101">
```

Each tour is addressed by a `taskId` query parameter, which points at a task
folder (e.g. `TaskID_101`, `TaskID_101glb`) containing that tour's exported
data. Swapping the `taskId` swaps the tour — the viewer itself is generic.

## Getting a tour onto a client's website

The viewer is built to serve any number of tasks — every tour a user creates
gets its own property card, addressed by its `taskId`. From there, a client
can go live two ways:

### Option A — Self-hosted (we give them the viewer)

We hand over the `3DViewer_v1_5_3` viewer bundle plus that tour's task
folder (e.g. `TaskID_101/`). They host both on their own web server and load
it the same way the demo does:

```html
<iframe
  src="/3DViewer_v1_5_3/index.html?taskId=TaskID_101"
  width="100%"
  height="600"
  frameborder="0"
  allowfullscreen>
</iframe>
```

They own the hosting, bandwidth, and file storage. Good fit for clients who
want the tour fully on their own infrastructure/domain, or who are buying a
license to redistribute the viewer itself.

### Option B — Hosted by us (we give them an embed code)

The tour data and viewer stay on `metaroom3d.com`; we give the client a
ready-made embed snippet pointing at their `taskId`:

```html
<iframe
  src="https://www.metaroom3d.com/3DViewer_v1_5_3/index.html?taskId=TASKID_HERE"
  width="100%"
  height="600"
  frameborder="0"
  allowfullscreen>
</iframe>
```

This is closer to a typical SaaS embed — they paste a snippet, we control
updates, uptime, and can revoke access. Better fit for most subscription
tiers, since nothing leaves our infrastructure.

**Before offering either externally**, decide per tier/plan:
- Which option(s) each pricing tier includes (self-hosted bundle vs. hosted embed vs. both)
- **Domain-lock** hosted embeds (check `Referer`/`Origin` server-side) so a
  `taskId` URL can't be freely reused on sites that haven't paid for it
- Whether embedded/self-hosted tours keep MetaRoom3D branding or can be white-labeled
- Licensing terms if handing over the actual viewer bundle (Option A) — that's
  distributing your code, not just granting access to it

---

## Repository structure

| Path | Purpose |
|---|---|
| `3DViewer_v1_5_3/` | The 3D tour viewer (loaded via `?taskId=`) |
| `Path Tracer/` | PT (daylight) and BDPT (night) photoreal renderer demos |
| `TaskID_101/`, `TaskID_101glb/` | Sample tour data used by the live demos |
| `index.html`, `script.js`, `styles.css` | Marketing site (www.metaroom3d.com) |
| `checkout.html` | PayPal subscription checkout flow |
| `products.html` | Full feature breakdown by plan |
| `about.html`, `privacy.html`, `terms.html`, `refund.html` | Site legal/info pages |
| `paypal-worker/` | Cloudflare Worker backing subscriptions (see below) |

---

## Pricing tiers

| Tier | Price | Includes |
|---|---|---|
| **Personal** | 7-day free trial | Room Layout Editor access, up to 2 saved projects, standard render quality, community support |
| **Professional** | $19/mo · $190/yr | Everything in Personal, unlimited projects, GLB export, high-quality rendering, priority email support |
| **Studio** | $49/mo · $490/yr | Everything in Professional, Path Tracer (PT + BDPT), team seats & shared projects, dedicated onboarding |
| **Enterprise** | Custom | Everything in Studio, custom seat/license tiers, SLA-backed support, dedicated account manager |

Full breakdown: [`products.html`](./products.html)

---

## Payments backend (PayPal Subscriptions Worker)

Subscriptions are handled by a Cloudflare Worker (`paypal-worker/`) that owns
plan definitions and subscription state; PayPal owns recurring billing,
retries, and cancellations. No secrets touch the browser — `checkout.html`
only ever talks to the Worker.

Quick setup:

1. **PayPal account** — Business account, app credentials created for both
   Sandbox and Live under [developer.paypal.com](https://developer.paypal.com/dashboard).
   Confirm **Pay & Get Paid → Subscriptions** is enabled on your account before
   going further.
2. **KV namespace** — `wrangler kv namespace create SUBS` (sandbox and
   `--env production`), then paste the IDs into `wrangler.toml`.
3. **Secrets & deploy** — `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`,
   `ADMIN_TOKEN`, then `wrangler deploy`.
4. **Create plans** — `POST /admin/sync-plans` builds the catalog products
   and billing plans in PayPal and stores their IDs in KV. Idempotent — safe
   to re-run.
5. **Webhooks** — point PayPal at `/webhook`, subscribe to the
   `BILLING.SUBSCRIPTION.*` and `PAYMENT.SALE.COMPLETED` events, then set
   `PAYPAL_WEBHOOK_ID`.
6. **Test in sandbox**, then repeat secrets/deploy/sync with `--env production`
   to go live.

Full endpoint reference, KV schema, and troubleshooting notes live in
[`paypal-worker/README.md`](./paypal-worker/README.md).

---

## License

MIT — see [`LICENSE`](./LICENSE).

## Contact

For enterprise licensing, embedding partnerships, or custom integrations,
reach out via the contact form on [www.metaroom3d.com](https://www.metaroom3d.com).
