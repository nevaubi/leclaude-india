# Skylar managed voice

The compact mic/orb UI is unchanged. One Cartesia Managed Agent WebSocket owns audio, dialogue memory, turn detection, interruptions and tool calling for the entire call. The previous independent STT/TTS and per-turn HTTP model loop is no longer used by the widget.

## Configuration

CARTESIA_API_KEY remains server-side. CARTESIA_AGENT_ID optionally selects another compatible agent; otherwise the app uses its provisioned Pramana Skylar agent, recorded in src/modules/voice/managed-agent.ts along with its configuration. The hosted model is gpt-5.4-mini and the voice is Skylar. Basic voice conversation needs no separate OpenAI key. Optional screenshot analysis uses the app's existing configured vision runtime.

POST /api/voice/session authenticates the user, mints a 900-second agent-grant token, and issues a user/tenant-bound application ticket for the vision endpoint. No master key is returned to the browser.

## Protocol and tools

Connect once to /v1/agents/websocket/{agent_id}. Send session_create first, with pcm_24000 and as_available, then wait for session_ready. Stream 50 ms mono 24 kHz PCM16 frames in base64 JSON audio_input events. Output uses the same format. Browser agent tokens cannot set dynamic_variables, as verified against the live API; current page context is instead read through client tools.

Play audio_output on one persistent Web Audio context. audio_output_clear immediately discards queued playback. turn_started and turn_ended update the existing status and transcript. In-app navigation does not recreate the connection.

Execute client_tool_call events sequentially against observed controls. Return client_tool_result with the original tool_call_id, including errors and cancellations. Results are bounded to 4096 UTF-8 bytes. read_screen accepts query and offset to locate controls without discarding a long list. Navigation verifies the destination before reporting success.

Consequential actions retain spoken/clicked confirmation. Screen vision remains opt-in. The screenshot tool captures only the app viewport and obtains a short description through authenticated /api/voice/vision; raw images are not placed into Cartesia tool results. Marked private fields and the voice UI are excluded.

## Lifetime and retention

The client stops the call at 15 minutes and releases the microphone, socket, nodes and timers. Muting preserves the connection. Silent audio maintains transport while paused. Cartesia separately ends a call after 240 seconds of conversational inactivity; check-ins are configured at 15 seconds. A real disconnect ends the native call; no silent replacement call claims to preserve its history. A full browser reload ends the call.

Managed conversation history is held by Cartesia. Provider transcripts, recordings and retention follow the Cartesia account settings; this is not a zero-retention promise. The app does not save raw microphone audio or screenshots. Precise authorities and dates should use the app's cited Research and practice tools.

## Verification

Protocol/lifecycle tests cover the handshake, browser-token restrictions, PCM rate, repeated turns, interruptions, tool-result IDs, UTF-8 limits and 15-minute timer. A real Cartesia call using synthetic utterances verified follow-up memory and a navigation tool call under one call ID. Browser integration tests use the actual local session endpoint and simulated agent events to verify navigation, typing, spoken confirmation, vision, mute/resume and microphone release. The duration cap is clock-tested, not a 15-minute network soak.

References: https://docs.cartesia.ai/agents/configuration and https://docs.cartesia.ai/line/integrations/websocket-api
