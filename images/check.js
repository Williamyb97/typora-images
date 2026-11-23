const CLASH_USER_AGENT = "Clash";

function safeDisplayUrl(targetUrl) {
  try {
    const url = new URL(targetUrl);
    return `${url.origin}${url.pathname}`;
  } catch (_) {
    return targetUrl || "-";
  }
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatBytes(value) {
  const n = Number(value);

  if (!Number.isFinite(n) || n < 0) {
    return "-";
  }

  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let size = n;
  let index = 0;

  while (size >= 1024 && index < units.length - 1) {
    size = size / 1024;
    index++;
  }

  const digits = index === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[index]}`;
}

function formatExpireTime(value) {
  const n = Number(value);

  if (!Number.isFinite(n) || n <= 0) {
    return "-";
  }

  const date = new Date(n * 1000);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function makeProgressBar(percentText) {
  const percent = Number(String(percentText).replace("%", ""));

  if (!Number.isFinite(percent)) {
    return "--------------------";
  }

  const totalBlocks = 20;
  const filledBlocks = Math.max(
    0,
    Math.min(totalBlocks, Math.round((percent / 100) * totalBlocks))
  );

  return "█".repeat(filledBlocks) + "░".repeat(totalBlocks - filledBlocks);
}

function parseSubscriptionUserinfo(headerValue) {
  if (!headerValue) {
    return null;
  }

  const data = {};

  headerValue
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => {
      const [key, value] = item.split("=");

      if (key && value !== undefined) {
        data[key.trim().toLowerCase()] = value.trim();
      }
    });

  const upload = Number(data.upload || 0);
  const download = Number(data.download || 0);
  const total = Number(data.total || 0);
  const used = upload + download;

  let usedPercent = "-";

  if (Number.isFinite(total) && total > 0) {
    usedPercent = `${((used / total) * 100).toFixed(2)}%`;
  }

  return {
    uploadText: formatBytes(upload),
    downloadText: formatBytes(download),
    usedText: formatBytes(used),
    totalText: formatBytes(total),
    usedPercent,
    progressBar: makeProgressBar(usedPercent),
    expireText: data.expire ? formatExpireTime(data.expire) : "-"
  };
}

function extractRulesetUrls(configText) {
  return [
    ...new Set(
      configText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line)
        .filter((line) => !line.startsWith(";"))
        .filter((line) => !line.startsWith("#"))
        .filter((line) => line.startsWith("ruleset="))
        .map((line) => {
          const match = line.match(/,\s*(https?:\/\/\S+)/);
          return match ? match[1] : null;
        })
        .filter(Boolean)
    )
  ];
}

function formatConvertedStatus(convertedResult) {
  if (convertedResult.ok) {
    return "✅ 正常";
  }

  return `❌ 异常 ${convertedResult.status}`;
}

async function fetchHeadInfo(targetUrl, userAgent) {
  if (!targetUrl) {
    return {
      ok: false,
      status: "MISSING",
      error: "链接未配置",
      info: null
    };
  }

  try {
    const resp = await fetch(targetUrl, {
      headers: {
        "User-Agent": userAgent,
        "Cache-Control": "no-cache"
      }
    });

    const subscriptionUserinfo = resp.headers.get("subscription-userinfo");

    try {
      if (resp.body) {
        resp.body.cancel();
      }
    } catch (_) {}

    return {
      ok: resp.ok,
      status: resp.status,
      info: parseSubscriptionUserinfo(subscriptionUserinfo)
    };
  } catch (err) {
    return {
      ok: false,
      status: "ERR",
      error: err && err.message ? err.message : String(err),
      info: null
    };
  }
}

async function checkSubscription(item) {
  const unifiedConfigured = Boolean(item.unifiedUrl);

  const [unifiedResult, convertedResult] = await Promise.all([
    unifiedConfigured
      ? fetchHeadInfo(item.unifiedUrl, CLASH_USER_AGENT)
      : Promise.resolve({
          ok: false,
          status: "SKIPPED",
          error: null,
          info: null
        }),
    fetchHeadInfo(item.convertedUrl, CLASH_USER_AGENT)
  ]);

  let diagnosis = "✅ 正常";

  if (!unifiedConfigured) {
    diagnosis = convertedResult.ok
      ? "转换订阅正常；统一订阅未配置，已跳过检查"
      : "转换订阅异常；统一订阅未配置，已跳过检查";
  } else if (unifiedResult.ok && convertedResult.ok) {
    diagnosis = "✅ 正常";
  } else if (unifiedResult.ok && !convertedResult.ok) {
    diagnosis = "⚠️ 统一订阅正常，转换订阅异常";
  } else if (!unifiedResult.ok && convertedResult.ok) {
    diagnosis = "❌ 统一订阅异常，转换订阅正常";
  } else {
    diagnosis = "❌ 统一订阅和转换订阅都异常";
  }

  // The unified endpoint is the actual URL consumed by Clash, so prefer
  // its Subscription-Userinfo header and fall back to the converted URL.
  const info = unifiedResult.info || convertedResult.info;
  const infoSource = unifiedResult.info
    ? "统一订阅"
    : convertedResult.info
      ? "转换订阅"
      : "";

  return {
    name: item.name,
    icon: item.icon,
    ok: convertedResult.ok && (!unifiedConfigured || unifiedResult.ok),
    unified: unifiedResult,
    converted: convertedResult,
    info,
    infoSource,
    diagnosis
  };
}

async function checkUrl(name, targetUrl) {
  if (!targetUrl) {
    return {
      name,
      ok: false,
      status: "MISSING",
      error: "链接未配置",
      url: "-"
    };
  }

  try {
    const resp = await fetch(targetUrl, {
      headers: {
        "User-Agent": CLASH_USER_AGENT,
        "Cache-Control": "no-cache"
      }
    });

    try {
      if (resp.body) {
        resp.body.cancel();
      }
    } catch (_) {}

    return {
      name,
      ok: resp.ok,
      status: resp.status,
      url: safeDisplayUrl(targetUrl)
    };
  } catch (err) {
    return {
      name,
      ok: false,
      status: "ERR",
      error: err && err.message ? err.message : String(err),
      url: safeDisplayUrl(targetUrl)
    };
  }
}

function renderHtml({
  showDetail,
  subscriptionResults = [],
  configResult = null,
  rulesetUrls = [],
  rulesetResults = [],
  skippedRulesetCount = 0,
  failedCount = 0,
  loadError = ""
}) {
  const airportOkCount = subscriptionResults.filter((item) => item.ok).length;
  const rulesetOkCount = rulesetResults.filter((item) => item.ok).length;
  const statusText = failedCount === 0 ? "All OK" : `${failedCount} Failed`;
  const statusClass = failedCount === 0 ? "ok" : "bad";

  const subscriptionCards = subscriptionResults.map((item) => {
    const unifiedStatusText = item.unified.status === "SKIPPED"
      ? "未配置，已跳过"
      : item.unified.ok
        ? "正常"
        : `异常 ${item.unified.status}`;

    const unifiedStatusClass = item.unified.status === "SKIPPED"
      ? "muted"
      : item.unified.ok
        ? "ok"
        : "bad";

    const convertedStatusText = item.converted.ok
      ? "正常"
      : `异常 ${item.converted.status}`;

    const convertedStatusClass = item.converted.ok ? "ok" : "bad";

    let usageHtml = `
      <div class="usage-empty">
        <span class="muted-text">未获取到 Subscription-Userinfo 流量信息</span>
      </div>
    `;

    if (item.info) {
      const percent = Number.parseFloat(item.info.usedPercent);
      const progressWidth = Number.isFinite(percent)
        ? Math.max(0, Math.min(100, percent))
        : 0;
      const percentText = item.info.usedPercent || "-";

      usageHtml = `
        <div class="usage-block">
          <div class="usage-heading">
            <span class="usage-label">流量使用情况</span>
            <span class="usage-percent">${escapeHtml(percentText)}</span>
          </div>
          <div class="progress-track">
            <div class="progress-value" style="width: ${progressWidth}%"></div>
          </div>
          <div class="usage-total">
            <strong>${escapeHtml(item.info.usedText)}</strong>
            <span>/ ${escapeHtml(item.info.totalText)}</span>
          </div>
          <div class="usage-meta">
            <span>上传 ${escapeHtml(item.info.uploadText)}</span>
            <span>下载 ${escapeHtml(item.info.downloadText)}</span>
          </div>
          <div class="expire-row">
            <span>到期时间</span>
            <strong>${escapeHtml(item.info.expireText)}</strong>
          </div>
          <div class="info-source">流量信息来源：${escapeHtml(item.infoSource || "-")}</div>
        </div>
      `;
    }

    const errorMessages = [];
    if (item.unified.error) {
      errorMessages.push(`统一订阅：${item.unified.error}`);
    }
    if (item.converted.error) {
      errorMessages.push(`转换订阅：${item.converted.error}`);
    }

    const errorsHtml = errorMessages.length
      ? `<div class="error-notes">${errorMessages.map((message) => `<div>${escapeHtml(message)}</div>`).join("")}</div>`
      : "";

    return `
      <article class="subscription-card">
        <div class="card-heading">
          <div class="provider-title">
            <span class="provider-icon">${escapeHtml(item.icon)}</span>
            <div>
              <h3>${escapeHtml(item.name)}</h3>
              <span class="provider-caption">Subscription</span>
            </div>
          </div>
          <span class="status-pill ${item.ok ? "ok" : "bad"}">${item.ok ? "正常" : "异常"}</span>
        </div>

        <div class="check-rows">
          <div class="check-row">
            <span>统一订阅</span>
            <span class="status-pill small ${unifiedStatusClass}">${escapeHtml(unifiedStatusText)}</span>
          </div>
          <div class="check-row">
            <span>转换订阅</span>
            <span class="status-pill small ${convertedStatusClass}">${escapeHtml(convertedStatusText)}</span>
          </div>
        </div>

        ${usageHtml}

        <div class="diagnosis">${escapeHtml(item.diagnosis)}</div>
        ${errorsHtml}
      </article>
    `;
  }).join("");

  const configStatusText = configResult
    ? (configResult.ok ? "正常" : `异常 ${configResult.status}`)
    : "未检查";
  const configStatusClass = configResult && configResult.ok ? "ok" : "bad";

  const rulesetRows = rulesetResults.map((item) => `
    <div class="rule-row">
      <div class="rule-main">
        <span class="rule-mark ${item.ok ? "ok-text" : "bad-text"}">${item.ok ? "●" : "●"}</span>
        <div class="rule-details">
          <strong>${escapeHtml(item.name)}</strong>
          <span>${escapeHtml(item.url)}</span>
          ${item.error ? `<span class="rule-error">${escapeHtml(item.error)}</span>` : ""}
        </div>
      </div>
      <span class="status-pill small ${item.ok ? "ok" : "bad"}">${item.ok ? "正常" : `异常 ${escapeHtml(item.status)}`}</span>
    </div>
  `).join("");

  const configDetailRow = configResult ? `
    <div class="rule-row">
      <div class="rule-main">
        <span class="rule-mark ${configResult.ok ? "ok-text" : "bad-text"}">●</span>
        <div class="rule-details">
          <strong>BinYang_ACL4SSR.ini 主配置</strong>
          <span>${escapeHtml(configResult.url || "-")}</span>
          ${configResult.error ? `<span class="rule-error">${escapeHtml(configResult.error)}</span>` : ""}
        </div>
      </div>
      <span class="status-pill small ${configResult.ok ? "ok" : "bad"}">${configResult.ok ? "正常" : `异常 ${escapeHtml(configResult.status)}`}</span>
    </div>
  ` : "";

  const detailContent = showDetail
    ? `
      <div class="detail-list">
        ${configDetailRow}
        ${rulesetRows || `<div class="empty-detail">没有提取到可检查的 Ruleset URL。</div>`}
      </div>
      <a class="action-link secondary-link" href="/check">返回简洁检查页</a>
    `
    : `
      <div class="rules-note">
        已检查 ${rulesetResults.length} 条规则链接
        ${skippedRulesetCount > 0 ? `，另有 ${skippedRulesetCount} 条因检查数量上限而跳过` : ""}
      </div>
      <a class="action-link" href="/check?detail=1">查看完整规则列表</a>
    `;

  const loadErrorHtml = loadError
    ? `<div class="global-error">${escapeHtml(loadError)}</div>`
    : "";

  const rulesetFailedCount = rulesetResults.filter((item) => !item.ok).length;

  const html = `
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>BinYang Health Check</title>
  <style>
    :root {
      color-scheme: light;
      --page: #f5f7fb;
      --surface: #ffffff;
      --text: #172033;
      --muted: #778198;
      --line: #e8ecf3;
      --green: #16834a;
      --green-bg: #eaf7ef;
      --red: #c43d45;
      --red-bg: #fff0f0;
      --amber: #a76a12;
      --amber-bg: #fff6e6;
      --blue: #3568c8;
      --blue-bg: #edf3ff;
      --shadow: 0 8px 28px rgba(25, 42, 70, .055);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      padding: 34px 20px 48px;
      background: var(--page);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Microsoft YaHei", Arial, sans-serif;
    }

    .container {
      width: min(1120px, 100%);
      margin: 0 auto;
    }

    .page-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 20px;
      margin-bottom: 26px;
    }

    .brand h1 {
      margin: 0;
      font-size: 26px;
      line-height: 1.25;
      letter-spacing: -.45px;
    }

    .subtitle {
      margin-top: 7px;
      color: var(--muted);
      font-size: 13px;
    }

    .overall-status {
      flex: 0 0 auto;
      padding: 9px 15px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 750;
      letter-spacing: .15px;
    }

    .overall-status.ok { color: var(--green); background: var(--green-bg); }
    .overall-status.bad { color: var(--red); background: var(--red-bg); }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
      margin-bottom: 30px;
    }

    .summary-card {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 15px;
      padding: 18px 20px;
      box-shadow: var(--shadow);
    }

    .summary-label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
    }

    .summary-value {
      margin-top: 8px;
      font-size: 27px;
      line-height: 1.15;
      font-weight: 750;
      letter-spacing: -.5px;
      font-variant-numeric: tabular-nums;
    }

    .summary-hint {
      margin-top: 5px;
      color: var(--muted);
      font-size: 11px;
    }

    .summary-value.good { color: var(--green); }
    .summary-value.alert { color: var(--red); }

    .section {
      margin-top: 28px;
    }

    .section-heading {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;
      margin-bottom: 14px;
    }

    .section-heading h2 {
      margin: 0;
      font-size: 17px;
      font-weight: 750;
    }

    .section-description {
      color: var(--muted);
      font-size: 12px;
    }

    .subscription-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 15px;
    }

    .subscription-card, .panel {
      min-width: 0;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 16px;
      box-shadow: var(--shadow);
    }

    .subscription-card {
      padding: 19px;
    }

    .card-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--line);
    }

    .provider-title {
      display: flex;
      align-items: center;
      gap: 11px;
      min-width: 0;
    }

    .provider-icon {
      display: grid;
      place-items: center;
      width: 40px;
      height: 40px;
      flex: 0 0 40px;
      border-radius: 12px;
      background: #f3f5f9;
      font-size: 21px;
    }

    .provider-title h3 {
      margin: 0;
      font-size: 15px;
      font-weight: 750;
    }

    .provider-caption {
      display: block;
      margin-top: 3px;
      color: var(--muted);
      font-size: 10px;
      letter-spacing: .5px;
      text-transform: uppercase;
    }

    .status-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      white-space: nowrap;
      padding: 5px 9px;
      border-radius: 999px;
      font-size: 11px;
      line-height: 1.2;
      font-weight: 700;
    }

    .status-pill.small { padding: 4px 8px; font-size: 10px; }
    .status-pill.ok { color: var(--green); background: var(--green-bg); }
    .status-pill.bad { color: var(--red); background: var(--red-bg); }
    .status-pill.warn { color: var(--amber); background: var(--amber-bg); }
    .status-pill.muted { color: #667085; background: #f0f2f6; }

    .check-rows {
      display: grid;
      gap: 10px;
      padding: 15px 0;
      border-bottom: 1px solid var(--line);
    }

    .check-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      color: #606b80;
      font-size: 12px;
    }

    .usage-block {
      padding-top: 16px;
    }

    .usage-heading, .usage-meta, .expire-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .usage-label {
      color: var(--muted);
      font-size: 11px;
      font-weight: 650;
    }

    .usage-percent {
      color: var(--text);
      font-size: 12px;
      font-weight: 750;
      font-variant-numeric: tabular-nums;
    }

    .progress-track {
      height: 7px;
      overflow: hidden;
      margin: 10px 0 8px;
      border-radius: 99px;
      background: #edf0f5;
    }

    .progress-value {
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, #35a66b, #16834a);
    }

    .usage-total {
      display: flex;
      align-items: baseline;
      gap: 5px;
      font-size: 12px;
      color: var(--muted);
    }

    .usage-total strong {
      color: var(--text);
      font-size: 16px;
      font-weight: 750;
      font-variant-numeric: tabular-nums;
    }

    .usage-meta {
      margin-top: 11px;
      color: var(--muted);
      font-size: 10px;
    }

    .expire-row {
      margin-top: 13px;
      padding-top: 11px;
      border-top: 1px dashed var(--line);
      color: var(--muted);
      font-size: 11px;
    }

    .expire-row strong {
      color: var(--text);
      font-size: 11px;
      font-weight: 650;
      text-align: right;
    }

    .info-source {
      margin-top: 8px;
      color: #9aa2b1;
      font-size: 10px;
    }

    .usage-empty {
      padding: 19px 0 6px;
      font-size: 11px;
    }

    .muted-text { color: var(--muted); }

    .diagnosis {
      margin-top: 14px;
      padding: 9px 10px;
      border-radius: 9px;
      background: #f7f8fb;
      color: #606b80;
      font-size: 11px;
      line-height: 1.55;
    }

    .error-notes {
      margin-top: 9px;
      color: var(--red);
      font-size: 10px;
      line-height: 1.5;
      overflow-wrap: anywhere;
    }

    .panel {
      padding: 20px;
    }

    .config-line {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--line);
      font-size: 13px;
      font-weight: 650;
    }

    .rules-stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      padding: 17px 0 5px;
    }

    .rule-stat {
      padding: 12px;
      border-radius: 11px;
      background: #f7f8fb;
    }

    .rule-stat span {
      display: block;
      color: var(--muted);
      font-size: 10px;
    }

    .rule-stat strong {
      display: block;
      margin-top: 6px;
      font-size: 18px;
      font-weight: 750;
      font-variant-numeric: tabular-nums;
    }

    .rule-stat strong.good { color: var(--green); }
    .rule-stat strong.alert { color: var(--red); }

    .rules-note {
      margin-top: 14px;
      color: var(--muted);
      font-size: 11px;
    }

    .action-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-top: 16px;
      padding: 9px 13px;
      border-radius: 9px;
      background: var(--blue-bg);
      color: var(--blue);
      font-size: 12px;
      font-weight: 700;
      text-decoration: none;
      transition: background .15s ease;
    }

    .action-link:hover { background: #e1ebff; }
    .secondary-link { background: #f0f2f6; color: #566176; }
    .secondary-link:hover { background: #e7eaf0; }

    .detail-list {
      margin-top: 17px;
      border-top: 1px solid var(--line);
    }

    .rule-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 14px;
      padding: 13px 2px;
      border-bottom: 1px solid var(--line);
    }

    .rule-main {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      min-width: 0;
    }

    .rule-mark {
      margin-top: 2px;
      font-size: 9px;
    }

    .ok-text { color: var(--green); }
    .bad-text { color: var(--red); }

    .rule-details {
      display: grid;
      gap: 4px;
      min-width: 0;
    }

    .rule-details strong {
      font-size: 12px;
      font-weight: 650;
    }

    .rule-details span {
      color: var(--muted);
      font-size: 10px;
      overflow-wrap: anywhere;
    }

    .rule-details .rule-error { color: var(--red); }

    .empty-detail {
      padding: 20px 0;
      color: var(--muted);
      font-size: 12px;
    }

    .global-error {
      margin-bottom: 20px;
      padding: 13px 15px;
      border: 1px solid #ffd6d6;
      border-radius: 11px;
      background: var(--red-bg);
      color: var(--red);
      font-size: 12px;
    }

    .footer {
      margin-top: 25px;
      color: #9aa2b1;
      font-size: 10px;
      text-align: center;
    }

    @media (max-width: 900px) {
      .subscription-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }

    @media (max-width: 620px) {
      body { padding: 24px 13px 34px; }
      .page-header { align-items: flex-start; }
      .brand h1 { font-size: 22px; }
      .overall-status { padding: 7px 10px; font-size: 11px; }
      .summary-grid { gap: 8px; }
      .summary-card { padding: 13px 11px; border-radius: 12px; }
      .summary-value { font-size: 22px; }
      .summary-label { font-size: 10px; }
      .subscription-grid { grid-template-columns: 1fr; }
      .rules-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .panel { padding: 15px; }
      .rule-row { align-items: flex-start; }
    }
  </style>
</head>
<body>
  <main class="container">
    <header class="page-header">
      <div class="brand">
        <h1>BinYang Health Check</h1>
        <div class="subtitle">机场订阅与远程规则集健康状态</div>
      </div>
      <div class="overall-status ${statusClass}">${escapeHtml(statusText)}</div>
    </header>

    ${loadErrorHtml}

    <section class="summary-grid" aria-label="健康状态概览">
      <div class="summary-card">
        <div class="summary-label">机场正常</div>
        <div class="summary-value ${airportOkCount === subscriptionResults.length ? "good" : "alert"}">
          ${airportOkCount}/${subscriptionResults.length}
        </div>
        <div class="summary-hint">包月、流量及备用机场</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">Ruleset 正常</div>
        <div class="summary-value ${rulesetFailedCount === 0 ? "good" : "alert"}">
          ${rulesetOkCount}/${rulesetResults.length}
        </div>
        <div class="summary-hint">已检查的远程规则链接</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">异常项目</div>
        <div class="summary-value ${failedCount === 0 ? "good" : "alert"}">${failedCount}</div>
        <div class="summary-hint">包含订阅、主配置及规则集异常</div>
      </div>
    </section>

    <section class="section">
      <div class="section-heading">
        <h2>📡 机场订阅</h2>
        <span class="section-description">${subscriptionResults.length} 个订阅源</span>
      </div>
      <div class="subscription-grid">
        ${subscriptionCards || `<div class="panel">暂无机场订阅检查结果。</div>`}
      </div>
    </section>

    <section class="section">
      <div class="section-heading">
        <h2>📋 Ruleset 规则检查</h2>
        <span class="section-description">主配置与远程规则集</span>
      </div>
      <div class="panel">
        <div class="config-line">
          <span>BinYang_ACL4SSR.ini 主配置</span>
          <span class="status-pill ${configStatusClass}">${escapeHtml(configStatusText)}</span>
        </div>

        <div class="rules-stats">
          <div class="rule-stat">
            <span>Ruleset Found</span>
            <strong>${rulesetUrls.length}</strong>
          </div>
          <div class="rule-stat">
            <span>Ruleset Checked</span>
            <strong>${rulesetResults.length}</strong>
          </div>
          <div class="rule-stat">
            <span>Ruleset OK</span>
            <strong class="good">${rulesetOkCount}</strong>
          </div>
          <div class="rule-stat">
            <span>Ruleset Failed</span>
            <strong class="${rulesetFailedCount > 0 ? "alert" : "good"}">${rulesetFailedCount}</strong>
          </div>
        </div>

        ${configResult && configResult.error ? `<div class="error-notes">主配置错误：${escapeHtml(configResult.error)}</div>` : ""}
        ${detailContent}
      </div>
    </section>

    <footer class="footer">BinYang Health Check · Subscription & Ruleset Monitor</footer>
  </main>
</body>
</html>
`;

  return html;
}

async function getRequiredKvValue(env, key) {
  const value = await env.SUB_CONFIG.get(key);

  if (!value || !value.trim()) {
    throw new Error(`KV 中没有找到 key：${key}`);
  }

  return value.trim();
}

async function getOptionalKvValue(env, key) {
  const value = await env.SUB_CONFIG.get(key);
  return value && value.trim() ? value.trim() : "";
}

async function loadSubConfig(env) {
  if (!env.SUB_CONFIG) {
    throw new Error("KV 绑定不存在，请检查绑定名是否为 SUB_CONFIG");
  }

  const [
    monthlyUnifiedUrl,
    monthlyConvertedUrl,
    trafficUnifiedUrl,
    trafficConvertedUrl,
    backupUnifiedUrl,
    backupConvertedUrl,
    configUrl
  ] = await Promise.all([
    getRequiredKvValue(env, "monthly_unified_url"),
    getRequiredKvValue(env, "monthly_converted_url"),
    getRequiredKvValue(env, "traffic_unified_url"),
    getRequiredKvValue(env, "traffic_converted_url"),
    getOptionalKvValue(env, "backup_unified_url"),
    getRequiredKvValue(env, "backup_converted_url"),
    getRequiredKvValue(env, "config_url")
  ]);

  return {
    monthly: {
      name: "包月机场",
      icon: "📅",
      unifiedUrl: monthlyUnifiedUrl,
      convertedUrl: monthlyConvertedUrl
    },
    traffic: {
      name: "按流量机场",
      icon: "📦",
      unifiedUrl: trafficUnifiedUrl,
      convertedUrl: trafficConvertedUrl
    },
    backup: {
      name: "备用机场",
      icon: "👑",
      unifiedUrl: backupUnifiedUrl,
      convertedUrl: backupConvertedUrl
    },
    configUrl
  };
}

function buildSubscriptions(config) {
  return [
    {
      name: config.monthly?.name || "包月机场",
      icon: config.monthly?.icon || "📅",
      unifiedUrl: config.monthly?.unifiedUrl || "",
      convertedUrl: config.monthly?.convertedUrl || ""
    },
    {
      name: config.traffic?.name || "按流量机场",
      icon: config.traffic?.icon || "📦",
      unifiedUrl: config.traffic?.unifiedUrl || "",
      convertedUrl: config.traffic?.convertedUrl || ""
    },
    {
      name: config.backup?.name || "备用机场",
      icon: config.backup?.icon || "👑",
      unifiedUrl: config.backup?.unifiedUrl || "",
      convertedUrl: config.backup?.convertedUrl || ""
    }
  ];
}

async function handleCheck(request, env) {
  const url = new URL(request.url);
  const showDetail = url.searchParams.get("detail") === "1";

  let kvConfig;

  try {
    kvConfig = await loadSubConfig(env);
  } catch (err) {
    const errorMessage = err && err.message ? err.message : String(err);
    const html = renderHtml({
      showDetail: false,
      failedCount: 1,
      loadError: `KV 配置读取失败：${errorMessage}`
    });

    return new Response(html, {
      status: 500,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }

  const subscriptions = buildSubscriptions(kvConfig);
  const configUrl = kvConfig.configUrl || "";

  const subscriptionResults = await Promise.all(
    subscriptions.map((item) => checkSubscription(item))
  );

  let configText = "";

  const configResult = {
    name: "BinYang_ACL4SSR.ini 主配置",
    ok: false,
    status: "ERR",
    url: safeDisplayUrl(configUrl)
  };

  try {
    const resp = await fetch(configUrl, {
      headers: {
        "User-Agent": CLASH_USER_AGENT,
        "Cache-Control": "no-cache"
      }
    });

    configResult.ok = resp.ok;
    configResult.status = resp.status;

    if (resp.ok) {
      configText = await resp.text();
    } else {
      try {
        if (resp.body) {
          resp.body.cancel();
        }
      } catch (_) {}
    }
  } catch (err) {
    configResult.error = err && err.message ? err.message : String(err);
  }

  const rulesetUrls = configText ? extractRulesetUrls(configText) : [];
  const limitedRulesetUrls = rulesetUrls.slice(0, 45);
  const skippedRulesetCount = Math.max(
    0,
    rulesetUrls.length - limitedRulesetUrls.length
  );

  const rulesetResults = await Promise.all(
    limitedRulesetUrls.map((targetUrl, index) =>
      checkUrl(`Ruleset ${index + 1}`, targetUrl)
    )
  );

  const failedSubscriptions = subscriptionResults.filter((item) => !item.ok);
  const failedRulesets = rulesetResults.filter((item) => !item.ok);
  const failed = [
    ...failedSubscriptions,
    ...(!configResult.ok ? [configResult] : []),
    ...failedRulesets
  ];

  const html = renderHtml({
    showDetail,
    subscriptionResults,
    configResult,
    rulesetUrls,
    rulesetResults,
    skippedRulesetCount,
    failedCount: failed.length
  });

  return new Response(html, {
    status: failed.length === 0 ? 200 : 500,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return Response.redirect(`${url.origin}/check`, 302);
    }

    if (url.pathname === "/check") {
      return handleCheck(request, env);
    }

    return new Response("Not Found", {
      status: 404,
      headers: {
        "content-type": "text/plain; charset=utf-8"
      }
    });
  }
};