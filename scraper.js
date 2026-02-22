const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const http = require("http");
const net = require("net");
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

// Tier 2: Individual dashboards (ROB, TML, TBL, CV)
const DASHBOARDS = [
  { key: "ROB", colOffset: 0, url: "https://ads.google.com/aw/dashboards/view?ocid=1787237&ascid=1787237&dashboardId=5468641&euid=1293959655&__u=7376522095&uscid=1787237&__c=2818649213&authuser=0" },
  { key: "TML", colOffset: 1, url: "https://ads.google.com/aw/dashboards/view?ocid=1787237&ascid=1787237&dashboardId=5484865&euid=1293959655&__u=7376522095&uscid=1787237&__c=2818649213&authuser=0" },
  { key: "TBL", colOffset: 1, url: "https://ads.google.com/aw/dashboards/view?ocid=1787237&ascid=1787237&dashboardId=5524802&euid=1293959655&__u=7376522095&uscid=1787237&__c=2818649213&authuser=0" },
  // ---- CARE VISION (added) ----
  { key: "CV", colOffset: -1, url: "https://ads.google.com/aw/dashboards/view?ocid=85074074&ascid=85074074&dashboardId=5438898&euid=1293959655&__u=7376522095&uscid=1787237&__c=2818649213&authuser=0" },
];

// Tier 1: MCC-level Auction Insights dashboard
const MCC_DASHBOARD = {
  key: "MCC",
  url: "https://ads.google.com/aw/dashboards/view?ocid=1787237&ascid=1787237&dashboardId=5445962&euid=1293959655&__u=7376522095&uscid=1787237&__c=2818649213&authuser=0",
};

// ============================================================
// ALERTING
// ============================================================

async function sendAlert(subject, body) {
  if (!CONFIG.alert.enabled) return;
  console.log(`ALERT: ${subject}`);
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
// PORT CHECK & PROCESS LIFECYCLE
// ============================================================

function checkPortFree(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use. Kill the existing process first.`));
      } else {
        reject(err);
      }
    });
    srv.once("listening", () => {
      srv.close(() => resolve());
    });
    srv.listen(port, "0.0.0.0");
  });
}

let _browserContext = null;

function setupShutdownHandlers() {
  async function shutdown(signal) {
    console.log(`\n${signal} received — shutting down...`);
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    if (_browserContext) {
      try { await _browserContext.close(); } catch {}
      _browserContext = null;
    }
    process.exit(0);
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", async (err) => {
    console.error("Uncaught exception:", err);
    if (_browserContext) {
      try { await _browserContext.close(); } catch {}
    }
    process.exit(1);
  });
  process.on("unhandledRejection", async (err) => {
    console.error("Unhandled rejection:", err);
    if (_browserContext) {
      try { await _browserContext.close(); } catch {}
    }
    process.exit(1);
  });
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
      console.log(`Keep-alive: ${isLoggedIn ? "active" : "expired"} (${new Date().toISOString()})`);
      if (!isLoggedIn) {
        await sendAlert(
          "[GAds Scraper] Session abgelaufen",
          `VNC: http://49.12.229.75:6080/vnc.html\nZeit: ${new Date().toISOString()}`
        );
      }
    } catch (e) {
      console.log(`Keep-alive error: ${e.message}`);
    }
  }, CONFIG.keepAliveInterval);
  console.log(`Keep-alive started (every ${CONFIG.keepAliveInterval / 3600000}h)`);
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
        reject(new Error("Login timeout - 5 minutes elapsed"));
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

  console.log("Navigating to Google Ads...");
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
    if (page.url().includes("selectaccount") || page.url().includes("nav/select")) {
      console.log("   MCC account picker detected (via URL)");
      const account = page.locator(`text="${CONFIG.mccAccountId}"`).first();
      if (await account.isVisible({ timeout: 5000 })) {
        await account.click();
        console.log("   Selected MCC account");
        await page.waitForTimeout(5000);
        await page.waitForLoadState("networkidle").catch(() => {});
      } else {
        const byName = page.locator('text="Hurra Communications"').first();
        if (await byName.isVisible({ timeout: 3000 })) {
          await byName.click();
          console.log("   Selected MCC account (by name)");
          await page.waitForTimeout(5000);
          await page.waitForLoadState("networkidle").catch(() => {});
        }
      }
    }
  } catch {}

  // Already logged in?
  try {
    if (page.url().includes("ads.google.com/aw/")) {
      console.log("Already logged in.");
      return page;
    }
  } catch {}

  // Need manual login
  console.log("\nLOGIN REQUIRED\n");
  await sendAlert(
    "[GAds Scraper] Login noetig",
    `VNC: http://49.12.229.75:6080/vnc.html\nZeit: ${new Date().toISOString()}`
  );

  const adsPage = await waitForAdsPage(context);
  await new Promise((r) => setTimeout(r, 5000));
  try { await adsPage.waitForLoadState("networkidle"); } catch {}
  console.log("Login successful!");
  return adsPage;
}

// ============================================================
// DASHBOARD (Tier 2)
// ============================================================

async function openDashboard(page, dashboardUrl, dashboardKey) {
  console.log(`Opening dashboard: ${dashboardKey} (direct URL)`);

  try {
    await page.goto(dashboardUrl, { waitUntil: "networkidle", timeout: CONFIG.timeout });
    await page.waitForTimeout(5000);

    const loaded = await page.locator('.particle-table-row, [aria-label="Download"], [aria-label="Herunterladen"]')
      .first().isVisible({ timeout: 30000 }).catch(() => false);

    if (loaded) {
      console.log("   Dashboard loaded");
      return page;
    }

    await page.waitForTimeout(10000);
    const retry = await page.locator('.particle-table-row').first().isVisible({ timeout: 10000 }).catch(() => false);
    if (retry) {
      console.log("   Dashboard loaded (after extra wait)");
      return page;
    }
  } catch (e) {
    console.log("   Navigation failed:", e.message.split("\n")[0]);
  }

  console.log("   Failed to load dashboard");
  try { await page.screenshot({ path: path.join(CONFIG.downloadDir, `dashboard-error-${dashboardKey}.png`) }); } catch {}
  return null;
}

// ============================================================
// DATE RANGE (Tier 2)
// ============================================================

async function setDateRange(page) {
  console.log("Setting date range: Letzte 7 Tage...");

  try {
    const dateSelectors = [
      '[aria-label="Zeitraum"]',
      '[aria-label="Date range"]',
      'button:has-text("Letzte")',
      'button:has-text("Last")',
      'material-button:has-text("Feb")',
      'material-button:has-text("Jan")',
      'material-button:has-text("Mar")',
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
            if (/\d{1,2}\.\s*(Jan|Feb|Mar|Apr|Mai|Jun|Jul|Aug|Sep|Okt|Nov|Dez)/i.test(text) ||
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
      console.log("   Date picker not found");
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
          console.log(`   Selected "Letzte 7 Tage"`);
          await page.waitForTimeout(2000);
          break;
        }
      } catch {}
    }

    for (const btnName of ["Anwenden", "Apply", "Uebernehmen"]) {
      try {
        const btn = page.locator(`text="${btnName}"`).first();
        if (await btn.isVisible({ timeout: 3000 })) {
          await btn.click();
          console.log(`   Date range applied`);
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
// SCRAPE TABLE DATA (Tier 2 - single dashboard)
// ============================================================

async function scrapeTableData(page, isFirstDashboard = true, colOffset = 0) {
  console.log(`Extracting table data (colOffset=${colOffset})...`);

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
    const xBtn = page.locator('button[aria-label="Close"], button[aria-label="Schliessen"]').first();
    if (await xBtn.isVisible({ timeout: 2000 })) {
      await xBtn.click();
      await page.waitForTimeout(1000);
    }
  } catch {}

  const tableData = await page.evaluate((offset) => {
    const rows = Array.from(document.querySelectorAll(".particle-table-row"));
    return rows.map((row) => {
      const cells = Array.from(row.querySelectorAll("ess-cell"));
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

  console.log(`   Extracted ${tableData.length} rows`);
  return tableData;
}

// ============================================================
// NEW-TAB HANDLING (Google Ads sometimes opens a new tab)
// ============================================================

async function navigateWithNewTabHandling(context, page, url, label) {
  console.log(`[NAV] ${label}: navigating...`);

  let newTabPage = null;
  const onNewPage = (p) => { newTabPage = p; };
  context.on("page", onNewPage);

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 90000 });
  } catch (e) {
    console.log(`[NAV] ${label}: navigation note - ${e.message.split("\n")[0]}`);
  }

  context.removeListener("page", onNewPage);

  // If a new tab opened, switch to it
  if (newTabPage) {
    console.log(`[NAV] ${label}: new tab detected, switching...`);
    try {
      await newTabPage.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 5000));
      // Check if the new tab is the ads page
      if (newTabPage.url().includes("ads.google.com")) {
        console.log(`[NAV] ${label}: using new tab (${newTabPage.url().substring(0, 80)})`);
        // Close old page if it's still alive
        try {
          const isAlive = await page.evaluate(() => true).catch(() => false);
          if (isAlive && page !== newTabPage) {
            await page.close().catch(() => {});
          }
        } catch {}
        return newTabPage;
      }
    } catch (e) {
      console.log(`[NAV] ${label}: new tab error - ${e.message}`);
    }
  }

  // Check if original page is still alive
  try {
    await page.evaluate(() => true);
    return page;
  } catch {
    // Original page is dead, find a live ads page
    console.log(`[NAV] ${label}: original page dead, searching for live page...`);
    const pages = context.pages();
    for (const p of pages) {
      try {
        const url = p.url();
        if (url.includes("ads.google.com")) {
          console.log(`[NAV] ${label}: found live ads page`);
          return p;
        }
      } catch {}
    }
    throw new Error(`${label}: no live Google Ads page found`);
  }
}

// ============================================================
// SCRAPE MCC TABLE (Tier 1 - paginated)
// ============================================================

async function scrapeMccPage(page) {
  await page.locator(".particle-table-row").first().waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const rows = await page.evaluate(() => {
    const tableRows = document.querySelectorAll(".particle-table-row");
    const data = [];

    tableRows.forEach(row => {
      const cells = row.querySelectorAll("ess-cell");
      if (cells.length < 8) return;

      const getText = (cell) => {
        const span = cell.querySelector("span") || cell.querySelector(".cell-text") || cell;
        return (span.textContent || "").trim();
      };

      const konto = getText(cells[0]);
      const domain = getText(cells[1]);
      const imprShare = getText(cells[2]);
      const overlapRate = getText(cells[3]);
      const posAboveRate = getText(cells[4]);
      const topOfPageRate = getText(cells[5]);
      const absTopRate = getText(cells[6]);
      const outrankingShare = getText(cells[7]);

      // Skip headers, empty, summary rows
      if (!konto || konto === "Konto" || konto === "Gesamt") return;
      if (!domain || domain === "Domain der angezeigten URL") return;

      data.push({ konto, domain, imprShare, overlapRate, posAboveRate, topOfPageRate, absTopRate, outrankingShare });
    });

    return data;
  });

  return rows;
}

async function getMccPageInfo(page) {
  const info = await page.evaluate(() => {
    const body = document.body.innerText;
    const match = body.match(/(\d+)\s+bis\s+(\d+)\s+von\s+(\d+)/);
    if (match) {
      return { from: parseInt(match[1]), to: parseInt(match[2]), total: parseInt(match[3]) };
    }
    return null;
  });
  return info;
}

async function clickMccNextPage(page) {
  const clicked = await page.evaluate(() => {
    const selectors = [
      'button[aria-label="Nächste Seite"]',
      'button[aria-label="Next page"]',
      '.paginator-next',
      '.particle-paginator button:last-child',
      'material-button[aria-label*="chste"]',
      'material-button[aria-label*="next"]'
    ];

    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled) {
        btn.click();
        return true;
      }
    }

    // Fallback: find arrow icon
    const buttons = document.querySelectorAll("button, material-button");
    for (const btn of buttons) {
      const icon = btn.querySelector("material-icon, .material-icons, i");
      if (icon && (icon.textContent.includes("navigate_next") || icon.textContent.includes("chevron_right"))) {
        if (!btn.disabled) {
          btn.click();
          return true;
        }
      }
    }

    return false;
  });

  if (clicked) {
    // Wait for new page data to load (500+ rows)
    await page.waitForTimeout(10000);
    // Extra check: wait until table rows are visible again
    await page.locator(".particle-table-row").first().waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  return clicked;
}

async function scrapeMccAllPages(context, page) {
  console.log("[MCC] Navigating to MCC Auction Insights dashboard...");

  // Use new-tab handling - Google Ads may open MCC dashboard in a new tab
  page = await navigateWithNewTabHandling(context, page, MCC_DASHBOARD.url, "MCC");
  await new Promise((r) => setTimeout(r, 10000));

  // Check if table loaded
  const hasTable = await page.locator(".particle-table-row").first().isVisible({ timeout: 30000 }).catch(() => false);

  if (!hasTable) {
    console.log("[MCC] WARNING: No .particle-table-row found. Taking screenshot...");
    try { await page.screenshot({ path: path.join(CONFIG.downloadDir, "mcc-scrape-error.png"), fullPage: true }); } catch {}
    await sendAlert(
      "[GAds Scraper] MCC - No table rows",
      `No .particle-table-row found on MCC dashboard.\nVNC: http://49.12.229.75:6080/vnc.html`
    );
    return { data: [], accounts: 0, totalRows: 0, pages: 0, warning: "No table rows found", _activePage: page };
  }

  let allRows = [];
  let pageNum = 1;
  let hasMore = true;

  while (hasMore) {
    console.log(`[MCC] Scraping page ${pageNum}...`);
    const rows = await scrapeMccPage(page);
    console.log(`[MCC] Page ${pageNum}: ${rows.length} rows`);
    allRows = allRows.concat(rows);

    const pageInfo = await getMccPageInfo(page);
    console.log(`[MCC] Pagination:`, pageInfo);

    if (pageInfo && pageInfo.to < pageInfo.total) {
      const clicked = await clickMccNextPage(page);
      if (clicked) {
        pageNum++;
        await new Promise((r) => setTimeout(r, 3000));
      } else {
        console.log("[MCC] Could not click next page");
        hasMore = false;
      }
    } else {
      hasMore = false;
    }
  }

  console.log(`[MCC] Total: ${allRows.length} rows across ${pageNum} pages`);

  const grouped = {};
  for (const row of allRows) {
    if (!grouped[row.konto]) grouped[row.konto] = [];
    grouped[row.konto].push(row);
  }

  const accountCount = Object.keys(grouped).length;
  console.log(`[MCC] Found ${accountCount} unique accounts`);

  return {
    data: allRows,
    accounts: accountCount,
    totalRows: allRows.length,
    pages: pageNum,
    _activePage: page,
  };
}

// ============================================================
// RUN TIER 2 - SEQUENTIAL (original /run behavior)
// ============================================================

async function runTier2(context) {
  const page = await login(context);
  const results = {};

  for (let i = 0; i < DASHBOARDS.length; i++) {
    const dash = DASHBOARDS[i];
    console.log(`\n${"=".repeat(40)}`);
    console.log(`[${i + 1}/${DASHBOARDS.length}] Scraping ${dash.key}`);
    console.log(`${"=".repeat(40)}`);

    const dashPage = await openDashboard(page, dash.url, dash.key);
    if (!dashPage) {
      console.log(`   ${dash.key} - dashboard failed to load`);
      results[dash.key] = [];
      continue;
    }

    // Set date range only on first dashboard
    if (i === 0) {
      await setDateRange(dashPage);
    }

    const tableData = await scrapeTableData(dashPage, i === 0, dash.colOffset);
    results[dash.key] = tableData;
    console.log(`   ${dash.key}: ${tableData.length} rows`);
  }

  const totalRows = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`\nAll done: ${totalRows} total rows from ${DASHBOARDS.length} dashboards`);

  return {
    ...results,
    timestamp: new Date().toISOString(),
    mccAccount: CONFIG.mccAccountId,
    totalRows,
  };
}

// ============================================================
// RUN MCC - TIER 1 (paginated MCC dashboard)
// ============================================================

async function runMcc(context) {
  const page = await login(context);

  const mccResult = await scrapeMccAllPages(context, page);

  return {
    data: mccResult.data,
    accounts: mccResult.accounts,
    totalRows: mccResult.totalRows,
    pages: mccResult.pages,
    timestamp: new Date().toISOString(),
    mccAccount: CONFIG.mccAccountId,
  };
}

// ============================================================
// RUN ALL - Individual first, then MCC (same session)
// ============================================================

async function runAll(context) {
  console.log("\n========================================");
  console.log("  RUN-ALL: Individual (Tier 2) + MCC (Tier 1)");
  console.log("========================================\n");

  const startTime = Date.now();

  // Single login for both phases
  let page = await login(context);

  const result = {
    mcc: null,
    individual: null,
    scrapedAt: new Date().toISOString(),
  };

  // --- Phase 1: Individual (sequential, same page) ---
  console.log("\n=== PHASE 1: Individual Dashboards ===\n");
  try {
    const individualResults = {};

    for (let i = 0; i < DASHBOARDS.length; i++) {
      const dash = DASHBOARDS[i];
      console.log(`\n${"=".repeat(40)}`);
      console.log(`[${i + 1}/${DASHBOARDS.length}] Scraping ${dash.key}`);
      console.log(`${"=".repeat(40)}`);

      const dashPage = await openDashboard(page, dash.url, dash.key);
      if (!dashPage) {
        console.log(`   ${dash.key} - dashboard failed to load`);
        individualResults[dash.key] = [];
        continue;
      }

      // Set date range only on first dashboard
      if (i === 0) {
        await setDateRange(dashPage);
      }

      const tableData = await scrapeTableData(dashPage, i === 0, dash.colOffset);
      individualResults[dash.key] = tableData;
      console.log(`   ${dash.key}: ${tableData.length} rows`);
    }

    const totalRows = Object.values(individualResults).reduce((sum, arr) => sum + arr.length, 0);
    result.individual = {
      success: true,
      ...individualResults,
      totalRows,
    };
    console.log(`\n[TIER2] Success: ${totalRows} rows\n`);
  } catch (e) {
    console.error(`[TIER2] FAILED: ${e.message}`);
    result.individual = { success: false, error: e.message };
    try { await page.screenshot({ path: path.join(CONFIG.downloadDir, "tier2-error.png") }); } catch {}
  }

  // Small pause between phases - use safe timeout
  console.log("[RUN-ALL] Waiting 10s between phases...\n");
  await new Promise((r) => setTimeout(r, 10000));

  // --- Phase 2: MCC ---
  console.log("=== PHASE 2: MCC Auction Insights ===\n");
  try {
    const mccResult = await scrapeMccAllPages(context, page);
    // Update page reference - MCC navigation may have opened a new tab
    page = mccResult._activePage || page;
    result.mcc = {
      success: true,
      data: mccResult.data,
      accounts: mccResult.accounts,
      totalRows: mccResult.totalRows,
      pages: mccResult.pages,
    };
    console.log(`\n[MCC] Success: ${mccResult.totalRows} rows, ${mccResult.accounts} accounts\n`);
  } catch (e) {
    console.error(`[MCC] FAILED: ${e.message}`);
    result.mcc = { success: false, error: e.message, data: [], totalRows: 0, accounts: 0 };
    try {
      const pages = context.pages();
      for (const p of pages) {
        try {
          if (p.url().includes("ads.google.com")) { page = p; break; }
        } catch {}
      }
    } catch {}
    try { await page.screenshot({ path: path.join(CONFIG.downloadDir, "mcc-error.png") }); } catch {}
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\n========================================`);
  console.log(`  RUN-ALL COMPLETE (${elapsed}s)`);
  console.log(`  MCC: ${result.mcc.success ? result.mcc.totalRows + ' rows' : 'FAILED'}`);
  console.log(`  Individual: ${result.individual.success ? result.individual.totalRows + ' rows' : 'FAILED'}`);
  console.log(`========================================\n`);

  // Alert
  const status = result.mcc.success && result.individual.success ? "Erfolgreich" : "Teilweise fehlgeschlagen";
  await sendAlert(
    `[GAds Scraper] Run-All ${status}`,
    `MCC: ${result.mcc.success ? result.mcc.totalRows + ' Zeilen, ' + result.mcc.accounts + ' Konten' : 'FEHLER: ' + (result.mcc.error || 'unknown')}\n` +
    `Individual: ${result.individual.success ? result.individual.totalRows + ' Zeilen' : 'FEHLER: ' + (result.individual.error || 'unknown')}\n` +
    `Dauer: ${elapsed}s\nZeit: ${new Date().toISOString()}`
  );

  return result;
}

// ============================================================
// HTTP API SERVER
// ============================================================

let isRunning = false;

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
        endpoints: ["/health", "/run", "/scrape-mcc", "/run-all"],
      }));
      return;
    }

    // Guard: only one scrape at a time
    if (isRunning) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "A scrape is already running. Try again later." }));
      return;
    }

    // /run - Tier 2 only (ROB, TML, TBL, CV) - ORIGINAL behavior, backward compatible
    if (req.url === "/run" && (req.method === "GET" || req.method === "POST")) {
      console.log(`\nAPI: /run triggered (${new Date().toISOString()})`);
      isRunning = true;

      try {
        const result = await runTier2(context);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));

        const dashboardList = DASHBOARDS.map(d => d.key).join(", ");
        await sendAlert(
          "[GAds Scraper] Erfolgreich",
          `${result.totalRows} Zeilen extrahiert aus ${DASHBOARDS.length} Dashboards (${dashboardList}).\nZeit: ${new Date().toISOString()}`
        );
      } catch (err) {
        console.error(`API error: ${err.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));

        await sendAlert(
          "[GAds Scraper] Fehlgeschlagen",
          `Fehler: ${err.message}\nVNC: http://49.12.229.75:6080/vnc.html`
        );
      } finally {
        isRunning = false;
      }
      return;
    }

    // /scrape-mcc - Tier 1 only (MCC dashboard)
    if (req.url === "/scrape-mcc" && (req.method === "GET" || req.method === "POST")) {
      console.log(`\nAPI: /scrape-mcc triggered (${new Date().toISOString()})`);
      isRunning = true;

      try {
        const result = await runMcc(context);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));

        await sendAlert(
          "[GAds Scraper] MCC Erfolgreich",
          `${result.totalRows} Zeilen, ${result.accounts} Konten.\nZeit: ${new Date().toISOString()}`
        );
      } catch (err) {
        console.error(`API /scrape-mcc error: ${err.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));

        await sendAlert(
          "[GAds Scraper] MCC Fehlgeschlagen",
          `Fehler: ${err.message}\nVNC: http://49.12.229.75:6080/vnc.html`
        );
      } finally {
        isRunning = false;
      }
      return;
    }

    // /run-all - MCC first, then Individual, single session
    if (req.url === "/run-all" && (req.method === "GET" || req.method === "POST")) {
      console.log(`\nAPI: /run-all triggered (${new Date().toISOString()})`);
      isRunning = true;

      try {
        const result = await runAll(context);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error(`API /run-all error: ${err.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));

        await sendAlert(
          "[GAds Scraper] Run-All Fehlgeschlagen",
          `Fehler: ${err.message}\nVNC: http://49.12.229.75:6080/vnc.html`
        );
      } finally {
        isRunning = false;
      }
      return;
    }

    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found. Endpoints: /health, /run, /scrape-mcc, /run-all" }));
  });

  server.listen(CONFIG.apiPort, "0.0.0.0", () => {
    console.log(`\nAPI server listening on http://0.0.0.0:${CONFIG.apiPort}`);
    console.log(`   Endpoints:`);
    console.log(`   GET  /health      - Status check`);
    console.log(`   GET  /run         - Tier 2 only (ROB, TML, TBL, CV) - original`);
    console.log(`   GET  /scrape-mcc  - Tier 1 only (MCC dashboard)`);
    console.log(`   GET  /run-all     - MCC first, then Individual\n`);
  });

  return server;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Google Ads Unified Auction Insights Scraper");
  console.log("============================================\n");
  console.log(`   MCC Account:  ${CONFIG.mccAccountId}`);
  console.log(`   Tier 1 (MCC): All accounts via MCC dashboard`);
  console.log(`   Tier 2:       ${DASHBOARDS.map(d => d.key).join(", ")}`);
  console.log(`   Port:         ${CONFIG.apiPort}`);
  console.log(`   Trigger:      GET http://49.12.229.75:${CONFIG.apiPort}/run-all\n`);

  await ensureDirs();
  setupShutdownHandlers();

  // Pre-check port BEFORE launching browser (avoids orphan Chrome on EADDRINUSE)
  if (!process.argv.includes("--once")) {
    await checkPortFree(CONFIG.apiPort);
  }

  const context = await launchBrowser();
  _browserContext = context;

  // If --once flag, skip server and just run once
  if (process.argv.includes("--once")) {
    try {
      const result = await runAll(context);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`Error: ${err.message}`);
    }
    await context.close();
    _browserContext = null;
    process.exit(0);
  }

  // Start keep-alive to prevent session expiry
  startKeepAlive(context);

  // Start HTTP API server
  startApiServer(context);

  console.log("Waiting for API requests...\n");
}

// ============================================================
// LOGIN-ONLY MODE
// ============================================================

async function loginOnly() {
  console.log("Google Ads - Login Mode\n");
  await ensureDirs();
  setupShutdownHandlers();
  const context = await launchBrowser();
  _browserContext = context;
  try {
    await login(context);
    console.log("\nLogin session saved.");
  } finally {
    await context.close();
    _browserContext = null;
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
