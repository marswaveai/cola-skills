#!/usr/bin/env python3
"""Batch speech generation with a local VoxCPM2 (MLX) model. Run with a Python that has mlx-audio installed.

    voxcpm_batch.py JOBS.json

JOBS.json: {"model": "/path/VoxCPM2-8bit", "reference": "ref.wav", "transcript": "逐字稿", "cfg": 2.0, "steps": 12,   (items may override reference / transcript)
            "items": [{"text": "…", "seed": 1, "out": "/abs/out.wav", "mode": "combined|reference|design", "instruct": "…"}, …]}
Modes (VoxCPM2 official):
  combined   Hi-Fi clone: reference audio + verbatim transcript; closest to the voice; bracket instructions are ignored
  reference  controllable clone: reference audio + optional instruct, e.g. "极度愤怒，东北话"
  design     voice from a text description only (instruct is the description)
Prints one JSON line per item. The model is loaded once; items whose output already exists are skipped.
"""
import json, os, sys, time

def main():
    job = json.load(open(sys.argv[1]))
    import numpy as np, mlx.core as mx, soundfile as sf
    from mlx_audio.tts.utils import load
    t0 = time.time()
    model = load(job['model'])
    print(json.dumps({'event': 'loaded', 'seconds': round(time.time() - t0, 1)}), flush=True)
    for it in job['items']:
        if os.path.exists(it['out']):
            print(json.dumps({'out': it['out'], 'skipped': True}), flush=True)
            continue
        text = it['text']
        mode = it.get('mode') or job.get('mode') or 'combined'
        kw = {'text': text, 'inference_timesteps': int(it.get('steps', job.get('steps', 10))), 'cfg_value': float(it.get('cfg', job.get('cfg', 2.0))),
              'max_tokens': len(text) * 6 + 10}
        if mode == 'design':
            kw['instruct'] = it.get('instruct') or job.get('design')
        elif mode == 'reference':
            kw['ref_audio'] = it.get('reference') or job['reference']
            if it.get('instruct'):
                kw['instruct'] = it['instruct']
        else:
            ref = it.get('reference') or job['reference']
            kw.update(ref_audio=ref, prompt_audio=ref, prompt_text=it.get('transcript') or job['transcript'])
        t1 = time.time()
        mx.random.seed(int(it.get('seed', 0)))
        res = list(model.generate(**kw))
        audio = np.concatenate([np.asarray(r.audio) for r in res]).astype(np.float32)
        sr = res[0].sample_rate
        tmp = it['out'] + '.tmp.wav'
        sf.write(tmp, audio, sr, subtype='PCM_16')
        os.replace(tmp, it['out'])
        print(json.dumps({'out': it['out'], 'mode': mode, 'seconds': round(time.time() - t1, 1), 'duration': round(len(audio) / sr, 3), 'sr': sr}), flush=True)

if __name__ == '__main__':
    main()
