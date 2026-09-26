import streamDeck from "@elgato/streamdeck";

import { CodexStatus } from "./actions/codex-status";

// We can enable "trace" logging so that all messages between the Stream Deck, and the plugin are recorded. When storing sensitive information
streamDeck.logger.setLevel("trace");

streamDeck.actions.registerAction(new CodexStatus());

// Finally, connect to the Stream Deck.
streamDeck.connect();
