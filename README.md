# Switchboard

Switchboard is a local interface for Codex and Claude Code. Choose chats to follow, see what an agent finished and the evidence behind its answer, then send your next decision to either provider. Each provider uses your own installed CLI and account.

## Download the pilot

[Open the pilot downloads](https://github.com/malhadeff28-gif/switchboard/releases/tag/v0.3.1-pilot.3). Choose the ZIP for your computer, extract it, and open the launcher listed below. The ZIP includes Node.

| Computer | Download name | Launcher |
|---|---|---|
| Apple silicon Mac, macOS 13.5 or later | [Notarized Switchboard.app ZIP](https://github.com/malhadeff28-gif/switchboard/releases/download/v0.3.1-pilot.3/Switchboard-0.3.1-pilot.3-notarized-arm64.zip) | Switchboard.app |
| Apple silicon Mac (portable) | Switchboard-darwin-arm64.zip | Start Switchboard.command |
| Intel Mac | Switchboard-darwin-x64.zip | Start Switchboard.command |
| Windows, Intel or AMD | Switchboard-win-x64.zip | Start Switchboard.cmd |
| Windows on ARM | Switchboard-win-arm64.zip | Start Switchboard.cmd |
| Linux, Intel or AMD | Switchboard-linux-x64.zip | Start Switchboard.sh |
| Linux on ARM64 | Switchboard-linux-arm64.zip | Start Switchboard.sh |

Keep the launch window open when using a portable package. You can start the Mac portable package from Terminal by typing `sh` followed by a space, dragging **Start Switchboard.command** from the extracted folder into Terminal, and pressing Return. On Linux you can run `sh "Start Switchboard.sh"` from the extracted folder. Switchboard listens at [127.0.0.1:4317](http://127.0.0.1:4317). The portable ZIPs are unsigned. The release notes identify the platforms and provider flows tested.

## First run

1. Open **Connections**. If your provider is already connected, choose your chats. On Mac, if you see **Open ChatGPT**, **Open Codex**, or **Open Claude**, sign in there, then return to Switchboard and click **OK**. Switchboard checks whether the local coding CLI can use that sign-in. If Switchboard offers a separate sign-in button, follow it and return to click **OK**. If the CLI is missing, install [Codex CLI](https://developers.openai.com/codex/cli) or [Claude Code](https://code.claude.com/docs/en/setup).
2. Select **Choose chats**. Pick a conversation from your local Codex or Claude Code history, or use **Follow several chats** to add them together. Switchboard shows each chat’s latest result while it prepares the handoff.
3. Open a result. Read **What happened**, expand a numbered source, then compare the options and their tradeoffs. Click an option to put it in your draft or type your own answer. Select the provider and press **Send**. **Send & move on** advances to the next ready project. The result menu lets you revisit earlier turns.
4. **Pause** on a watched project stops automatic handoff analysis. You can also try simulated projects without connecting an account.

## What follows you between providers

A watched chat remains open in its original application. Your first Switchboard reply starts a separate session in that project folder. Later replies resume the corresponding Switchboard session for that provider. The receiving provider gets the handoff you answered, its ordered options and evidence, relevant prior instructions, saved project decisions, and a bounded conversation excerpt. A project starts with read-only file access. **File edits** enables workspace writes through the selected provider. Claude shell commands are unavailable in managed project turns.

Use one editor at a time for a project folder. Switchboard checks overlapping followed and paused originals before starting a reply with file edits and warns if it detects new activity while the reply runs. An independent chat can start writing before Switchboard sees it. Use **Read only** for replies while another agent edits.

The composer shows which provider and result your draft will answer. Browsing other results keeps that draft attached to its original result. Replying to an older result starts a fresh session if the selected provider has newer work in the project. In **Project memory**, use **Pin requirements** for instructions that should carry into every agent reply, and **Save a decision** for choices you’ve confirmed.

Selecting a chat enables automatic analysis on that provider’s account and may consume its usage allowance. A watched completion appears immediately. Switchboard asks Codex for a text-only sample or runs Claude Code with tools and session persistence disabled. It presents cited chat, command, and file records. A reported claim can have no independent verification. A failed analysis leaves the original output available with a retry button. A provider CLI without the required sampling or hook interface may need an update.

For Claude, following a chat installs Switchboard’s own Stop and StopFailure hooks alongside existing user hooks. Reload hook settings if Claude prompts. These hooks record completion only for selected sessions. Removing or pausing the last Claude watch removes Switchboard’s hook entries. Switchboard also reads lifecycle records to catch up after a restart. Only the latest completed turn is imported when you first follow a chat.

## Storage and other features

The portable launcher stores settings, chats and handoffs under the user data directory: **Library/Application Support/Switchboard** on Mac, **%LOCALAPPDATA%\\Switchboard** on Windows, and **$XDG_DATA_HOME/Switchboard** or **~/.local/share/Switchboard** on Linux. Keep this directory when replacing the download. Source checkouts continue to use **.local**. Draft prompts are kept in browser local storage. Sign-in stays with the CLI. There is no Switchboard cloud service.

Close older pilot launchers before switching builds. Current builds allow one server to write to a given workspace, even if the instances use different ports. If the server was killed, the next launch can reclaim the lock when its owner has exited.

The ideas shelf, manual usage snapshots, priorities, stop controls, and simulated demo remain available. The separate **Inside Codex** page is an experimental Mac feature for navigating existing native chats. The portable workspace works through the browser.

## Development and validation

The hosted interface at `https://switchboard.us.com/app/` runs against the companion on the same computer. It needs HTTPS, a browser that allows an explicitly approved loopback connection, and the local pilot on port 4317. In the local app choose **Options → Open on website**, create a one-use link, and approve the browser connection. Use **Disconnect website** to revoke the pairing or `SWITCHBOARD_WEB_ENABLED=0` to disable it at launch. Connect the Codex and Claude Code CLIs on the Mac. The website never handles provider login codes, and it communicates with the local service directly. Drafts are separate between the website and local browser origins. Build the static app directory with `node scripts/package-website.mjs <site checkout>/app`.

Requires Node 20 or later. Run `npm start` for a source checkout and `npm test` for regression tests. `npm run test:claude-local` exercises the installed Claude Code CLI against a local mock API. Live provider access requires a separate check. Environment overrides include `PORT`, `SWITCHBOARD_DATA_DIR`, `SWITCHBOARD_CODEX_BIN`, `SWITCHBOARD_CLAUDE_BIN`, and `SWITCHBOARD_EXCLUDE_SESSION`.

Build a portable download with `python3 scripts/package.py linux-x64 --cache build/cache --dest build/downloads`. The builder checks the pinned official Node archive checksum and includes its license. Run `python3 scripts/check-package.py build/downloads/Switchboard-linux-x64.zip` on the matching OS and CPU to test extraction, launch, send, handoff, and data location. Add `--browser` for a desktop trial.

To build the Apple silicon app on a Mac with Xcode Command Line Tools:

```sh
python3 scripts/package.py darwin-arm64 --cache build/cache --dest build/downloads
python3 scripts/package-mac.py build/downloads/Switchboard-darwin-arm64.zip --dest build/downloads
python3 scripts/check-package.py build/downloads/Switchboard-0.3.1-pilot.4-local-test-arm64.zip
```

For distribution, repeat the app build with `--identity` and the publisher’s Developer ID Application identity. Submit the signed ZIP using `xcrun notarytool submit --keychain-profile PROFILE --wait ZIP`. Once Apple accepts it, extract the app, run `xcrun stapler staple Switchboard.app`, and create the final ZIP with `ditto -c -k --sequesterRsrc --keepParent Switchboard.app FINAL.zip`. Verify the extracted final app with `spctl --assess --type execute -vv Switchboard.app` and run the package check against the final ZIP.
