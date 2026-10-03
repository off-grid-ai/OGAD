"""Exercise the real helper process against a synthetic compositor CLI boundary."""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HELPER = Path(__file__).resolve().parents[1] / 'desktop.py'
# A valid one-pixel PNG: the compositor boundary provides image bytes, not product state.
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4XkAAAAASUVORK5CYII=')

class WindowContract(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.env = {**os.environ, 'PATH': str(self.root) + os.pathsep + os.environ['PATH'],
                    'SWAYSOCK': str(self.root / 'compositor.sock'), 'XDG_CURRENT_DESKTOP': 'sway'}
        self.env.pop('HYPRLAND_INSTANCE_SIGNATURE', None)
        self.window = dict(type='con', id=42, focused=True, name='Document — synthetic',
                           app_id='synthetic-editor', pid=123, rect=dict(x=-1280, y=30, width=640, height=480))
        self.tree = self.root / 'tree.json'
        self.tree.write_text(json.dumps(dict(type='root', nodes=[dict(type='output', nodes=[self.window])], floating_nodes=[])))
        self.env['COMPOSITOR_TREE'] = str(self.tree)
        self.env['COMPOSITOR_PNG'] = str(self.root / 'pixel.png')
        (self.root / 'pixel.png').write_bytes(PNG)
        self.executable('swaymsg', '''import json, os, sys
from pathlib import Path
p=Path(os.environ['COMPOSITOR_TREE'])
if sys.argv[1:] == ['-t', 'get_tree', '-r']: print(p.read_text())
else:
    identifier=int(sys.argv[1].split('=')[1].rstrip(']'))
    window=json.loads(p.read_text())['nodes'][0]['nodes'][0]
    print(json.dumps([{'success': identifier == window['id']}]))
''')
        self.executable('grim', '''import json, os, sys
from pathlib import Path
p=Path(os.environ['COMPOSITOR_TREE'])
window=json.loads(p.read_text())['nodes'][0]['nodes'][0]
b=window['rect']
expected=f"{b['x']},{b['y']} {b['width']}x{b['height']}"
if sys.argv[1:3] != ['-g', expected]: sys.exit(3)
Path(sys.argv[3]).write_bytes(Path(os.environ['COMPOSITOR_PNG']).read_bytes())
if os.environ.get('SWITCH_DURING_CAPTURE'):
    tree=json.loads(p.read_text()); tree['nodes'][0]['nodes'][0]['id']=43; p.write_text(json.dumps(tree))
''')

    def executable(self, name, body):
        p = self.root / name
        p.write_text('#!' + sys.executable + '\n' + body)
        p.chmod(0o755)

    def tearDown(self):
        self.directory.cleanup()

    def call(self, *args):
        result = subprocess.run([sys.executable, str(HELPER), *args], env=self.env,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_focus_identifies_exact_window_on_second_monitor(self):
        result = self.call('focus')
        self.assertEqual(result['token'], 'sway:42')
        self.assertEqual(result['owner']['name'], 'synthetic-editor')
        self.assertEqual(result['title'], self.window['name'])
        self.assertEqual(result['bounds'], self.window['rect'])

    def test_capture_returns_compositor_image_of_focused_bounds(self):
        result = self.call('capture', '42')
        self.assertEqual(base64.b64decode(result['png']), PNG)

    def test_capture_rejects_wrong_window(self):
        self.assertIsNone(self.call('capture', '43'))

    def test_capture_discards_image_when_focus_changes(self):
        self.env['SWITCH_DURING_CAPTURE'] = '1'
        self.assertIsNone(self.call('capture', '42'))

    def test_restore_accepts_only_exact_window(self):
        self.assertTrue(self.call('activate', 'sway:42'))
        self.assertFalse(self.call('activate', 'sway:43'))

    def test_no_focused_window_does_not_capture(self):
        self.window['focused'] = False
        self.tree.write_text(json.dumps(dict(type='root', nodes=[self.window])))
        self.assertIsNone(self.call('focus'))
        self.assertIsNone(self.call('capture', '42'))

if __name__ == '__main__':
    unittest.main()
