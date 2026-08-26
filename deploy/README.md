# Deploying Hivekit

One container, one volume, one hostname. The gateway is a single Bun process holding the
web app, the WSS thread, the agent loops, the routine scheduler and the connectors, with
SQLite (WAL) on a persistent disk.

The only hard requirement: **something has to stay awake.** A routine that fires at 07:00
needs a host that is up at 07:00. That is why v1 targets a cloud VM rather than a laptop
daemon.

Sizing: 1 vCPU / 1 GB is enough for 8 concurrent workers, because workers are I/O-bound API
calls — Hivekit never runs inference locally.

---

## Quick start

```bash
git clone https://github.com/dipendrakshah/xcog-bot hivekit && cd hivekit
cp config/hivekit.example.yaml config/hivekit.yaml
$EDITOR config/hivekit.yaml                 # public_url, connectors, routines_seed

cat > .env <<EOF2
HIVE_HOST=hive.example.com
PUBLIC_URL=https://hive.example.com
HIVEKIT_TOKEN=$(openssl rand -hex 24)
HIVEKIT_MASTER_KEY=$(openssl rand -base64 32)
TZ=Asia/Kolkata
EOF2
chmod 600 .env

docker compose -f deploy/docker-compose.yml up -d
```

Point an A record at the box first — Caddy needs to reach port 80 to issue the certificate.
Then open `https://hive.example.com`, set the owner passkey, paste an OpenRouter key, pick a
master and a worker model, and send the first message from
[`examples/example-jobs.md`](../examples/example-jobs.md).

**Two secrets, different jobs.** `HIVEKIT_TOKEN` bootstraps the owner login before a passkey
exists. `HIVEKIT_MASTER_KEY` decrypts the vault — lose it and you re-enter every provider and
connector credential; leak it and someone with the volume can read them all. Keep it out of
the repo and out of your shell history.

---

## Option 1 — EC2 (the reference target)

`t4g.nano` (2 vCPU ARM, 0.5 GB) works if you keep `max_workers_per_job` at 4;
`t4g.small` (2 GB, ~$12/mo) is the comfortable choice. Both are arm64, which the image builds
for.

```bash
# Amazon Linux 2023, arm64
sudo dnf install -y docker git
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user && newgrp docker

git clone https://github.com/dipendrakshah/xcog-bot hivekit && cd hivekit
cp config/hivekit.example.yaml config/hivekit.yaml
# …write .env as above…
docker compose -f deploy/docker-compose.yml up -d
```

**Security group:** inbound 80 and 443 only. Never expose 8787.

**Storage:** put `/var/lib/docker/volumes` on its own EBS volume and snapshot it. It holds the
database, the vault and every artifact — the entire state of the hive.

**Swap:** on `t4g.nano`, add 1 GB of swap. The image build will otherwise OOM during
`docker compose up --build`. Build elsewhere and pull the image if you can.

---

## Option 2 — Any small VM (cheapest)

Hetzner CX22, DigitalOcean, Vultr: $4–6/month, same compose file, more headroom than a nano.
This is what most people should pick.

---

## Option 3 — Fly.io / Railway (easiest)

A container with a volume and TLS, without touching a security group.

```bash
fly launch --no-deploy
fly volumes create hivekit_data --size 3
fly secrets set HIVEKIT_TOKEN=... HIVEKIT_MASTER_KEY=...
fly deploy
```

Mount the volume at `/data`, drop the Caddy service (the platform terminates TLS), and
**scale to exactly one machine**. Two instances means two schedulers, and every routine fires
twice.

---

## Option 4 — Cloudflare

Worth being precise, because the obvious guess does not work.

**Cloudflare Workers cannot host the gateway.** The thread is a long-lived WebSocket and a
job is a minutes-long tool loop with local SQLite. That is outside what Workers does.

Two shapes that do work:

1. **Cloudflare in front of a VM (recommended).** Keep the gateway on EC2 or Hetzner and put
   Cloudflare's DNS proxy — or `cloudflared` for a tunnel with no inbound ports at all — in
   front. You get TLS, a hostname, DDoS protection and optionally Cloudflare Access in front
   of the login. Least work, fewest surprises. Uncomment the `cloudflared` service in the
   compose file and drop `caddy`.
   - Enable **WebSockets** in the zone (on by default on current plans).
   - Cloudflare's proxy has a ~100 s idle timeout; the gateway sends WS pings well inside it.
2. **Cloudflare Containers.** Legitimate if you are already all-in on Cloudflare. Run the same
   image, keep the routine scheduler in a Durable Object alarm so it survives the container
   idling out, and back the volume with R2 snapshots.

---

## What it costs

| Line | Typical |
| --- | --- |
| VM | $4–12 / month |
| Morning site routine, daily, 4 free workers | ~$0.03–0.10 per run |
| Hourly inbox sweep | ~$0.01–0.03 per run |
| X API | Paid above a small free allowance — see below |

Roughly 90% of model spend is the master, which is the whole point of the split. Settings
shows the breakdown per job, per worker and per model. Set `limits.budget_usd_per_day` and the
gateway stops starting new jobs when it is hit.

---

## Connector credentials

All three are configured in **Settings → Connectors** and stored AES-GCM encrypted in SQLite.
Nothing below ever belongs in the repo or in `hivekit.yaml`.

### `site` — publishing to your website

Generate a deploy key, add it to the repo as a deploy key with write access, paste the private
key into Settings.

```bash
ssh-keygen -t ed25519 -f ./hivekit_deploy -N "" -C "hivekit"
cat ./hivekit_deploy       # paste into Settings → Connectors → site
shred -u ./hivekit_deploy
```

Prefer a branch plus a diff approval over pushing to `main` directly. Draft-only mode works
with read-only access if you would rather commit by hand at first.

### `x` — posting to X

Read this before wiring it up:

- **The X API is paid** above a very small free allowance. Check current tiers against your
  posting volume; a weekly digest and a few drafts is a different plan from an hourly bot.
- **Automated posting is subject to X's automation rules**, and enforcement is account-level.

Hivekit therefore keeps `x.post` in `policy.always_ask` in every mode and ships no auto-post
preset. `x.draft` is free to use; posting waits for a tap.

### `email` — IMAP and SMTP

The supported path is **IMAP + an app password**, not OAuth. Gmail's API needs OAuth app
verification to distribute, which is a lot of ceremony for a single-operator box; app
passwords work today with Gmail, Fastmail, Proton Bridge and anything else with IMAP.

Two things to know:

- **Sending from a VM IP has deliverability problems.** Route SMTP through your provider's
  relay (Gmail app password, Fastmail, or a transactional provider), not straight from the box.
- **Email is the most sensitive scope here.** `stealth_allowed_scopes` excludes `email` by
  default so triage never runs on a free route whose provider retains prompts. Leave it that
  way unless you have read the provider's retention policy.

---

## Backup and restore

Everything is in the `hivekit_data` volume — including `/data/threads`, which holds each
thread's `INSTRUCTIONS.md`, `MEMORY.md` and artifacts. Losing that loses what your bots have
learned, which is harder to recreate than the database.

```bash
docker compose exec hivekit sqlite3 /data/hivekit.db ".backup /data/backup.db"
docker run --rm -v hivekit_data:/d -v "$PWD":/out alpine \
  tar czf /out/hivekit-$(date +%F).tar.gz -C /d backup.db threads
```

If you set `memory.git: true`, `/data/threads` is itself a git repository — you can push it to
a private remote and get off-box history of every memory write for free:

```bash
docker compose exec hivekit git -C /data/threads remote add origin git@github.com:you/hive-memory.git
docker compose exec hivekit git -C /data/threads push -u origin main
```

Store `HIVEKIT_MASTER_KEY` **separately** from the archive — the archive is useless without
it, which is the point. Rehearse the restore onto a second VM before you need it; an untested
backup is not a backup.

## Upgrading

```bash
git pull && docker compose -f deploy/docker-compose.yml up -d --build
```

Migrations run on boot and take a database backup first. Pin an image tag in production so a
`git pull` cannot surprise you mid-routine.

## Operating notes

- **Run one instance.** Two schedulers double-fire every routine.
- **Watch spend for the first week.** A vaguer routine prompt than you think produces more
  workers than you expect.
- **Send the routine as a one-off first.** The confirm card is where you find out the prompt
  was ambiguous — better then than at 07:00 unattended.
- `docker compose exec hivekit hivekit doctor` checks config, vault, provider ping per
  configured model, connector auth, disk and TLS expiry.
