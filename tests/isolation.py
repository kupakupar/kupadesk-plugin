"""Hash protection for the live installation; never print private contents."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / 'evidence' / 'live-protection.json'
CONFIG = Path.home() / '.config/magpie'
INSTALLED = CONFIG / 'plugins/node_modules/kupadesk'


def snapshot():
    files = [CONFIG / n for n in ['plugins.json', 'providers.json', 'settings.json', 'sync.json']]
    # Runtime-generated catalogs and indexes naturally update; package sources do not.
    files += [p for p in INSTALLED.rglob('*') if p.is_file() and
              p.name not in ['kupadesk-native-003-model-catalog.js', 'request-index.js', 'index.html', '.native-assets-key']]
    files += [Path.home() / 'AppData/Local/Programs/magpie/magpie.exe']
    values = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in files if p.is_file()}
    doc = json.loads((CONFIG / 'plugins.json').read_text(encoding='utf-8-sig'))
    entries = [x for x in doc.get('plugins', []) if 'kupadesk' in x.get('spec', '')]
    assert len(entries) == 1
    options = entries[0].get('options', {})
    return {'files': values, 'version': json.loads((INSTALLED / 'package.json').read_text(encoding='utf-8-sig'))['version'],
            'entry': entries[0]['spec'], 'prompts': len(options.get('bindings', [])),
            'bindings': sum(len(x.get('models', [])) for x in options.get('bindings', [])),
            'optionsHash': hashlib.sha256(json.dumps(options, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['baseline', 'verify', 'checkpoint', 'verify-runtime'])
    args = parser.parse_args()
    current = snapshot()
    if args.action == 'baseline':
        REPORT.parent.mkdir(exist_ok=True)
        if REPORT.exists():
            raise RuntimeError('Baseline already exists; refusing to replace it')
        REPORT.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding='utf-8')
    elif args.action == 'checkpoint':
        checkpoint = REPORT.with_name('live-options-checkpoint.json')
        if checkpoint.exists(): raise RuntimeError('Checkpoint already exists')
        checkpoint.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding='utf-8')
    elif args.action == 'verify-runtime':
        baseline = json.loads(REPORT.read_text(encoding='utf-8'))
        changed = [name for name, digest in baseline['files'].items() if current['files'].get(name) != digest]
        allowed_dynamic = {str(CONFIG / name) for name in ['plugins.json', 'providers.json', 'settings.json', 'sync.json']}
        assert all(name in allowed_dynamic for name in changed), 'Installed package/program changed'
        checkpoint = json.loads(REPORT.with_name('live-options-checkpoint.json').read_text(encoding='utf-8'))
        assert current['optionsHash'] == checkpoint['optionsHash'], 'KupaDesk settings changed since observation checkpoint'
        for key in ['version', 'entry', 'prompts', 'bindings']: assert current[key] == baseline[key]
        print(json.dumps({'packageAndOfficialBinaryUnchanged': True, 'optionsUnchangedSinceCheckpoint': True,
                          'wholeConfigurationHashesUnchanged': not bool(changed),
                          'changedConfigurationFiles': [Path(x).name for x in changed]}))
    else:
        baseline = json.loads(REPORT.read_text(encoding='utf-8'))
        changed = [name for name, digest in baseline['files'].items() if current['files'].get(name) != digest]
        assert not changed, 'Protected files changed: ' + ', '.join(Path(x).name for x in changed)
        assert current['version'] == baseline['version'] == '0.0.15'
        assert {k: v for k, v in current.items() if k != 'files'} == {k: v for k, v in baseline.items() if k != 'files'}
    print(json.dumps({'action': args.action, 'version': current['version'], 'protectedFiles': len(current['files']),
                      'prompts': current['prompts'], 'bindings': current['bindings'], 'liveWrites': False}))
