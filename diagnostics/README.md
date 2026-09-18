# Diagnostics

Temporary, throwaway tools. **Not part of the shipping exporter.** `build.mjs` does
not read this directory, and `test.mjs` does not cover it.

## `image-metadata-probe.user.js`

Answers one question: **does ChatGPT store a per-image model identifier at all?**

The v0.11.0 image-model label always fell back to `unknown / not found` in live
testing. That result cannot distinguish "the provider does not expose a model name"
from "it does, and our extraction misses it". This probe settles it.

### Privacy boundary

The probe reads the same signed-in conversation record the exporter already reads.
It prints **field names and value types only**. A literal string value is printed
only when both hold:

1. the field name matches `/model|engine|generator|version/i`, and
2. the value passes the exporter's safe-identifier test, `/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,120}$/`.

Every other string is reduced to `string(len=N)`. The probe never outputs prompts,
message text, captions, image bytes, asset URLs, conversation IDs, tokens, cookies,
or headers. There is no telemetry and no third-party request.

### Use

1. Install alongside the exporter in Tampermonkey.
2. Open a ChatGPT conversation that contains a generated image.
3. Click **Image metadata probe** (bottom right).
4. Copy the panel contents.

Works on existing conversations — it reads stored history, not live generation.
If an old conversation shows nothing model-related, repeat on a freshly generated
image to rule out the field only being written recently.

### What the output means

- A model-related key with a printed value → the identifier exists; wire it into
  `IMAGE_MODEL_KEYS` in `src/core.mjs`.
- No model-related key on any image part → the provider does not expose one.
  `unknown / not found` is the correct permanent behaviour, and the feature should
  be simplified or cut.

The `PART TYPE CENSUS` section also shows which message shapes produce the blank
`[non-text content omitted]` rows seen in live testing.

### Afterwards

Delete this file once the question is answered.

## `claude-attachment-probe.user.js`

Answers one question: **what does Claude's conversation payload carry for an uploaded
image, and can the bytes be fetched with the signed-in session?**

The exporter embeds images on ChatGPT but not on Claude — Claude image support was
never built, and Claude has no image generation, so uploads are the whole of what
support would mean there. Claude's conversation API is undocumented and there is no
public reference for it, so the field carrying a fetchable image URL is unknown.
Building against a guess is not acceptable; this probe reports the real shape.

### Privacy boundary

The probe reads the same signed-in conversation record the exporter already reads. It
prints **field names, value types, and redacted route shapes**. Specifically:

- A URL-shaped value becomes a route shape: `(same-origin) /api/organizations/<id:36>/files/<id:36>/preview`.
  Every path segment longer than 24 characters, hex-and-dash, or otherwise
  identifier-shaped is replaced by its length. Query **values are always dropped**;
  only short, identifier-shaped parameter names survive.
- A literal string is printed only when it is a short plain token (a MIME type, a
  `file_kind`, an extension). Everything else becomes `string(len=N)`.
- A name-ish key (`file_name`, `title`, `caption`, `label`) is reported by length only,
  and a uuid- or hex-shaped value becomes `<id:N>`. Both pass the plain-token test on
  their own — a file name such as `a.png` and a `file_uuid` were printed in full before
  this rule, which is the user's content and a private identifier respectively.
- One request is made per distinct URL to report a status category, content type, and
  size — the response body is never read.

The probe never outputs prompts, message text, file names, image bytes, full or signed
URLs, query-string values, conversation IDs, organization IDs, tokens, cookies, or
headers. There is no telemetry and no third-party request.

### Use — console version (preferred)

`claude-attachment-probe-console.js` is the same probe with the same privacy boundary
and no install step. Open a Claude conversation with an uploaded image, open the browser
console, paste the whole file, press Enter. The report prints and is copied to the
clipboard. Chrome may require typing `allow pasting` in the console once first.

It is the preferred route because it has no install surface to get wrong: the
userscript's button depends on Tampermonkey matching, injecting, and surviving a React
re-render, and each of those is a way for it to silently not appear. The console version
also takes the last id-shaped path segment rather than requiring `/chat/<id>` exactly.

### Use — userscript version

1. Install alongside the exporter in Tampermonkey.
2. Open a Claude conversation containing an **uploaded image** (a photo or screenshot
   attached to a prompt — not a PDF or text file, though including one of those in the
   same conversation is useful for comparison).
3. Click **Claude attachment probe** (bottom right).
4. Copy the panel contents.

The button sits just above the exporter's own **Export HTML** control, bottom right.
Like the exporter, the probe reinstalls itself on DOM mutation and matches all of
`claude.ai`, checking the route itself: claude.ai is a single-page app, so a
client-side navigation never re-runs a userscript and a React re-render can drop a
node appended to `body`. A probe that installs once simply never appears.

### What the output means

- A URL-shaped field reachable same-origin with an `image/*` content type → embedding
  works the same way as the ChatGPT path; wire that field into the Claude client.
- Only id-shaped keys and no URL → the bytes live behind a separate file-download
  endpoint, and that endpoint has to be found before support can be built.
- `auth-rejected` or a cross-origin host → the session cannot reach the bytes from the
  page, which changes what is feasible.

### Afterwards

Delete this directory once both questions are answered.
