"""Run installed clients against an isolated official Magpie and real providers.

Private options/keys stay in a temporary profile; reports contain assertions only.
No production application, provider, plugin, or client configuration is written.
"""
import argparse
import base64
import copy
import hashlib
import http.server
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import struct
import zlib
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
START = '<!-- KUPADESK-NATIVE-PAGE-TEST:BEGIN -->'
CODEX_PROMPT = 'Tools remain available. Complete the requested read-only tool call before replying. End with KUPA008_CODEX_OK.'


def sha(value):
    raw = value if isinstance(value, bytes) else json.dumps(value, sort_keys=True, ensure_ascii=False).encode()
    return hashlib.sha256(raw).hexdigest()


def main(args):
    source = args.config.resolve()
    installed = source / 'plugins/node_modules/kupadesk'
    protected = [source / 'plugins.json', source / 'providers.json'] + [installed / name for name in
        ['package.json', 'kupadesk.middleware.js', 'kupadesk.hooks.mjs', 'settings-sync.mjs', 'page/kupadesk-native-003-app.js']]
    before = {str(p): sha(p.read_bytes()) for p in protected}
    production = json.loads((source / 'plugins.json').read_text(encoding='utf-8'))
    original = next(p['options'] for p in production['plugins'] if 'kupadesk' in p.get('spec', '').lower())
    providers = json.loads((source / 'providers.json').read_text(encoding='utf-8'))
    chosen = {p['id']: copy.deepcopy(p) for p in providers['providers'] if p['id'] in [args.codex_provider, 'deepseek']}
    assert len(chosen) == 2, 'required existing providers missing'
    assert all(chosen[p].get('key') for p in chosen), 'real provider keys are required'
    model = args.codex_provider + '/' + args.codex_model
    assert not any(model in b.get('models', []) for b in original.get('bindings', [])), 'test model already has a private binding'
    options = copy.deepcopy(original)
    options['bindings'].append({'id': 'isolated-codex-tools', 'name': 'Isolated tool check', 'enabled': True,
        'models': [model], 'prompt': CODEX_PROMPT, 'chatRole': 'auto'})
    expected_dsh = next(b['prompt'] for b in original['bindings'] if b.get('enabled') is not False and
        'deepseek/deepseek-flash' in b.get('models', []))
    sandbox = Path(tempfile.mkdtemp(prefix='kupadesk008-live-'))
    package = sandbox / 'plugin'
    package.mkdir()
    meta = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    assert meta['version'] == '0.0.8' and not meta['magpie'].get('panels') and not meta['magpie'].get('actions')
    for name in meta['files'] + ['package.json']:
        a, b = ROOT / name, package / name
        shutil.copytree(a, b) if a.is_dir() else shutil.copy2(a, b)
    config = sandbox / 'config/magpie'
    config.mkdir(parents=True)
    profile = sandbox / 'profile'
    profile.mkdir()
    work = sandbox / 'work'
    work.mkdir()
    nonce = os.urandom(16).hex()
    (work / 'tool-check.txt').write_text(nonce, encoding='utf-8')
    if args.codex_check == 'image':
        def chunk(kind, data):
            return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
        png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 64, 64, 8, 2, 0, 0, 0))
        png += chunk(b'IDAT', zlib.compress((b'\0' + bytes([239, 68, 68]) * 64) * 64)) + chunk(b'IEND', b'')
        (work / 'tool-check.png').write_bytes(png)
        nonce = base64.b64encode(png).decode()
    report = {'version': meta['version'], 'profile': str(sandbox), 'results': {}, 'requests': []}
    targets = {}
    direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    external = urllib.request.build_opener()
    lock = threading.Lock()

    class Relay(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *_):
            pass

        def do_POST(self):
            raw = self.rfile.read(int(self.headers.get('Content-Length', '0')))
            body = json.loads(raw)
            egress = self.server is outgoing
            label = 'codex' if ('/codex/' in self.path if egress else self.path.split('?')[0].endswith('/responses')) else 'dsh'
            prompt = CODEX_PROMPT if label == 'codex' else expected_dsh
            def content_text(content):
                if isinstance(content, str):
                    return content
                return '\n'.join(p.get('text', '') for p in content if isinstance(p, dict)) if isinstance(content, list) else ''
            instructions = content_text(body.get('instructions')) if label == 'codex' else '\n'.join(
                content_text(m.get('content')) for m in body.get('messages', []) if m.get('role') in ['system', 'developer'])
            tools = body.get('tools', [])
            items = body.get('input', [])
            row = {'stage': 'upstream' if egress else 'client', 'client': label, 'tools': len(tools),
                'toolsSHA256': sha(tools), 'managedBlocks': instructions.count(START),
                'codeToolsSHA256': sha([t for t in tools if t.get('name') in ['exec', 'wait']]),
                'boundPromptPresent': prompt in instructions,
                'toolOutputs': sum(x.get('type') in ['function_call_output', 'custom_tool_call_output']
                    for x in items if isinstance(x, dict)) if isinstance(items, list) else 0,
                'toolResultContainsNonce': any(nonce in json.dumps(x.get('output', ''), ensure_ascii=False)
                    for x in items if isinstance(x, dict) and x.get('type') in ['function_call_output', 'custom_tool_call_output'])
                    if isinstance(items, list) else False}
            with lock:
                report['requests'].append(row)
            if label == 'codex' and isinstance(items, list):
                diagnostics = []
                for item in items:
                    if not isinstance(item, dict) or item.get('type') not in ['function_call_output', 'custom_tool_call_output']:
                        continue
                    value = json.dumps(item.get('output', ''), ensure_ascii=False)
                    diagnostics.extend(re.findall(r'(?i)(?:error|exception|permission|sandbox|not available|not found|unavailable|failed)[^\n]{0,350}', value))
                row['toolDiagnostics'] = diagnostics[:4]
            if egress:
                prefix = '/codex/v1' if label == 'codex' else '/dsh/v1'
                url = targets[label].rstrip('/') + self.path[len(prefix):]
                opener = external
            else:
                url = gateway + self.path
                opener = direct
            headers = {k: v for k, v in self.headers.items() if k.lower() not in
                ['host', 'content-length', 'connection', 'transfer-encoding', 'accept-encoding']}
            request = urllib.request.Request(url, data=raw, headers=headers)
            try:
                try:
                    response = opener.open(request, timeout=90)
                except urllib.error.HTTPError as error:
                    response = error
                with response:
                    row['status'] = response.status
                    self.send_response(response.status)
                    for k, v in response.headers.items():
                        if k.lower() not in ['content-length', 'connection', 'transfer-encoding']:
                            self.send_header(k, v)
                    self.send_header('Connection', 'close')
                    self.end_headers()
                    while chunk := response.read(8192):
                        self.wfile.write(chunk)
                        self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                row['disconnected'] = True
            except Exception as error:
                row['transportError'] = type(error).__name__
                self.close_connection = True

    outgoing = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Relay)
    incoming = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Relay)
    threads = []
    for server in [outgoing, incoming]:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        threads.append(thread)
    relay = f'http://127.0.0.1:{outgoing.server_port}'
    ingress = f'http://127.0.0.1:{incoming.server_port}'
    gateway = f'http://127.0.0.1:{args.port}'
    targets['codex'] = chosen[args.codex_provider]['responses']
    targets['dsh'] = chosen['deepseek']['chat']
    chosen[args.codex_provider]['responses'] = relay + '/codex/v1'
    chosen['deepseek']['chat'] = relay + '/dsh/v1'
    chosen['deepseek']['responses'] = relay + '/dsh/v1'
    chosen['deepseek']['models'] = ['deepseek-flash', 'deepseek-v4-pro']
    for provider in chosen.values():
        provider['proxy'] = 'direct'
    documents = {'providers.json': {'providers': list(chosen.values())},
        'settings.json': {'proxy': 'direct', 'noStats': True},
        'plugins.json': {'plugins': [{'spec': str(package), 'options': options}]}}
    for name, document in documents.items():
        (config / name).write_text(json.dumps(document, ensure_ascii=False), encoding='utf-8')
    env = os.environ.copy()
    env.update({'USERPROFILE': str(profile), 'APPDATA': str(sandbox / 'roaming'),
        'LOCALAPPDATA': str(sandbox / 'local'), 'XDG_CONFIG_HOME': str(sandbox / 'config'),
        'XDG_CACHE_HOME': str(sandbox / 'cache'), 'MAGPIE_ADDR': f'127.0.0.1:{args.port}',
        'MAGPIE_BUN': str(args.bun)})
    binary_sha = sha(args.magpie.read_bytes())
    log = (sandbox / 'host.log').open('wb')
    process = subprocess.Popen([str(args.magpie), 'serve'], env=env, cwd=sandbox, stdout=log, stderr=log,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)

    def run_client(label, command, client_env, task):
        print(json.dumps({'step': label, 'state': 'running'}), flush=True)
        result = subprocess.run(command, input=task, env=client_env, cwd=work, capture_output=True,
            text=True, encoding='utf-8', errors='replace', timeout=180)
        summary = {'exitCode': result.returncode, 'events': [], 'finalMarker': False}
        events = []
        for line in result.stdout.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            events.append(event)
            summary['events'].append(event.get('type', '?'))
        marker = 'KUPA008_CODEX_OK' if label == 'codex' else 'KUPA008_DSH_OK'
        summary['finalMarker'] = marker in result.stdout
        if label == 'codex':
            summary['itemTypes'] = [e.get('item', {}).get('type') for e in events if e.get('type') == 'item.completed']
            summary['modelMetadataWarning'] = 'metadata' in result.stderr.lower()
            summary['testReply'] = [e.get('item', {}).get('text', '')[:1200] for e in events if
                e.get('type') == 'item.completed' and e.get('item', {}).get('type') == 'agent_message']
            commands = [e.get('item', {}) for e in events if e.get('type') == 'item.completed' and
                e.get('item', {}).get('type') == 'command_execution']
            summary['check'] = args.codex_check
            summary['successfulReadOnlyTool'] = (nonce in result.stdout if args.codex_check == 'terminal' else
                any(r['client'] == 'codex' and r['toolResultContainsNonce'] for r in report['requests']))
            summary['commandEvents'] = len(commands)
        if result.returncode:
            summary['errorCategories'] = [word for word in ['401', '403', '429', 'timeout', 'invalid', 'not found', 'error']
                if word in result.stderr.lower() + result.stdout.lower()]
        report['results'][label] = summary
        print(json.dumps({'step': label, **summary}), flush=True)
        return result

    try:
        for _ in range(80):
            if process.poll() is not None:
                raise RuntimeError('isolated host exited')
            try:
                with direct.open(gateway + '/api/hello', timeout=.3):
                    break
            except (urllib.error.URLError, TimeoutError):
                time.sleep(.1)
        else:
            raise RuntimeError('isolated host startup timed out')
        clone_options = json.loads((config / 'plugins.json').read_text(encoding='utf-8'))['plugins'][0]['options']
        assert clone_options['bindings'][:-1] == original['bindings'], 'private prompts or bindings changed in clone'
        # Codex refuses to create helper binaries below the Windows temp root.
        codex_home = Path(tempfile.mkdtemp(prefix='kupadesk008-codex-', dir=args.report.parent))
        catalog_result = subprocess.run([str(args.codex), 'debug', 'models', '--bundled'],
            capture_output=True, text=True, encoding='utf-8', timeout=20, check=True)
        catalog = json.loads(catalog_result.stdout)
        metadata = next(row for row in catalog['models'] if row['slug'] == args.codex_model)
        # Third-party Responses endpoints use the public tools field. Keep
        # tool implementations intact; change only the test wire format.
        metadata['use_responses_lite'] = False
        catalog_path = codex_home / 'models.json'
        catalog_path.write_text(json.dumps({'models': [metadata]}), encoding='utf-8')
        client_env = os.environ.copy()
        client_env.update({'CODEX_HOME': str(codex_home), 'KUPADESK008_GATEWAY_KEY': 'magpie-codex'})
        command = [str(args.codex), 'exec', '--ephemeral', '--json', '--skip-git-repo-check', '--ignore-rules',
            '--ignore-user-config', '--enable', 'code_mode', '--enable', 'code_mode_only', '--disable', 'multi_agent',
            '-s', 'read-only', '-C', str(work), '-m', args.codex_model,
            '-c', 'approval_policy="never"',
            '-c', f'model_catalog_json="{catalog_path.as_posix()}"',
            '-c', 'model_provider="kupadesk008"', '-c', 'model_reasoning_effort="low"',
            '-c', 'model_providers.kupadesk008.name="KupaDesk 008 isolated"',
            '-c', f'model_providers.kupadesk008.base_url="{ingress}/v1"',
            '-c', 'model_providers.kupadesk008.wire_api="responses"',
            '-c', 'model_providers.kupadesk008.env_key="KUPADESK008_GATEWAY_KEY"',
            '-c', 'model_providers.kupadesk008.requires_openai_auth=false', '-']
        task = ('Use your terminal tool to read tool-check.txt from the current directory. Do not modify any file. '
            'Return the exact file content and KUPA008_CODEX_OK. Do not delegate or use the network.\n') if args.codex_check == 'terminal' else (
            'Use the built-in view_image tool to open tool-check.png in the current directory. '
            'Do not use a shell, do not modify files, and do not delegate. After inspecting the image, '
            'describe its color briefly and end with KUPA008_CODEX_OK.\n')
        run_client('codex', command, client_env, task)
        # Reuse only the current DSH model and Magpie adapter entries, without
        # copying its MCP, instructions, tools, account, or desktop configuration.
        if not args.only_codex:
            import yaml
            patch = yaml.compose((args.dsh_home / 'profiles/desktop/cordis.patch.yml').read_text(encoding='utf-8'))
            selected = []
            for row in patch.value:
                identity = next((v.value for k, v in row.value if k.value == 'id'), '')
                if identity in ['agent-default-model', 'llm-pi-ai']:
                    selected.append(row)
            assert len(selected) == 2, 'DSH Magpie adapter entries missing'
            text = yaml.serialize(yaml.SequenceNode('tag:yaml.org,2002:seq', selected))
            text = text.replace('http://127.0.0.1:3425/v1', ingress + '/v1')
            text += '\n- id: session-telemetry-otel\n  disabled: true\n- id: otel\n  disabled: true\n- id: session-title-llm\n  disabled: true\n'
            patch_path = sandbox / 'headless.patch.yml'
            patch_path.write_text(text, encoding='utf-8')
            dsh_env = os.environ.copy()
            dsh_env.update({'DSH_HOME': str(sandbox / 'dsh-home'), 'ELECTRON_RUN_AS_NODE': '1', 'MAGPIE_GATEWAY_KEY': 'magpie-dsh'})
            entry = args.dsh.parent / 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
            run_client('dsh', [str(args.dsh), str(entry), 'headless', '--patch', str(patch_path), '--json', '-'],
                dsh_env, '这是一次连通性测试。只回复 KUPA008_DSH_OK，不调用任何工具。\n')
        outgoing_codex = [r for r in report['requests'] if r['stage'] == 'upstream' and r['client'] == 'codex']
        outgoing_dsh = [r for r in report['requests'] if r['stage'] == 'upstream' and r['client'] == 'dsh']
        incoming_codex = [r for r in report['requests'] if r['stage'] == 'client' and r['client'] == 'codex']
        report['assertions'] = {
            'privateBindingsPreserved': clone_options['bindings'][:-1] == original['bindings'],
            'codexToolExecuted': report['results']['codex'].get('successfulReadOnlyTool', False),
            'codexToolsPreserved': bool(outgoing_codex) and all(r['tools'] > 0 and r['boundPromptPresent'] and r['managedBlocks'] == 1 for r in outgoing_codex)
                and [r['codeToolsSHA256'] for r in outgoing_codex] == [r['codeToolsSHA256'] for r in incoming_codex],
            'codexToolOutputRoundTrip': any(r['toolOutputs'] > 0 and r['toolResultContainsNonce'] for r in outgoing_codex),
        }
        if not args.only_codex:
            report['assertions'].update({
                'dshOriginalFullPromptInjected': bool(outgoing_dsh) and all(r['boundPromptPresent'] and r['managedBlocks'] == 1 for r in outgoing_dsh),
                'dshCompleted': report['results']['dsh']['exitCode'] == 0 and report['results']['dsh']['finalMarker'],
            })
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        log.close()
        for server, thread in zip([outgoing, incoming], threads):
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)
        report['productionUnchanged'] = all(sha(Path(p).read_bytes()) == value for p, value in before.items())
        report['officialBinaryUnchanged'] = sha(args.magpie.read_bytes()) == binary_sha
        report['preservedBindings'] = len(original['bindings'])
        report['preservedModelBindings'] = sum(len(b.get('models', [])) for b in original['bindings'])
        for provider in documents['providers.json']['providers']:
            provider.pop('key', None)
        (config / 'providers.json').write_text(json.dumps(documents['providers.json'], ensure_ascii=False), encoding='utf-8')
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({'report': str(args.report), 'productionUnchanged': report['productionUnchanged']}), flush=True)
    assert report['productionUnchanged'] and report['officialBinaryUnchanged']
    assert all(report.get('assertions', {}).values()), 'live client assertions failed; inspect the sanitized report'


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--magpie', type=Path, required=True)
    parser.add_argument('--bun', type=Path, required=True)
    parser.add_argument('--codex', type=Path, required=True)
    parser.add_argument('--dsh', type=Path, required=True)
    parser.add_argument('--dsh-home', type=Path, required=True)
    parser.add_argument('--codex-provider', required=True)
    parser.add_argument('--codex-model', default='gpt-6.1-sol')
    parser.add_argument('--port', type=int, default=14640)
    parser.add_argument('--only-codex', action='store_true')
    parser.add_argument('--codex-check', choices=['terminal', 'image'], default='terminal')
    parser.add_argument('--report', type=Path, required=True)
    main(parser.parse_args())
