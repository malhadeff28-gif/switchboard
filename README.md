# Switchboard

Switchboard is a local interface for Codex and Claude Code. Choose chats to follow, see what an agent finished and the evidence behind its answer, then send your next decision to either provider. Each provider uses your own installed CLI and account.

## Download the pilot

[Open the pilot downloads](https://github.com/malhadeff28-gif/switchboard/releases/tag/v0.3.0-pilot.1). Choose the ZIP for your operating system and CPU. Extract the entire folder, then open its launcher. The ZIP includes Node. Keep the launch window open while using the browser workspace.

| Computer | Download name | Launcher |
|---|---|---|
| Apple silicon Mac | Switchboard-darwin-arm64.zip | Start Switchboard.command |
| Intel Mac | Switchboard-darwin-x64.zip | Start Switchboard.command |
| Windows, Intel or AMD | Switchboard-win-x64.zip | Start Switchboard.cmd |
| Windows on ARM | Switchboard-win-arm64.zip | Start Switchboard.cmd |
| Linux, Intel or AMD | Switchboard-linux-x64.zip | Start Switchboard.sh |
| Linux on ARM64 | Switchboard-linux-arm64.zip | Start Switchboard.sh |

On Mac, if Finder does not open the unsigned launcher, open Terminal, type `sh` followed by a space, drag **Start Switchboard.command** from the extracted folder into Terminal, and press Return. This launches the bundled runtime. On Linux you can run `sh "Start Switchboard.sh"` from the extracted folder. Switchboard listens at [127.0.0.1:4317](http://127.0.0.1:4317). The pilot ZIPs are unsigned. Managed computers may block scripts or downloads. The release notes identify the platforms and provider flows tested.

## First run

1. Open **Connections**. Install [Codex CLI](https://developers.openai.com/codex/cli) or [Claude Code](https://code.claude.com/docs/en/setup) using the provider’s instructions. Click **Refresh connections** and sign in with either provider. The panel distinguishes a local sign-in from the time the provider last returned a successful response.
2. Select **Choose chats**. Pick a conversation from your local Codex or Claude Code history. Repeat to add another. Switchboard reads the selected project’s transcript and shows its latest result while it prepares the handoff.
3. Open a result. Read **What happened**, expand a numbered source, then compare the options and their tradeoffs. Click an option to put it in your draft or type your own answer. Select the provider and press **Send**. **Send & move on** advances to the next ready project. The result menu lets you revisit earlier turns.
4. **Pause** on a watched project stops automatic handoff analysis. You can also try simulated projects without connecting an account.

## What follows you between providers

A watched chat remains open in its original application. Your first Switchboard reply starts a separate session in that project folder. Later replies resume the corresponding Switchboard session for that provider. The receiving provider gets the handoff you answered, its ordered options and evidence, relevant prior instructions, saved project decisions, and a bounded conversation excerpt. A project starts with read-only file access. **File edits** enables workspace writes through the selected provider. Claude shell commands are unavailable in managed project turns.

Selecting a chat enables automatic analysis on that provider’s account and may consume its usage allowance. A watched completion appears immediately. Switchboard asks Codex for a text-only sample or runs Claude Code with tools and session persistence disabled. It presents cited chat, command, and file records. A reported claim can have no independent verification. A failed analysis leaves the original output available with a retry button. A provider CLI without the required sampling or hook interface may need an update.

For Claude, following a chat installs Switchboard’s own Stop and StopFailure hooks alongside existing user hooks. Reload hook settings if Claude prompts. These hooks record completion only for selected sessions. Removing or pausing the last Claude watch removes Switchboard’s hook entries. Switchboard also reads lifecycle records to catch up after a restart. Only the latest completed turn is imported when you first follow a chat.

## Storage and other features

The portable launcher stores settings, chats and handoffs under the user data directory: **Library/Application Support/Switchboard** on Mac, **%LOCALAPPDATA%\\Switchboard** on Windows, and **$XDG_DATA_HOME/Switchboard** or **~/.local/share/Switchboard** on Linux. Keep this directory when replacing the download. Source checkouts continue to use **.local**. Draft prompts are kept in browser local storage. Sign-in stays with the CLI. There is no Switchboard cloud service.

The ideas shelf, manual usage snapshots, priorities, stop controls, and simulated demo remain available. The separate **Inside Codex** page is an experimental Mac feature for navigating existing native chats. The portable workspace works through the browser.

## Development and validation

Requires Node 20 or later. Run `npm start` for a source checkout and `npm test` for regression tests. `npm run test:claude-local` exercises the installed Claude Code CLI against a local mock API. Live provider access requires a separate check. Environment overrides include `PORT`, `SWITCHBOARD_DATA_DIR`, `SWITCHBOARD_CODEX_BIN`, `SWITCHBOARD_CLAUDE_BIN`, and `SWITCHBOARD_EXCLUDE_SESSION`.

Build a portable download with `python3 scripts/package.py linux-x64 --cache build/cache --dest build/downloads`. The builder checks the pinned official Node archive checksum and includes its license. Run `python3 scripts/check-package.py build/downloads/Switchboard-linux-x64.zip` on the matching OS and CPU to test extraction, launch, send, handoff, and data location. Add `--browser` for a desktop trial.
