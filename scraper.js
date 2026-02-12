process.env.DISPLAY = ":99";
const { chromium } = require("playwright");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

// ============================================================
// CONFIGURATION
// ============================================================
const CONFIG = {
  // MCC Account ID
  mccAccountId: "612-310-3619",

  // Dashboard name and ID
  dashboardName: "Auktion_ROB_Weekly",
  dashboardId: "5468641",

  // Working directory (screenshots, logs)
  downloadDir: path.join(__dirname, "downloads"),

  // Browser state directory
  userDataDir: path.join(__dirname, "browser-data"),

  // Headless mode
  headless: false,

  // Slow down actions (ms)
  slowMo: 100,

  // Timeout for page loads (ms)
  timeout: 60000,

  // Keep-alive interval (ms)
  keepAliveInterval: 6 * 60 * 60 * 1000, // 6 hours

  // Email alert settings
  alert: {
    enabled: true,
    to: "kastri@mikgroup.ch",
    from: "scraper@gads-automation.local",
  },
};

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
      console.log(`   ✅ Alert sent to ${CONFIG.alert.to}`);
    } catch {
      console.log(`   ⚠️  Mail command failed — install msmtp: apt install msmtp msmtp-mta`);
    }
    try { fs.unlinkSync(tmpFile); } catch {}
  } catch (e) {
    console.log(`   Alert error: ${e.message}`);
  }
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
        timeout: 30000,
        waitUntil: "domcontentloaded",
      }).catch(() => {});
      const isLoggedIn = p.url().includes("ads.google.com/aw/");
      console.log(`🔄 Keep-alive: ${isLoggedIn ? "✅ active" : "⚠️ expired"} (${new Date().toISOString()})`);
      if (!isLoggedIn) {
        await sendAlert(
          "[GAds Scraper] Session abgelaufen",
          `Bitte einloggen via VNC:\nhttp://49.12.229.75:6080/vnc.html\n\nZeit: ${new Date().toISOString()}`
        );
      }
    } catch (e) {
      console.log(`🔄 Keep-alive error: ${e.message}`);
    }
  }, CONFIG.keepAliveInterval);
  console.log(`🔄 Keep-alive started (every ${CONFIG.keepAliveInterval / 3600000}h)`);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
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
  // Clean stale lock files that prevent browser launch
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    const p = path.join(CONFIG.userDataDir, f);
    try { fs.unlinkSync(p); } catch {}
  }

  return await chromium.launchPersistentContext(CONFIG.userDataDir, {
    headless: CONFIG.headless,
    slowMo: CONFIG.slowMo,
    viewport: { width: 1440, height: 900 },
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-session-crashed-bubble",
      "--disable-infobars",
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
      try { console.log(`   [waitForAdsPage] Resolved via ${source}: ${p.url()}`); } catch {}
      resolve(p);
    };

    const checkPages = () => {
      pollCount++;
      const pages = context.pages();
      if (pollCount % 5 === 1) {
        const urls = pages.map((p) => { try { return p.url(); } catch { return "(closed)"; } });
        console.log(`   [waitForAdsPage] Poll #${pollCount}, ${pages.length} tab(s): ${JSON.stringify(urls)}`);
      }
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
      console.log("   [waitForAdsPage] New tab opened");
      const checkNew = () => {
        try {
          if (newPage.url().includes("ads.google.com/aw/")) {
            tryResolve(newPage, "newTab");
          }
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
  let page = context.pages()[0] || (await context.newPage());

  console.log("🔐 Navigating to Google Ads...");
  try {
    await page.goto("https://ads.google.com", { waitUntil: "networkidle", timeout: CONFIG.timeout });
  } catch (e) {
    console.log("   Navigation: " + e.message.split("\n")[0]);
    // If page is dead (restored from crashed session), create a fresh one
    if (e.message.includes("Target page, context or browser has been closed")) {
      console.log("   ↪ Page crashed, opening new tab...");
      page = await context.newPage();
      try {
        await page.goto("https://ads.google.com", { waitUntil: "networkidle", timeout: CONFIG.timeout });
      } catch (e2) {
        console.log("   Navigation retry: " + e2.message.split("\n")[0]);
      }
    }
  }

  // Handle cookie consent
  try {
    if (page.url().includes("consent.google.com")) {
      for (const sel of ['button:has-text("Alle ablehnen")', 'button:has-text("Reject all")']) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 3000 })) {
            await el.click();
            console.log("   ✅ Cookie consent handled");
            await page.waitForTimeout(3000);
            break;
          }
        } catch {}
      }
    }
  } catch {}

  // Redirect from business.google.com to actual Ads interface
  try {
    if (page.url().includes("business.google.com")) {
      console.log("   ↪ Redirecting from business.google.com to ads.google.com...");
      await page.goto("https://ads.google.com/aw/overview", { waitUntil: "domcontentloaded", timeout: CONFIG.timeout });
      await page.waitForTimeout(3000);
    }
  } catch {}

  // Handle MCC account picker ("Google Ads-Konto auswählen")
  try {
    const hasAccountPicker = await page.locator(':text("Konto auswählen"), :text("Choose an account")').first().isVisible({ timeout: 3000 });
    if (hasAccountPicker) {
      console.log("   🏢 Account picker detected, selecting MCC account...");
      for (const sel of [
        `:text("${CONFIG.mccAccountId}")`,
        ':text("Hurra Communications")',
        `[data-account-id*="${CONFIG.mccAccountId.replace(/-/g, "")}"]`,
      ]) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 3000 })) {
            await el.click();
            console.log(`   ✅ Selected account via: ${sel}`);
            await page.waitForTimeout(5000);
            break;
          }
        } catch {}
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
  console.log("\n⚠️  LOGIN REQUIRED — bitte manuell einloggen via VNC\n");
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

async function openDashboard(page, context) {
  console.log(`📊 Opening dashboard: ${CONFIG.dashboardName}`);

  // Extract auth params
  let authParams = {};
  for (const p of context.pages()) {
    try {
      const url = p.url();
      if (url.includes("ads.google.com")) {
        const parsed = new URL(url);
        for (const key of ["ocid", "ascid", "euid", "__u", "uscid", "__c", "authuser"]) {
          if (parsed.searchParams.has(key)) authParams[key] = parsed.searchParams.get(key);
        }
        if (Object.keys(authParams).length > 0) break;
      }
    } catch {}
  }

  const listUrl = new URL("https://ads.google.com/aw/dashboards");
  for (const [key, val] of Object.entries(authParams)) listUrl.searchParams.set(key, val);

  try {
    await page.goto(listUrl.toString(), { waitUntil: "networkidle", timeout: CONFIG.timeout });
    await page.waitForTimeout(5000);

    // Click dashboard name
    await page.locator(`text="${CONFIG.dashboardName}"`).first().click();
    await page.waitForTimeout(10000);
    await page.waitForLoadState("networkidle").catch(() => {});

    // Verify dashboard loaded (check for table or dashboard content)
    const loaded = await page.locator('.particle-table-row, [aria-label="Download"], [aria-label="Herunterladen"]')
      .first().isVisible({ timeout: 15000 }).catch(() => false);

    if (loaded) {
      console.log("   ✅ Dashboard loaded");
      return page;
    }

    // Extra wait
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
  try { await page.screenshot({ path: path.join(CONFIG.downloadDir, "dashboard-error.png") }); } catch {}
  return null;
}


// ============================================================
// SCRAPE TABLE DATA
// ============================================================

async function scrapeTableData(page) {
  console.log("📊 Extracting table data from dashboard...");

  // Wait for table to render
  try {
    await page.locator(".particle-table-row").first().waitFor({ state: "visible", timeout: 30000 });
    console.log("   Table rows visible");
  } catch {
    console.log("   ⚠️  No table rows found, trying anyway...");
  }
  await page.waitForTimeout(3000);

  // Dismiss notification banners
  try {
    const xBtn = page.locator('button[aria-label="Close"], button[aria-label="Schließen"]').first();
    if (await xBtn.isVisible({ timeout: 2000 })) {
      await xBtn.click();
      console.log("   Dismissed notification banner");
      await page.waitForTimeout(1000);
    }
  } catch {}

  // Extract data from DOM
  const tableData = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".particle-table-row"));
    return rows.map((row) => {
      const cells = Array.from(row.querySelectorAll("ess-cell"));
      return {
        domain: cells[0]?.innerText.trim(),
        imprShare: cells[1]?.innerText.trim(),
        overlapRate: cells[2]?.innerText.trim(),
        aboveRate: cells[3]?.innerText.trim(),
        topOfPage: cells[4]?.innerText.trim(),
        absTop: cells[5]?.innerText.trim(),
        outranking: cells[6]?.innerText.trim(),
      };
    });
  });

  console.log(`   ✅ Extracted ${tableData.length} rows`);
  if (tableData.length > 0) {
    console.log(`   First row: ${JSON.stringify(tableData[0])}`);
  }

  return tableData;
}

// ============================================================
// MAIN
// ============================================================

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

async function runOnce(context) {
  const page = await login(context);

  const dashPage = await openDashboard(page, context);
  if (!dashPage) {
    throw new Error(`Dashboard "${CONFIG.dashboardName}" failed to load`);
  }


  // Scrape table data from DOM
  const tableData = await scrapeTableData(dashPage);

  const timestamp = new Date().toISOString();
  console.log(`\n${"=".repeat(50)}`);
  console.log("📋 SUMMARY");
  console.log(`${"=".repeat(50)}`);
  console.log(`   Date: ${timestamp}`);
  console.log(`   Rows extracted: ${tableData.length}`);

  return {
    auctionData: tableData,
    timestamp,
    dashboard: CONFIG.dashboardName,
    mccAccount: CONFIG.mccAccountId,
    rows: tableData.length,
  };
}

async function main() {
  const once = process.argv.includes("--once");

  console.log("🚀 Google Ads Auction Insights Scraper");
  console.log("=======================================\n");
  console.log(`   MCC Account: ${CONFIG.mccAccountId}`);
  console.log(`   Dashboard:   ${CONFIG.dashboardName}`);
  console.log(`   Method:      DOM Scraping → JSON API`);
  console.log(`   Mode:        ${once ? "single run" : "weekly (every 7 days)"}\n`);

  await ensureDirs();
  const context = await launchBrowser();

  try {
    await runOnce(context);

    if (once) {
      console.log("\n✅ Single run complete. Exiting.");
      return;
    }

    startKeepAlive(context);

    while (true) {
      const nextRun = new Date(Date.now() + WEEK_MS);
      console.log(`\n⏰ Next run: ${nextRun.toISOString()}`);
      await new Promise((r) => setTimeout(r, WEEK_MS));

      console.log(`\n${"=".repeat(50)}`);
      console.log(`🔄 Weekly run: ${new Date().toISOString()}`);
      console.log(`${"=".repeat(50)}\n`);

      try {
        const result = await runOnce(context);
        await sendAlert(
          "[GAds Scraper] ✅ Erfolgreich",
          `${result.rows} Zeilen extrahiert und an n8n gesendet.\nZeit: ${new Date().toISOString()}`
        );
      } catch (err) {
        console.error(`\n❌ Weekly run failed: ${err.message}`);
        await sendAlert(
          "[GAds Scraper] ❌ Fehlgeschlagen",
          `Fehler: ${err.message}\n\nVNC: http://49.12.229.75:6080/vnc.html\nZeit: ${new Date().toISOString()}`
        );
        try {
          const pages = context.pages();
          if (pages.length > 0) {
            await pages[pages.length - 1].screenshot({
              path: path.join(CONFIG.downloadDir, "error-screenshot.png"),
            });
          }
        } catch {}
      }
    }
  } catch (err) {
    console.error(`\n❌ Fatal error: ${err.message}`);
    await sendAlert(
      "[GAds Scraper] ❌ Fatal Error",
      `Scraper gestoppt: ${err.message}\nZeit: ${new Date().toISOString()}`
    );
  } finally {
    stopKeepAlive();
    await context.close();
  }
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
    console.log("\n✅ Login session saved to: " + CONFIG.userDataDir);
  } finally {
    await context.close();
  }
}

// ============================================================
// HTTP SERVER (health check & manual trigger)
// ============================================================

let lastRun = null;
let lastError = null;
let running = false;

function startServer() {
  const PORT = process.env.PORT || 3000;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", lastRun, lastError, running }));
    } else if (req.url === "/run" && req.method === "POST") {
      if (running) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "already running" }));
        return;
      }
      try {
        const result = await triggerRun();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  server.listen(PORT, () => console.log(`🌐 HTTP server listening on port ${PORT}`));
}

async function triggerRun() {
  running = true;
  lastError = null;
  let context;
  try {
    await ensureDirs();
    context = await launchBrowser();
    const result = await runOnce(context);
    lastRun = { date: result.timestamp, rows: result.rows };
    console.log("✅ Triggered run complete.");
    return result;
  } catch (err) {
    lastError = err.message;
    console.error("❌ Triggered run failed:", err.message);
    throw err;
  } finally {
    running = false;
    if (context) await context.close().catch(() => {});
  }
}

// ============================================================
// ENTRY POINT
// ============================================================

if (process.argv.includes("--login-only")) {
  loginOnly().catch(console.error);
} else if (process.argv.includes("--once")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  // Default: HTTP server only, scrape triggered via POST /run
  startServer();
}