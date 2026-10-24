"""Long prompts through an unchanged official host, synthetic loopback upstream only."""
import copy
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import threading
import time
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'evidence' / ('host-long-' + time.strftime('%Y%m%d-%H%M%S'))
OFFICIAL = Path('C:/Users/kupakupa/AppData/Local/Programs/magpie/magpie.exe')
BUN = Path('C:/Users/kupakupa/.cache/magpie/bun/1.4.2/bun.exe')
BASE = Path('E:/破限版/kupadesk-016')
spec = importlib.util.spec_from_file_location('host_fixture', ROOT / 'tests/host-016.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
FOOTER = re.compile(r'\n<!-- KUPADESK:MANAGED:1:(text|message|part):(\d+):[a-f0-9]{16}:(\d+):[a-f0-9]{16} -->$')
DROP = object()


def strip_prompt(value, prompt, found):
    if isinstance(value, str):
        match = FOOTER.search(value)
        if match:
            assert value.endswith(prompt + '\n<!-- KUPADESK-NATIVE-PAGE-TEST:END -->' + match[0])
            prefix = value.encode('utf-16-le')[:int(match[2]) * 2].decode('utf-16-le')
            assert int(match[3]) == len(prompt.encode('utf-16-le')) // 2
            found.append(match[1])
            if match[1] == 'part' and int(match[2]) == 0:
                # Gemini's official translator joins separate text parts.
                # Undo its separator, retaining the original instruction part.
                at = value.rfind('<!-- KUPADESK-NATIVE-PAGE-TEST:BEGIN -->\n' + prompt)
                prefix = value[:at]
                if prefix.endswith('\n\n'):
                    prefix = prefix[:-2]
            return prefix
        return value
    if isinstance(value, list):
        rows = [strip_prompt(v, prompt, found) for v in value]
        return [v for v in rows if v is not DROP]
    if isinstance(value, dict):
        text = value.get('text')
        if isinstance(text, str) and FOOTER.search(text) and set(value) <= {'type', 'text'}:
            cleaned = strip_prompt(text, prompt, found)
            if cleaned == '':
                return DROP
            return {**value, 'text': cleaned}
        return {k: strip_prompt(v, prompt, found) for k, v in value.items()}
    return value


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    binary_hash = hashlib.sha256(OFFICIAL.read_bytes()).hexdigest()
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), fixture.Upstream)
    server.received = []
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    upstream = f'http://127.0.0.1:{server.server_port}'
    baseline, rows = {}, []
    selected = [c for c in fixture.cases() if c[0] != 'chat-failover']
    long = 'x' * 60000
    variants = [('off', None, ''), ('016-short', BASE, 'SYNTHETIC_PROMPT'),
                ('017-short', ROOT, 'SYNTHETIC_PROMPT'), ('016-long', BASE, long),
                ('017-long', ROOT, long), ('017-fallback', ROOT, long)]
    try:
        for variant, source, prompt in variants:
            root = OUT / variant
            root.mkdir(exist_ok=False)
            config = root / 'config/magpie'
            config.mkdir(parents=True)
            plugin_entries = []
            if source:
                package = root / 'package'
                shutil.copytree(source, package, ignore=shutil.ignore_patterns('.git', 'evidence', 'tests', '__pycache__'))
                if variant.endswith('fallback'):
                    meta = json.loads((package / 'package.json').read_text(encoding='utf-8'))
                    del meta['magpie']['hooks']
                    (package / 'package.json').write_text(json.dumps(meta), encoding='utf-8')
                opts = {'schemaVersion': 1, 'enabled': True, 'bindings': [{'id': 'long', 'name': 'Synthetic', 'prompt': prompt,
                    'models': [p + '/test' for p in ['chat', 'responses', 'anthropic', 'gemini']]}]}
                plugin_entries = [{'spec': str(package), 'options': opts}]
            providers = [{'id': p, 'name': p, 'key': 'synthetic', api: upstream + '/' + p + path, 'models': ['test']}
                for p, api, path in [('chat', 'chat', '/v1'), ('responses', 'responses', '/v1'), ('anthropic', 'anthropic', ''), ('gemini', 'gemini', '')]]
            for name, value in {'providers.json': {'providers': providers}, 'plugins.json': {'plugins': plugin_entries},
                                'settings.json': {'proxy': 'direct'}}.items():
                (config / name).write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
            env = os.environ.copy()
            for key, name in [('HOME', 'home'), ('USERPROFILE', 'home'), ('APPDATA', 'roaming'), ('LOCALAPPDATA', 'local'),
                              ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache')]:
                (root / name).mkdir(exist_ok=True)
                env[key] = str((root / name).resolve())
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            env.update(MAGPIE_ADDR=f'127.0.0.1:{port}', MAGPIE_BUN=str(BUN), HTTP_PROXY='http://127.0.0.1:1',
                       HTTPS_PROXY='http://127.0.0.1:1', ALL_PROXY='http://127.0.0.1:1', NO_PROXY='127.0.0.1,localhost')
            with (root / 'host.log').open('wb') as log:
                process = subprocess.Popen([str(OFFICIAL), 'serve'], cwd=root, env=env, stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)
                try:
                    gateway = f'http://127.0.0.1:{port}'
                    deadline = time.monotonic() + 20
                    while True:
                        if process.poll() is not None:
                            raise RuntimeError('Isolated host exited')
                        try:
                            fixture.ask(gateway + '/api/hello')
                            break
                        except (urllib.error.URLError, TimeoutError):
                            if time.monotonic() > deadline:
                                raise
                            time.sleep(.1)
                    for label, protocol, route, body in selected:
                        start = len(server.received)
                        try:
                            status, reply = fixture.ask(gateway + route, copy.deepcopy(body))
                        except urllib.error.HTTPError as error:
                            status, reply = error.code, error.read()
                        if variant == '016-long':
                            assert status == 400 and len(server.received) == start, (variant, label, status)
                        else:
                            assert status == 200 and b'SYNTHETIC_REPLY' in reply, (variant, label, status)
                            assert len(server.received) == start + 1, (variant, label, 'upstream count')
                            sent = server.received[-1]
                            if variant == 'off':
                                baseline[label] = sent
                            else:
                                found = []
                                normalized = strip_prompt(sent, prompt, found)
                                assert len(found) == 1, (variant, label, 'prompt block count', len(found))
                                if normalized != baseline[label]:
                                    (OUT / 'difference.json').write_text(json.dumps({'case': label, 'before': baseline[label],
                                        'after': normalized}, ensure_ascii=False, indent=2), encoding='utf-8')
                                assert normalized == baseline[label], (variant, label, 'protected upstream fields changed', str(OUT / 'difference.json'))
                        rows.append({'variant': variant, 'case': label, 'status': status,
                            'protectedUpstreamFieldsPreserved': variant != '016-long', 'expectedOldRejection': variant == '016-long'})
                    print(json.dumps({'variant': variant, 'casesPassed': len(selected)}), flush=True)
                finally:
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=5)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
        assert hashlib.sha256(OFFICIAL.read_bytes()).hexdigest() == binary_hash
        report = {'passed': len(rows) == len(variants) * len(selected), 'cases': rows,
                  'officialBinaryUnchanged': True, 'realModelCalls': 0, 'realToolExecutions': 0}
        (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'passed': report['passed'], 'cases': len(rows), 'officialBinaryUnchanged': True}))


if __name__ == '__main__':
    main()
