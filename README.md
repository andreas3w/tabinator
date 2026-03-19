# Tabinator (Chrome Extension)

Limits unpinned tabs per window and prompts before opening more.

## Features

- Configurable unpinned-tab limit (`X`) via extension popup.
- Auto-close list supports domain patterns like `github.com`, wildcard domains like `*.awsapps.com`, and exact host+port entries like `127.0.0.1:8020`.
- Auto-pin list can pin matching tabs automatically on open.
- The first 5 auto-pin patterns are treated as fixed quick slots (`Ctrl+1` to `Ctrl+5`) and are kept in order.
- `Open all (Ctrl+1-5)` button opens or reuses those quick-slot tabs in one click.
- Optional `Only one` mode for auto-pin keeps a single tab per hostname and prompts `Keep old` / `Keep new` on conflicts.
- When limit is hit and a new unpinned tab is requested:
  - tab request is queued,
  - extension prompt opens near the toolbar icon (corner-style popup),
  - you can choose:
    - `Close oldest` (quick action)
    - `X` next to any listed tab (close specific tab)
    - `Don't open` (discard one queued tab request)
- Multiple blocked opens are queued FIFO.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder: `/home/ab000195/plugin`.

## Configure

1. Click the extension icon.
2. Set `Unpinned tab limit`.
3. Save.

## Notes

- Limit is enforced per window.
- Pinned tabs are ignored.
- While queue is active, the extension icon opens the prompt; when queue clears, icon goes back to settings popup.
- If browser blocks programmatic popup opening, the extension falls back to a separate popup window.
- Due to Chrome extension API timing, blocked tabs may appear briefly before being closed and queued.
