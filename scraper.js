const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
const axios = require("axios");

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

  // n8n Webhook URL for data delivery
  webhookUrl: "https://n8n.hurra.com/webhook-test/e3854837-8069-4e1f-9016-0203ec5fa052",

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
  const page = context.pages()[0] || (await context.newPage());

  console.log("🔐 Navigating to Google Ads...");
  try {
    await page.goto("https://ads.google.com", { waitUntil: "networkidle", timeout: CONFIG.timeout });
  } catch (e) {
    console.log("   Navigation: " + e.message.split("\n")[0]);
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
// DATE RANGE: "Letzte 7 Tage (bis gestern)"
// ============================================================

async function setDateRange(page) {
  console.log("📅 Setting date range: Letzte 7 Tage...");
  const screenshotDir = CONFIG.downloadDir;

  try {
    // Click the date range button in the toolbar
    // Google Ads shows the current date range as a button/dropdown in the top bar
    const dateSelectors = [
      '[aria-label="Zeitraum"]',
      '[aria-label="Date range"]',
      'button:has-text("Letzte")',
      'button:has-text("Last")',
      // The date range often shows the actual dates like "1. Feb – 7. Feb 2026"
      'material-button:has-text("Feb")',
      'material-button:has-text("Jan")',
      'material-button:has-text("Mär")',
      // Generic date picker button
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

    // Fallback: find by coordinate (date range is typically top-right toolbar area)
    if (!datePickerClicked) {
      try {
        const rect = await page.evaluate(() => {
          // Look for elements containing date-like text in the toolbar
          const allEls = document.querySelectorAll("material-button, button, [role='button']");
          for (const el of allEls) {
            const text = el.textContent?.trim() || "";
            // Match date patterns like "1. Feb – 7. Feb" or "Last 7 days"
            if (/\d{1,2}\.\s*(Jan|Feb|Mär|Apr|Mai|Jun|Jul|Aug|Sep|Okt|Nov|Dez)/i.test(text) ||
                /letzte|last|zeitraum|date range/i.test(text)) {
              const r = el.getBoundingClientRect();
              if (r.width > 0 && r.height > 0 && r.y < 200) { // toolbar is at top
                return { x: r.x, y: r.y, width: r.width, height: r.height };
              }
            }
          }
          return null;
        });
        if (rect) {
          await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
          datePickerClicked = true;
          console.log("   Clicked date picker via coordinate fallback");
          await page.waitForTimeout(2000);
        }
      } catch {}
    }

    if (!datePickerClicked) {
      console.log("   ⚠️  Could not find date picker — using default date range");
      await page.screenshot({ path: path.join(screenshotDir, "date-picker-not-found.png") });
      return;
    }

    await page.screenshot({ path: path.join(screenshotDir, "date-picker-open.png") });

    // Select "Letzte 7 Tage" from the predefined options
    const rangeSelectors = [
      'text="Letzte 7 Tage"',
      'text="Last 7 days"',
      'li:has-text("Letzte 7 Tage")',
      'li:has-text("Last 7 days")',
      '[role="menuitem"]:has-text("7 Tage")',
      '[role="menuitem"]:has-text("7 days")',
      '[role="option"]:has-text("7 Tage")',
      '[role="option"]:has-text("7 days")',
    ];

    let rangeSelected = false;
    for (const sel of rangeSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 5000 })) {
          await el.click();
          rangeSelected = true;
          console.log(`   ✅ Selected "Letzte 7 Tage" via: ${sel}`);
          await page.waitForTimeout(2000);
          break;
        }
      } catch {}
    }

    if (!rangeSelected) {
      console.log("   ⚠️  'Letzte 7 Tage' option not found");
      await page.screenshot({ path: path.join(screenshotDir, "date-range-options.png") });
      return;
    }

    // Click "Anwenden" / "Apply" to confirm the date range
    for (const btnName of ["Anwenden", "Apply", "Übernehmen"]) {
      try {
        const btn = page.locator(`text="${btnName}"`).first();
        if (await btn.isVisible({ timeout: 3000 })) {
          await btn.click();
          console.log(`   ✅ Date range applied via "${btnName}"`);
          await page.waitForTimeout(5000);
          // Wait for dashboard to reload with new data
          await page.waitForLoadState("networkidle").catch(() => {});
          break;
        }
      } catch {}
    }

    await page.screenshot({ path: path.join(screenshotDir, "date-range-applied.png") });
    console.log("   📅 Date range set successfully");
  } catch (e) {
    console.log(`   Date range error: ${e.message}`);
  }
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
// SEND DATA TO n8n WEBHOOK
// ============================================================

async function sendToWebhook(tableData) {
  console.log(`📤 Sending ${tableData.length} rows to n8n webhook...`);

  if (tableData.length === 0) {
    console.log("   ⚠️  No data to send");
    return false;
  }

  try {
    const response = await axios.post(
      CONFIG.webhookUrl,
      {
        auctionData: tableData,
        timestamp: new Date().toISOString(),
        dashboard: CONFIG.dashboardName,
        mccAccount: CONFIG.mccAccountId,
      },
      { headers: { "Content-Type": "application/json" }, timeout: 30000 }
    );
    console.log(`   ✅ Webhook response: ${response.status}`);
    return true;
  } catch (err) {
    console.error(`   ❌ Webhook error: ${err.message}`);
    return false;
  }
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

  // Set date range to "Letzte 7 Tage"
  await setDateRange(dashPage);

  // Scrape table data from DOM
  const tableData = await scrapeTableData(dashPage);

  // Send to n8n webhook
  const success = await sendToWebhook(tableData);

  const timestamp = new Date().toISOString().split("T")[0];
  console.log(`\n${"=".repeat(50)}`);
  console.log("📋 SUMMARY");
  console.log(`${"=".repeat(50)}`);
  console.log(`   Date: ${timestamp}`);
  console.log(`   Rows extracted: ${tableData.length}`);
  console.log(`   Webhook: ${success ? "✅ sent" : "❌ failed"}`);

  return { rows: tableData.length, success };
}

async function main() {
  const once = process.argv.includes("--once");

  console.log("🚀 Google Ads Auction Insights Scraper");
  console.log("=======================================\n");
  console.log(`   MCC Account: ${CONFIG.mccAccountId}`);
  console.log(`   Dashboard:   ${CONFIG.dashboardName}`);
  console.log(`   Method:      DOM Scraping → n8n Webhook`);
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