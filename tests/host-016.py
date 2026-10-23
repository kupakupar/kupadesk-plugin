"""Compare 015 and 016 through the unchanged official binary, loopback only."""
import argparse
import copy
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def ask(url, body=None):
    request = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
        headers={'Authorization': 'Bearer magpie-dsh', 'Content-Type': 'application/json'})
    with DIRECT.open(request, timeout=25) as response:
        return response.status, response.read()


def cases():
    function = {'name': 'fixture_exec', 'description': 'Synthetic tool; never executed',
                'parameters': {'type': 'object', 'properties': {'command': {'type': 'string'}}}}
    chat = {'model': 'chat/test', 'messages': [{'role': 'system', 'content': 'ORIGINAL_INSTRUCTION'},
        {'role': 'user', 'content': 'SYNTHETIC_USER'}, {'role': 'assistant', 'content': None,
         'reasoning_content': 'SEALED_HISTORY', 'tool_calls': [{'id': 'call_1', 'type': 'function', 'function': {'name': 'fixture_exec', 'arguments': '{}'}}]},
        {'role': 'tool', 'tool_call_id': 'call_1', 'content': 'SYNTHETIC_RESULT'}],
        'tools': [{'type': 'function', 'function': function}], 'tool_choice': 'auto', 'reasoning_effort': 'high', 'max_tokens': 32}
    responses = {'model': 'responses/test', 'instructions': 'ORIGINAL_INSTRUCTION',
        'input': [{'type': 'reasoning', 'id': 'r_1', 'encrypted_content': 'SEALED_HISTORY', 'summary': []},
                  {'role': 'user', 'content': 'SYNTHETIC_USER'},
                  {'type': 'function_call', 'call_id': 'call_1', 'name': 'fixture_exec', 'arguments': '{}'},
                  {'type': 'function_call_output', 'call_id': 'call_1', 'output': 'SYNTHETIC_RESULT'}],
        'tools': [{'type': 'function', **function}], 'tool_choice': 'auto', 'reasoning': {'effort': 'high'}, 'max_output_tokens': 32}
    anthropic = {'model': 'anthropic/test', 'system': [{'type': 'text', 'text': 'ORIGINAL_INSTRUCTION', 'cache_control': {'type': 'ephemeral'}}],
        'messages': [{'role': 'assistant', 'content': [{'type': 'thinking', 'thinking': 'SEALED_HISTORY', 'signature': 'SIGNATURE'},
            {'type': 'tool_use', 'id': 'call_1', 'name': 'fixture_exec', 'input': {}}]},
            {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'call_1', 'content': 'SYNTHETIC_RESULT'}]}],
        'tools': [{'name': 'fixture_exec', 'input_schema': function['parameters']}],
        'thinking': {'type': 'enabled', 'budget_tokens': 1024}, 'max_tokens': 2048}
    gemini = {'systemInstruction': {'parts': [{'text': 'ORIGINAL_INSTRUCTION'}]},
        'contents': [{'role': 'model', 'parts': [{'text': 'SEALED_HISTORY', 'thought': True, 'thoughtSignature': 'SIGNATURE'},
            {'functionCall': {'id': 'call_1', 'name': 'fixture_exec', 'args': {}}, 'thoughtSignature': 'TOOL_SIGNATURE'}]},
            {'role': 'user', 'parts': [{'functionResponse': {'id': 'call_1', 'name': 'fixture_exec', 'response': {'result': 'SYNTHETIC_RESULT'}}}]}],
        'tools': [{'functionDeclarations': [function]}], 'generationConfig': {'thinkingConfig': {'thinkingBudget': 1024, 'includeThoughts': True}}}
    result = []
    for protocol, route, body in [('chat', '/v1/chat/completions', chat), ('responses', '/v1/responses', responses),
        ('anthropic', '/v1/messages', anthropic), ('gemini', '/v1beta/models/gemini/test:generateContent', gemini)]:
        for stream in [False, True]:
            value = copy.deepcopy(body)
            if protocol != 'gemini': value['stream'] = stream
            result.append((protocol + ('-stream' if stream else ''), protocol, route.replace(':generateContent', ':streamGenerateContent') if stream else route, value))
    lite = copy.deepcopy(responses)
    lite['input'].insert(0, {'type': 'additional_tools', 'role': 'developer', 'tools': [
        {'type': 'namespace', 'name': 'functions', 'tools': lite.pop('tools')}]})
    result.append(('responses-lite', 'responses', '/v1/responses', lite))
    long = copy.deepcopy(chat); long['messages'][1]['content'] = 'HISTORY_' + 'x' * (2 * 1024 * 1024)
    result.append(('chat-long', 'chat', '/v1/chat/completions', long))
    failover = copy.deepcopy(chat); failover['model'] = 'group/fixture-route'
    result.append(('chat-failover', 'chat', '/v1/chat/completions', failover))
    return result


class Upstream(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_): pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.received.append(body)
        serial = len(self.server.received)
        if '/fail/' in self.path:
            raw = json.dumps({'error': {'type': 'rate_limit_error', 'message': 'Too many requests (synthetic)'}}).encode()
            self.send_response(429); self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(raw))); self.end_headers(); self.wfile.write(raw)
            return
        if '/responses/' in self.path:
            reply = {'id': 'resp_' + str(serial), 'object': 'response', 'status': 'completed', 'model': 'test',
                     'output': [{'type': 'message', 'role': 'assistant', 'id': 'msg_1', 'status': 'completed',
                                 'content': [{'type': 'output_text', 'text': 'SYNTHETIC_REPLY', 'annotations': []}]}],
                     'usage': {'input_tokens': 3, 'output_tokens': 1, 'total_tokens': 4}}
            events = [{'type': 'response.created', 'response': {**reply, 'status': 'in_progress', 'output': []}},
                      {'type': 'response.output_item.added', 'output_index': 0, 'item': reply['output'][0]},
                      {'type': 'response.output_item.done', 'output_index': 0, 'item': reply['output'][0]},
                      {'type': 'response.completed', 'response': reply}]
        elif '/anthropic/' in self.path:
            reply = {'id': 'msg_' + str(serial), 'type': 'message', 'role': 'assistant', 'model': 'test',
                     'content': [{'type': 'text', 'text': 'SYNTHETIC_REPLY'}], 'stop_reason': 'end_turn',
                     'usage': {'input_tokens': 3, 'output_tokens': 1}}
            events = [{'type': 'message_start', 'message': {**reply, 'content': [], 'stop_reason': None}},
                      {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}},
                      {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': 'SYNTHETIC_REPLY'}},
                      {'type': 'content_block_stop', 'index': 0}, {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}, 'usage': {'output_tokens': 1}},
                      {'type': 'message_stop'}]
        elif '/gemini/' in self.path:
            reply = {'responseId': 'gemini_' + str(serial), 'candidates': [{'content': {'role': 'model', 'parts': [{'text': 'SYNTHETIC_REPLY'}]}, 'finishReason': 'STOP'}],
                     'usageMetadata': {'promptTokenCount': 3, 'candidatesTokenCount': 1, 'totalTokenCount': 4}}
            events = [reply]
        else:
            reply = {'id': 'chat_' + str(serial), 'object': 'chat.completion', 'model': 'test',
                     'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': 'SYNTHETIC_REPLY'}, 'finish_reason': 'stop'}],
                     'usage': {'prompt_tokens': 3, 'completion_tokens': 1, 'total_tokens': 4}}
            events = [{'id': reply['id'], 'object': 'chat.completion.chunk', 'model': 'test',
                       'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': 'SYNTHETIC_REPLY'}, 'finish_reason': None}]},
                      {'id': reply['id'], 'object': 'chat.completion.chunk', 'model': 'test',
                       'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}], 'usage': reply['usage']}]
        stream = body.get('stream') or 'streamGenerateContent' in self.path
        raw = (''.join('data: ' + json.dumps(event) + '\n\n' for event in events).encode() if stream else json.dumps(reply).encode())
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream' if stream else 'application/json')
        self.send_header('Content-Length', str(len(raw))); self.end_headers(); self.wfile.write(raw)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--magpie', type=Path, required=True)
    parser.add_argument('--bun', type=Path, required=True)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    binary_hash = hashlib.sha256(args.magpie.read_bytes()).hexdigest()
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Upstream); server.received = []
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    upstream = 'http://127.0.0.1:' + str(server.server_port)
    baseline = {}; observations = []; snapshots = {}
    try:
        for variant in ['015', '016', '016-checks-off', '016-fallback']:
            root = args.output / variant; root.mkdir()
            config = root / 'config/magpie'; config.mkdir(parents=True)
            package = root / 'plugin'; package.mkdir()
            source = args.baseline if variant == '015' else ROOT
            meta = json.loads((source / 'package.json').read_text(encoding='utf-8'))
            for name in meta['files'] + ['package.json']:
                a, b = source / name, package / name
                shutil.copytree(a, b) if a.is_dir() else shutil.copy2(a, b)
            if variant.endswith('fallback'):
                meta['magpie'].pop('hooks', None)
                (package / 'package.json').write_text(json.dumps(meta), encoding='utf-8')
            options = {'schemaVersion': 1, 'enabled': True, 'gatewayTimeoutMs': 5000,
                'bindings': [{'id': 'fixture', 'name': 'Synthetic', 'prompt': 'SYNTHETIC_PROMPT',
                              'models': [p + '/test' for p in ['chat', 'responses', 'anthropic', 'gemini']] + ['group/fixture-route']}],
                'catalogSync': {'intervalMs': 1000}}
            if variant.endswith('checks-off'): options['diagnostics'] = {'checks': False, 'routes': False}
            providers = [{'id': p, 'name': p, 'key': 'synthetic', api: upstream + '/' + p + path, 'models': ['test']}
                for p, api, path in [('chat', 'chat', '/v1'), ('responses', 'responses', '/v1'), ('anthropic', 'anthropic', ''), ('gemini', 'gemini', '')]]
            providers.append({'id': 'fail', 'name': 'Fail', 'key': 'synthetic', 'chat': upstream + '/fail/v1', 'models': ['test']})
            groups = [{'id': 'fixture-route', 'name': 'Synthetic route', 'members': ['fail/test', 'chat/test'], 'routing': 'order'}]
            for name, value in {'providers.json': {'providers': providers, 'groups': groups}, 'plugins.json': {'plugins': [{'spec': str(package), 'options': options}]},
                'settings.json': {'proxy': 'direct'}}.items():
                (config / name).write_text(json.dumps(value), encoding='utf-8')
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
            env = os.environ.copy()
            for key, name in [('HOME', 'home'), ('USERPROFILE', 'home'), ('APPDATA', 'roaming'), ('LOCALAPPDATA', 'local'),
                              ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache')]:
                (root / name).mkdir(exist_ok=True); env[key] = str((root / name).resolve())
            env.update(MAGPIE_ADDR=f'127.0.0.1:{port}', MAGPIE_BUN=str(args.bun), HTTP_PROXY='http://127.0.0.1:1',
                       HTTPS_PROXY='http://127.0.0.1:1', ALL_PROXY='http://127.0.0.1:1', NO_PROXY='127.0.0.1,localhost')
            log = (root / 'host.log').open('wb')
            process = subprocess.Popen([str(args.magpie), 'serve'], cwd=root, env=env, stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)
            gateway = f'http://127.0.0.1:{port}'
            try:
                deadline = time.monotonic() + 15
                while True:
                    if process.poll() is not None: raise RuntimeError('Isolated official host exited')
                    try: ask(gateway + '/api/hello'); break
                    except (urllib.error.URLError, TimeoutError):
                        if time.monotonic() > deadline: raise
                        time.sleep(.1)
                for label, protocol, route, body in cases():
                    start = len(server.received)
                    status, reply = ask(gateway + route, body)
                    assert b'SYNTHETIC_REPLY' in reply, (variant, label, 'fixture reply absent')
                    assert len(server.received) == start + (2 if label == 'chat-failover' else 1), (variant, label, 'unexpected upstream count')
                    sent = server.received[start:]
                    if variant == '015': baseline[label] = sent
                    else:
                        if sent != baseline[label]:
                            (args.output / 'difference.json').write_text(json.dumps({'case': label, 'before': baseline[label], 'after': sent}, indent=2), encoding='utf-8')
                        assert sent == baseline[label], (variant, label, 'outgoing request differs from 015')
                    observations.append({'variant': variant, 'case': label, 'protocol': protocol, 'status': status, 'matches015': True})
                if variant in ['016', '016-checks-off']:
                    catalog = package / 'page/kupadesk-native-003-model-catalog.js'
                    deadline = time.monotonic() + 20
                    while time.monotonic() < deadline:
                        try:
                            raw = catalog.read_text(encoding='utf-8')
                            snapshot = json.loads(raw.split('window.KUPADESK_MODEL_CATALOG = ', 1)[1].rsplit(';', 1)[0])['injection']
                            recent = snapshot['recent']
                            if len(recent) >= 11 and all(x.get('completion') for x in recent):
                                matched = sum(x['route'].get('state') == 'matched' for x in recent)
                                if matched >= 9 and recent[0]['route'].get('state') == 'matched': break
                        except (FileNotFoundError, KeyError, ValueError): pass
                        time.sleep(.2)
                    else: raise AssertionError('Missing completion/ledger observations: ' + variant)
                    snapshots[variant] = snapshot
                    if variant == '016':
                        route = recent[0]['route']
                        assert route['total'] == 2 and route['provider'] == 'chat', route
                        # Official 1352 omits this unbilled 429 from usage.jsonl.
                        # The observer must say partial instead of inventing it.
                        assert route['attemptState'] == 'partial', route
                        assert [x['provider'] for x in route['attempts']] == ['chat'], route
                        assert [x['status'] for x in route['attempts']] == [200], route
                    for item in recent:
                        if variant == '016':
                            for phase in ['plugin', 'host']:
                                assert all(x['state'] == 'same' for x in item['checks'][phase].values()), (phase, item['protocol'], item['checks'])
                        else: assert item['checks']['plugin']['state'] == item['checks']['host']['state'] == 'disabled'
                    print(json.dumps({'variant': variant, 'hostObservations': len(recent), 'matchedRoutes': matched}), flush=True)
            finally:
                if process.poll() is None:
                    process.terminate()
                    try: process.wait(timeout=5)
                    except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)
                log.close()
            print(json.dumps({'variant': variant, 'cases': 11, 'matches015': True}), flush=True)
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=3)
        assert hashlib.sha256(args.magpie.read_bytes()).hexdigest() == binary_hash
        (args.output / 'report.json').write_text(json.dumps({'cases': observations, 'snapshots': snapshots,
            'officialBinaryUnchanged': True, 'realModelCalls': 0, 'realToolExecutions': 0}, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'passedCases': len(observations), 'officialBinaryUnchanged': True, 'realModelCalls': 0}))


if __name__ == '__main__': main()
