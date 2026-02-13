const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { execSync } = require("child_process");

// ============================================================
// CONFIGURATION
// ============================================================
const CONFIG = {
  mccAccountId: "612-310-3619",

  downloadDir: path.join(__dirname, "downloads"),
  userDataDir: path.join(__dirname, "browser-data"),

  headless: false,
  slowMo: 100,
  timeout: 60000,

  // HTTP API port (n8n triggers this)
  apiPort: 3000,

  // Keep-alive interval (ms)
  keepAliveInterval: 6 * 60 * 60 * 1000,

  alert: {
    enabled: true,
    to: "kastri@mikgroup.ch",
    from: "scraper@gads-automation.local",
  },
};

const DASHBOARDS = [
  { key: "ROB", colOffset: 0, url: "https://ads.google.com/aw/dashboards/view?ocid=1787237&ascid=1787237&dashboardId=5468641&euid=1293959655&__u=7376522095&uscid=1787237&__c=2818649213&authuser=0" },
  { key: "TML", colOffset: 1, url: "https://ads.google.com/aw/dashboards/view?ocid=1787237&ascid=1787237&dashboardId=5484865&euid=1293959655&__u=7376522095&uscid=1787237&__c=2818649213&authuser=0" },
  { key: "TBL", colOffset: 1, url: "https://ads.google.com/aw/dashboards/view?ocid=1787237&ascid=1787237&dashboardId=5524802&euid=1293959655&__u=7376522095&uscid=1787237&__c=2818649213&authuser=0" },
];

// ============================================================
// ALERTING
// ============================================================

async function sendAlert(subject, body) {
  if (!CONFIG.alert.enabled) return;
  console.log(`🔔 ALERT: ${subject}`);
  try {
    const mailBody = `Subject: ${subject}\nFrom: ${CONFIG.alert.from}\nTo: ${CONFIG.alert.to}\n\n${body}`;
    const tmpFile = path.join(CONFIG.downloadDir, ".alert-mail.txt");
    fs.writeFileSync(tmpFile, mailBody);
    try {
      execSync(
        `sendmail ${CONFIG.alert.to} < ${tmpFile} 2>/dev/null || mail -s "${subject}" ${CONFIG.alert.to} < ${tmpFile} 2>/dev/null`,
        { timeout: 10000 }
      );
    } catch {}
    try { fs.unlinkSync(tmpFile); } catch {}
  } catch {}
}

// ============================================================
// KEEP-ALIVE
// ============================================================

let keepAliveTimer = null;

function startKeepAlive(context) {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(async () => {
    try {
      const pages = context.pages();
      if (pages.length === 0) return;
      const p = pages[0];
      await p.goto("https://ads.google.com/aw/overview", {
        timeout: 30000, waitUntil: "domcontentloaded",
      }).catch(() => {});
      const isLoggedIn = p.url().includes("ads.google.com/aw/");
      console.log(`🔄 Keep-alive: ${isLoggedIn ? "✅ active" : "⚠️ expired"} (${new Date().toISOString()})`);
      if (!isLoggedIn) {
        await sendAlert(
          "[GAds Scraper] Session abgelaufen",
          `VNC: http://49.12.229.75:6080/vnc.html\nZeit: ${new Date().toISOString()}`
        );
      }
    } catch (e) {
      console.log(`🔄 Keep-alive error: ${e.message}`);
    }
  }, CONFIG.keepAliveInterval);
  console.log(`🔄 Keep-alive started (every ${CONFIG.keepAliveInterval / 3600000}h)`);
}

// ============================================================
// BROWSER & LOGIN
// ============================================================

async function ensureDirs() {
  for (const dir of [CONFIG.downloadDir, CONFIG.userDataDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

async function launchBrowser() {
  return await chromium.launchPersistentContext(CONFIG.userDataDir, {
    headless: CONFIG.headless,
    slowMo: CONFIG.slowMo,
    viewport: { width: 1440, height: 900 },
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });
}

async function waitForAdsPage(context, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    let pollCount = 0;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        clearInterval(interval);
        context.removeListener("page", onNewPage);
        reject(new Error("Login timeout — 5 minutes elapsed"));
      }
    }, timeoutMs);

    const tryResolve = (p, source) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      clearInterval(interval);
      context.removeListener("page", onNewPage);
      resolve(p);
    };

    const checkPages = () => {
      pollCount++;
      const pages = context.pages();
      for (const p of pages) {
        try {
          if (p.url().includes("ads.google.com/aw/")) {
            tryResolve(p, "poll");
            return;
          }
        } catch {}
      }
    };

    const onNewPage = (newPage) => {
      const checkNew = () => {
        try {
          if (newPage.url().includes("ads.google.com/aw/")) tryResolve(newPage, "newTab");
        } catch {}
      };
      setTimeout(checkNew, 2000);
      setTimeout(checkNew, 5000);
      setTimeout(checkNew, 10000);
    };

    context.on("page", onNewPage);
    const interval = setInterval(checkPages, 3000);
    checkPages();
  });
}

async function login(context) {
  const page = context.pages()[0] || (await context.newPage());

  console.log("🔐 Navigating to Google Ads...");
  try {
    await page.goto("https://ads.google.com", { waitUntil: "networkidle", timeout: CONFIG.timeout });
  } catch (e) {
    console.log("   Navigation: " + e.message.split("\n")[0]);
  }

  // Handle business.google.com redirect
  try {
    if (page.url().includes("business.google.com")) {
      console.log("   Redirecting from business.google.com...");
      await page.goto("https://ads.google.com/aw/overview", { waitUntil: "networkidle", timeout: CONFIG.timeout });
    }
  } catch {}

  // Handle cookie consent
  try {
    if (page.url().includes("consent.google.com")) {
      for (const sel of ['button:has-text("Alle ablehnen")', 'button:has-text("Reject all")']) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 3000 })) {
            await el.click();
            await page.waitForTimeout(3000);
            break;
          }
        } catch {}
      }
    }
  } catch {}

  // Handle MCC account picker
  try {
    const pickerVisible = await page.locator('text="Konto auswählen", text="Choose an account"')
      .first().isVisible({ timeout: 5000 }).catch(() => false);
    if (pickerVisible) {
      console.log("   MCC account picker detected");
      const account = page.locator(`text="${CONFIG.mccAccountId}"`).first();
      if (await account.isVisible({ timeout: 3000 })) {
        await account.click();
        console.log("   ✅ Selected MCC account");
        await page.waitForTimeout(5000);
        await page.waitForLoadState("networkidle").catch(() => {});
      }
    }
  } catch {}

  // Already logged in?
  try {
    if (page.url().includes("ads.google.com/aw/")) {
      console.log("✅ Already logged in.");
      return page;
    }
  } catch {}

  // Need manual login
  console.log("\n⚠️  LOGIN REQUIRED\n");
  await sendAlert(
    "[GAds Scraper] Login nötig",
    `VNC: http://49.12.229.75:6080/vnc.html\nZeit: ${new Date().toISOString()}`
  );

  const adsPage = await waitForAdsPage(context);
  await new Promise((r) => setTimeout(r, 5000));
  try { await adsPage.waitForLoadState("networkidle"); } catch {}
  console.log("✅ Login successful!");
  return adsPage;
}

// ============================================================
// DASHBOARD
// ============================================================

async function openDashboard(page, dashboardUrl, dashboardKey) {
  console.log(`📊 Opening dashboard: ${dashboardKey} (direct URL)`);

  try {
    await page.goto(dashboardUrl, { waitUntil: "networkidle", timeout: CONFIG.timeout });
    await page.waitForTimeout(5000);

    const loaded = await page.locator('.particle-table-row, [aria-label="Download"], [aria-label="Herunterladen"]')
      .first().isVisible({ timeout: 30000 }).catch(() => false);

    if (loaded) {
      console.log("   ✅ Dashboard loaded");
      return page;
    }

    await page.waitForTimeout(10000);
    const retry = await page.locator('.particle-table-row').first().isVisible({ timeout: 10000 }).catch(() => false);
    if (retry) {
      console.log("   ✅ Dashboard loaded (after extra wait)");
      return page;
    }
  } catch (e) {
    console.log("   Navigation failed:", e.message.split("\n")[0]);
  }

  console.log("   ❌ Failed to load dashboard");
  try { await page.screenshot({ path: path.join(CONFIG.downloadDir, `dashboard-error-${dashboardKey}.png`) }); } catch {}
  return null;
}

// ============================================================
// DATE RANGE
// ============================================================

async function setDateRange(page) {
  console.log("📅 Setting date range: Letzte 7 Tage...");

  try {
    const dateSelectors = [
      '[aria-label="Zeitraum"]',
      '[aria-label="Date range"]',
      'button:has-text("Letzte")',
      'button:has-text("Last")',
      'material-button:has-text("Feb")',
      'material-button:has-text("Jan")',
      'material-button:has-text("Mär")',
      '[class*="date-range"]',
      '[class*="dateRange"]',
    ];

    let datePickerClicked = false;
    for (const sel of dateSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 3000 })) {
          await el.click();
          datePickerClicked = true;
          console.log(`   Clicked date picker via: ${sel}`);
          await page.waitForTimeout(2000);
          break;
        }
      } catch {}
    }

    if (!datePickerClicked) {
      try {
        const rect = await page.evaluate(() => {
          const allEls = document.querySelectorAll("material-button, button, [role='button']");
          for (const el of allEls) {
            const text = el.textContent?.trim() || "";
            if (/\d{1,2}\.\s*(Jan|Feb|Mär|Apr|Mai|Jun|Jul|Aug|Sep|Okt|Nov|Dez)/i.test(text) ||
                /letzte|last|zeitraum|date range/i.test(text)) {
              const r = el.getBoundingClientRect();
              if (r.width > 0 && r.height > 0 && r.y < 200) {
                return { x: r.x, y: r.y, width: r.width, height: r.height };
              }
            }
          }
          return null;
        });
        if (rect) {
          await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
          datePickerClicked = true;
          await page.waitForTimeout(2000);
        }
      } catch {}
    }

    if (!datePickerClicked) {
      console.log("   ⚠️  Date picker not found");
      return;
    }

    const rangeSelectors = [
      'text="Letzte 7 Tage"', 'text="Last 7 days"',
      'li:has-text("Letzte 7 Tage")', 'li:has-text("Last 7 days")',
      '[role="menuitem"]:has-text("7 Tage")', '[role="option"]:has-text("7 Tage")',
    ];

    for (const sel of rangeSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 5000 })) {
          await el.click();
          console.log(`   ✅ Selected "Letzte 7 Tage"`);
          await page.waitForTimeout(2000);
          break;
        }
      } catch {}
    }

    for (const btnName of ["Anwenden", "Apply", "Übernehmen"]) {
      try {
        const btn = page.locator(`text="${btnName}"`).first();
        if (await btn.isVisible({ timeout: 3000 })) {
          await btn.click();
          console.log(`   ✅ Date range applied`);
          await page.waitForTimeout(5000);
          await page.waitForLoadState("networkidle").catch(() => {});
          break;
        }
      } catch {}
    }
  } catch (e) {
    console.log(`   Date range error: ${e.message}`);
  }
}

// ============================================================
// SCRAPE TABLE DATA
// ============================================================

async function scrapeTableData(page, isFirstDashboard = true, colOffset = 0) {
  console.log(`📊 Extracting table data (colOffset=${colOffset})...`);

  // Wait for data refresh - 60s for first dashboard, 15s for others
  if (isFirstDashboard) {
    console.log("   Waiting 60s for data refresh...");
    for (let i = 60; i > 0; i -= 10) {
      console.log(`   ${i}s remaining...`);
      await page.waitForTimeout(10000);
    }
  } else {
    console.log("   Waiting 15s for table data...");
    await page.waitForTimeout(15000);
  }

  try {
    await page.locator(".particle-table-row").first().waitFor({ state: "visible", timeout: 30000 });
  } catch {}
  await page.waitForTimeout(3000);

  // Dismiss banners
  try {
    const xBtn = page.locator('button[aria-label="Close"], button[aria-label="Schließen"]').first();
    if (await xBtn.isVisible({ timeout: 2000 })) {
      await xBtn.click();
      await page.waitForTimeout(1000);
    }
  } catch {}

  const tableData = await page.evaluate((offset) => {
    const rows = Array.from(document.querySelectorAll(".particle-table-row"));
    return rows.map((row) => {
      const cells = Array.from(row.querySelectorAll("ess-cell"));
      // Field mapping with offset for TML/TBL (extra Kundennummer column)
      // ROB (offset=0): cells = [domain, imprShare, ..., overlapRate, ..., absTopRate]
      // TML/TBL (offset=1): cells = [Kundennr, domain, imprShare, ..., overlapRate, ..., absTopRate]
      return {
        domain: cells[0 + offset]?.innerText.trim(),
        imprShare: cells[1 + offset]?.innerText.trim(),
        overlapRate: cells[2 + offset]?.innerText.trim(),
        aboveRate: cells[3 + offset]?.innerText.trim(),
        topOfPage: cells[4 + offset]?.innerText.trim(),
        absTop: cells[5 + offset]?.innerText.trim(),
        outranking: cells[6 + offset]?.innerText.trim(),
      };
    });
  }, colOffset);

  console.log(`   ✅ Extracted ${tableData.length} rows`);
  return tableData;
}

// ============================================================
// RUN ONCE (called by API)
// ============================================================

let isRunning = false;

async function runOnce(context) {
  if (isRunning) {
    throw new Error("A scrape is already running");
  }
  isRunning = true;

  try {
    const page = await login(context);
    const results = {};

    for (let i = 0; i < DASHBOARDS.length; i++) {
      const dash = DASHBOARDS[i];
      console.log(`\n${"=".repeat(40)}`);
      console.log(`📊 [${i + 1}/${DASHBOARDS.length}] Scraping ${dash.key}`);
      console.log(`${"=".repeat(40)}`);

      const dashPage = await openDashboard(page, dash.url, dash.key);
      if (!dashPage) {
        console.log(`   ❌ ${dash.key} — dashboard failed to load`);
        results[dash.key] = [];
        continue;
      }

      // Set date range only on first dashboard
      if (i === 0) {
        await setDateRange(dashPage);
      }

      const tableData = await scrapeTableData(dashPage, i === 0, dash.colOffset);
      results[dash.key] = tableData;
      console.log(`   ✅ ${dash.key}: ${tableData.length} rows`);
    }

    const totalRows = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);
    console.log(`\n✅ All done: ${totalRows} total rows from ${DASHBOARDS.length} dashboards`);

    return {
      ...results,
      timestamp: new Date().toISOString(),
      mccAccount: CONFIG.mccAccountId,
      totalRows,
    };
  } finally {
    isRunning = false;
  }
}

// ============================================================
// HTTP API SERVER
// ============================================================

function startApiServer(context) {
  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        running: isRunning,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    // Trigger scrape
    if (req.url === "/run" && (req.method === "GET" || req.method === "POST")) {
      console.log(`\n🌐 API: /run triggered (${new Date().toISOString()})`);

      try {
        const result = await runOnce(context);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));

        const dashboardList = DASHBOARDS.map(d => d.key).join(", ");
        await sendAlert(
          "[GAds Scraper] ✅ Erfolgreich",
          `${result.totalRows} Zeilen extrahiert aus ${DASHBOARDS.length} Dashboards (${dashboardList}).\nZeit: ${new Date().toISOString()}`
        );
      } catch (err) {
        console.error(`❌ API error: ${err.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));

        await sendAlert(
          "[GAds Scraper] ❌ Fehlgeschlagen",
          `Fehler: ${err.message}\nVNC: http://49.12.229.75:6080/vnc.html`
        );
      }
      return;
    }

    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found. Use GET /run or GET /health" }));
  });

  server.listen(CONFIG.apiPort, "0.0.0.0", () => {
    console.log(`\n🌐 API server listening on http://0.0.0.0:${CONFIG.apiPort}`);
    console.log(`   Endpoints:`);
    console.log(`   GET  /health  — Status check`);
    console.log(`   POST /run     — Trigger scrape, returns JSON data`);
    console.log(`   GET  /run     — Same (for easy testing)\n`);
  });

  return server;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("🚀 Google Ads Auction Insights Scraper");
  console.log("=======================================\n");
  console.log(`   MCC Account: ${CONFIG.mccAccountId}`);
  console.log(`   Dashboards:  ${DASHBOARDS.map(d => d.key).join(", ")}`);
  console.log(`   Mode:        HTTP API on port ${CONFIG.apiPort}`);
  console.log(`   Trigger:     POST http://49.12.229.75:${CONFIG.apiPort}/run\n`);

  await ensureDirs();
  const context = await launchBrowser();

  // Start keep-alive to prevent session expiry
  startKeepAlive(context);

  // Start HTTP API server — n8n triggers /run
  startApiServer(context);

  // If --once flag, do a single run and exit
  if (process.argv.includes("--once")) {
    try {
      const result = await runOnce(context);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`❌ ${err.message}`);
    }
    process.exit(0);
  }

  console.log("⏳ Waiting for API requests...\n");
}

// ============================================================
// LOGIN-ONLY MODE
// ============================================================

async function loginOnly() {
  console.log("🔐 Google Ads - Login Mode\n");
  await ensureDirs();
  const context = await launchBrowser();
  try {
    await login(context);
    console.log("\n✅ Login session saved.");
  } finally {
    await context.close();
  }
}

// ============================================================
// ENTRY POINT
// ============================================================

if (process.argv.includes("--login-only")) {
  loginOnly().catch(console.error);
} else {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}