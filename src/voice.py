"""Runs inside one user's Sandbox. Audio and model data never leave that user environment."""
import base64
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request
import zipfile

ROOT = Path('/workspace/.telegram-codex/voice')
ENV = ROOT / 'env'


def prepare():
    with (ROOT / 'setup.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        ready = ENV / 'ready-v1'
        if ready.exists():
            return
        subprocess.run(['python3', '-m', 'venv', '--without-pip', str(ENV)], check=True)
        python = str(ENV / 'bin/python')
        site = subprocess.check_output([python, '-c', 'import sysconfig;print(sysconfig.get_path("purelib"))'], text=True).strip()
        # Bootstrap pip from a pinned PyPI wheel and verify its published digest.
        with urllib.request.urlopen('https://pypi.org/pypi/pip/25.2/json', timeout=30) as response:
            metadata = json.load(response)
        wheel = next(item for item in metadata['urls'] if item['filename'].endswith('.whl'))
        with urllib.request.urlopen(wheel['url'], timeout=60) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != wheel['digests']['sha256']:
            raise RuntimeError('Package checksum mismatch')
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            archive.extractall(site)
        subprocess.run([python, '-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir',
                        '--only-binary=:all:', 'faster-whisper==1.2.1'], check=True, timeout=300)
        ready.touch()


def transcribe(job):
    import av
    import numpy as np
    from faster_whisper import WhisperModel

    info = json.loads((job / 'input.json').read_text())
    if not 1 <= info['chunks'] <= 24:
        raise ValueError('Invalid audio size')
    encoded = ''.join((job / f'audio-{i}.b64').read_text() for i in range(info['chunks']))
    audio = base64.b64decode(encoded, validate=True)
    if len(audio) > 4 * 1024 * 1024:
        raise ValueError('Invalid audio size')
    # Bound decoded duration too, rather than trusting Telegram metadata.
    resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
    parts = []
    samples = 0
    with av.open(io.BytesIO(audio)) as container:
        for frame in container.decode(audio=0):
            for converted in resampler.resample(frame):
                samples += converted.samples
                if samples > 180 * 16000:
                    raise ValueError('Audio exceeds three minutes')
                parts.append(converted.to_ndarray().flatten())
        for converted in resampler.resample(None):
            samples += converted.samples
            if samples > 180 * 16000:
                raise ValueError('Audio exceeds three minutes')
            parts.append(converted.to_ndarray().flatten())
    if not samples:
        return ''
    waveform = np.concatenate(parts).astype(np.float32) / 32768.0
    model = WhisperModel('small', device='cpu', compute_type='int8', cpu_threads=2,
                         download_root=str(ROOT / 'models'))
    segments, _ = model.transcribe(waveform, beam_size=5, vad_filter=True, condition_on_previous_text=False)
    text = ' '.join(segment.text.strip() for segment in segments).strip()
    if len(text) > 16000:
        raise ValueError('Transcript exceeds text limit')
    return text


def main():
    if len(sys.argv) < 2 or not sys.argv[1].isdigit():
        raise ValueError('Invalid voice job')
    job = ROOT / 'jobs' / sys.argv[1]
    if len(sys.argv) == 2:
        try:
            prepare()
        except Exception:
            (job / 'result.json').write_text(json.dumps({'error': 'setup failed'}))
            for part in job.glob('audio-*.b64'):
                part.unlink()
            raise
        os.execv(str(ENV / 'bin/python'), [str(ENV / 'bin/python'), __file__, sys.argv[1], '--run'])
    with (job / 'job.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if (job / 'result.json').exists():
            return
        try:
            result = {'text': transcribe(job)}
        except Exception as error:
            # Avoid putting paths, request URLs or credentials into bot messages.
            result = {'error': type(error).__name__}
        temporary = job / 'result.tmp'
        temporary.write_text(json.dumps(result, ensure_ascii=False))
        temporary.replace(job / 'result.json')
        for part in job.glob('audio-*.b64'):
            part.unlink()


if __name__ == '__main__':
    main()
