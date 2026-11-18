#!/usr/bin/env python3
"""Word (character) timestamps for Chinese speech with mlx-whisper.

    asr_words.py MODEL AUDIO [AUDIO …]
Prints one JSON line per file: {"file": …, "text": …, "words": [[word, start, end], …]}.
Runs offline (HF_HUB_OFFLINE=1 is set by the caller); the model must already be in the Hugging Face cache.
"""
import json, sys
import mlx_whisper

def main():
    model = sys.argv[1]
    for path in sys.argv[2:]:
        r = mlx_whisper.transcribe(path, path_or_hf_repo=model, language='zh', word_timestamps=True,
                                   initial_prompt='以下是普通话的句子。', condition_on_previous_text=False)
        words = [[w['word'], round(float(w['start']), 3), round(float(w['end']), 3)] for s in r['segments'] for w in s.get('words', [])]
        print(json.dumps({'file': path, 'text': r['text'], 'words': words}, ensure_ascii=False), flush=True)

if __name__ == '__main__':
    main()
