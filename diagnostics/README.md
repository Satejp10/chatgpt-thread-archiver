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

Delete this directory once the question is answered.
