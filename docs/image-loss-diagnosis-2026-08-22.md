# Image-loss diagnosis from user export

The attached export is `chatgpt-thread-archiver 0.4.0`, exported at `2026-08-22T01:28:30.945Z`. Its header reports `Images: 1 embedded, 3 unavailable`.

The three unavailable markers all use the same reason: `[image unavailable: asset metadata did not contain a same-origin estuary download URL]`. The one successful item is rendered as a large `data:image/png;base64,...` image inside a tool message. The HTML CSP allows only `data:` image sources, so the renderer itself is not silently dropping the three failed images; the resolver marked them unavailable before rendering.

The export title and source URL options are disabled in this sample. No asset pointers, signed URLs, bearer tokens, or cookies are present in the generated HTML. The observed failure is therefore concentrated in metadata response parsing or same-origin signed-URL validation, not offline HTML rendering.
