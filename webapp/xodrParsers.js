function parseXodrDoc(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(String(xmlText || ''), 'application/xml');
  const parserErr = doc.querySelector('parsererror');
  if (parserErr) throw new Error('XODR/XML 解析失败，请检查文件格式');
  const root = doc.querySelector('OpenDRIVE');
  if (!root) throw new Error('不是有效的 OpenDRIVE 文件');
  return { doc, root };
}

export function parseHeaderFromXodr(xmlText) {
  const { root } = parseXodrDoc(xmlText);
  const header = root.querySelector(':scope > header');
  if (!header) {
    return {
      rawHeaderXml: '',
      name: '',
      vendor: '',
      north: undefined,
      south: undefined,
      east: undefined,
      west: undefined
    };
  }
  return {
    rawHeaderXml: new XMLSerializer().serializeToString(header),
    name: header.getAttribute('name') || '',
    vendor: header.getAttribute('vendor') || '',
    north: header.hasAttribute('north') ? Number(header.getAttribute('north')) : undefined,
    south: header.hasAttribute('south') ? Number(header.getAttribute('south')) : undefined,
    east: header.hasAttribute('east') ? Number(header.getAttribute('east')) : undefined,
    west: header.hasAttribute('west') ? Number(header.getAttribute('west')) : undefined
  };
}

export function parseRoadContactPointsFromXodr(xmlText) {
  const { doc } = parseXodrDoc(xmlText);
  const out = {};
  doc.querySelectorAll('OpenDRIVE > road').forEach((roadEl) => {
    const rid = String(roadEl.getAttribute('id') || '').trim();
    if (!rid) return;
    const linkEl = roadEl.querySelector(':scope > link');
    if (!linkEl) return;
    const pred = linkEl.querySelector(':scope > predecessor');
    const succ = linkEl.querySelector(':scope > successor');
    out[rid] = {
      predecessorContactPoint: pred?.getAttribute('contactPoint') || '',
      successorContactPoint: succ?.getAttribute('contactPoint') || ''
    };
  });
  return out;
}

export function parseRoadDetailsFromXodr(xmlText) {
  const { doc } = parseXodrDoc(xmlText);
  const roadContact = parseRoadContactPointsFromXodr(xmlText);
  const rawRoads = {};
  const details = {};
  doc.querySelectorAll('OpenDRIVE > road').forEach((roadEl) => {
    const rid = String(roadEl.getAttribute('id') || '').trim();
    if (!rid) return;
    rawRoads[rid] = new XMLSerializer().serializeToString(roadEl);
    const detail = {
      predecessorType: 'road',
      predecessorId: '',
      predecessorContactPoint: roadContact[rid]?.predecessorContactPoint || 'end',
      successorType: 'road',
      successorId: '',
      successorContactPoint: roadContact[rid]?.successorContactPoint || 'start'
    };
    const linkEl = roadEl.querySelector(':scope > link');
    const pred = linkEl?.querySelector(':scope > predecessor');
    const succ = linkEl?.querySelector(':scope > successor');
    if (pred) {
      detail.predecessorType = pred.getAttribute('elementType') || 'road';
      detail.predecessorId = pred.getAttribute('elementId') || '';
      detail.predecessorContactPoint = pred.getAttribute('contactPoint') || detail.predecessorContactPoint;
    }
    if (succ) {
      detail.successorType = succ.getAttribute('elementType') || 'road';
      detail.successorId = succ.getAttribute('elementId') || '';
      detail.successorContactPoint = succ.getAttribute('contactPoint') || detail.successorContactPoint;
    }
    if (pred != null || succ != null) {
      details[rid] = detail;
    }
  });
  return { details, rawRoads };
}

export function parseJunctionSpecsFromXodr(xmlText) {
  const { doc } = parseXodrDoc(xmlText);
  const specs = [];
  const rawById = {};
  doc.querySelectorAll('OpenDRIVE > junction').forEach((junctionEl) => {
    const jid = String(junctionEl.getAttribute('id') || '').trim();
    if (!jid) return;
    rawById[jid] = new XMLSerializer().serializeToString(junctionEl);
    const connections = Array.from(junctionEl.querySelectorAll(':scope > connection')).map((connEl, idx) => ({
      id: String(connEl.getAttribute('id') || idx),
      incomingRoad: String(connEl.getAttribute('incomingRoad') || ''),
      connectingRoad: String(connEl.getAttribute('connectingRoad') || ''),
      contactPoint: String(connEl.getAttribute('contactPoint') || 'start'),
      laneLinks: Array.from(connEl.querySelectorAll(':scope > laneLink')).map((laneEl) => ({
        from: String(laneEl.getAttribute('from') || ''),
        to: String(laneEl.getAttribute('to') || '')
      }))
    }));
    specs.push({
      id: jid,
      name: String(junctionEl.getAttribute('name') || `junction_${jid}`),
      connections,
      rawJunctionXml: rawById[jid]
    });
  });
  return { specs, rawById };
}

export function parseOpenDriveExtrasFromXodr(xmlText) {
  const { root } = parseXodrDoc(xmlText);
  const serializer = new XMLSerializer();
  const extras = [];
  Array.from(root.children).forEach((child) => {
    const tag = String(child.tagName || '').toLowerCase();
    if (tag === 'header' || tag === 'road' || tag === 'junction') return;
    extras.push(serializer.serializeToString(child));
  });
  return extras;
}
