#!/usr/bin/env python3
"""Transcribe a whole audio file with mlx-whisper into timed segments.

    transcribe.py MODEL AUDIO LANG [INITIAL_PROMPT]
LANG is zh, en, … or auto. Prints one JSON object: {"language": …, "text": …, "segments": [{"start", "end", "text"}, …]}.
Runs offline (HF_HUB_OFFLINE=1 is set by the caller); the model must already be in the Hugging Face cache.
"""
import json, sys
import mlx_whisper

def main():
    model, audio, lang = sys.argv[1], sys.argv[2], sys.argv[3]
    prompt = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None
    kw = dict(path_or_hf_repo=model, verbose=False, word_timestamps=False, initial_prompt=prompt)
    if lang and lang != 'auto':
        kw['language'] = lang
    r = mlx_whisper.transcribe(audio, **kw)
    segs = [{'start': round(float(s['start']), 2), 'end': round(float(s['end']), 2), 'text': s['text'].strip()} for s in r.get('segments', []) if s.get('text', '').strip()]
    print(json.dumps({'language': r.get('language'), 'text': r.get('text', ''), 'segments': segs}, ensure_ascii=False), flush=True)

if __name__ == '__main__':
    main()
