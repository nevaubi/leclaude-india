"use client";
import * as React from "react";
import type { LocaleCode } from "@/lib/india/languages";

/**
 * Browser dictation (Web Speech API). Speech is recognised by the browser; nothing is uploaded by this app.
 * Interim words are shown live; final words are committed. `stop()` ends listening (e.g. on send).
 */

interface RecognitionResult { isFinal: boolean; 0: { transcript: string }; length: number }
interface RecognitionEvent { resultIndex: number; results: ArrayLike<RecognitionResult> }
interface RecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => RecognitionLike;

/** UI locale → BCP-47 tag for Indian speech recognition. */
const SPEECH_LANG: Partial<Record<LocaleCode, string>> = {
  en: "en-IN", hi: "hi-IN", kn: "kn-IN", te: "te-IN", ta: "ta-IN", mr: "mr-IN", bn: "bn-IN", ur: "ur-IN",
  gu: "gu-IN", ml: "ml-IN", pa: "pa-IN",
};
export const speechLang = (locale: LocaleCode | string): string => SPEECH_LANG[locale as LocaleCode] ?? "en-IN";

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Join committed text and new words with a single space. */
export function joinDictation(base: string, words: string): string {
  const w = words.replace(/\s+/g, " ").trim();
  if (!w) return base;
  return base && !/\s$/.test(base) ? `${base} ${w}` : `${base}${w}`;
}

export interface Dictation {
  /** null until mounted (SSR), then whether the browser supports speech recognition. */
  supported: boolean | null;
  listening: boolean;
  error: string | null;
  start: () => void;
  stop: () => void;
  toggle: () => void;
}

const ERRORS: Record<string, string> = {
  "not-allowed": "Microphone access was blocked. Allow it in the browser to dictate.",
  "service-not-allowed": "Dictation is not allowed in this browser.",
  "audio-capture": "No microphone was found.",
  network: "Dictation needs a network connection in this browser.",
  "language-not-supported": "Dictation is not available for this language in this browser.",
};

/**
 * @param value current text (read when listening starts; dictated words are appended to it)
 * @param onChange receives the text with committed + interim words
 */
export function useDictation({ value, onChange, lang }: { value: string; onChange: (v: string) => void; lang: string }): Dictation {
  const [supported, setSupported] = React.useState<boolean | null>(null);
  const [listening, setListening] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const recRef = React.useRef<RecognitionLike | null>(null);
  const valueRef = React.useRef(value);
  valueRef.current = value;
  const onChangeRef = React.useRef(onChange);
  onChangeRef.current = onChange;

  React.useEffect(() => { setSupported(Boolean(recognitionCtor())); }, []);

  const stop = React.useCallback(() => {
    const rec = recRef.current;
    recRef.current = null;
    setListening(false);
    if (rec) { rec.onresult = null; rec.onend = null; rec.onerror = null; try { rec.stop(); } catch { /* already stopped */ } }
  }, []);

  const start = React.useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor || recRef.current) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = lang;
    // Text committed so far: what was in the box when listening began plus every final result since.
    let committed = valueRef.current;
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) committed = joinDictation(committed, r[0].transcript);
        else interim += r[0].transcript;
      }
      onChangeRef.current(joinDictation(committed, interim));
    };
    rec.onerror = (e) => { if (e?.error && e.error !== "aborted" && e.error !== "no-speech") setError(ERRORS[e.error] ?? "Dictation stopped."); };
    rec.onend = () => {
      // Drop interim words that never became final.
      if (recRef.current === rec) { recRef.current = null; setListening(false); onChangeRef.current(committed); }
    };
    setError(null);
    try {
      rec.start();
      recRef.current = rec;
      setListening(true);
    } catch {
      setError("Dictation could not start.");
    }
  }, [lang]);

  const toggle = React.useCallback(() => { if (recRef.current) stop(); else start(); }, [start, stop]);

  React.useEffect(() => () => { const rec = recRef.current; recRef.current = null; if (rec) { rec.onresult = null; rec.onend = null; rec.onerror = null; try { rec.abort(); } catch { /* ignore */ } } }, []);

  return { supported, listening, error, start, stop, toggle };
}
