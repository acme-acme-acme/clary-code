# Otter Code

Otter Code is a fork of [T3 Code](https://github.com/pingdotgg/t3code) with its own name, app IDs,
relay, and release channel. Everything in `AGENTS.md` still applies. This file covers what is
different and how to keep the fork aligned with upstream.

## How the fork stays in sync

- `main` is the upstream commit recorded in the `upstream-base` branch plus these commits, in this
  order:
  1. `chore(otter): brand fork as Otter Code`: names, IDs, domains, icons, relay values, this file,
     and `scripts/otter/`.
  2. `ci(otter): release Otter Code`: release gating and `.github/scripts/otter-adapt-upstream.sh`.
  3. `feat(otter): Linear integration`: linked Linear issues and the Linear agent app (see
     [Linear agent app](#linear-agent-app)).
  4. One squash commit per earlier sync, oldest first, each ending in an `Otter-Sync: <date>`
     trailer.
  5. `chore(otter): adapt upstream files (generated)`: output of `.github/scripts/otter-adapt-upstream.sh`.
     Never edit it by hand. Every sync drops and regenerates it, so noisy line-level edits to
     upstream files (runner labels, skipped Windows jobs, the pointer in `AGENTS.md`) never
     conflict.
  6. The newest sync's squash commit, then anything committed to `main` since.
- **Upstream** is PR #2829's head (`refs/pull/2829/head` of `pingdotgg/t3code`) while that PR is
  open, and `main` once it merges.
- **Changing the fork:** commit to `main` directly. Never merge upstream into it.
- **Syncing** is done by hand. It moves commits 1–4 and the newest squash onto the new upstream,
  regenerates the adapt commit, and squash-merges everything committed since the last sync on top
  through a pull request, which keeps the individual commits:

  ```sh
  git fetch origin && git fetch https://github.com/pingdotgg/t3code.git refs/pull/2829/head
  old=$(git rev-parse origin/upstream-base) new=$(git rev-parse FETCH_HEAD)
  boundary=$(git log -1 --format=%H -E --grep='^Otter-Sync: ' \
    --grep='^chore\(otter\): adapt upstream files \(generated\)$' $old..origin/main)
  git checkout --detach $boundary
  git rebase -i --onto $new $old   # drop the adapt commit, resolve conflicts
  .github/scripts/otter-adapt-upstream.sh && git commit -am "chore(otter): adapt upstream files (generated)"
  git branch -f otter/sync-<date> origin/main && git rebase --onto HEAD $boundary otter/sync-<date>
  ```

  Resolve conflicts in favour of upstream's code, dropping fork changes upstream now covers.
  If upstream added relay migrations, its snapshot chain and the fork's now both branch off the
  same parent. The relay deploy diffs the schema against the first snapshot head it finds and
  replays the other branch's tables. Fold a merge migration into the Linear commit. It records
  both heads as parents and changes no schema:

  ```sh
  cd infra/relay && pnpm exec drizzle-kit generate --custom --name otter_upstream_merge \
    --dialect postgresql --schema ./src/persistence/schema.ts --out ./migrations/postgres
  ```

  Push the detached commit as `main` (`--force-with-lease`) and `$new` as `upstream-base`, push
  the sync branch, open a pull request, and squash-merge it with `Otter-Sync: <date>` as the last
  line of the commit message. Then publish a nightly with
  `gh workflow run release.yml -f channel=nightly`: scheduled nightlies only release commits ahead
  of the last nightly tag, and a synced `main` has diverged from it.

- **Keep the diff small:** prefer repository variables and secrets over code, and new files
  over edits to upstream files. Leave internal names (`@t3tools/*`, `T3CODE_*`, code identifiers)
  alone. `scripts/otter/rebrand-ui-text.sh` renames client UI text; it runs only by hand, and
  its exclusions list text that must keep matching what the server or agents emit.

## Identities and infrastructure

| What                 | Value                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------- |
| App and bundle ID    | `dev.otterware.code` (`.dev`, `.preview`; iOS extensions `.widgets`, `.sharing`)        |
| URL scheme           | `ottercode` (`ottercode-dev`, `ottercode-preview`)                                      |
| Data home            | `~/.otter-code` (never `~/.t3`, so it can sit beside an installed T3 Code)              |
| Background service   | `otter-code.service` (systemd user unit), `dev.otterware.code.service` (launchd)        |
| Releases and updates | GitHub Releases of `acme-acme-acme/otter-code`, nightly channel                         |
| Relay                | `https://relay.otterware.dev` (Cloudflare Worker, deployed from `infra/relay`)          |
| Tunnels              | `prod-<digest>.otterware.dev`, one per linked machine                                   |
| Hosted web app       | `https://code.otterware.dev` (Vercel project `otter-code-web`)                          |
| Sign-in              | Clerk at `clerk.otterware.dev`                                                          |
| Apple                | Team `YNJ5WLH965`, App Store app `6815697255`                                           |
| Mobile builds        | EAS project `@clary-so/otter-code`                                                      |
| CLI on npm           | `otter-code` (command `otter-code`), platform builds `@otterware/otter-code-<platform>` |

Secrets live in the repository's Actions secrets and its `production` environment.

## Releases

- **Desktop and server runtimes:** `release.yml` (T3's pipeline) builds macOS arm64/x64 and Linux
  x64/arm64 on GitHub-hosted runners and publishes a nightly GitHub Release that installed apps
  offer in their update dialog. Windows, AUR, marketing, and Discord are skipped.
  Start one by hand with `gh workflow run release.yml -f channel=nightly`.
- **CLI on npm:** the same run publishes `otter-code` and its `@otterware/otter-code-<platform>`
  packages with the `NPM_TOKEN` secret (an npm account that is a member of the `otterware` org),
  tagged `nightly` and also `latest`, so `npx otter-code` and `npm i -g otter-code` get the newest
  build. The token is needed because new packages have no npm trusted publisher yet.
- **Relay:** `Deploy T3 Connect relay` runs on every push to `main`. The relay adopts the
  existing `otterware.dev` zone and a PlanetScale database with a retain policy. Never run
  `alchemy destroy` against `prod`. Its PlanetScale service token (`PLANETSCALE_API_TOKEN*`)
  needs `delete_production_branch_password` and `delete_branch_password` on the database.
  Alchemy runs migrations as a temporary role and deletes it with `postgres` as successor, which
  hands the new tables to `postgres`. Without those accesses the deletion fails with only a
  warning, the tables stay owned by the expired role, and a later `ALTER TABLE` migration fails
  with `must be owner of table`.
- **iOS** is built and uploaded locally, not in CI:

  ```sh
  cd apps/mobile
  pnpm dlx eas-cli@latest build --platform ios --profile production --local --non-interactive \
    --output ../../../otter-code-builds/otter-code-ios.ipa </dev/null
  xcrun altool --upload-app -f ../../../otter-code-builds/otter-code-ios.ipa -t ios \
    --apiKey <key id> --apiIssuer <issuer id>   # key from API_PRIVATE_KEYS_DIR
  ```

  Use a **release** Xcode; App Store Connect rejects beta toolchains (error 90534). Public build
  config (`T3CODE_CLERK_*`, `T3CODE_RELAY_URL`) is stored as EAS environment variables. Don't put
  it in a gitignored `.env.local`: EAS builds from a clean copy of the repo, and the runtime
  fingerprints would not match.

## Moving a machine from T3 Code

`scripts/otter/migrate-from-t3.sh` copies a T3 Code home (V2 preview or T3 Nightly) into
`~/.otter-code`. Threads, projects, settings, secrets, attachments, and the environment ID
come along, so saved connections to that machine keep matching. It never modifies the
source. Run it with `--dry-run` first.

- **Desktop:** quit both apps first (the script refuses while a database is open), then:

  ```sh
  scripts/otter/migrate-from-t3.sh --from ~/.t3/orchestrator-preview-2829
  open -a "Otter Code"
  ```

- **Server with a systemd unit:** install the Otter Code runtime into the new home, then let the
  script stop the old unit, copy, install `otter-code.service`, and restore the old unit if
  anything fails:

  ```sh
  curl -fsSL https://raw.githubusercontent.com/acme-acme-acme/otter-code/main/scripts/install.sh \
    | T3CODE_HOME=~/.otter-code T3CODE_CHANNEL=nightly sh
  scripts/otter/migrate-from-t3.sh --from ~/.t3/orchestrator-preview-2829 \
    --stop-unit t3code-pr2829.service --wait-idle 10 --install-service
  ```

  The installer links the command as `otter-code`, so it never replaces an installed T3 Code's
  `t3`. The script refuses to touch T3 Nightly's `t3code.service`.

Deliberately not copied:

- Desktop client files encrypted with the old app's Keychain key (`connection-catalog.json`,
  `clerk-tokens.json`, `cloud-auth-token.json`). Otter Code can't read them, and its window
  would stay empty.
- The stored T3 Connect link (`secrets/cloud-*`), which points at T3's relay and account.

## T3 Connect

- **Desktop:** Settings → Connections → T3 Connect.
- **Stale link:** if a machine says it is "already linked to a different cloud account", clear the
  old link with `t3 connect logout --base-dir ~/.otter-code`. On the desktop, run the CLI through
  the app binary with `ELECTRON_RUN_AS_NODE=1` and `Contents/Resources/app.asar/apps/server/dist/bin.mjs`.
- **SSH-only hosts:** the desktop has no Connect switch for SSH environments, and Clerk's device
  grant is not enabled, so link from the host over an SSH session that forwards the loopback
  OAuth callback:

  ```sh
  ssh -tt -L 34338:127.0.0.1:34338 <host> \
    'T=$(ls -d ~/.otter-code/runtime/versions/*/t3 | sort -V | tail -1);
     env -u SSH_CONNECTION -u SSH_TTY -u SSH_CLIENT "$T" connect --base-dir ~/.otter-code'
  ```

  Open the printed `code.otterware.dev/connect` link on the local machine, approve it, then
  restart `otter-code.service` on the host so it brings the link up.

- **Relay reaching tunnels:** the relay Worker needs the `global_fetch_strictly_public`
  compatibility flag (`infra/relay/src/worker.ts`), because tunnels share the relay's zone.
  Without it, the relay's calls to a tunnel fail with Cloudflare 530 and phones report
  `endpoint_request_failed`.

## Linear agent app

Delegating Linear issues to Otter needs one Linear OAuth app owned by Otter, configured on the relay.
Without it the relay reports Linear as unavailable and clients hide the section.

- Create the app at `linear.app/settings/api/applications/new` with distribution **public**, callback
  URL `https://relay.otterware.dev/v1/linear/oauth/callback`, webhooks on, webhook URL
  `https://relay.otterware.dev/v1/linear/webhook`, and the **Agent session events**, **Issues**,
  **Comments**, and **OAuth app revoked** categories. Issues and Comments are what make linked
  issues update right away; without them, machines fall back to polling.
- Store the client ID as the `LINEAR_CLIENT_ID` repository variable, and the client secret and webhook
  signing secret as the `LINEAR_CLIENT_SECRET` and `LINEAR_WEBHOOK_SECRET` secrets in the `production`
  environment. `HOSTED_APP_URL` is optional and defaults to `https://code.otterware.dev`.
- The relay generates its own keys for sealing Linear tokens and signing OAuth state. Rotating them
  forces every workspace to reinstall and every user to relink.

## Other traps

- **Electron as Node:** agent shells inside Otter Code can inherit `ELECTRON_RUN_AS_NODE=1`, and
  `open` passes it on, so an app launched from such a shell runs as plain Node and exits. Launch
  it with `env -u ELECTRON_RUN_AS_NODE open -a "Otter Code"`.
- **macOS runners:** macOS jobs run on `macos-15`. On GitHub's `macos-26` image, electron-builder
  below 26.16.1 fails to unlock its signing keychain. Move to `macos-26` in the generated script
  once upstream pins 26.16.1 or later.
