# Deployment — prod-linode (45.33.41.124)

## Architecture

Push to `main` → GitHub Actions → SSH (user `deploy`) → `/srv/hypnosis-studio` → `sudo systemctl restart hypnosis-studio` → smoke test on 127.0.0.1:4100.

- **App:** Node 24 (`/usr/local/bin/node` → `/opt/node-v24.11.1`), systemd unit `hypnosis-studio.service`, env `PORT=4100`, binds loopback only
- **Edge:** nginx vhost `/etc/nginx/sites-available/hypnosis-studio` → `proxy_pass http://127.0.0.1:4100`
- **Firewall (UFW):** only 22/80/443 public; the app port stays loopback-only. Shared server — do not touch other vhosts/services.

## Server changes made (2026-07-21, all additive)

- User `deploy` (key-only login), `github_actions_prod.pub` in `~deploy/.ssh/authorized_keys`
- `/srv/hypnosis-studio` owned by `deploy`
- `/etc/sudoers.d/deploy-hypnosis`: NOPASSWD limited to `/bin/systemctl restart|status|is-active hypnosis-studio`
- Node v24.11.1 copied from root's nvm to `/opt/node-v24.11.1`, symlinked into `/usr/local/bin`
- `/etc/systemd/system/hypnosis-studio.service` (enabled)
- nginx site `hypnosis-studio` enabled; **placeholder** `server_name hypnosis.frankbria.com`

## One-time GitHub setup (manual step)

Repo → Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `PROD_HOST` | `45.33.41.124` |
| `PROD_USER` | `deploy` |
| `PROD_SSH_KEY` | full contents of `C:\Users\frank\.ssh\github_actions_prod` (the private key) |

After the secrets exist, any push to `main` deploys.

## Domain (pending decision)

The nginx `server_name` is a placeholder. To go live:

1. Point the DNS A record at `45.33.41.124`
2. `ssh prod 'sed -i "s/hypnosis.frankbria.com/<domain>/" /etc/nginx/sites-available/hypnosis-studio && nginx -t && systemctl reload nginx'`
3. `ssh prod 'certbot --nginx -d <domain>'`

## Ops cheat sheet

- Logs: `ssh prod 'journalctl -u hypnosis-studio -f'`
- Restart: `ssh prod 'systemctl restart hypnosis-studio'`
- Always `nginx -t` before `systemctl reload nginx`
