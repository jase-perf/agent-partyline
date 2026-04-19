# Vendored Libraries

Third-party JS libraries bundled with the dashboard so we have no runtime npm install step.

## marked

- File: `marked.min.js`
- Version: 15.x (see file header for exact)
- License: MIT
- Source: https://github.com/markedjs/marked
- Purpose: Parse markdown text from session transcripts into HTML.

## DOMPurify

- File: `purify.min.js`
- Version: 3.x
- License: Apache-2.0 OR MPL-2.0 (dual)
- Source: https://github.com/cure53/DOMPurify
- Purpose: Sanitize rendered HTML before insertion into the DOM. Runs on every marked output.

## Upgrading

Re-fetch via `curl` from jsDelivr with the major version pinned in the URL. Bump this README with the new version strings.
