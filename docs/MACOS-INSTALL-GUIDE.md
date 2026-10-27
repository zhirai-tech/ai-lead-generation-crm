# macOS Installation Guide

**Product:** ZHIRAI AI Lead Generation & Outreach CRM  
**Version:** 1.1.0-1025  
**Package:** `ZHIRAI-1.1.0-1025-macOS-arm64.tar.gz`

## Important: this is not a DMG or ISO

The macOS package is a **`.tar.gz` compressed archive**, not a disk image and not an installer. You do not need Terminal and you do not need to "mount" anything. Double-clicking it in Finder extracts a folder.

## Requirements

- Apple Silicon Mac: M1 / M2 / M3 / M4
- macOS 13 or newer
- Intel Macs are **not supported**
- No Node.js installation is required

## Steps

1. Download `ZHIRAI-1.1.0-1025-macOS-arm64.tar.gz`.
2. In Finder, double-click the file. macOS Archive Utility extracts a folder named `ZHIRAI-1.1.0-1025-macOS-arm64`.
3. Open the extracted folder.
4. Double-click `ZHIRAI-Base.app`. Finder may show the display name **ZHIRAI AI Lead Generation CRM**.
5. If macOS says the app cannot be opened because the developer cannot be verified:
   - Right-click `ZHIRAI-Base.app` and choose **Open**;
   - Click **Open** again in the dialog;
   - If it still fails: Apple menu → System Settings → Privacy & Security → **Open Anyway**.
6. Wait a few seconds. The app starts its local service and opens the browser.
7. If the browser does not open automatically, open Safari or Chrome and visit:

   `http://127.0.0.1:4173`

8. On first launch, create the administrator account on the setup page.

You can optionally drag `ZHIRAI-Base.app` into Applications, but this is not required. Do not drag the helper apps separately.

## Where your data is stored

```text
~/Library/Application Support/ai-lead-generation-crm/data
```

To open it:

1. Open Finder.
2. Press `Command + Shift + G`.
3. Paste the path above.
4. Press Return.

The folder contains the database, uploads and local secret key. Back it up before changing computers or reinstalling.

## Quit and backup

- Quit from the app menu: **ZHIRAI AI Lead Generation CRM → Quit** (or `Command + Q`).
- Do not copy or overwrite the database while the app is running.
- To back up: quit the app, then copy the whole `data` folder.
- To uninstall: quit the app and move `ZHIRAI-Base.app` to the Trash. The data folder is not deleted automatically.

## Common questions

**Is it signed?**  
No. The app is unsigned and not notarized. The warning is expected; use right-click → Open. Only download it from the official release source.

**Does it need Node.js?**  
No. The packaged macOS app includes its own runtime.

**Nothing opens?**  
Check that you are on Apple Silicon and macOS 13+. Close other apps using port 4173, then open the app again. If needed, open `http://127.0.0.1:4173` manually.

**Can I use it on an Intel Mac?**  
No. This build is arm64-only.

**Can I move it to Applications?**  
Yes, dragging the `.app` is optional. Keep the app intact; do not move only the helper apps.

## First-run safety

Sending is paused by default (`GLOBAL_SEND_PAUSED=1`). No real bulk email is sent until you configure email/compliance and explicitly enable sending.

## If macOS says “is damaged and can’t be opened”

This usually means the app is unsigned or its bundle signature became invalid after packaging. “Allow applications from Anywhere” does not fix an invalid signature.

Click **Cancel**; do not move it to the Trash.

Open Terminal and run:

```bash
cd ~/Downloads/ZHIRAI-1.1.0-1025-macOS-arm64
xattr -cr ZHIRAI-Base.app
codesign --force --deep --sign - ZHIRAI-Base.app
open ZHIRAI-Base.app
```

If the app is already in Applications:

```bash
cd /Applications
xattr -cr ZHIRAI-Base.app
codesign --force --deep --sign - ZHIRAI-Base.app
open ZHIRAI-Base.app
```

If macOS still says the developer cannot be verified, right-click the app → Open.
