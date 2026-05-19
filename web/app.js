const state = {
  config: null,
  routeMode: "destination",
  stops: [],
  route: null,
  records: [],
  fuelDetails: [],
  destinationPool: [],
};

const $ = (id) => document.getElementById(id);

function setStatus(message, isError = false) {
  const status = $("status");
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function amapHeaders() {
  const key = $("amapKey").value.trim();
  return key ? { "X-AMAP-Key": key } : {};
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...amapHeaders(),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.detail || "请求失败");
  }
  return data;
}

function money(value) {
  return `${Number(value || 0).toFixed(2)} 元`;
}

function number2(value) {
  return Number(value || 0).toFixed(2);
}

function calcLiters(km) {
  return Number(km || 0) * state.config.fuel_rate;
}

function calcAmount(km, price) {
  return calcLiters(km) * Number(price || 0);
}

function todayText() {
  return new Date().toISOString().slice(0, 10);
}

function parseLocalDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function shuffle(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function defaultDestinationPool() {
  return [];
}

function renderPriceStrip(prices) {
  const strip = $("priceStrip");
  strip.innerHTML = "";
  for (const row of prices) {
    const pill = document.createElement("div");
    pill.className = "price-pill";
    pill.innerHTML = `<span>${row.effective_date} 生效</span><strong>${Number(row.price).toFixed(2)} 元/L</strong>`;
    strip.appendChild(pill);
  }
}

function renderCandidates(pois) {
  const box = $("candidates");
  box.innerHTML = "";
  state.route = null;
  updateRouteCard();

  for (const poi of pois) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "candidate";
    button.innerHTML = `
      <i aria-hidden="true">⌖</i>
      <div>
        <strong>${poi.name}</strong>
        <span>${[poi.district, poi.type, poi.location].filter(Boolean).join(" · ") || "高德候选地点"}</span>
      </div>
    `;
    button.addEventListener("click", () => {
      commitPoi(poi);
    });
    box.appendChild(button);
  }
}

function destinationLabel(stops) {
  return stops.map((stop) => stop.name).join("-");
}

function resetCurrentRouteInput() {
  state.stops = [];
  state.routeMode = "destination";
  state.route = null;
  $("keyword").value = "";
  $("candidates").innerHTML = "";
  updateRouteCard();
}

function routeWaypoints() {
  return state.stops.filter((stop) => stop.role === "waypoint");
}

function routeDestination() {
  return state.stops.find((stop) => stop.role === "destination") || null;
}

function setRouteParts(waypoints, destination) {
  state.stops = destination ? [...waypoints, destination] : waypoints;
}

function renderStops() {
  const box = $("stopsList");
  const destination = routeDestination();
  const rows = [
    {
      role: "origin",
      label: "出发",
      name: $("origin").value || "安盟财产保险有限公司长春中心支公司",
      meta: "固定出发地",
    },
    ...state.stops,
  ];

  const items = rows
    .map((stop, index) => {
      const waypointIndex = rows
        .slice(0, index + 1)
        .filter((item) => item.role === "waypoint").length;
      const label = stop.role === "origin" ? "出发" : stop.role === "destination" ? "目的" : `途经${waypointIndex}`;
      const removable = stop.role !== "origin";
      return `
        <div class="stop-item ${stop.role}">
          <b>${label}</b>
          <div>
            <strong>${stop.name}</strong>
            <small>${stop.meta || stop.address || stop.location || ""}</small>
          </div>
          ${removable ? `<button type="button" data-index="${index - 1}">移除</button>` : "<i></i>"}
        </div>
      `;
    })
    .join("");

  const hint = destination ? "" : '<p class="route-hint">请先搜索并选择目的地。</p>';
  box.innerHTML = `<span>路线停靠点</span>${items}${hint}`;
  box.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.index);
      state.stops.splice(index, 1);
      state.route = null;
      updateRouteCard();
    });
  });
}

function updateRouteCard() {
  const destination = routeDestination();
  const isWaypointMode = state.routeMode === "waypoint";
  $("routeModeText").textContent = isWaypointMode
    ? "正在添加途经点，选择候选后会插入目的地上方"
    : destination
      ? "选择候选后会替换当前目的地"
      : "选择候选后自动设为目的地";
  $("keywordLabel").firstChild.textContent = isWaypointMode ? "途经点关键词" : "目的地关键词";
  $("keyword").placeholder = isWaypointMode ? "例如：莲花山生态旅游区" : "例如：经开区工业园";
  $("addWaypointBtn").textContent = isWaypointMode ? "完成添加途经点" : "添加途经点";
  $("addWaypointBtn").classList.toggle("active-mode", isWaypointMode);
  renderStops();

  if (!state.route) {
    $("distanceText").textContent = "-";
    $("amountText").textContent = "-";
    renderSegments();
    return;
  }

  const price = Number($("fuelPrice").value || 0);
  $("distanceText").textContent = `${state.route.distance_km} km`;
  $("amountText").textContent = money(calcAmount(state.route.distance_km, price));
  renderSegments();
}

function renderSegments() {
  const box = $("segmentList");
  if (!state.route || !state.route.segments || state.route.segments.length <= 1) {
    box.innerHTML = "";
    return;
  }

  const rows = state.route.segments
    .map((segment, index) => `
      <div class="segment-item">
        <b>${index + 1}</b>
        <span>${segment.from} -> ${segment.to}</span>
        <strong>${segment.distance_km_exact} km</strong>
      </div>
    `)
    .join("");
  box.innerHTML = `<span>分段距离</span>${rows}`;
}

function commitPoi(poi) {
  const destination = routeDestination();
  const waypoints = routeWaypoints();
  if (state.routeMode === "waypoint" && destination) {
    setRouteParts([...waypoints, { ...poi, role: "waypoint" }], destination);
    setStatus(`已加入途经点：${poi.name}`);
  } else {
    setRouteParts(waypoints, { ...poi, role: "destination" });
    setStatus(`已设置目的地：${poi.name}`);
  }
  state.route = null;
  $("keyword").value = "";
  $("candidates").innerHTML = "";
  updateRouteCard();
}

function toggleWaypointMode() {
  if (state.routeMode !== "waypoint" && !routeDestination()) {
    setStatus("请先选择目的地，再添加途经点。", true);
    return;
  }
  state.routeMode = state.routeMode === "waypoint" ? "destination" : "waypoint";
  $("keyword").value = "";
  $("candidates").innerHTML = "";
  updateRouteCard();
  setStatus(state.routeMode === "waypoint" ? "现在可以连续添加途经点。" : "已回到目的地编辑。");
}

function renderRecords() {
  const body = $("recordsBody");
  body.innerHTML = "";
  let totalKm = 0;
  let totalLiters = 0;
  let totalAmount = 0;
  const fuelRateText = (state.config.fuel_rate * 100).toFixed(2).replace(/\.00$/, "");

  state.records.forEach((record, index) => {
    const liters = calcLiters(record.distance_km);
    const amount = calcAmount(record.distance_km, record.fuel_price);
    totalKm += Number(record.distance_km || 0);
    totalLiters += liters;
    totalAmount += amount;

    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${index + 1}</td>
      <td>${record.date}</td>
      <td>${record.origin}</td>
      <td>${record.poi_name}</td>
      <td>${record.distance_km} km</td>
      <td>${number2(liters)}</td>
      <td>${number2(record.fuel_price)}</td>
      <td>${number2(amount)}</td>
      <td>${fuelRateText}</td>
      <td class="screen-only"><button class="delete-btn" type="button">删除</button></td>
    `;
    row.querySelector("button").addEventListener("click", () => {
      state.records.splice(index, 1);
      renderRecords();
    });
    body.appendChild(row);
  });

  $("countSum").textContent = state.records.length;
  $("kmSum").textContent = `${Math.round(totalKm)} km`;
  $("literSum").textContent = `${totalLiters.toFixed(2)} L`;
  $("amountSum").textContent = money(totalAmount);

  if (!state.records.length) {
    const empty = document.createElement("tr");
    empty.className = "empty-row";
    empty.innerHTML = `<td colspan="10">暂无明细。左侧确认地点并计算距离后，加入记录。</td>`;
    body.appendChild(empty);
    return;
  }

  const totalRow = document.createElement("tr");
  totalRow.className = "total-row";
  totalRow.innerHTML = `
    <td colspan="4">合计</td>
    <td>${Math.round(totalKm)}</td>
    <td>${number2(totalLiters)}</td>
    <td></td>
    <td>${number2(totalAmount)}</td>
    <td>${number2(state.records.length * state.config.fuel_rate * 100)}</td>
    <td class="screen-only"></td>
  `;
  body.appendChild(totalRow);
}

function collectFuelDetails() {
  return [...document.querySelectorAll("#fuelDetailsBody tr[data-index]")]
    .map((row) => ({
      date: row.querySelector('[data-field="date"]').value,
      vehicle: row.querySelector('[data-field="vehicle"]').value.trim(),
      driver: row.querySelector('[data-field="driver"]').value.trim(),
      amount: Number(row.querySelector('[data-field="amount"]').value || 0),
      liters: Number(row.querySelector('[data-field="liters"]').value || 0),
    }))
    .filter((row) => row.date || row.vehicle || row.driver || row.amount || row.liters);
}

function renderFuelDetails() {
  const body = $("fuelDetailsBody");
  body.innerHTML = "";
  let totalAmount = 0;
  let totalLiters = 0;

  state.fuelDetails.forEach((item, index) => {
    totalAmount += Number(item.amount || 0);
    totalLiters += Number(item.liters || 0);

    const row = document.createElement("tr");
    row.dataset.index = String(index);
    row.innerHTML = `
      <td>${index + 1}</td>
      <td><input data-field="date" type="date" value="${item.date || todayText()}" /></td>
      <td><input data-field="vehicle" type="text" value="${item.vehicle || ""}" /></td>
      <td><input data-field="driver" type="text" value="${item.driver || ""}" /></td>
      <td><input data-field="amount" type="number" step="0.01" value="${Number(item.amount || 0)}" /></td>
      <td><input data-field="liters" type="number" step="0.01" value="${Number(item.liters || 0)}" /></td>
      <td>${item.liters ? number2(Number(item.amount || 0) / Number(item.liters || 1)) : "-"}</td>
      <td><button class="delete-btn" type="button">删除</button></td>
    `;
    row.querySelectorAll("input").forEach((input) => {
      input.addEventListener("input", () => {
        state.fuelDetails = collectFuelDetails();
        updateFuelDetailsSummary();
      });
    });
    row.querySelector("button").addEventListener("click", () => {
      state.fuelDetails = collectFuelDetails();
      state.fuelDetails.splice(index, 1);
      renderFuelDetails();
    });
    body.appendChild(row);
  });

  if (!state.fuelDetails.length) {
    const empty = document.createElement("tr");
    empty.className = "empty-row";
    empty.innerHTML = `<td colspan="8">暂无加油明细。可以从 Excel 读取或新增记录。</td>`;
    body.appendChild(empty);
  }

  updateFuelDetailsSummary(totalAmount, totalLiters);
}

function updateFuelDetailsSummary(amountOverride, litersOverride) {
  const rows = collectFuelDetails();
  const totalAmount = amountOverride ?? rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const totalLiters = litersOverride ?? rows.reduce((sum, row) => sum + Number(row.liters || 0), 0);
  $("fuelDetailCount").textContent = rows.length;
  $("fuelAmountSum").textContent = money(totalAmount);
  $("fuelLiterSum").textContent = `${totalLiters.toFixed(2)} L`;
  $("fuelAvgPrice").textContent = totalLiters ? `${number2(totalAmount / totalLiters)} 元/L` : "0 元/L";
}

function addFuelDetailRow() {
  state.fuelDetails = collectFuelDetails();
  state.fuelDetails.push({
    date: $("date").value || todayText(),
    vehicle: "吉AKC166",
    driver: "李博",
    amount: 0,
    liters: 0,
  });
  renderFuelDetails();
}

async function loadFuelDetails(source = "draft") {
  try {
    const data = await api(source === "source" ? "/api/fuel-details/source" : "/api/fuel-details", { method: "GET" });
    state.fuelDetails = data.rows || [];
    renderFuelDetails();
    setStatus(source === "source" ? "已从 Excel 读取加油明细。" : "已加载加油明细。");
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function saveFuelDetailsDraft() {
  state.fuelDetails = collectFuelDetails();
  try {
    const data = await api("/api/fuel-details/draft", {
      method: "POST",
      body: JSON.stringify({ rows: state.fuelDetails }),
    });
    setStatus(`加油明细草稿已保存：${data.count} 条。`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function exportFuelDetails() {
  state.fuelDetails = collectFuelDetails();
  if (!state.fuelDetails.length) {
    setStatus("没有可导出的加油明细。", true);
    return;
  }
  try {
    const response = await fetch("/api/fuel-details/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: state.fuelDetails }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.detail || "导出失败");
    }
    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename\*=UTF-8''([^;]+)|filename="?([^"]+)"?/);
    const filename = match ? decodeURIComponent(match[1] || match[2]) : "加油明细_维护导出.xlsx";
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setStatus(`已导出加油明细 Excel：${filename}`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

function switchTab(name) {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === name);
  });
  $("usageTab").classList.toggle("active", name === "usage");
  $("fuelTab").classList.toggle("active", name === "fuel");
}

function renderDestinationPool() {
  const box = $("destinationPoolList");
  box.innerHTML = "";
  if (!state.destinationPool.length) {
    box.innerHTML = `<div class="auto-result">暂无已确认目的地。请先搜索高德地点并加入目的地池。</div>`;
    return;
  }
  state.destinationPool.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = `pool-row ${item.enabled === false ? "disabled" : ""}`;
    row.innerHTML = `
      <div>
        <strong>${item.business_name || item.name}</strong>
        <span>${item.name} · ${item.district || ""} · ${item.address || ""} · ${item.location}</span>
      </div>
      <div class="pool-row-actions">
        <button type="button" data-action="toggle">${item.enabled === false ? "启用" : "停用"}</button>
        <button type="button" data-action="delete">删除</button>
      </div>
    `;
    row.querySelector('[data-action="toggle"]').addEventListener("click", () => {
      state.destinationPool[index].enabled = state.destinationPool[index].enabled === false;
      renderDestinationPool();
    });
    row.querySelector('[data-action="delete"]').addEventListener("click", () => {
      state.destinationPool.splice(index, 1);
      renderDestinationPool();
    });
    box.appendChild(row);
  });
}

async function loadDestinationPool() {
  const data = await api("/api/destination-pool", { method: "GET" });
  state.destinationPool = data.destinations || [];
  renderDestinationPool();
}

async function saveDestinationPool() {
  try {
    const data = await api("/api/destination-pool", {
      method: "POST",
      body: JSON.stringify({ destinations: state.destinationPool }),
    });
    setStatus(`目的地池已保存：${data.count} 个。`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function searchPoolCandidates() {
  const keyword = $("poolKeyword").value.trim();
  if (!keyword) return;
  const box = $("poolCandidates");
  box.innerHTML = `<div class="auto-result">正在搜索高德地点...</div>`;
  try {
    const data = await api("/api/pois", {
      method: "POST",
      body: JSON.stringify({ keyword, city: state.config.city }),
    });
    box.innerHTML = "";
    for (const poi of data.pois || []) {
      const row = document.createElement("div");
      row.className = "pool-candidate";
      row.innerHTML = `
        <div>
          <strong>${poi.name}</strong>
          <span>${poi.district || ""} · ${poi.address || ""} · ${poi.location}</span>
        </div>
        <button type="button">加入</button>
      `;
      row.querySelector("button").addEventListener("click", () => {
        const exists = state.destinationPool.some((item) => item.location === poi.location);
        if (!exists) {
          state.destinationPool.push({
            business_name: keyword,
            name: poi.name,
            address: poi.address || "",
            district: poi.district || "",
            type: poi.type || "",
            location: poi.location,
            enabled: true,
          });
          renderDestinationPool();
        }
        box.innerHTML = "";
        $("poolKeyword").value = "";
      });
      box.appendChild(row);
    }
  } catch (error) {
    box.innerHTML = `<div class="auto-result">${error.message}</div>`;
  }
}

function openAutoGenerateModal() {
  state.fuelDetails = collectFuelDetails();
  $("autoFuelRate").value = String(state.config?.fuel_rate || 0.09);
  refreshAutoIntervals();
  if (!state.destinationPool.length) renderDestinationPool();
  $("autoGenerateResult").textContent = "选择一个加油区间后生成，区间金额和油价会从加油明细自动带入。";
  $("autoGenerateModal").classList.add("active");
  $("autoGenerateModal").setAttribute("aria-hidden", "false");
}

function closeAutoGenerateModal() {
  $("autoGenerateModal").classList.remove("active");
  $("autoGenerateModal").setAttribute("aria-hidden", "true");
}

function workdaysBetween(startText, endText, skipWeekends) {
  const days = [];
  let cursor = parseLocalDate(startText);
  const end = parseLocalDate(endText);
  while (cursor <= end) {
    const day = cursor.getDay();
    if (!skipWeekends || (day !== 0 && day !== 6)) {
      days.push(formatLocalDate(cursor));
    }
    cursor = addDays(cursor, 1);
  }
  return days;
}

function buildFuelIntervals(fuelRows) {
  const sorted = [...fuelRows]
    .filter((row) => row.date && Number(row.amount) > 0 && Number(row.liters) > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const intervals = [];
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const current = sorted[index];
    const next = sorted[index + 1];
    const intervalStart = index === 0 ? current.date : formatLocalDate(addDays(parseLocalDate(current.date), 1));
    const intervalEnd = next.date;
    if (intervalStart > intervalEnd) continue;
    intervals.push({
      index: index + 1,
      start: intervalStart,
      end: intervalEnd,
      liters: Number(current.liters),
      price: Number(current.amount) / Number(current.liters),
      amount: Number(current.amount),
      fuelDate: current.date,
      nextFuelDate: next.date,
    });
  }
  return intervals;
}

function refreshAutoIntervals() {
  state.fuelDetails = collectFuelDetails();
  const intervals = buildFuelIntervals(state.fuelDetails);
  const select = $("autoIntervalSelect");
  const selectedValue = select.value;
  select.innerHTML = "";
  for (const interval of intervals) {
    const option = document.createElement("option");
    option.value = String(interval.index);
    option.textContent = `区间${interval.index}: ${interval.start} 至 ${interval.end} | ${money(interval.amount)} | ${interval.liters.toFixed(2)}L | ${interval.price.toFixed(2)}元/L`;
    select.appendChild(option);
  }
  if (selectedValue && intervals.some((interval) => String(interval.index) === selectedValue)) {
    select.value = selectedValue;
  }
  if (!intervals.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "没有可用加油区间";
    select.appendChild(option);
  }
  return intervals;
}

async function firstPoiForKeyword(keyword, poiCache) {
  if (poiCache.has(keyword)) return poiCache.get(keyword);
  const data = await api("/api/pois", {
    method: "POST",
    body: JSON.stringify({ keyword, city: state.config.city }),
  });
  const poi = data.pois?.[0] || null;
  poiCache.set(keyword, poi);
  return poi;
}

async function routeForPoi(poi, routeCache) {
  const key = poi.location;
  if (routeCache.has(key)) return routeCache.get(key);
  const data = await api("/api/route", {
    method: "POST",
    body: JSON.stringify({
      origin: $("origin").value,
      stops: [{ ...poi, role: "destination" }],
    }),
  });
  routeCache.set(key, data);
  return data;
}

async function runAutoGenerate() {
  const config = {
    fuelRate: Number($("autoFuelRate").value || 0.09),
    intervalIndex: Number($("autoIntervalSelect").value || 0),
    usageRatio: Math.max(80, Math.min(100, Number($("autoUsageRatio").value || 85))) / 100,
    skipWeekends: $("autoSkipWeekends").checked,
    append: $("autoAppendRecords").checked,
    pool: state.destinationPool.filter((item) => item.enabled !== false),
  };
  if (!config.fuelRate || config.fuelRate <= 0) {
    $("autoGenerateResult").textContent = "请填写有效的单公里油耗。";
    return;
  }
  if (!config.pool.length) {
    $("autoGenerateResult").textContent = "请至少维护一个已确认且启用的高德目的地。";
    return;
  }

  state.fuelDetails = collectFuelDetails();
  const intervals = buildFuelIntervals(state.fuelDetails);
  const interval = intervals.find((item) => item.index === config.intervalIndex);
  if (!interval) {
    $("autoGenerateResult").textContent = "没有可用加油区间，请先维护加油金额和升数。";
    return;
  }

  $("autoGenerateResult").textContent = "正在生成，可能需要等待高德路线计算...";
  const routeCache = new Map();
  const generated = [];
  let totalAmount = 0;
  let skipped = 0;
  let usedLiters = 0;
  let lastDestination = "";
  const targetLiters = interval.liters * config.usageRatio;
  const intervalPrice = Number(interval.price.toFixed(2));
  const days = shuffle(workdaysBetween(interval.start, interval.end, config.skipWeekends));
  const existingKeys = config.append ? new Set(state.records.map((record) => `${record.date}|${record.poi_name}`)) : new Set();

  for (const date of days) {
    if (usedLiters >= targetLiters) break;
    if (totalAmount >= interval.amount) break;

    let accepted = null;
    for (const poi of shuffle(config.pool)) {
      const displayName = poi.business_name || poi.name;
      if (displayName === lastDestination) continue;
      if (existingKeys.has(`${date}|${displayName}`)) continue;
      const route = await routeForPoi(poi, routeCache);
      const km = Number(route.distance_km || 0);
      const liters = km * config.fuelRate;
      const amount = liters * intervalPrice;
      if (usedLiters + liters > interval.liters) continue;
      if (totalAmount + amount > interval.amount) continue;
      accepted = { poi, route, km, liters, amount, displayName };
      break;
    }

    if (!accepted) {
      skipped += 1;
      continue;
    }

    usedLiters += accepted.liters;
    totalAmount += accepted.amount;
    lastDestination = accepted.displayName;
    existingKeys.add(`${date}|${accepted.displayName}`);
    generated.push({
      date,
      origin: $("origin").value,
      destination: accepted.displayName,
      poi_name: accepted.displayName,
      poi_address: accepted.poi.address || "",
      poi_location: accepted.poi.location,
      stops: [{ ...accepted.poi, role: "destination" }],
      distance_km: accepted.route.distance_km,
      distance_km_exact: accepted.route.distance_km_exact,
      fuel_price: intervalPrice,
    });
  }

  if (!generated.length) {
    $("autoGenerateResult").textContent = `未生成记录。当前目的地池中的路线可能都超过了区间剩余油量/金额，请增加更近或更多样的已确认目的地。跳过候选 ${skipped} 次。`;
    return;
  }

  state.records = config.append ? [...state.records, ...generated] : generated;
  state.records.sort((a, b) => a.date.localeCompare(b.date));
  renderRecords();
  const achieved = usedLiters / interval.liters;
  $("autoGenerateResult").textContent = `区间${interval.index}：${interval.start} 至 ${interval.end}
已生成 ${generated.length} 条，合计约 ${Math.round(generated.reduce((sum, row) => sum + Number(row.distance_km || 0), 0))} km。
耗油 ${usedLiters.toFixed(2)}L / ${interval.liters.toFixed(2)}L，使用比例 ${(achieved * 100).toFixed(1)}%，目标 ${(config.usageRatio * 100).toFixed(0)}%。
燃油费 ${money(totalAmount)} / 区间加油金额 ${money(interval.amount)}。${achieved < 0.8 ? "\n未达到80%，请增加更合适距离的目的地。" : ""}`;
  setStatus(`已自动生成 ${generated.length} 条车辆使用明细。`);
}

async function loadFuelPrice() {
  const date = $("date").value;
  if (!date) return;
  try {
    const data = await api(`/api/fuel-price?date=${encodeURIComponent(date)}`, { method: "GET" });
    if (!data.price) {
      setStatus(`没有找到 ${date} 对应的本地油价，可以先刷新或手动填写。`, true);
      return;
    }
    $("fuelPrice").value = Number(data.price.price).toFixed(2);
    setStatus(`${date} 使用 ${data.price.effective_date} 生效的 92号汽油价：${Number(data.price.price).toFixed(2)} 元/L`);
    updateRouteCard();
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function searchPois() {
  const keyword = $("keyword").value.trim();
  if (!keyword) {
    setStatus("请先输入目的地关键词。", true);
    return;
  }
  setStatus("正在匹配高德地点...");
  try {
    const data = await api("/api/pois", {
      method: "POST",
      body: JSON.stringify({ keyword, city: state.config.city }),
    });
    renderCandidates(data.pois);
    setStatus(`找到 ${data.pois.length} 个候选地点，请选择一个。`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function calculateRoute() {
  if (!routeDestination()) {
    setStatus("请先设置目的地。", true);
    return null;
  }

  const routeStops = [...state.stops];
  setStatus("正在计算驾车距离...");
  try {
    const data = await api("/api/route", {
      method: "POST",
      body: JSON.stringify({
        origin: $("origin").value,
        stops: routeStops,
      }),
    });
    state.route = data;
    updateRouteCard();
    setStatus(`驾车距离 ${data.distance_km_exact} km，已按 ${data.distance_km} km 记入。`);
    return data;
  } catch (error) {
    setStatus(error.message, true);
    return null;
  }
}

async function addRecord() {
  const price = Number($("fuelPrice").value || 0);
  if (!price) {
    setStatus("请先确认油价。", true);
    return;
  }
  if (!state.route) {
    const route = await calculateRoute();
    if (!route) return;
  }

  state.records.push({
    date: $("date").value,
    origin: $("origin").value,
    destination: state.stops.map((stop) => stop.name).join("-"),
    poi_name: destinationLabel(state.stops),
    poi_address: state.stops.map((stop) => stop.address || "").filter(Boolean).join(" / "),
    poi_location: state.stops.map((stop) => stop.location).join(";"),
    stops: state.stops,
    distance_km: state.route.distance_km,
    distance_km_exact: state.route.distance_km_exact,
    fuel_price: price,
  });

  renderRecords();
  resetCurrentRouteInput();
  setStatus("已加入明细。");
}

async function saveRecords() {
  try {
    const data = await api("/api/records", {
      method: "POST",
      body: JSON.stringify({ records: state.records }),
    });
    setStatus(`草稿已保存：${data.count} 条。`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function exportExcel() {
  if (!state.records.length) {
    setStatus("没有可导出的明细记录。", true);
    return;
  }
  try {
    const response = await fetch("/api/export", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...amapHeaders(),
      },
      body: JSON.stringify({ records: state.records }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.detail || "导出失败");
    }
    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename\*=UTF-8''([^;]+)|filename="?([^"]+)"?/);
    const filename = match ? decodeURIComponent(match[1] || match[2]) : "加油明细_在线编辑器生成.xlsx";
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setStatus(`已导出 Excel：${filename}`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function refreshFuelPrices() {
  setStatus("正在从吉林省发改委抓取4月油价...");
  try {
    const data = await api("/api/fuel-prices/refresh", {
      method: "POST",
      body: JSON.stringify({ year_month: "2026-04" }),
    });
    renderPriceStrip(data.prices);
    await loadFuelPrice();
    setStatus(`油价已刷新，新增/更新 ${data.refreshed.length} 条公告。`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function boot() {
  state.config = await api("/api/config", { method: "GET" });
  $("origin").value = state.config.origin;
  $("date").value = "2026-04-08";
  $("amapKey").value = localStorage.getItem("amapKey") || "";

  const prices = await api("/api/fuel-prices", { method: "GET" });
  renderPriceStrip(prices.prices);
  await loadFuelPrice();

  const records = await api("/api/records", { method: "GET" });
  state.records = records.records || [];
  renderRecords();
  await loadFuelDetails();
  await loadDestinationPool();

  if (!state.config.has_server_key && !$("amapKey").value) {
    setStatus("请输入高德 Key 后开始匹配地点。");
  }
}

$("amapKey").addEventListener("change", () => {
  localStorage.setItem("amapKey", $("amapKey").value.trim());
});
$("date").addEventListener("change", loadFuelPrice);
$("fuelPrice").addEventListener("input", updateRouteCard);
$("searchBtn").addEventListener("click", searchPois);
$("keyword").addEventListener("keydown", (event) => {
  if (event.key === "Enter") searchPois();
});
$("routeBtn").addEventListener("click", calculateRoute);
$("addBtn").addEventListener("click", addRecord);
$("addWaypointBtn").addEventListener("click", toggleWaypointMode);
$("clearRouteBtn").addEventListener("click", resetCurrentRouteInput);
$("saveBtn").addEventListener("click", saveRecords);
$("exportBtn").addEventListener("click", exportExcel);
$("refreshFuelBtn").addEventListener("click", refreshFuelPrices);
$("autoGenerateBtn").addEventListener("click", openAutoGenerateModal);
$("closeAutoGenerateBtn").addEventListener("click", closeAutoGenerateModal);
$("runAutoGenerateBtn").addEventListener("click", runAutoGenerate);
$("poolSearchBtn").addEventListener("click", searchPoolCandidates);
$("poolKeyword").addEventListener("keydown", (event) => {
  if (event.key === "Enter") searchPoolCandidates();
});
$("saveDestinationPoolBtn").addEventListener("click", saveDestinationPool);
$("addFuelDetailBtn").addEventListener("click", addFuelDetailRow);
$("reloadFuelDetailsBtn").addEventListener("click", () => loadFuelDetails("source"));
$("saveFuelDetailsBtn").addEventListener("click", saveFuelDetailsDraft);
$("exportFuelDetailsBtn").addEventListener("click", exportFuelDetails);
document.querySelectorAll(".tab-button").forEach((button) => {
  button.addEventListener("click", () => switchTab(button.dataset.tab));
});

boot().catch((error) => setStatus(error.message, true));
