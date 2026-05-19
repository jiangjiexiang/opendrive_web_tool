export function addIdsToFlagMap(targetRef, ids) {
  if (!Array.isArray(ids) || !ids.length) return;
  const next = { ...(targetRef.value || {}) };
  ids.forEach((id) => {
    const sid = String(id ?? '').trim();
    if (!sid) return;
    next[sid] = true;
  });
  targetRef.value = next;
}

export function postJson(url, payload) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(async (res) => {
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  });
}

export function formatErrorMessage(error) {
  const raw = String(error?.message || error || '').trim();
  if (!raw) return '未知错误';
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.error) return String(parsed.error);
  } catch (_) {}
  return raw;
}

export function installImportApi(host) {
  function detachImportedSource(options = {}) {
    if (host.suppressDetach.value) return;
    host.importedXodrText.value = '';

    if (options.headerChanged) {
      host.headerDirty.value = true;
    }

    const roadIds = Array.isArray(options.roadIds) ? options.roadIds : [];
    const junctionIds = Array.isArray(options.junctionIds) ? options.junctionIds : [];
    if (roadIds.length) addIdsToFlagMap(host.dirtyRoadIds, roadIds);
    if (junctionIds.length) addIdsToFlagMap(host.dirtyJunctionIds, junctionIds);
  }

  host.addIdsToFlagMap = addIdsToFlagMap;
  host.detachImportedSource = detachImportedSource;
  host.postJson = postJson;
  host.formatErrorMessage = formatErrorMessage;
}
