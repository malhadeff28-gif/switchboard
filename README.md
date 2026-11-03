# Switchboard

A local companion for Codex and Claude: prompt a project, move immediately to the next chat that needs your attention, and keep the project's context in one place.

## Run

On macOS, double-click **Launch Switchboard.command**. It opens http://127.0.0.1:4317 and uses the Node runtime bundled with Codex if Node is not on your PATH. Keep its Terminal window open while using the app. If Switchboard is already running, the launcher opens the existing workspace.

With Node.js 20 or later:

```sh
npm start
```

No npm dependencies or installation are required. You need Codex CLI and/or Claude Code installed to use live agents. Connections detects your existing sign-ins. Its sign-in buttons start the provider's own browser authentication flow; Switchboard does not collect passwords or copy auth tokens.

## Use on another computer

Clone the repository:

```sh
git clone https://github.com/malhadeff28-gif/switchboard.git
cd switchboard
npm start
```

Install Node.js 20 or later before running these commands. Open http://127.0.0.1:4317 after the server starts. Install and sign in to Codex CLI and/or Claude Code on that computer to use live agents. Existing-chat auto-switch also requires the Codex desktop app on macOS; configure its queue at http://127.0.0.1:4317/desktop.

GitHub stores the app's source code. Chat history, ideas, queue settings, browser drafts, and provider sign-ins stay on each computer and are not synced by this repository. Running Switchboard from a phone or tablet would require a separate hosted or remote-access implementation; this version runs locally on a computer.

## What works

- One chat interface with a Codex/Claude picker for every project.
- Sending returns immediately, while the agent works in a background process. With **Send & move on** enabled, the next ready chat is selected. A completion adds a chat to the queue without pulling you away from whatever you are reading or typing.
- Handoffs include a short summary, the next action, and saved decisions. Each provider keeps its own session for the project; switching carries recent conversation context and decisions to the other provider.
- Recent local Codex and Claude conversations can be discovered and imported. Imports include bounded history excerpts and their original project folder. The first prompt starts a new managed conversation, rather than resuming an original desktop chat that could still be running.
- Projects can be prioritized, marked caught up, stopped, and continued. Up to three managed chats can work at once.
- An ideas shelf lets you capture ideas and turn them into a project. Draft prompts, decisions, conversation history, project goals, and ideas persist locally.
- A clearly labeled demo uses simulated replies and no provider calls.
- Responsive layout, keyboard shortcuts, reduced-motion support, and separate mobile navigation.
- **Inside Codex**: an existing-chat queue at http://127.0.0.1:4317/desktop. With auto-switch enabled, type in the original Codex app. A local listener detects a composer-started turn and opens the next available original chat through `codex://threads/<id>`. This mode does not submit prompts, resume sessions through the companion, or create copied chats. You can reorder the queue, pause switching, and restrict triggering to selected chats. When all queued chats are working, choose a new brainstorming composer in Codex, the companion's saved-ideas workspace, or staying in the current chat. The brainstorming composer contains an unsubmitted starter prompt; a new chat is created only if you send it.

**Keyboard:** Command/Ctrl+Enter sends a prompt; Alt+N advances to the next ready chat.

## Current boundaries

The companion chat interface uses installed, authenticated CLIs. The new **Inside Codex** mode operates on original Codex desktop chats on macOS, using a local background listener and native app links. The listener must stay running; launch the app again after stopping it. Queue settings and enabled state persist across restarts. This is an external integration, not a patch to the vendor application or an embedded composer extension.

Existing-chat switching currently supports **Codex on macOS**. Claude remains supported in the companion interface, but automatic switching of existing Claude desktop chats is not yet connected.

The Codex listener watches appended local session events. It reacts to root turns attributed to `composer`; scheduled automations, agent messages, subagents, and CLI executions do not trigger navigation. It opens a chat when its new turn starts, so a message queued behind an already-running turn may not switch immediately when first submitted. The transcript format is an installed-version integration and may change with Codex updates. Initial ready/working status comes from recent history; subsequent start/completion events update it while the listener is active. Remote/cloud-only chats without a local transcript are not covered.

Companion context import is still an excerpt; it does not reproduce every artifact, attachment, tool result, or connector available in the original chat. Existing-app switching avoids those import limits by opening the original conversation.

Codex defaults to a read-only sandbox; **File edits** selects workspace-write. Claude defaults to Read/Glob/Grep; **File edits** adds Edit/Write. Claude shell commands are not enabled in this version. Neither adapter bypasses provider permissions. Denied tools and unsuccessful turns are shown in the project, rather than reported as completed work. Changes made before a stop remain in the project folder.

The existing sign-ins and live chat flow were checked on the development Mac. Sign-in launchers are implemented from the installed CLI interfaces, but a fresh logout/login cycle was not tested. Submitting a prompt uses the selected provider's account and applicable usage allowance. No project prompt runs merely because it was discovered or imported.

## Implementation

`server.mjs` serves the UI on loopback, supervises CLI processes, handles authentication status and launch flows, and saves workspace state atomically. `lib/core.mjs` holds the attention scheduler, handoff parsing, context transfer, CLI arguments, and event normalization. `lib/discovery.mjs` reads bounded excerpts from local session histories. `public/` is the buildless interface. Live updates use Server-Sent Events.

`lib/desktop.mjs` follows local Codex logs from their current end, normalizes composer and completion events, selects a ready original chat, and dispatches the installed app's native URL. It does not replay old prompts on startup. The handoff log records IDs, target titles, and timing, not prompt text. The installed Codex app's registered URL scheme and existing-chat URL parser were checked locally before using this path; vendor app files were not modified.

The agent adapters use the documented [Codex non-interactive CLI](https://developers.openai.com/codex/noninteractive) and [Claude Code programmatic CLI](https://code.claude.com/docs/en/headless). Arguments were checked against the CLIs installed on this Mac.

Runtime records are in `.local/workspace.json`; draft text is in browser localStorage. Authentication instructions are held in memory during sign-in and are not written to the workspace. `.local/` is excluded from source sharing. The server binds only to 127.0.0.1, validates Host and Origin, and requires a per-run token on mutations. No cloud server is involved; prompts and supplied context still go to the selected AI provider when you press Send.

Supported environment overrides: `PORT`, `SWITCHBOARD_DATA_DIR`, `SWITCHBOARD_CODEX_BIN`, `SWITCHBOARD_CLAUDE_BIN`, `SWITCHBOARD_EXCLUDE_SESSION`, and launcher-only `SWITCHBOARD_NODE`.

## Validation

```sh
npm test
```

Tests cover attention ordering, working-chat exclusion, malformed handoffs, cross-provider context, managed-session resume, error reporting, immediate send acceptance, duplicate-request protection, stop behavior, persisted state after restart, and rejected cross-origin mutations.

Nine tests passed, including bounded transcript discovery, filtering of composer versus automation events, constrained native URLs, busy-chat exclusion, ignoring historical prompt events, fragmented event records, completion updates, and pause behavior. Browser checks verified the existing-chat control panel and enabling the listener. The native open endpoint returned successful dispatch for an existing chat. A new prompt through the original Codex composer remains the live end-to-end acceptance check; a successful URL dispatch alone does not prove the visible destination or submission-triggered handoff.

Earlier companion browser checks verified send-and-advance, draft preservation, saved decisions after switching providers, and access to project memory at a 390px mobile breakpoint. The browser reported no errors or warnings during those checks.

Live smoke checks on this Mac completed a Codex turn, switched to Claude with the same remembered word, and resumed the Codex conversation successfully. These small probes verify response transport, context handoff, and resume; they do not establish reliability for long builds or arbitrary existing desktop sessions.

## Next build

The next milestone is the Claude existing-session navigation path and a packaged menu-bar listener. A structured Codex app-server / Claude Agent SDK bridge can replace transcript observation where the installed app exposes a shared runtime. Then add inline permission requests for companion runs, configurable attention ranking, and better context compression for long conversations.
