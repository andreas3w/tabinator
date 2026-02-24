# Tabinator (Chrome Extension)

Limits unpinned tabs per window and prompts before opening more.

## Features

- Configurable unpinned-tab limit (`X`) via extension popup.
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
