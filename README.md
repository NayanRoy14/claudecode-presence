# Claude Code Presence

Discord Rich Presence for **Claude Code**. It shows what Claude is doing (thinking, editing a file, running commands, waiting for your permission) with animated status images, plus stats like session tokens, today's hours and lines changed this week.

- No dependencies: plain Node.js, nothing to `npm install`
- Runs locally: talks to the Discord desktop app over its local IPC pipe, and the only network call is an optional GitHub lookup for the repo button
- Starts itself from Claude Code's hooks and exits when you stop working
- Inspired by [claude-rpc](https://github.com/rar-file/claude-rpc) (MIT)

| status | example (lines rotate) |
| --- | --- |
| working | Working in myapp · Editing · page.tsx · 260k tokens |
| thinking | Thinking in myapp · Opus 5.5 · 9 prompts · 259k tokens |
| notification | Waiting on you · myapp · Permission needed |
| shipped | Shipped a commit · myapp · fix login redirect |
| idle | Idle in myapp · Opus 5.5 · 2h 10m today / This week · 14h 5m · 120 prompts |

---

## Requirements

- **Node.js 18+** on your `PATH` (check with `node --version` in a new terminal)
- **Claude Code** (CLI, desktop app or IDE extension) on the same machine
- **Discord desktop app** running (the browser version can't show Rich Presence)
- In Discord: **User Settings → Activity Privacy → "Share your detected activities with others"** turned on
- Windows, macOS or Linux

## Setup

### 1. Get the code

Clone it somewhere permanent. The hooks point at this folder, so don't move it later (if you do, run setup again).

```bash
git clone https://github.com/NayanRoy14/claudecode-presence.git
cd claudecode-presence
```

### 2. Install the hooks

```bash
node setup.js
```

This adds hook entries to the `hooks` section of `~/.claude/settings.json`. Your other settings and hooks stay as they are, and a `.bak` copy is saved first. Running it twice won't add duplicates.

<details>
<summary>Prefer to add the hooks by hand?</summary>

Add this to `~/.claude/settings.json`, replacing the path with where you cloned the repo (forward slashes work on Windows too):

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "node \"C:/path/to/claudecode-presence/hook.js\"", "timeout": 5 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node \"C:/path/to/claudecode-presence/hook.js\"", "timeout": 5 }] }],
    "PreToolUse":  [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"C:/path/to/claudecode-presence/hook.js\"", "timeout": 5, "async": true }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"C:/path/to/claudecode-presence/hook.js\"", "timeout": 5, "async": true }] }],
    "PreCompact":       [{ "hooks": [{ "type": "command", "command": "node \"C:/path/to/claudecode-presence/hook.js\"", "timeout": 5 }] }],
    "Notification":     [{ "hooks": [{ "type": "command", "command": "node \"C:/path/to/claudecode-presence/hook.js\"", "timeout": 5 }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "node \"C:/path/to/claudecode-presence/hook.js\"", "timeout": 5 }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "node \"C:/path/to/claudecode-presence/hook.js\"", "timeout": 5 }] }]
  }
}
```

</details>

### 3. Restart Claude Code and check

Start a new Claude Code session and send a prompt. Within a few seconds your Discord profile should show **Playing Claude Code**. In Claude Code, `/hooks` lists the loaded hooks. From a terminal:

```bash
node cli.js status
```

```
paused: no
daemon: running (pid 12345)
  session: myapp - working (Editing)
  last log: [2026-10-25T14:20:01.000Z] presence: Working in myapp | Editing · page.tsx · 260k tokens
```

## Daily use

```bash
node cli.js pause 30m   # hide presence for 30 minutes (or 2h; default 1h)
node cli.js resume      # show it again
node cli.js status      # daemon, sessions, last log line
```

With several Claude Code sessions open, the busiest one is shown with a `(+N)` count.

## Statuses

| status | when |
| --- | --- |
| working | a tool is running (Edit, Bash, Search, MCP tools, subagents…) |
| thinking | after your prompt and between tool calls |
| compacting | the context is being compacted |
| notification | Claude is waiting on a permission prompt |
| shipped | for 60 s after Claude runs `git commit`, with the commit subject |
| idle | the turn is finished; rotates through today/week stats |

Stats come from Claude Code's own transcripts in `~/.claude/projects`. They're read locally and cached in `.state/aggregate.json`.

## Customizing

Edit `config.json`. Changes apply the next time the daemon starts (it exits about a minute after your last session ends).

| key | what it does |
| --- | --- |
| `frames` | Per-status lists of `[top line, bottom line]` templates. Several frames rotate. `{vars}` that come out empty drop their ` · ` segment, and a frame whose line ends up empty is skipped. |
| `images` | Per-status Discord asset key or `https://` URL. GIFs animate. |
| `projects` | Rename or hide folders: `{ "secret-client": "hidden", "myapp": "My App" }` |
| `githubButton` | Adds a "View on GitHub" button when the project is a **public** GitHub repo |
| `rotateSeconds` | How often frames rotate |
| `hideAfterIdleMinutes` | Clear presence after being idle this long (`0` = never) |
| `staleMinutes` | Ignore sessions with no activity for this long |
| `exitAfterIdleSeconds` | How long the daemon waits with no sessions before exiting |
| `clientId` | Discord application ID (see below) |

**Template variables:**
`{project} {tool} {file} {model} {lastCommit}`,
`{sessionTokens} {sessionPrompts} {sessionAdded}`,
`{todayHours} {todayPrompts} {weekHours} {weekPrompts} {weekTokens} {weekAdded} {weekRemoved} {topLang}`.

### Using your own Discord app (optional)

The bundled `clientId` works for everyone and shows as "Playing **Claude Code**". To change the name or upload your own art:

1. Create an application at <https://discord.com/developers/applications>. Its name is the "Playing …" text.
2. Copy the **Application ID** into `clientId`.
3. Optionally upload images under **Rich Presence → Art Assets** and use their keys in `images`, or use any public `https://` image/GIF URL.

## How it works

```
Claude Code hooks ─► hook.js ─► .state/sessions/<session>.json ─► daemon.js ─► Discord IPC
                                                                     ▲
                                  ~/.claude/projects transcripts ─► stats.js
```

| file | role |
| --- | --- |
| `hook.js` | Runs on each hook event: records status, tool and file, then starts the daemon if needed. Fast, and never fails the hook. |
| `session.js` | Atomic session-file writes and daemon start-up |
| `daemon.js` | Connects to Discord, picks the busiest session, renders frames, exits when nothing is left |
| `stats.js` | Reads transcripts for token, prompt, active-time, line and language stats |
| `cli.js` | pause / resume / status |
| `setup.js` | Installs or removes the hooks |

Everything it writes stays in `.state/` inside this folder (sessions, stats cache, log). It's git-ignored.

## Troubleshooting

| problem | fix |
| --- | --- |
| Nothing shows on Discord | Use the Discord **desktop** app, turn on Activity Privacy → share activity, and restart Discord if it was closed. Check `.state/daemon.log`. |
| `status` says "not running" | The daemon only runs while a session is active; send a prompt first. Run `node daemon.js` by hand to see errors. |
| Hooks don't fire | Restart Claude Code after setup and check `/hooks`. Make sure `node` works in a new terminal. |
| Stats are empty | They fill in once a session has a transcript; the weekly totals are rescanned every 5 minutes. |
| Wrong project name | Add it to `projects` in `config.json`. |
| Moved the folder | Run `node setup.js` again. |

## Uninstall

```bash
node setup.js --uninstall
```

Then delete the folder.

## License

MIT, see [LICENSE](LICENSE).
