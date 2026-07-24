"""Test bootstrap: point the app's settings singleton at a throwaway data dir
BEFORE any app module is imported, so tests never touch a real library."""

import os
import tempfile

_data_dir = tempfile.mkdtemp(prefix="pm-test-data-")
os.environ["PM_DATA_DIR"] = _data_dir
