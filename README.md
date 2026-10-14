# Crashlytics CODEOWNERS Bot

Listens for Firebase Crashlytics alerts posted by Firebase's native Slack
integration, figures out which file crashed, looks up the owner in your
repo's `CODEOWNERS`, and replies in the alert's thread mentioning them.

```
[Firebase] New issue: NullPointerException
MainActivity.onCreate (MainActivity.kt:45)
                                  │
                                  ▼
                    ┌─────────────────────────┐
                    │  This bot (Slack Bolt)   │
                    │  1. parses "(File:line)" │
                    │  2. finds full path via  │
                    │     GitHub repo tree     │
                    │  3. matches CODEOWNERS   │
                    │  4. maps handle -> Slack │
                    └─────────────────────────┘
                                  │
                                  ▼
              (thread reply) 📂 Crash traced to
              app/src/main/.../MainActivity.kt:45.
              Code owner: @jane
```

## How it works

Firebase's built-in Slack integration doesn't include a full stack trace in
its message — but the issue title/subtitle it posts almost always contains
the top stack frame formatted as `ClassName.method (File.kt:123)`. This bot:

1. Listens to every message in the configured Slack channel.
2. Detects Crashlytics alerts (checks for a `console.firebase.google.com/.../crashlytics/` link or the word "Crashlytics" in the message).
3. Extracts the filename + line number from that `(File.kt:123)` pattern.
4. Resolves the bare filename to a full repo path by searching your GitHub repo's file tree (cached 10 min).
5. Fetches and parses `CODEOWNERS`, matching the full path using gitignore-style pattern rules (last match wins, per the CODEOWNERS spec).
6. Maps the matched GitHub handle/team to a Slack user or user group ID via `config/owners-map.json`.
7. Looks up the most recent commit that touched that file on the `release/<version>` branch matching the alert's `Version` field (falling back to the default branch if that release branch doesn't exist), and tries to match its git author email to a Slack account (`users.lookupByEmail`). Falls back to the plain git author name if no Slack account matches (e.g. a GitHub noreply email).
8. If the alert names a function (or a line number), reads the file from that same release branch, locates the function's body, and asks GitHub's blame who most recently changed it. Skipped when the function can't be pinned to exactly one declaration (overloads, lambdas, constructors, generated code).
9. Replies in the alert's thread with `chat.postMessage` (`thread_ts` = original message timestamp), `@`-mentioning the CODEOWNERS owner, the file's last editor and the function's last editor, with an **"ACK and will investigate"** button attached.
10. When someone clicks that button: reacts to the original alert message with `:ackw:`, and posts a follow-up thread reply `@`-mentioning whoever clicked, saying "ACK and will investigate this issue."

**Known limitation:** this relies on Crashlytics including the `(File.kt:line)`
pattern in the alert text, which is true for most crashes but may be absent
for some ANRs or custom non-fatals. When it can't be parsed, the bot just
logs and skips — it won't reply. If you need higher accuracy, the official
[Crashlytics API](https://firebase.google.com/docs/crashlytics/crashlytics-api)
can fetch the full stack trace instead of parsing the Slack text; that's a
reasonable follow-up but requires its own GCP service-account setup and
wasn't wired in here since its response schema needs to be verified against
your project.

## Setup

### 1. Create the Slack app

1. Go to https://api.slack.com/apps → **Create New App** → From scratch.
2. **Socket Mode**: enable it (Settings → Socket Mode). This generates an
   app-level token — create one with the `connections:write` scope. Save it
   as `SLACK_APP_TOKEN` (starts with `xapp-`).
3. **OAuth & Permissions** → Bot Token Scopes, add:
   - `chat:write`
   - `channels:history` (public channel) and/or `groups:history` (private channel)
   - `reactions:write` (for the ACK button's `:ackw:` reaction)
   - `users:read.email` (to match a commit author's git email to their Slack account for the "last edited by" line)
4. **Event Subscriptions** → enable, and subscribe to bot events:
   - `message.channels` (public channel) and/or `message.groups` (private channel)
5. **Interactivity & Shortcuts** → toggle **On**. No Request URL is needed
   since this runs over Socket Mode — the ACK button's click event arrives
   through the same socket connection.
6. Install the app to your workspace. Copy the **Bot User OAuth Token**
   (starts with `xoxb-`) as `SLACK_BOT_TOKEN`.
7. Invite the bot to the channel where Firebase posts Crashlytics alerts:
   `/invite @your-bot-name`.
8. Get the channel ID: right-click the channel → View channel details →
   copy the ID at the bottom → `CRASH_CHANNEL_ID`.

If you already have the app installed and are just adding this feature, add
the new scope, enable Interactivity, then **reinstall the app** — scope and
event/interactivity changes only take effect after reinstalling.

### 2. GitHub access

Create a token that can read your Android repo's contents:
- Fine-grained PAT with **Contents: Read-only** on the target repo, or
- Classic PAT with the `repo` scope (if the repo is private).

Set `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`. `GITHUB_BRANCH` and
`CODEOWNERS_PATH` are optional (default to the repo's default branch and
`.github/CODEOWNERS`).

### 3. Map CODEOWNERS handles to Slack

```bash
cp config/owners-map.example.json config/owners-map.json
```

For each handle/team that appears in your `CODEOWNERS` file, add an entry:

```json
{
  "octocat": { "type": "user", "id": "U0123ABCDE" },
  "your-org/team-mobile": { "type": "usergroup", "id": "S0123ABCDE" }
}
```

- User ID: their Slack profile → "..." menu → **Copy member ID**.
- User group (subteam) ID: Slack admin → People → User groups (or the
  `usergroups.list` API method if you have the right scope).

### 4. Configure and run

```bash
cp .env.example .env
# fill in .env

npm install
npm run dev     # local development, auto-restarts on change
```

No public URL is required — Socket Mode uses an outbound WebSocket
connection, so this runs fine locally, in a container, on a small VM, or as
a long-running always-on process. See below for how we run it in practice.

## Deploying to the Mac mini runner

This runs as a native macOS background service (`launchd`) on the team's
Mac mini — the same box already used as a CI/build runner. That gets us,
for free, without adding a process manager dependency:

- Starts automatically on boot.
- Restarts itself automatically if it ever crashes (`KeepAlive`, throttled
  so a persistent failure doesn't hammer Slack/GitHub in a crash loop).
- Runs as a normal (non-root) user, same footprint as any other script on
  the machine — the daemon just runs under that account.
- Secrets stay in the `.env` file on disk; nothing goes into the plist or
  into git.

First-time setup, from a checkout of this repo on the mini:

```bash
cp .env.example .env   # fill in tokens
sudo ./deploy/install.sh
```

That installs dependencies, builds, writes
`/Library/LaunchDaemons/com.crashlyticsbot.slack.plist`, and starts the
service. Logs go to `logs/bot.log` / `logs/bot.err.log` in the repo.

To ship a code change after that:

```bash
sudo ./deploy/update.sh   # git pull, rebuild, restart the service
```

Useful commands:

```bash
sudo launchctl print system/com.crashlyticsbot.slack   # status
sudo launchctl kickstart -k system/com.crashlyticsbot.slack   # force restart
tail -f logs/bot.log logs/bot.err.log                  # live logs
```

## Project layout

- `src/app.ts` — Bolt app entry point / message handler wiring
- `src/crashMessageParser.ts` — detects Crashlytics alerts, extracts `(File:line)`
- `src/github.ts` — resolves filename → full path via repo tree, fetches CODEOWNERS
- `src/codeowners.ts` — CODEOWNERS parsing + gitignore-style matching
- `src/ownerMap.ts` — GitHub handle → Slack mention lookup
- `config/owners-map.json` — your handle → Slack ID mapping (gitignored; copy from the `.example`)
- `deploy/` — `launchd` service template + `install.sh` / `update.sh` for running on the Mac mini runner
