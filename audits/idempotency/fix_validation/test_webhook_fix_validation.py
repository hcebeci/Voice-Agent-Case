from pathlib import Path
import subprocess
import tempfile

import pytest

ROOT=Path(__file__).resolve().parents[3]

@pytest.mark.parametrize('scenario',['normal','concurrent','append','lifecycle','materialized','processed'])
def test_webhook_current_handler_retries_materialization_without_duplicate_events(scenario):
    source=(ROOT/'supabase/functions/livekit-webhook/index.ts').read_text()
    body=source[source.index('type LiveKitEvent'):source.index('/** Receive signed LiveKit callbacks;')]
    fixture=Path(__file__).with_name('webhook_handler_harness.mts').read_text()
    imports=f"import {{getLifecycleUpdate}} from '{(ROOT/'supabase/functions/livekit-webhook/lifecycle.mjs').as_uri()}';\n"
    with tempfile.TemporaryDirectory(prefix='webhook-fixed-') as directory:
        probe=Path(directory)/'probe.mts';probe.write_text(imports+fixture.replace('// HANDLER',body))
        result=subprocess.run(['node','--experimental-strip-types',str(probe),scenario],capture_output=True,text=True)
        assert result.returncode==0,result.stdout+result.stderr
