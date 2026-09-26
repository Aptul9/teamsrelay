# Sending images from the app

Date: 2026-09-26. Receiving images: [architecture.md](../architecture.md#content).

**Goal:** an image pasted or attached in the compose box of the app reaches the Teams chat as an inline image, as if pasted in Teams, with the text of the box as caption.

## What Teams offers

Checked live on slot 2 of the local stack (Npo, behind Defender for Cloud Apps), in the self chat, on 2026-09-26.

| Way in | What happens |
|---|---|
| Paste in the compose box | The box (`[data-tid="ckeditor"]`, CKEditor 5) takes a `paste` event whose `clipboardData` holds an image file, a synthetic one included, and cancels it. The box then shows the image (`<inlineimage>`, `img[data-tid="image-with-loader"]`). Enter sends it: after 0.8 s the conversation has a new message of yours with the image (`itemtype` AMSImage, `blob:` source, `data-orig-src`), a temporary id and the status "Sending..."; after 2.3 s the final id and "Sent" (PNG of 3 KB). |
| Attach files (`sendMessageCommands-FilePicker`) | The file is uploaded to OneDrive or SharePoint and the message carries a file card, not an inline image. The page has no file input until the picker is opened. |

The paste is used: it gives the message a person gets by pasting, needs no OneDrive, and the agent builds the file inside the page from the bytes, so no file path has to exist in the browser container.

## Flow

1. The app sends `POST /api/sendimage?a=N`, multipart: `name` (chat), `file` (image), `text` (caption, optional).
2. The web app checks the session user owns slot N (404 otherwise) and the account is not stopped (409), the size (up to 10 MB, 413 above) and the type from the first bytes of the file: PNG, JPEG, GIF or WebP (415 otherwise). The declared type and name are not trusted.
3. It writes the file to `data/N/uploads/<16 hex>.<ext>` and queues the command `sendimage`: `arg1` the chat, `arg2` `{"file": "<name>", "text": "<caption>"}`. Uploads older than a day are deleted at the next upload of the slot.
4. The agent of slot N reads the file (a name that does not match the upload pattern is refused), opens the chat and refuses when Teams shows another one, refuses a compose box that already holds a draft (it would go out with the image), pastes the image, types the caption, presses Enter.
5. It waits up to 30 s for a new message of yours with an image that Teams no longer shows as "Sending", saves the conversation, deletes the upload: `done`, otherwise `failed` and the compose box is emptied of the pasted image.

## Contract

- Command type `sendimage` added to `COMMAND_TYPES` in `app/src/shared/slot-db/commands.ts`; the existing names do not change. Arguments `ImageArgs` `{file, text}`.
- Accepted types and their extensions: `IMAGE_TYPES` in the same module, used by the web app and the agent.

## App

- Compose box: an attach button (images only) and the paste of an image. The image shows above the box with a remove button; the text of the box goes with it as caption; Enter or the send button sends. Type and size are checked in the browser too.

## Tests

- Web app: type from content, size, file written, command queued, 400, 404, 409, 413, 415.
- Agent: the handler reads the upload, hands name, type and bytes to the Teams action, deletes the file, refuses a name outside the pattern.
- Page scripts in Chrome: the paste delivers a file of the right name, type and size to the compose box; the sent-image check on the fixture captured from Teams, before and after "Sending".
- Live, self chats of both slots: PNG and JPEG, with and without caption, each read back in the app.

## Out of scope

One image per message (Teams takes more), no drag and drop, no other files. iOS Safari hands HEIC photos over as JPEG when the file input does not accept HEIC.
