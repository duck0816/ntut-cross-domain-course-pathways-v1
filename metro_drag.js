(() => {
  "use strict";

  const CAREER = window.CAREER_METRO_DATA;
  if (!CAREER?.routes?.length) return;

  const STORAGE_PREFIX = "ntut-career-metro-layout:v2-topology:";
  const stateKey = `${STORAGE_PREFIX}${DATA.department.analysis_id}`;
  const G = { left: 90, plotWidth: 960, labelGap: 150, top: 105, laneGap: 118, stationGapX: 112, stationGapY: 96, right: 90, minHeight: 700 };
  const stationByCareerId = Object.fromEntries(CAREER.stations.map((station) => [station.station_id, station]));

  let saved = loadSaved();
  let activeCareer = "all";
  let currentLayout = null;
  let nodeDrag = null;
  let suppressClickUntil = 0;
  let redrawFrame = 0;
  let dragLocked = false;

  function emptyState() { return { stations: {}, careers: {} }; }
  function loadSaved() {
    try {
      const value = JSON.parse(localStorage.getItem(stateKey) || "null");
      return value && typeof value === "object" ? { stations: value.stations || {}, careers: value.careers || {} } : emptyState();
    } catch { return emptyState(); }
  }
  function saveLayout() {
    try { localStorage.setItem(stateKey, JSON.stringify(saved)); }
    catch { /* The map remains draggable for the current session. */ }
  }
  function hash(value) {
    let result = 2166136261;
    for (let index = 0; index < value.length; index += 1) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
    return (result >>> 0).toString(36);
  }
  function unique(values) { return [...new Set(values.filter(Boolean))]; }
  function isPrerequisiteRole(role) {
    return role?.node_type === "prerequisite" || role?.node_type === "recommended_prerequisite";
  }
  function roleRank(role) {
    if (isPrerequisiteRole(role)) return 0;
    if (role?.node_type === "course_gap") return 3;
    if (role?.node_type === "external_skill_course") return 2;
    return 1;
  }
  function routeMatchesSource(route) {
    const value = document.querySelector("#source-select").value;
    if (value === "104") return route.has_104_market_evidence;
    if (value === "cip") return route.has_cip_soc_evidence && !route.has_104_market_evidence;
    return true;
  }
  function shortCareerTitle(route) {
    if (route.market_job_titles_104?.length) return route.market_job_titles_104.join("／");
    let title = String(route.title || "職涯路徑");
    const plus = title.indexOf("＋");
    if (plus >= 0) title = title.slice(plus + 1);
    return title.replace(/(?:跨域)?(?:職涯|能力)?路徑$/u, "") || "職涯路徑";
  }
  function groupSignature(route) {
    const skills = route.skills.filter((skill) => skill.priority_tier !== "foundation").map((skill) => skill.skill_id).sort();
    const stations = [...route.station_ids, ...route.gap_station_ids].sort();
    return `${skills.join("|")}::${stations.join("|")}`;
  }
  function careerColor(signature) {
    const signatures = unique(CAREER.routes.map(groupSignature)).sort();
    const index = Math.max(0, signatures.indexOf(signature));
    const hue = Math.round((index * 137.508 + 198) % 360);
    return `hsl(${hue} 58% 40%)`;
  }
  function buildCareerGroups() {
    const grouped = new Map();
    for (const route of CAREER.routes.filter(routeMatchesSource)) {
      const signature = groupSignature(route);
      if (!grouped.has(signature)) grouped.set(signature, { signature, members: [] });
      grouped.get(signature).members.push(route);
    }
    return [...grouped.values()].map((group) => {
      const id = `career:${hash(group.signature)}`;
      const skillMap = new Map();
      for (const route of group.members) {
        for (const skill of route.skills) {
          const previous = skillMap.get(skill.skill_id);
          if (!previous || Number(skill.relative_priority || 0) > Number(previous.relative_priority || 0)) skillMap.set(skill.skill_id, skill);
        }
      }
      const memberLabels = unique(group.members.map(shortCareerTitle));
      const name = memberLabels.length === 1 ? memberLabels[0] : `${memberLabels.slice(0, 2).join("／")}等${memberLabels.length}職涯`;
      const fullStationIds = unique(group.members.flatMap((route) => [...route.station_ids, ...route.gap_station_ids]));
      const overviewStationIds = unique(group.members.flatMap((route) => [
        ...(route.station_roles || [])
          .filter((role) => !isPrerequisiteRole(role))
          .map((role) => role.station_id),
        ...route.gap_station_ids,
      ]));
      const edgeMap = new Map();
      for (const edge of group.members.flatMap((route) => route.edges)) {
        edgeMap.set(`${edge.from_station_id}|${edge.to_station_id}|${edge.relation}`, edge);
      }
      const stationRoles = {};
      for (const role of group.members.flatMap((route) => route.station_roles || [])) {
        const previous = stationRoles[role.station_id];
        if (!previous || roleRank(role) > roleRank(previous)) stationRoles[role.station_id] = role;
      }
      for (const id of fullStationIds.filter((stationId) => stationId.startsWith("gap:"))) {
        stationRoles[id] = { station_id: id, node_type: "course_gap", skill_ids: [], skill_names: [] };
      }
      return {
        id,
        name,
        color: careerColor(group.signature),
        members: group.members,
        skills: [...skillMap.values()],
        stationIds: fullStationIds,
        fullStationIds,
        overviewStationIds,
        stationRoles,
        edges: [...edgeMap.values()],
      };
    });
  }
  function sharedStations(a, b) {
    const right = new Set(b.overviewStationIds);
    return a.overviewStationIds.reduce((count, id) => count + (right.has(id) ? 1 : 0), 0);
  }
  function orderGroups(groups) {
    if (groups.length < 3) return groups;
    const remaining = [...groups];
    remaining.sort((a, b) => {
      const aTotal = remaining.reduce((sum, row) => sum + sharedStations(a, row), 0);
      const bTotal = remaining.reduce((sum, row) => sum + sharedStations(b, row), 0);
      return bTotal - aTotal || b.stationIds.length - a.stationIds.length || a.name.localeCompare(b.name);
    });
    const ordered = [remaining.shift()];
    while (remaining.length) {
      remaining.sort((a, b) => {
        const aNear = Math.max(...ordered.map((row) => sharedStations(a, row)));
        const bNear = Math.max(...ordered.map((row) => sharedStations(b, row)));
        return bNear - aNear || b.stationIds.length - a.stationIds.length || a.name.localeCompare(b.name);
      });
      ordered.push(remaining.shift());
    }
    return ordered;
  }
  function careerLabelWidth(group) { return Math.min(330, Math.max(190, group.name.length * 14 + 70)); }

  function selectedRelationMode() {
    return document.querySelector("#relation-select")?.value || "none";
  }
  function relationModeLabel(mode = selectedRelationMode()) {
    if (mode === "all") return "顯示正式＋建議先備";
    if (mode === "formal") return "只顯示正式／明文先修";
    return "只顯示主課與能力課";
  }
  function stationIdsForRelationMode(group, mode) {
    const ids = new Set(group.overviewStationIds);
    if (mode === "all") return [...new Set([...group.fullStationIds, ...ids])];
    if (mode === "formal") {
      for (const [stationId, role] of Object.entries(group.stationRoles)) {
        if (role?.node_type === "prerequisite") ids.add(stationId);
      }
    }
    return [...ids];
  }

  function orderedStationIds(group) {
    const ids = [...group.displayStationIds];
    const idSet = new Set(ids);
    const outgoing = Object.fromEntries(ids.map((id) => [id, []]));
    const indegree = Object.fromEntries(ids.map((id) => [id, 0]));
    for (const edge of group.edges) {
      if (!idSet.has(edge.from_station_id) || !idSet.has(edge.to_station_id) || edge.from_station_id === edge.to_station_id) continue;
      if (!outgoing[edge.from_station_id].includes(edge.to_station_id)) {
        outgoing[edge.from_station_id].push(edge.to_station_id);
        indegree[edge.to_station_id] += 1;
      }
    }
    const compare = (left, right) => {
      const roleDifference = roleRank(group.stationRoles[left]) - roleRank(group.stationRoles[right]);
      if (roleDifference) return roleDifference;
      const leftShared = currentMembershipSeed?.[left]?.length || 0;
      const rightShared = currentMembershipSeed?.[right]?.length || 0;
      return rightShared - leftShared || (stationByCareerId[left]?.name_zh || left).localeCompare(stationByCareerId[right]?.name_zh || right);
    };
    const queue = ids.filter((id) => indegree[id] === 0).sort(compare);
    const result = [];
    while (queue.length) {
      const id = queue.shift();
      result.push(id);
      for (const target of outgoing[id]) {
        indegree[target] -= 1;
        if (indegree[target] === 0) { queue.push(target); queue.sort(compare); }
      }
    }
    return [...result, ...ids.filter((id) => !result.includes(id)).sort(compare)];
  }

  let currentMembershipSeed = null;
  function separateTopologyStations(positions, membership, maxY) {
    const ids = Object.keys(positions);
    for (let pass = 0; pass < 55; pass += 1) {
      let moved = false;
      for (let leftIndex = 0; leftIndex < ids.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < ids.length; rightIndex += 1) {
          const left = positions[ids[leftIndex]];
          const right = positions[ids[rightIndex]];
          const dx = Math.abs(left.x - right.x);
          const dy = Math.abs(left.y - right.y);
          if (dx >= G.stationGapX || dy >= G.stationGapY) continue;
          const overlap = (G.stationGapY - dy) / 2 + 2;
          const direction = left.y === right.y ? (ids[leftIndex] < ids[rightIndex] ? -1 : 1) : Math.sign(left.y - right.y);
          left.y += direction * overlap;
          right.y -= direction * overlap;
          left.y = Math.max(G.top, Math.min(maxY, left.y));
          right.y = Math.max(G.top, Math.min(maxY, right.y));
          moved = true;
        }
      }
      if (!moved) break;
    }
    for (const id of ids) {
      const relatedLanes = membership[id] || [];
      if (relatedLanes.length > 1) positions[id].y = Math.max(G.top, Math.min(maxY, positions[id].y));
    }
  }

  function calculateLayout() {
    let groups = orderGroups(buildCareerGroups());
    if (activeCareer !== "all") groups = groups.filter((group) => group.id === activeCareer);
    const relationMode = selectedRelationMode();
    groups.forEach((group) => {
      group.displayStationIds = stationIdsForRelationMode(group, relationMode);
    });
    const lane = {};
    groups.forEach((group, index) => { lane[group.id] = G.top + index * G.laneGap; });
    const membership = {};
    for (const group of groups) {
      for (const id of group.displayStationIds) (membership[id] ||= []).push(group.id);
    }
    currentMembershipSeed = membership;
    groups.forEach((group) => { group.orderedStationIds = orderedStationIds(group); });
    currentMembershipSeed = null;
    const progress = {};
    for (const group of groups) {
      const count = group.orderedStationIds.length;
      group.orderedStationIds.forEach((id, index) => {
        const normalized = count < 2 ? 0.5 : index / (count - 1);
        (progress[id] ||= []).push(normalized);
      });
    }
    const positions = {};
    const networkBottom = Math.max(G.minHeight - 100, G.top + Math.max(1, groups.length - 1) * G.laneGap);
    for (const [id, groupIds] of Object.entries(membership)) {
      const ys = groupIds.map((groupId) => lane[groupId]).sort((a, b) => a - b);
      const desiredY = ys[Math.floor((ys.length - 1) / 2)] || G.top;
      const averageProgress = (progress[id] || [0.5]).reduce((sum, value) => sum + value, 0) / (progress[id]?.length || 1);
      positions[id] = { x: G.left + averageProgress * G.plotWidth, y: desiredY };
    }
    separateTopologyStations(positions, membership, networkBottom);
    let maxY = networkBottom + 105;
    for (const [id, point] of Object.entries(positions)) {
      const manual = saved.stations[id] || { dx: 0, dy: 0 };
      point.x += Number(manual.dx) || 0;
      point.y += Number(manual.dy) || 0;
      maxY = Math.max(maxY, point.y + 105);
    }
    const labels = {};
    const labelX = G.left + G.plotWidth + G.labelGap;
    for (const group of groups) {
      const manual = saved.careers[group.id] || { dx: 0, dy: 0 };
      labels[group.id] = { x: labelX + (Number(manual.dx) || 0), y: lane[group.id] + (Number(manual.dy) || 0), width: careerLabelWidth(group) };
      maxY = Math.max(maxY, labels[group.id].y + 50);
    }
    const width = labelX + Math.max(330, ...groups.map(careerLabelWidth)) + G.right;
    const height = Math.max(G.minHeight, maxY + 45);
    currentLayout = { groups, lane, membership, positions, labels, width, height, relationMode };
    return currentLayout;
  }

  function routePoints(group, layout) {
    const label = layout.labels[group.id];
    const stations = group.orderedStationIds.map((id) => ({ ...layout.positions[id], stationId: id }))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    const destination = { x: label.x, y: label.y };
    return stations.length ? [...stations, destination] : [{ x: destination.x - 55, y: destination.y }, destination];
  }
  function sharedEdgeOffsets(layout) {
    const edges = new Map();
    for (const group of layout.groups) {
      const points = routePoints(group, layout);
      for (let index = 1; index < points.length; index += 1) {
        const a = points[index - 1].stationId;
        const b = points[index].stationId;
        if (!a || !b) continue;
        const key = [a, b].sort().join("::");
        if (!edges.has(key)) edges.set(key, []);
        edges.get(key).push(group.id);
      }
    }
    const result = {};
    for (const [key, ids] of edges) {
      ids.sort();
      ids.forEach((id, index) => { result[`${id}::${key}`] = (index - (ids.length - 1) / 2) * 8; });
    }
    return result;
  }
  function segmentPath(a, b, offset = 0) {
    const direction = b.x >= a.x ? 1 : -1;
    const dx = Math.abs(b.x - a.x);
    const lead = Math.min(28, Math.max(14, dx * 0.18));
    const ax = a.x + direction * lead;
    const bx = b.x - direction * lead;
    if (Math.abs(a.y - b.y) < 3) {
      return `M${a.x},${a.y} L${ax},${a.y} L${ax + direction * 9},${a.y + offset} L${bx - direction * 9},${b.y + offset} L${bx},${b.y} L${b.x},${b.y}`;
    }
    const middle = (ax + bx) / 2 + offset * 1.5;
    return `M${a.x},${a.y} L${ax},${a.y} L${middle},${a.y} L${middle},${b.y} L${bx},${b.y} L${b.x},${b.y}`;
  }
  function careerPath(group, layout, offsets) {
    const points = routePoints(group, layout);
    let path = "";
    for (let index = 1; index < points.length; index += 1) {
      const a = points[index - 1];
      const b = points[index];
      const key = a.stationId && b.stationId ? [a.stationId, b.stationId].sort().join("::") : "";
      path += `${segmentPath(a, b, key ? offsets[`${group.id}::${key}`] || 0 : 0)} `;
    }
    return path.trim();
  }
  function dependencyPath(a, b, status) {
    if (status === "reverse_observed_position") {
      const lower = Math.max(a.y, b.y) + 52;
      return `M${a.x},${a.y} C${a.x},${lower} ${b.x},${lower} ${b.x},${b.y}`;
    }
    const middle = (a.x + b.x) / 2;
    return `M${a.x},${a.y} C${middle},${a.y} ${middle},${b.y} ${b.x},${b.y}`;
  }
  function wrapText(value, length = 9) {
    const text = String(value || "");
    if (text.length <= length) return [text];
    const rest = text.slice(length);
    return [text.slice(0, length), rest.length <= length ? rest : `${rest.slice(0, length - 1)}…`];
  }
  function stationAbilities(station) {
    const names = [...(station.skill_names || [])];
    const legacy = DATA.stations.find((row) => row.station_id === station.station_id);
    for (const lineId of legacy?.line_ids || []) {
      if (lineById[lineId]?.line_type === "cross_domain") names.push(lineById[lineId].name);
    }
    return unique(names);
  }
  function stationMarkup(station, point, layout) {
    const groupIds = layout.membership[station.station_id] || [];
    const groups = groupIds.map((id) => layout.groups.find((group) => group.id === id)).filter(Boolean);
    const transfer = groups.length > 1;
    const gap = station.node_types?.includes("course_gap");
    const color = groups[0]?.color || "#173f5f";
    const names = wrapText(station.name_zh);
    const abilities = stationAbilities(station);
    const nameMarkup = names.map((text, index) => `<text class="course-name" text-anchor="middle" y="${40 + index * 16}">${esc(text)}</text>`).join("");
    const departmentY = 42 + names.length * 16;
    const abilityY = departmentY + 15;
    const transferY = abilityY + (abilities.length ? 15 : 0);
    const dots = transfer && activeCareer !== "all" ? groups.slice(0, 10).map((group, index) => {
      const angle = Math.PI * 2 * index / groups.length;
      return `<circle cx="${(Math.cos(angle) * 27).toFixed(1)}" cy="${(Math.sin(angle) * 27).toFixed(1)}" r="3.5" fill="${group.color}"/>`;
    }).join("") : "";
    return `<g class="station draggable-node ${transfer ? "transfer" : ""} ${gap ? "gap" : ""} ${selectedStation?.station_id === station.station_id ? "selected" : ""}" data-station="${esc(station.station_id)}" data-careers="${groupIds.map(esc).join(" ")}" transform="translate(${point.x},${point.y})">
      <title>${esc(station.name_zh)}｜${groupIds.length} 條職涯線</title>${transfer ? '<circle class="transfer-ring" r="24"/>' : ""}${dots}
      <rect class="station-box" x="-18" y="-18" width="36" height="36" rx="8" stroke="${gap ? "#B65420" : color}"/>
      <text class="term" text-anchor="middle" y="4">${esc(gap ? "缺口" : station.position?.label || "待定")}</text>
      ${nameMarkup}<text class="course-meta" text-anchor="middle" y="${departmentY}">${esc(shorten(station.department_names?.[0] || "目前無對應課程", 13))}</text>
      ${abilities.length ? `<text class="ability-note" text-anchor="middle" y="${abilityY}">能力：${esc(shorten(abilities[0], 11))}${abilities.length > 1 ? `＋${abilities.length - 1}` : ""}</text>` : ""}
      ${transfer ? `<text class="transfer-note" text-anchor="middle" y="${transferY}">共用於 ${groups.length} 條職涯線</text>` : ""}
    </g>`;
  }
  function careerLabel(group, point) {
    const mainCount = group.overviewStationIds.filter((id) => !id.startsWith("gap:")).length;
    const fullCount = group.fullStationIds.filter((id) => !id.startsWith("gap:")).length;
    const gapCount = group.fullStationIds.length - fullCount;
    const sourceLabel = group.members.some((member) => member.has_104_market_evidence) ? "104" : "CIP–SOC";
    return `<g class="career-label draggable-node" data-career="${group.id}" data-line="${group.id}" transform="translate(${point.x},${point.y})">
      <title>${esc(group.members.map((member) => member.title).join("／"))}</title><rect x="0" y="-27" width="${point.width}" height="54" rx="10" stroke="${group.color}"/>
      <circle cx="17" cy="-7" r="6" fill="${group.color}"/><text class="career-name" x="30" y="-3">${esc(shorten(group.name, 17))}</text>
      <text class="career-meta" x="17" y="16">${sourceLabel} · 主課 ${mainCount} 門 · 完整 ${fullCount} 門${gapCount ? ` · ${gapCount} 缺口` : ""}</text>
    </g>`;
  }

  function drawCareerMetro() {
    const layout = calculateLayout();
    const svg = document.querySelector("#metro-svg");
    svg.classList.toggle("overview-mode", activeCareer === "all");
    const offsets = sharedEdgeOffsets(layout);
    let body = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10Z" fill="#607381"/></marker><marker id="arrow-warn" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10Z" fill="#b65420"/></marker></defs>`;
    body += `<text class="network-heading" x="${G.left}" y="35">課程路網</text><text class="network-note" x="${G.left}" y="56">位置依共用與先備關係安排；站內保留實際學期</text><text class="network-heading" x="${G.left + G.plotWidth + G.labelGap}" y="35">職涯方向</text>`;
    const relationMode = layout.relationMode;
    if (relationMode !== "none") {
      const edgeMap = new Map();
      for (const group of layout.groups) for (const edge of group.edges) edgeMap.set(`${edge.from_station_id}|${edge.to_station_id}|${edge.relation}`, edge);
      for (const edge of edgeMap.values()) {
        if (relationMode === "formal" && edge.relation === "recommended_knowledge_prerequisite") continue;
        const a = layout.positions[edge.from_station_id];
        const b = layout.positions[edge.to_station_id];
        if (!a || !b) continue;
        const className = edge.relation === "recommended_knowledge_prerequisite" ? "recommended" : edge.timing_status === "reverse_observed_position" ? "reverse" : "";
        const path = dependencyPath(a, b, edge.timing_status);
        body += `<path class="dependency-casing" d="${path}"/><path class="dependency ${className}" d="${path}"/>`;
      }
    }
    for (const group of layout.groups) {
      const path = careerPath(group, layout, offsets);
      body += `<path class="career-casing" data-career="${group.id}" d="${path}"/><path class="career-line" data-career="${group.id}" d="${path}" stroke="${group.color}"/><path class="line-hit" data-career="${group.id}" data-line="${group.id}" d="${path}"><title>${esc(group.name)}</title></path>`;
    }
    for (const [id, groupIds] of Object.entries(layout.membership)) {
      const station = stationByCareerId[id];
      const point = layout.positions[id];
      if (station && point && groupIds.length) body += stationMarkup(station, point, layout);
    }
    for (const group of layout.groups) body += careerLabel(group, layout.labels[group.id]);
    svg.style.height = `${layout.height}px`;
    svg.setAttribute("viewBox", viewBox ? `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}` : `0 0 ${layout.width} ${layout.height}`);
    svg.innerHTML = body;
    bindInteractions(svg);
    const transfers = Object.values(layout.membership).filter((ids) => ids.length > 1).length;
    const modeText = relationModeLabel(layout.relationMode);
    document.querySelector("#map-caption").textContent = `${modeText} · ${layout.groups.length} 條職涯線 · ${Object.keys(layout.membership).length} 個課程／缺口站 · ${transfers} 個共用站`;
    document.querySelector("#side-summary").textContent = layout.relationMode === "none"
      ? "目前只畫各職涯直接選入的主課與能力課；可用「先備顯示」加入正式或建議先備。"
      : layout.relationMode === "formal"
        ? "目前已加入正式先修、官方課程順序與明文學習先備；不含建議知識先備。"
        : "目前已加入正式、明文與建議知識先備；虛線箭頭代表建議先備。";
  }

  function bindInteractions(svg) {
    svg.querySelectorAll("[data-station]").forEach((element) => {
      element.addEventListener("pointerdown", beginStationDrag, { capture: true });
      element.onclick = (event) => { event.stopPropagation(); selectedStation = stationByCareerId[element.dataset.station]; renderCourseDetail(selectedStation); draw(); openDrawer(); };
    });
    svg.querySelectorAll("[data-career]").forEach((element) => {
      if (element.classList.contains("career-label")) element.addEventListener("pointerdown", beginCareerDrag, { capture: true });
      element.onclick = (event) => { event.stopPropagation(); selectCareer(element.dataset.career, true); };
      element.addEventListener("mouseenter", () => setHoverCareer(svg, element.dataset.career));
      element.addEventListener("mouseleave", () => setHoverCareer(svg, null));
    });
  }
  function setHoverCareer(svg, careerId) {
    svg.querySelectorAll("[data-career]").forEach((element) => {
      element.classList.toggle("hover-muted", Boolean(careerId) && element.dataset.career !== careerId);
      element.classList.toggle("hover-focus", Boolean(careerId) && element.dataset.career === careerId);
    });
    svg.querySelectorAll("[data-careers]").forEach((element) => {
      const careers = (element.dataset.careers || "").split(" ");
      element.classList.toggle("hover-muted", Boolean(careerId) && !careers.includes(careerId));
      element.classList.toggle("hover-focus", Boolean(careerId) && careers.includes(careerId));
    });
    const caption = document.querySelector("#map-caption");
    if (careerId) {
      const group = currentLayout?.groups.find((row) => row.id === careerId);
      if (group) caption.textContent = `聚焦：${group.name} · 主課 ${group.overviewStationIds.filter((id) => !id.startsWith("gap:")).length} 門；先備範圍由上方選單控制`;
    } else if (currentLayout) {
      const transfers = Object.values(currentLayout.membership).filter((ids) => ids.length > 1).length;
      const modeText = relationModeLabel(currentLayout.relationMode);
      caption.textContent = `${modeText} · ${currentLayout.groups.length} 條職涯線 · ${Object.keys(currentLayout.membership).length} 個課程／缺口站 · ${transfers} 個共用站`;
    }
  }
  function sourceName(group) {
    const market = group.members.some((member) => member.has_104_market_evidence);
    const cip = group.members.some((member) => member.has_cip_soc_evidence);
    return market && cip ? "104＋CIP–SOC" : market ? "104市場職涯" : "CIP–SOC探索";
  }
  function renderCourseDetail(station) {
    const abilities = stationAbilities(station);
    const groups = buildCareerGroups().filter((group) => group.stationIds.includes(station.station_id));
    const reasons = station.selection_reasons || [];
    document.querySelector("#detail").innerHTML = `<h3>${esc(station.name_zh)}</h3><div class="tags"><span class="tag">${esc(station.course_code || "能力缺口")}</span><span class="tag">${esc(station.credits ?? "—")} 學分</span><span class="tag">${esc(station.position?.label || "位置待確認")}</span>${groups.length > 1 ? `<span class="tag">${groups.length} 條職涯共用</span>` : ""}</div><h4>開課系所</h4><p>${esc(station.department_names?.join("／") || "目前沒有對應課程")}</p><h4>對應能力</h4><ul>${abilities.map((name) => `<li>${esc(name)}</li>`).join("") || "<li>先備課程；未直接指定能力。</li>"}</ul><h4>出現在哪些職涯線</h4><ul>${groups.map((group) => `<li>${esc(group.name)}</li>`).join("")}</ul><h4>選入理由</h4><ul>${reasons.slice(0, 8).map((reason) => `<li>${esc(reason)}</li>`).join("") || "<li>由該職涯主課的先備閉包納入。</li>"}</ul><h4>位置來源</h4><p>${esc(station.position?.source_label || "位置待確認")}；最近開課：${esc(station.availability?.latest_term || "未觀察")}</p>`;
  }
  function renderCareerDetail(group) {
    const courses = group.fullStationIds.map((id) => stationByCareerId[id]).filter(Boolean).sort((a, b) => (a.position?.term || 9) - (b.position?.term || 9) || a.name_zh.localeCompare(b.name_zh));
    const mainCount = group.overviewStationIds.filter((id) => !id.startsWith("gap:")).length;
    const core = group.skills.filter((skill) => skill.priority_tier === "core");
    const support = group.skills.filter((skill) => skill.priority_tier === "support");
    const foundation = group.skills.filter((skill) => skill.priority_tier === "foundation");
    document.querySelector("#detail").innerHTML = `<h3>${esc(group.name)}</h3><div class="tags"><span class="tag">${esc(sourceName(group))}</span><span class="tag">主課 ${mainCount} 門</span><span class="tag">含先備共 ${courses.filter((course) => !course.station_id.startsWith("gap:")).length} 門</span><span class="tag">${group.skills.length} 項能力</span>${group.members.length > 1 ? `<span class="tag">合併 ${group.members.length} 個職涯</span>` : ""}</div><h4>成員職涯</h4><ul>${group.members.map((member) => `<li>${esc(member.title)}</li>`).join("")}</ul><h4>本科基礎能力</h4><p>${esc(foundation.map((skill) => skill.name_zh).join("、") || "目前未另列")}</p><h4>核心能力</h4><ul>${core.map((skill) => `<li>${esc(skill.name_zh)}${skill.course_coverage === "course_gap" ? "｜校內課程缺口" : ""}</li>`).join("") || "<li>目前未另列。</li>"}</ul><h4>支援能力</h4><ul>${support.map((skill) => `<li>${esc(skill.name_zh)}${skill.course_coverage === "course_gap" ? "｜校內課程缺口" : ""}</li>`).join("") || "<li>目前未另列。</li>"}</ul><h4>完整課程順序（含先備）</h4><ol>${courses.map((course) => `<li>${esc(course.position?.label || "待確認")}｜${esc(course.name_zh)}${course.station_id.startsWith("gap:") ? "（能力缺口）" : ""}</li>`).join("")}</ol><h4>O*NET職業</h4><ul>${unique(group.members.flatMap((member) => member.occupations.map((occupation) => `${occupation.title}｜${occupation.soc}`))).map((text) => `<li>${esc(text)}</li>`).join("")}</ul>`;
  }
  function renderCareerList() {
    const groups = buildCareerGroups();
    document.querySelector("#detail").innerHTML = `<h3>職涯路徑</h3><div class="overlap-note"><b>如何閱讀</b><br>共同停靠代表多條職涯共用課程。點選職涯可聚焦單一路徑；是否加入正式與建議先備，請使用上方「先備顯示」。</div><div class="jobs">${groups.map((group) => `<button class="job ${activeCareer === group.id ? "active" : ""}" data-career-choice="${group.id}"><b>${esc(group.name)}</b><small>${esc(sourceName(group))} · 主課 ${group.overviewStationIds.filter((id) => !id.startsWith("gap:")).length} 門 · 完整 ${group.fullStationIds.filter((id) => !id.startsWith("gap:")).length} 門</small></button>`).join("") || '<div class="empty">目前篩選條件下沒有職涯路徑。</div>'}</div>`;
    document.querySelectorAll("[data-career-choice]").forEach((button) => { button.onclick = () => selectCareer(button.dataset.careerChoice, false); });
  }
  function selectCareer(id, showDrawer) {
    activeCareer = id;
    selectedStation = null;
    const select = document.querySelector("#line-select");
    if ([...select.options].some((option) => option.value === id)) select.value = id;
    viewBox = null;
    const group = buildCareerGroups().find((row) => row.id === id);
    if (group) renderCareerDetail(group); else renderCareerList();
    draw();
    if (showDrawer) openDrawer();
  }
  function refreshCareerOptions() {
    const groups = buildCareerGroups();
    const select = document.querySelector("#line-select");
    select.innerHTML = '<option value="all">顯示全部職涯線</option>' + groups.map((group) => `<option value="${group.id}">${esc(group.name)}</option>`).join("");
    if (!groups.some((group) => group.id === activeCareer)) activeCareer = "all";
    select.value = activeCareer;
  }

  function svgPoint(event) {
    const svg = document.querySelector("#metro-svg");
    const point = svg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
    return point.matrixTransform(svg.getScreenCTM().inverse());
  }
  function beginStationDrag(event) {
    if (dragLocked || event.button !== 0) return;
    const id = event.currentTarget.dataset.station;
    nodeDrag = { type: "station", id, start: svgPoint(event), offset: { ...(saved.stations[id] || { dx: 0, dy: 0 }) }, moved: false };
    event.preventDefault(); event.stopPropagation();
  }
  function beginCareerDrag(event) {
    if (dragLocked || event.button !== 0) return;
    const id = event.currentTarget.dataset.career;
    nodeDrag = { type: "career", id, start: svgPoint(event), offset: { ...(saved.careers[id] || { dx: 0, dy: 0 }) }, moved: false };
    event.preventDefault(); event.stopPropagation();
  }
  function moveNode(event) {
    if (!nodeDrag) return;
    const point = svgPoint(event);
    const dx = point.x - nodeDrag.start.x;
    const dy = point.y - nodeDrag.start.y;
    nodeDrag.moved ||= Math.hypot(dx, dy) > 4;
    (nodeDrag.type === "station" ? saved.stations : saved.careers)[nodeDrag.id] = { dx: nodeDrag.offset.dx + dx, dy: nodeDrag.offset.dy + dy };
    if (!redrawFrame) redrawFrame = requestAnimationFrame(() => { redrawFrame = 0; draw(); });
    event.preventDefault();
  }
  function endNodeDrag() {
    if (!nodeDrag) return;
    if (nodeDrag.moved) { suppressClickUntil = Date.now() + 350; saveLayout(); }
    nodeDrag = null;
  }

  function installUI() {
    const lineLabel = document.querySelector('label[for="line-select"]');
    if (lineLabel) lineLabel.textContent = "職涯路徑";
    const mastCopy = document.querySelector(".mast p");
    if (mastCopy) mastCopy.textContent = "職涯是線、課程是站；捷運圖依路網關係配置，不再受八學期欄位限制。";
    const svgDescription = document.querySelector("#svg-desc");
    if (svgDescription) svgDescription.textContent = "課程位置依共用與先備關係配置；站內學期僅作為實際開課資訊。";
    const legend = document.querySelector(".legend");
    if (legend) legend.innerHTML = '<span><i class="sample"></i>一色一組職涯路徑</span><span><i class="sample dashed"></i>建議先備箭頭</span><span><i class="station-sample"></i>主課／能力課</span><span><i class="station-sample transfer"></i>多職涯共用課程</span><span>點職涯線聚焦；先備範圍由上方選單控制</span>';
    const relation = document.querySelector("#relation-select");
    if (!relation.querySelector('option[value="none"]')) relation.insertAdjacentHTML("afterbegin", '<option value="none">先隱藏先備線</option>');
    relation.value = "none";
    relation.onchange = () => { viewBox = null; draw(); };
    document.querySelector("#source-select").onchange = () => { activeCareer = "all"; refreshCareerOptions(); renderCareerList(); viewBox = null; draw(); };
    refreshCareerOptions();
    document.querySelector("#line-select").onchange = (event) => {
      activeCareer = event.target.value; selectedStation = null; viewBox = null;
      if (activeCareer === "all") renderCareerList(); else renderCareerDetail(buildCareerGroups().find((group) => group.id === activeCareer));
      draw(); if (activeCareer !== "all") openDrawer();
    };
    const toolbar = document.querySelector(".map-toolbar");
    const fit = document.querySelector("#fit");
    const hint = document.createElement("span"); hint.className = "drag-hint"; hint.textContent = "拖曳只調整圖面，不改學期"; toolbar.insertBefore(hint, fit);
    const lock = document.createElement("button"); lock.type = "button"; lock.textContent = "鎖定站位";
    lock.onclick = () => { dragLocked = !dragLocked; lock.textContent = dragLocked ? "解除鎖定" : "鎖定站位"; };
    toolbar.insertBefore(lock, fit);
    const reset = document.createElement("button"); reset.id = "reset-node-layout"; reset.type = "button"; reset.textContent = "重設站位";
    reset.onclick = () => { saved = emptyState(); saveLayout(); viewBox = null; draw(); };
    toolbar.insertBefore(reset, fit); fit.textContent = "重設視野";

    const metroTab = document.querySelector("#metro-tab");
    const timelineTab = document.querySelector("#timeline-tab");
    const metroView = document.querySelector("#metro-view");
    const timelineView = document.querySelector("#timeline-view");
    const switchView = (showMetro) => {
      metroView.classList.toggle("hidden", !showMetro);
      timelineView.classList.toggle("active", !showMetro);
      metroTab.classList.toggle("active", showMetro);
      timelineTab.classList.toggle("active", !showMetro);
      metroTab.setAttribute("aria-selected", String(showMetro));
      timelineTab.setAttribute("aria-selected", String(!showMetro));
      if (showMetro) draw();
      else closeDrawer();
    };
    metroTab.onclick = () => switchView(true);
    timelineTab.onclick = () => switchView(false);
    if (!timelineView.querySelector(".timeline-return-bar")) {
      const returnBar = document.createElement("div");
      returnBar.className = "timeline-return-bar";
      returnBar.innerHTML = '<button type="button" class="timeline-return">← 返回捷運圖</button><span>八學期時間軸保留原版內容；可隨時回到捷運圖。</span>';
      returnBar.querySelector("button").onclick = () => switchView(true);
      timelineView.insertBefore(returnBar, timelineView.firstChild);
    }
  }
  function installStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .map-scroll svg{background:#f8fafb}.map-toolbar .drag-hint{margin-left:auto;color:#536b7a;font-size:12px}.network-heading{fill:#173f5f;font:800 15px "Microsoft JhengHei",sans-serif;letter-spacing:.08em}.network-note{fill:#718491;font:600 11px "Microsoft JhengHei",sans-serif}
      .career-casing{fill:none;stroke:#fff;stroke-width:13;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}.career-line{fill:none;stroke-width:6;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}.line-hit{fill:none;stroke:transparent;stroke-width:23;cursor:pointer}
      .dependency-casing{fill:none;stroke:#fff;stroke-width:7}.dependency{fill:none;stroke:#607381;stroke-width:1.8;marker-end:url(#arrow)}.dependency.recommended{stroke-dasharray:7 6}.dependency.reverse{stroke:#b65420;stroke-width:2.4;marker-end:url(#arrow-warn)}
      .station,.career-label{cursor:grab;touch-action:none}.station .station-box{fill:#fff;stroke-width:4;filter:drop-shadow(0 3px 3px rgba(20,37,54,.16))}.station .transfer-ring{fill:#fff;stroke:#142536;stroke-width:3}.station.gap .station-box{fill:#fff3ec;stroke-dasharray:5 4}.station.selected .station-box{stroke-width:6}
      .station text{pointer-events:none;paint-order:stroke;stroke:#f8fafb;stroke-width:5px;stroke-linejoin:round}.station .term{fill:#142536;stroke:#fff;stroke-width:3px;font:800 9px Consolas,"Microsoft JhengHei",sans-serif}.station .course-name{fill:#172735;font-size:13px;font-weight:800}.station .course-meta{fill:#637482;font-size:10px;font-weight:600}.station .ability-note{fill:#365d73;font-size:10px;font-weight:700}.station .transfer-note{fill:#8b4f18;font-size:10px;font-weight:800}
      .career-label rect{fill:#fff;stroke-width:3;filter:drop-shadow(0 3px 4px rgba(20,37,54,.13))}.career-label text{pointer-events:none}.career-label .career-name{fill:#172735;font-size:13px;font-weight:800}.career-label .career-meta{fill:#637482;font-size:10px;font-weight:650}
      .career-line,.career-casing,.career-label,.station{transition:opacity .16s ease,filter .16s ease,stroke-width .16s ease}.overview-mode .career-line{stroke-width:2.5;opacity:.24}.overview-mode .career-casing{stroke-width:6;opacity:.5}.overview-mode .career-label{opacity:.82}.hover-muted{opacity:.045!important}.career-line.hover-focus,.overview-mode .career-line.hover-focus{stroke-width:8;opacity:1}.career-casing.hover-focus,.overview-mode .career-casing.hover-focus{stroke-width:14;opacity:1}.career-label.hover-focus,.station.hover-focus{opacity:1;filter:drop-shadow(0 0 6px rgba(20,37,54,.24))}
      .timeline-return-bar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:12px;padding:10px 14px;border:1px solid #d5dfe4;border-bottom:0;background:rgba(248,250,251,.97);box-shadow:0 4px 12px rgba(20,37,54,.08);color:#536b7a;font-size:12px}.timeline-return{border:1px solid #173f5f;border-radius:7px;background:#173f5f;color:#fff;padding:8px 13px;font-weight:800;cursor:pointer}.timeline-return:hover{background:#235b79}
      @media(max-width:900px){.map-toolbar .drag-hint{display:none}}
    `;
    document.head.appendChild(style);
  }

  window.addEventListener("pointermove", moveNode, { passive: false });
  window.addEventListener("pointerup", endNodeDrag); window.addEventListener("pointercancel", endNodeDrag);
  document.addEventListener("click", (event) => { if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  draw = drawCareerMetro;
  installStyles(); installUI(); renderCareerList(); draw();
})();
