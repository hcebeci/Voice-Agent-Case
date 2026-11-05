/** Decode only safe timestamp/UUID values before constructing a PostgREST filter. */
export function decodeCursor(value) {
  if (!value) return null;
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid cursor');
  const cursor = JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/')));
  if (!cursor || !/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(cursor.created_at)
    || !Number.isFinite(Date.parse(cursor.created_at))
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor.id)) throw new Error('Invalid cursor');
  return cursor;
}

export function pageSessions(rows, limit) {
  const sessions = rows.slice(0, limit);
  const last = sessions.at(-1);
  const next_cursor = rows.length > limit && last
    ? btoa(JSON.stringify({created_at:last.created_at,id:last.id})).replaceAll('+','-').replaceAll('/','_').replaceAll('=','') : null;
  return {sessions,next_cursor};
}
