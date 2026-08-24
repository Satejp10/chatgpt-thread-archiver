# ChatGPT Thread Archiver

ChatGPT Thread Archiver is a browser userscript that exports the **currently open ChatGPT or Claude.ai conversation** as a standalone HTML file you can keep and open offline.

It runs locally in your browser, uses your existing signed-in session, and does not upload your conversation to a third-party service.

## Install

### Quick install with Tampermonkey

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser and accept the browser's extension prompt.
2. Open [`dist/chatgpt-chats-exporter.user.js`](https://github.com/Satejp10/chatgpt-thread-archiver/blob/main/dist/chatgpt-chats-exporter.user.js) on GitHub, click **Raw**, and then click **Install** in Tampermonkey.
3. Open or refresh a signed-in ChatGPT or Claude.ai conversation. The floating **Export HTML** button should appear.

If you already have an older version installed, remove the old userscript entry from Tampermonkey before installing this one.

## Use it

Open a conversation, click **Export HTML**, choose the available privacy and image options, and save the generated HTML file. The export includes formatted messages, prompt navigation, copy buttons, and safe local statistics. ChatGPT images are included on a best-effort basis, and basic Claude.ai text export is supported.

## Privacy

The script does not ask for your password, persist conversation content, or call third-party services. Requests go only to the provider's own web application through your existing browser session.

## Current limitations

The script exports only the conversation currently open in the browser; bulk or all-chat export is not supported. Provider web-app interfaces may change, and unsupported files or rich-content blocks may appear as omission markers instead of being fully rendered.

## Development

The project requires **Node.js 20 or newer** and has no third-party dependencies. From the project directory:

```bash
npm run build
npm run check
node --check dist/chatgpt-chats-exporter.user.js
```

For maintainer details, see the [developer handoff](docs/developer-handoff.md), [build history](docs/build-history.md), and [user testing checklist](docs/user-test-checklist.md).
