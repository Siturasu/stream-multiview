#!/usr/bin/env python3
"""Exercise packaging with a fake xcodebuild; never build or sign a real app."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile

source = Path(__file__).resolve().parents[1] / "build-ipa.sh"
for mode in ("failed-build", "missing-app", "fresh-build"):
    with tempfile.TemporaryDirectory(prefix="sv-ipa-check-") as temporary:
        root = Path(temporary)
        project = root / "ios"
        project.mkdir()
        script = project / source.name
        shutil.copy2(source, script)
        output = project / "build" / "StreamMultiview.ipa"
        output.parent.mkdir()
        output.write_bytes(b"previous ipa")
        stale_app = root / "stream-multiview-derived-ios/Build/Products/Release-iphoneos/Stream Multiview.app"
        stale_app.mkdir(parents=True)
        (stale_app / "stale.txt").write_text("old build")
        bin_dir = root / "bin"
        bin_dir.mkdir()
        fake = bin_dir / "xcodebuild"
        fake.write_text("""#!/bin/zsh
if [[ "$SV_CHECK_MODE" == "failed-build" ]]; then
  echo 'error: simulated build failure'
  exit 42
fi
if [[ "$SV_CHECK_MODE" == "fresh-build" ]]; then
  mkdir -p "$SV_CHECK_APP"
  echo 'new build' > "$SV_CHECK_APP/fresh.txt"
fi
echo '** BUILD SUCCEEDED **'
""")
        fake.chmod(0o755)
        env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "TMPDIR": str(root),
               "SV_CHECK_MODE": mode, "SV_CHECK_APP": str(stale_app)}
        result = subprocess.run(["/bin/zsh", str(script)], env=env, capture_output=True, text=True)
        if mode == "fresh-build":
            assert result.returncode == 0, result.stderr
            with zipfile.ZipFile(output) as archive:
                assert "Payload/Stream Multiview.app/fresh.txt" in archive.namelist()
                assert not any(name.endswith("stale.txt") for name in archive.namelist())
            assert "ipa:" in result.stdout
        else:
            assert result.returncode != 0, result.stdout
            assert output.read_bytes() == b"previous ipa"
            assert "ipa:" not in result.stdout
            assert not stale_app.exists()
        print(f"ok: {mode}")
print("3 IPA packaging checks passed")
