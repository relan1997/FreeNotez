# FreeNotez — Chrome Extension Setup

## Loading the extension in Brave

1. Open Brave and go to `brave://extensions`
2. Toggle **Developer mode** ON (top-right corner)
3. Click **Load unpacked**
4. Navigate to and select the `extension/` folder inside this project
5. The extension is now installed — you'll see "FreeNotez" in your extensions list

## Testing it

1. Join any Google Meet call (or open any `https://meet.google.com/...` URL)
2. A red **📝 FreeNotez** button appears at the bottom-right of the page
3. Click it — you should see an alert popup

## Updating after code changes

Whenever you edit files in `extension/`:
1. Go back to `brave://extensions`
2. Click the **reload** icon (↻) on the FreeNotez card
3. Refresh the Meet tab

## Troubleshooting

- **Button not showing up?** Make sure the URL starts with `https://meet.google.com/`. The content script only injects on Meet pages.
- **Extension not listed?** Confirm you selected the `extension/` folder (the one containing `manifest.json`), not the parent `FreeNotez/` folder.
- **Changes not reflecting?** You must reload the extension AND refresh the Meet tab after every code change.
