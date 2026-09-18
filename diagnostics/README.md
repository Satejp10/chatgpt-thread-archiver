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
- One request is made per distinct URL to report a status category, content type, and
  size — the response body is never read.

The probe never outputs prompts, message text, file names, image bytes, full or signed
URLs, query-string values, conversation IDs, organization IDs, tokens, cookies, or
headers. There is no telemetry and no third-party request.

### Use

1. Install alongside the exporter in Tampermonkey.
2. Open a Claude conversation containing an **uploaded image** (a photo or screenshot
   attached to a prompt — not a PDF or text file, though including one of those in the
   same conversation is useful for comparison).
3. Click **Claude attachment probe** (bottom right).
4. Copy the panel contents.

### What the output means

- A URL-shaped field reachable same-origin with an `image/*` content type → embedding
  works the same way as the ChatGPT path; wire that field into the Claude client.
- Only id-shaped keys and no URL → the bytes live behind a separate file-download
  endpoint, and that endpoint has to be found before support can be built.
- `auth-rejected` or a cross-origin host → the session cannot reach the bytes from the
  page, which changes what is feasible.

### Afterwards

Delete this directory once both questions are answered.
