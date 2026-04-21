export function parseXodrDoc(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(String(xmlText || ''), 'application/xml');
  const parserErr = doc.querySelector('parsererror');
  if (parserErr) throw new Error('XODR/XML 解析失败，请检查文件格式');
  const root = doc.querySelector('OpenDRIVE');
  if (!root) throw new Error('不是有效的 OpenDRIVE 文件');
  return { doc, root };
}

function resolveXodrContext(source) {
  if (source && typeof source === 'object' && source.doc && source.root) {
    return source;
  }
  return parseXodrDoc(source);
}

export function parseHeaderFromXodr(source) {
  const { root } = resolveXodrContext(source);
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

export function parseRoadContactPointsFromXodr(source) {
  const { doc } = resolveXodrContext(source);
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

export function parseRoadDetailsFromXodr(source) {
  const context = resolveXodrContext(source);
  const { doc } = context;
  const roadContact = parseRoadContactPointsFromXodr(context);
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
    detail.laneSectionsSpec = Array.from(roadEl.querySelectorAll(':scope > lanes > laneSection')).map((sectionEl) => {
      const laneLinks = {};
      const laneEls = Array.from(sectionEl.querySelectorAll(':scope > left > lane, :scope > center > lane, :scope > right > lane'));
      laneEls.forEach((laneEl) => {
        const laneId = String(laneEl.getAttribute('id') || '').trim();
        if (!laneId || laneId === '0') return;
        const laneLinkEl = laneEl.querySelector(':scope > link');
        if (!laneLinkEl) return;
        const predEl = laneLinkEl.querySelector(':scope > predecessor');
        const succEl = laneLinkEl.querySelector(':scope > successor');
        if (!predEl && !succEl) return;
        laneLinks[laneId] = {
          predecessor: predEl?.getAttribute('id') ?? '',
          successor: succEl?.getAttribute('id') ?? ''
        };
      });
      return {
        s: Number(sectionEl.getAttribute('s') || 0),
        singleSide: String(sectionEl.getAttribute('singleSide') || ''),
        laneLinks
      };
    });
    if (pred != null || succ != null) {
      details[rid] = detail;
    } else if (detail.laneSectionsSpec.length) {
      details[rid] = detail;
    }
  });
  return { details, rawRoads };
}

export function parseJunctionSpecsFromXodr(source) {
  const { doc } = resolveXodrContext(source);
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

export function parseOpenDriveExtrasFromXodr(source) {
  const { root } = resolveXodrContext(source);
  const serializer = new XMLSerializer();
  const extras = [];
  Array.from(root.children).forEach((child) => {
    const tag = String(child.tagName || '').toLowerCase();
    if (tag === 'header' || tag === 'road' || tag === 'junction') return;
    extras.push(serializer.serializeToString(child));
  });
  return extras;
}

export function parseXodrImportBundle(xmlText) {
  const context = parseXodrDoc(xmlText);
  return {
    header: parseHeaderFromXodr(context),
    roadDetails: parseRoadDetailsFromXodr(context),
    junctions: parseJunctionSpecsFromXodr(context),
    extras: parseOpenDriveExtrasFromXodr(context)
  };
}
