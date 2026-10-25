# SPDX-License-Identifier: AGPL-3.0-only
import importlib.util
import io
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace as N
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('reader',Path(__file__).parents[1]/'scripts/update-reader.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(m.signal.alarm, 0)

    def test_rejects_arbitrary_commands_and_arguments_before_open(self):
        for value in ('','id','cat /etc/shadow','hostboard-updates-v1 extra','docker pull example'):
            with patch.dict(os.environ,{'SSH_ORIGINAL_COMMAND':value}),patch.object(m.os,'open') as opened,patch.object(m.sys,'argv',['reader']):
                with self.assertRaises(SystemExit):m.main()
                opened.assert_not_called()
        with patch.dict(os.environ,{'SSH_ORIGINAL_COMMAND':'hostboard-updates-v1'}),patch.object(m.sys,'argv',['reader','arbitrary']):
            with self.assertRaises(SystemExit):m.main()

    def test_fixed_file_regular_root_owned_bounded_snapshot(self):
        actual_open=os.open
        for uid,mode,size,success in [(0,stat.S_IFREG|0o640,2,True),(1000,stat.S_IFREG|0o640,2,False),(0,stat.S_IFREG|0o666,2,False),(0,stat.S_IFIFO|0o640,2,False),(0,stat.S_IFREG|0o640,4000001,False)]:
            with tempfile.TemporaryDirectory() as d:
                p=Path(d)/'status.json';p.write_bytes(b'{}')
                opened=[]
                def open_fixed(path,flags):
                    opened.append(path);self.assertTrue(flags&os.O_NOFOLLOW);return actual_open(p,os.O_RDONLY)
                output=io.BytesIO()
                with patch.dict(os.environ,{'SSH_ORIGINAL_COMMAND':'hostboard-updates-v1'}),patch.object(m.sys,'argv',['reader']),patch.object(m.sys,'stdout',N(buffer=output)),patch.object(m.os,'open',side_effect=open_fixed),patch.object(m.os,'fstat',return_value=N(st_uid=uid,st_mode=mode,st_size=size)):
                    if success:m.main();self.assertEqual(output.getvalue(),b'{}')
                    else:
                        with self.assertRaises(SystemExit):m.main()
                self.assertEqual(opened,['/var/lib/hostboard-updates/status.json'])

if __name__=='__main__':unittest.main()
