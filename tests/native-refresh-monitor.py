"""Sample only descendants of the explicitly identified isolated test host."""
import argparse
import json
import time
from pathlib import Path
import psutil

p = argparse.ArgumentParser()
p.add_argument('--pid', type=int, required=True)
p.add_argument('--seconds', type=int, default=630)
p.add_argument('--output', type=Path, required=True)
a = p.parse_args()
root = psutil.Process(a.pid)
if root.name().lower() != 'native-refresh-host.exe':
    raise SystemExit('unexpected root process; no sampling performed')
previous = {}
rows = []
started = last = time.monotonic()
while root.is_running() and time.monotonic() - started < a.seconds:
    now = time.monotonic()
    processes = [root, *root.children(recursive=True)]
    metrics = []
    for proc in processes:
        try:
            cpu = sum(proc.cpu_times()[:2])
            before = previous.get(proc.pid, cpu)
            metrics.append({'pid': proc.pid, 'name': proc.name(), 'coreUse': round((cpu - before) / max(now - last, .001), 3),
                            'rssMB': round(proc.memory_info().rss / 1048576, 1)})
            previous[proc.pid] = cpu
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    rows.append({'seconds': round(now - started, 2), 'processes': metrics})
    a.output.write_text(json.dumps({'seconds': round(now-started), 'rows': rows}, indent=2), encoding='utf-8')
    last = now
    time.sleep(5)
print(json.dumps({'samples': len(rows), 'peakCoreUse': max(p['coreUse'] for row in rows for p in row['processes'])}))
