/** Client-safe contracts for the Chat page (fast, general-purpose assistant on the OpenAI Responses API). */

/** Composer toggles. Search is on by default; the router also turns tools on when the message clearly needs them. */
export interface ChatToolFlags {
  search: boolean;
  code: boolean;
  image: boolean;
  browse: boolean;
}

export const DEFAULT_TOOL_FLAGS: ChatToolFlags = { search: true, code: false, image: false, browse: false };

/**
 * The composer's knowledge switch: which sources the assistant may consult. Web maps to the web-search tool (and
 * stays in sync with `tools.search`); law adds the Indian judgment/statute tools; library the firm library tools;
 * docSetIds the user's document sets (validated on the server against the sets the caller may read; fail closed).
 */
export interface ChatKnowledge {
  web: boolean;
  law: boolean;
  library: boolean;
  docSetIds: string[];
}

export const DEFAULT_KNOWLEDGE: ChatKnowledge = { web: true, law: true, library: false, docSetIds: [] };

/** At most this many document sets per message. */
export const MAX_DOC_SETS = 20;

export interface ChatSource {
  url: string;
  title: string;
}

/** A file the assistant produced (code interpreter output, generated image, created document), stored as a blob. */
export interface ChatFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
  kind: "image" | "file";
}

export interface ChatAttachmentMeta {
  name: string;
  mime: string;
  size: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  attachments?: ChatAttachmentMeta[];
  sources?: ChatSource[];
  files?: ChatFile[];
  /** What the assistant did, in order ("Searched: …", "Ran code"). */
  steps?: string[];
  model?: string;
  tier?: "fast" | "standard";
  durationMs?: number;
  /** Set when the answer stopped early (cancelled, error, output limit). */
  status?: "complete" | "stopped" | "error" | "incomplete";
  error?: string;
  feedback?: "up" | "down";
}

export interface ChatThread {
  id: string;
  ownerId: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatThreadSummary {
  id: string;
  title: string;
  updatedAt: string;
  messages: number;
}

/** An attachment sent with a message (base64, small files only: the request body limit is a few MB). */
export interface ChatAttachmentInput extends ChatAttachmentMeta {
  data: string;
}

export interface ChatRequest {
  threadId?: string;
  message: string;
  tools?: Partial<ChatToolFlags>;
  /** Knowledge switch. Absent (older clients): web follows `tools.search`, law on, library off, no document sets. */
  knowledge?: Partial<ChatKnowledge>;
  attachments?: ChatAttachmentInput[];
  /** Replace the last assistant answer (regenerate) instead of appending a new user turn. */
  regenerate?: boolean;
}

/** Server → client stream events. */
export type ChatEvent =
  | { type: "thread"; threadId: string; title: string; userMessageId?: string }
  | { type: "route"; tier: "fast" | "standard"; model: string; tools: string[] }
  | { type: "step"; id: string; label: string; state: "running" | "done" | "failed" }
  | { type: "delta"; text: string }
  | { type: "source"; source: ChatSource }
  | { type: "file"; file: ChatFile }
  | { type: "done"; message: ChatMessage }
  | { type: "error"; message: string; code?: string };

/** Composer attachment limits (the serverless request body is capped at ~4.5 MB). */
export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 3.2 * 1024 * 1024;
