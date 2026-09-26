# Codex Status for Stream Deck

This plugin displays a numbered Codex task on a Stream Deck key. Its property
inspector deliberately has one option: **Task Number**. Task 1 is the most
recent shared Codex session, task 2 is the next most recent, and so on.

The key header is `<project>: <session>`. Session numbers are assigned in
creation order among each project's currently open shared-server sessions;
they reset to 1 after that project's sessions close. Task positions are
ordered by most recent activity. Project colours are generated deterministically,
so a given project keeps its colour.

## Runtime setup

The plugin starts a local Codex app-server at `ws://127.0.0.1:45999` and
connects to it. Start Codex sessions through that same server and explicitly
pass the project working directory:

```sh
codex --remote ws://127.0.0.1:45999 --cd "$PWD"
```

The explicit `--cd` matters because the app-server runs inside the Stream
Deck plugin directory; without it, Codex records that plugin directory as the
thread's working directory.

This shared-server connection is required for live status. The app-server
reports `WORK`, `WAIT`, and `DONE` reliably for threads it owns; it correctly
marks separately started CLI sessions as `notLoaded`, so the plugin excludes
them rather than showing an incorrect state. `WAIT` covers both approvals and
interactive user-input requests.

To use an app-server you manage yourself, launch it separately and set the
Stream Deck plugin process environment variable `CODEX_APP_SERVER_URL` to its
localhost WebSocket URL. This does not add a Stream Deck configuration option.

## Development

```sh
npm run build
streamdeck link com.falcon.falcon
streamdeck restart com.falcon.falcon
```

The generated plugin is in `com.falcon.falcon.sdPlugin`.
