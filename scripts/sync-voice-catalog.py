"""Copy browser catalog metadata into isolated worker and Edge Function deployments."""
import argparse
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = root / "ui/voice-catalog.json"
targets = [root / "Livekit-Agents/src/voice_catalog.json", root / "supabase/functions/agents/voice-catalog.json"]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--check", action="store_true")
args = parser.parse_args()
for target in targets:
    if args.check:
        if not target.exists() or target.read_bytes() != source.read_bytes():
            raise SystemExit(f"Catalog out of sync: {target}")
    else:
        target.write_bytes(source.read_bytes())
