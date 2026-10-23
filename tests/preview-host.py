"""Loopback-only UI preview. Never loads the injection runtime or writes live settings."""
import argparse
import hashlib
import http.server
import json
import pathlib
import threading
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parents[1]
PAGE = ROOT / 'page'
PRIVATE = ROOT / 'evidence' / 'preview-private'
LIVE = pathlib.Path.home() / '.config' / 'magpie'
PUBLIC_ASSETS = {p.name for p in PAGE.iterdir() if p.is_file()}
LOCK = threading.Lock()


def write_json(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(path)


def initialize():
    PRIVATE.mkdir(exist_ok=True, parents=True)
    original = PRIVATE / 'original-options.json'
    if not original.exists():
        raw = json.loads((LIVE / 'plugins.json').read_text(encoding='utf-8-sig'))
        matches = [p for p in raw['plugins'] if 'kupadesk' in p.get('spec', '').lower()]
        if len(matches) != 1:
            raise RuntimeError('Expected one installed KupaDesk; refusing to guess')
        options = matches[0].get('options', {})
        # Copy UI settings only. No login, sync credentials, provider keys or routes.
        options = {k: options[k] for k in ('schemaVersion', 'enabled', 'gatewayTimeoutMs', 'bindings', 'catalogSync', 'view', 'diagnostics') if k in options}
        write_json(original, options)
        write_json(PRIVATE / 'options.json', options)
        catalog = LIVE / 'plugins' / 'node_modules' / 'kupadesk' / 'page' / 'kupadesk-native-003-model-catalog.js'
        source = catalog.read_text(encoding='utf-8-sig')
        value = json.loads(source.split('window.KUPADESK_MODEL_CATALOG = ', 1)[1].rsplit(';', 1)[0])
        value.pop('injection', None)  # 015's runtime records are not 016 test results.
        (PRIVATE / 'catalog.js').write_text('window.KUPADESK_MODEL_CATALOG = ' + json.dumps(value, ensure_ascii=False) + ';\n', encoding='utf-8')
        live_files = [LIVE / 'plugins.json'] + list((LIVE / 'plugins' / 'node_modules' / 'kupadesk').glob('*.mjs')) + list((LIVE / 'plugins' / 'node_modules' / 'kupadesk' / 'page').glob('*'))
        write_json(PRIVATE / 'live-baseline.json', {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in live_files if p.is_file()})
    return json.loads(original.read_text(encoding='utf-8'))


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, code, body=b'', content_type='application/json; charset=utf-8'):
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; frame-ancestors 'self'; connect-src 'self'; base-uri 'self'")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.headers.get('Host') != f'127.0.0.1:{self.server.server_port}':
            return self.reply(403, b'{}')
        route = urllib.parse.urlparse(self.path).path
        if route == '/':
            data = (ROOT / 'tests' / 'preview-host.html').read_text(encoding='utf-8')
            data = data.replace('</head>', '<meta name="preview-data" content="' + ('synthetic' if self.server.synthetic else 'private-copy') + '"></head>')
            return self.reply(200, data.encode('utf-8'), 'text/html; charset=utf-8')
        if route == '/preview-host.js':
            return self.reply(200, (ROOT / 'tests' / 'preview-host.js').read_bytes(), 'text/javascript; charset=utf-8')
        if route == '/api/options':
            with LOCK:
                return self.reply(200, (PRIVATE / 'options.json').read_bytes())
        if route.startswith('/plugin/') and route.rsplit('/', 1)[-1] in PUBLIC_ASSETS:
            name = route.rsplit('/', 1)[-1]
            target = PRIVATE / 'catalog.js' if name == 'kupadesk-native-003-model-catalog.js' else PAGE / name
            kind = {'js': 'text/javascript', 'css': 'text/css', 'html': 'text/html', 'svg': 'image/svg+xml'}.get(name.rsplit('.', 1)[-1], 'application/octet-stream')
            data = target.read_bytes()
            diagnostics = PRIVATE / 'diagnostics.json'
            if name == 'kupadesk-native-003-model-catalog.js' and diagnostics.exists():
                source = data.decode('utf-8')
                value = json.loads(source.split('window.KUPADESK_MODEL_CATALOG = ', 1)[1].rsplit(';', 1)[0])
                value['injection'] = json.loads(diagnostics.read_text(encoding='utf-8'))
                data = ('window.KUPADESK_MODEL_CATALOG = ' + json.dumps(value, ensure_ascii=True) + ';\n').encode('utf-8')
            return self.reply(200, data, kind + '; charset=utf-8')
        return self.reply(404, b'{}')

    def do_POST(self):
        origin = f'http://127.0.0.1:{self.server.server_port}'
        if self.headers.get('Origin') != origin or self.headers.get('X-Kupa-Preview') != '1':
            return self.reply(403, b'{}')
        if self.path != '/api/options':
            return self.reply(404, b'{}')
        length = int(self.headers.get('Content-Length', '0'))
        if length <= 0 or length > 48 * 1024:
            return self.reply(413, b'{}')
        try:
            value = json.loads(self.rfile.read(length))
            if not isinstance(value, dict) or value.get('schemaVersion') != 1 or not isinstance(value.get('bindings'), list):
                raise ValueError('Invalid options')
            with LOCK:
                write_json(PRIVATE / 'options.json', value)
            self.reply(200, json.dumps(value, ensure_ascii=False).encode('utf-8'))
        except (ValueError, TypeError):
            self.reply(400, b'{}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=4692)
    parser.add_argument('--synthetic', action='store_true', help='Use clearly labelled example data instead of copying private settings')
    args = parser.parse_args()
    if args.synthetic:
        PRIVATE = ROOT / 'evidence' / 'synthetic-preview'
        PRIVATE.mkdir(exist_ok=True, parents=True)
        options = {'schemaVersion': 1, 'enabled': True, 'bindings': [
            {'id': 'sample', 'name': '示例 · 工作助手', 'prompt': '这是独立预览的示例提示词。\n保持回答清楚，准确说明完成情况。',
             'enabled': True, 'models': ['deepseek/deepseek-flash'], 'chatRole': 'auto'},
            {'id': 'sample-writing', 'name': '示例 · 写作', 'prompt': '这是独立预览的写作示例。', 'enabled': True, 'models': [], 'chatRole': 'auto'}]}
        catalog = {'schemaVersion': 1, 'status': 'ready', 'checkedAt': '2026-10-24T11:00:00Z',
                   'providers': [{'id': p, 'name': n} for p, n in [('deepseek', 'DeepSeek'), ('codex', 'Codex'), ('kimi', 'Kimi'), ('devin', 'Devin')]],
                   'models': [{'id': p + '/' + model, 'name': name, 'provider': p, 'providerName': provider} for p, model, name, provider in [
                       ('deepseek', 'deepseek-flash', 'DeepSeek Flash', 'DeepSeek'), ('deepseek', 'deepseek-pro', 'DeepSeek Pro', 'DeepSeek'),
                       ('codex', 'gpt-6-astra', 'GPT-6 Astra', 'Codex'), ('codex', 'gpt-6.1-sol', 'GPT-6.1 Sol', 'Codex'),
                       ('kimi', 'k3.1-pro', 'K3.1 Pro', 'Kimi'), ('devin', 'gemini-4-argon', 'Gemini 4 Argon', 'Devin')]]}
        for name in ['original-options.json', 'options.json']:
            if not (PRIVATE / name).exists(): write_json(PRIVATE / name, options)
        (PRIVATE / 'catalog.js').write_text('window.KUPADESK_MODEL_CATALOG = ' + json.dumps(catalog) + ';\n', encoding='utf-8')
    else:
        options = initialize()
    server = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.synthetic = args.synthetic
    print(json.dumps({'preview': f'http://127.0.0.1:{server.server_port}/', 'prompts': len(options.get('bindings', [])), 'bindings': sum(len(x.get('models', [])) for x in options.get('bindings', [])), 'productionWrites': False, 'exampleData': args.synthetic}), flush=True)
    server.serve_forever()
