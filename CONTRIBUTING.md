# Contributing to CodeAtlas

Thanks for contributing.

## Development

1. Install the Tauri 2 prerequisites for your OS.
2. Install Rust and `tauri-cli` v2.
3. Run `cargo tauri dev` from the repository root.

The frontend is intentionally dependency-free: edit `src/index.html`, `src/styles.css` and `src/app.js` directly.

The repository scanner lives in `src-tauri/src/lib.rs`.

## Pull requests

Keep changes focused and explain:

- What changed.
- Why it is useful.
- Which operating system(s) you tested.
- Any known limitations.

Please avoid adding telemetry or cloud upload behavior without a very clear reason and explicit opt-in.
