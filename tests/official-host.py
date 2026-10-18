"""HTTP integration against an unchanged official host and isolated fixtures."""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MARKER = 'KUPADESK-NATIVE-PAGE-TEST:BEGIN'


def check_host(executable, bun, fallback=False):
    root = Path(tempfile.mkdtemp(prefix='kupadesk-official-fixture-'))
    package = root / 'plugin'
    package.mkdir()
    meta = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    for name in meta['files'] + ['package.json']:
        source, target = ROOT / name, package / name
        if source.is_dir():
            shutil.copytree(source, target)
        else:
            shutil.copy2(source, target)
    if fallback:
        meta['magpie'].pop('hooks', None)
        (package / 'package.json').write_text(json.dumps(meta), encoding='utf-8')
    received, results = [], []

    class Fixture(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            received.append({'path': self.path, 'body': body})
            message = {'role': 'assistant', 'content': 'fixture'}
            if body.get('stream'):
                chunks = [
                    {'id': 'fixture', 'object': 'chat.completion.chunk', 'model': 'fixture',
                     'choices': [{'index': 0, 'delta': message, 'finish_reason': None}]},
                    {'id': 'fixture', 'object': 'chat.completion.chunk', 'model': 'fixture',
                     'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}],
                     'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}},
                ]
                raw = ''.join('data: ' + json.dumps(row) + '\n\n' for row in chunks).encode() + b'data: [DONE]\n\n'
                kind = 'text/event-stream'
            else:
                raw = json.dumps({'id': 'fixture', 'object': 'chat.completion', 'model': 'fixture',
                                  'choices': [{'index': 0, 'message': message, 'finish_reason': 'stop'}],
                                  'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}}).encode()
                kind = 'application/json'
            self.send_response(200)
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *_):
            pass

    fixture = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    thread = threading.Thread(target=fixture.serve_forever, daemon=True)
    thread.start()
    origin = f'http://127.0.0.1:{fixture.server_port}'
    config = root / 'config/magpie'
    config.mkdir(parents=True)
    profile = root / 'profile'
    profile.mkdir()
    providers = [
        {'id': 'one', 'name': 'One', 'was': ['former'], 'key': 'fixture',
         'chat': origin + '/one/v1', 'models': ['unique', 'm']},
        {'id': 'two', 'name': 'Two', 'key': 'fixture', 'chat': origin + '/two/v1', 'models': ['m']},
    ]
    groups = [{'id': 'pool', 'name': 'Fixture Pool', 'members': ['one/m', 'two/m']}]
    options = {'schemaVersion': 1, 'enabled': True, 'gatewayTimeoutMs': 5000,
               'bindings': [{'id': 'one', 'enabled': True, 'models': ['one/unique', 'one/m', 'one/later'],
                             'prompt': 'FIXTURE_PROMPT', 'chatRole': 'auto'},
                            {'id': 'pool', 'enabled': True, 'models': ['group/pool'],
                             'prompt': 'POOL_PROMPT', 'chatRole': 'auto'}]}
    for name, value in {
        'providers.json': {'providers': providers, 'groups': groups},
        'settings.json': {'proxy': 'direct', 'noStats': True},
        'plugins.json': {'plugins': [{'spec': str(package), 'options': options}]},
    }.items():
        (config / name).write_text(json.dumps(value), encoding='utf-8')
    env = os.environ.copy()
    env.update({'USERPROFILE': str(profile), 'APPDATA': str(root / 'roaming'),
                'LOCALAPPDATA': str(root / 'local'), 'XDG_CONFIG_HOME': str(root / 'config'),
                'XDG_CACHE_HOME': str(root / 'cache'), 'MAGPIE_ADDR': '127.0.0.1:14639',
                'MAGPIE_BUN': str(bun)})
    digest = hashlib.sha256(executable.read_bytes()).hexdigest()
    log = (root / 'host.log').open('wb')
    process = subprocess.Popen([str(executable), 'serve'], cwd=root, env=env, stdout=log, stderr=log,
                               creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)

    def request(label, body, route='/v1/chat/completions', expected=200, prompt='FIXTURE_PROMPT'):
        before = len(received)
        req = urllib.request.Request('http://127.0.0.1:14639' + route, data=json.dumps(body).encode(),
                                     headers={'Content-Type': 'application/json', 'Authorization': 'Bearer magpie-dsh'})
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                status, reply = response.status, response.read()
        except urllib.error.HTTPError as error:
            status, reply = error.code, error.read()
        assert status == expected, (label, status, reply[:450])
        if expected == 200:
            assert len(received) > before, label
            sent = received[-1]['body']
            text = json.dumps(sent)
            if prompt:
                assert prompt in text, (label, 'prompt absent')
                assert text.count(MARKER) == 1, (label, 'duplicate block')
            else:
                assert MARKER not in text, label
            assert 'ORIGINAL_SYSTEM' in text, (label, 'original instructions lost')
        else:
            assert len(received) == before, (label, 'invalid request reached upstream')
        results.append({'case': label, 'status': status, 'fallback': fallback})

    def chat(model, extra=''):
        return {'model': model, 'messages': [{'role': 'system', 'content': 'ORIGINAL_SYSTEM'},
                                            {'role': 'user', 'content': 'FIXTURE_USER' + extra}], 'max_tokens': 8}

    try:
        for _ in range(80):
            if process.poll() is not None:
                raise RuntimeError('isolated host exited')
            try:
                with urllib.request.urlopen('http://127.0.0.1:14639/api/hello', timeout=.3):
                    break
            except (urllib.error.URLError, TimeoutError):
                time.sleep(.1)
        else:
            raise RuntimeError('isolated host startup timed out')
        request('canonical', chat('one/unique'))
        request('effort suffix', chat('one/unique:max'))
        request('bare model', chat('unique'))
        request('provider rename', chat('former/unique'))
        request('routing group name', chat('Fixture Pool'), prompt='POOL_PROMPT')
        request('ambiguous bare model', chat('m'), expected=400)
        request('long history', chat('unique', 'x' * (2 * 1024 * 1024)))
        request('anthropic client', {'model': 'unique', 'system': 'ORIGINAL_SYSTEM',
                                    'messages': [{'role': 'user', 'content': 'FIXTURE_USER'}], 'max_tokens': 8}, '/v1/messages')
        request('responses client', {'model': 'unique', 'instructions': 'ORIGINAL_SYSTEM',
                                    'input': 'FIXTURE_USER', 'max_output_tokens': 8}, '/v1/responses')
        request('gemini client', {'systemInstruction': {'parts': [{'text': 'ORIGINAL_SYSTEM'}]},
                                 'contents': [{'role': 'user', 'parts': [{'text': 'FIXTURE_USER'}]}]},
                '/v1beta/models/one/unique:generateContent')
        request('unbound passthrough', chat('two/m'), prompt=None)
        providers[0]['models'].append('later')
        (config / 'providers.json').write_text(json.dumps({'providers': providers, 'groups': groups}), encoding='utf-8')
        for _ in range(80):
            if 'one/later' in (package / 'request-index.js').read_text(encoding='utf-8'):
                time.sleep(1.1)  # Bun refreshes its local alias index once per second.
                break
            time.sleep(.2)
        else:
            raise AssertionError('model index did not refresh after provider change')
        request('new model without restart', chat('later'))
        if not fallback:
            for _ in range(35):
                source = (package / 'page/kupadesk-native-003-model-catalog.js').read_text(encoding='utf-8')
                try:
                    value = json.loads(source.split('window.KUPADESK_MODEL_CATALOG = ', 1)[1].rsplit(';', 1)[0])
                except (ValueError, IndexError):
                    value = {}
                if value.get('injection', {}).get('totals', {}).get('injected', 0) >= 5:
                    break
                time.sleep(.3)
            else:
                raise AssertionError('Bun injection diagnostics never observed successful hooks')
        print(json.dumps({'results': results, 'temporaryProfile': str(root), 'officialSHA256': digest}))
        return results
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        log.close()
        fixture.shutdown()
        fixture.server_close()
        thread.join(timeout=3)
        assert hashlib.sha256(executable.read_bytes()).hexdigest() == digest


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--magpie', type=Path, required=True)
    parser.add_argument('--bun', type=Path, required=True)
    args = parser.parse_args()
    check_host(args.magpie, args.bun)
    check_host(args.magpie, args.bun, fallback=True)
