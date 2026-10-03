# Skylar voice guide

The bottom-right microphone opens an opt-in assistant. Cartesia Ink 2 transcribes microphone audio with turn detection; Sonic 3.6 speaks using Skylar. The existing provider-neutral fast model handles dialogue and observed UI tools. The agent is mounted in the persistent application shell and survives in-app navigation.

## Activation

Set CARTESIA_API_KEY in server environment variables, or sign in as the workspace owner and paste the key into the microphone panel's Connect Cartesia field. The latter validates the key and encrypts it with AES-256-GCM in a separate private_voice Postgres schema using a key derived from AUTH_JWT_SECRET. The master key is never returned by the API. Browsers receive scoped STT/TTS access tokens and a separate user/tenant-bound signed application ticket, each lasting 900 seconds. Rotating AUTH_JWT_SECRET requires reconnecting the encrypted provider key.

## Interaction

Speech interrupts queued audio and cancels pending reasoning. A throttled background planner prefetches likely navigation destinations from partial speech; it never commits actions from unfinished speech. Final utterances can navigate, click observed controls, fill ordinary inputs, scroll, and refresh screen context. Up to six sequential observation/action rounds are allowed per turn; repeated identical or failed actions stop the batch. Navigation is same-origin and limited to app pages. API URLs, credentials, external links and downloads cannot be operated by voice. Unknown or consequential buttons and edits to autosaving rich-text documents require a spoken or clicked confirmation.

Screen vision is off by default. When enabled, screenshots are generated on demand from this app's viewport, with marked private fields and the voice UI excluded, and passed to the configured vision-capable model. Cross-origin images or embedded viewers may be absent from DOM-rendered screenshots. This is not desktop capture.

The feature stores neither raw microphone recordings nor screenshots. Conversation text lives in this browser tab for the current session; a reload or closing the tab ends the call. Canonical dialogue is bounded to 70 messages, keeping the opening context plus recent turns. Provider retention and processing terms still apply; the UI discloses which data is transmitted.

## Legal assistance

Skylar provides general information and app guidance, not a representation that she is human or a lawyer. Current-law research and precise citations should use the existing Research page. She can navigate there and populate a question, then discuss visible source-linked results. Screen text and documents are explicitly treated as untrusted data rather than instructions.

## Verification

Unit tests cover safe navigation, confirmation labels, credential redaction, ticket expiry and user/tenant binding. Browser tests use a fake microphone and mocked Cartesia/LLM responses to exercise the actual UI and control flow without spending provider credits. A live Cartesia audio test is still needed after connecting the operator's key.
