#!/usr/bin/env python3
"""Print the complete ordered SQL plan; never connects to or changes a database."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def migration_paths(root: Path = ROOT) -> list[Path]:
    paths = list((root / 'supabase' / 'migrations').glob('*.sql'))
    paths += list((root / 'supabase' / 'manual-migrations').glob('*.sql'))
    # The first two legacy filenames contain an underscore after their date.
    def version(path: Path) -> str:
        return re.match(r'[\d_]+', path.name).group().replace('_', '')
    paths.sort(key=lambda path: (version(path), path.name))
    versions = [version(path) for path in paths]
    if len(versions) != len(set(versions)):
        raise SystemExit('Duplicate migration versions; resolve ordering before applying SQL.')
    return paths


if __name__ == '__main__':
    for migration in migration_paths():
        print(migration.relative_to(ROOT))
