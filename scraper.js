const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

// ============================================================
// CONFIGURATION
// ============================================================
const CONFIG = {
  // MCC Account ID (format: "xxx-xxx-xxxx")
  mccAccountId: "612-310-3619",

  // Dashboard name and ID
  dashboardName: "Auktion_ROB_Weekly",
  dashboardId: "5468641",

  // Download format
  downloadFormat: "xlsx",

  // Download directory
  downloadDir: path.join(__dirname, "downloads"),

  // Browser state directory
  userDataDir: path.join(__dirname, "browser-data"),

  // Headless mode
  headless: false,

  // Slow down actions (ms)
  slowMo: 100,

  // Timeout for page loads (ms)
  timeout: 60000,
};

// ============================================================
// BROWSER & LOGIN
// ============================================================

async function ensureDirs() {
  for (const dir of [CONFIG.downloadDir, CONFIG.userDataDir]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

async function launchBrowser() {
  const context = await chromium.launchPersistentContext(CONFIG.userDataDir, {
    headless: CONFIG.headless,
    slowMo: CONFIG.slowMo,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-popup-blocking",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  return context;
}

// Google Ads MCC login opens a NEW TAB after the account selector,
// while the original tab crashes to chrome-error://. This function
// monitors all tabs and returns the one that reaches Google Ads.
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
      try {
        console.log(`   [waitForAdsPage] Resolved via ${source}: ${p.url()}`);
      } catch {}
      resolve(p);
    };

    const checkPages = () => {
      pollCount++;
      const pages = context.pages();
      if (pollCount % 5 === 1) {
        // Log every 15 seconds (5 polls * 3s interval)
        const urls = pages.map((p) => { try { return p.url(); } catch { return "(closed)"; } });
        console.log(`   [waitForAdsPage] Poll #${pollCount}, ${pages.length} tab(s): ${JSON.stringify(urls)}`);
      }
      for (const p of pages) {
        try {
          const url = p.url();
          if (url.includes("ads.google.com/aw/")) {
            tryResolve(p, "poll");
            return;
          }
        } catch {}
      }
    };

    const onNewPage = (newPage) => {
      console.log("   [waitForAdsPage] New tab opened");
      // Check immediately and then again after delays
      const checkNew = () => {
        try {
          const url = newPage.url();
          console.log(`   [waitForAdsPage] New tab URL: ${url}`);
          if (url.includes("ads.google.com/aw/")) {
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
    // Do an immediate check
    checkPages();
  });
}

async function login(context) {
  const page = context.pages()[0] || await context.newPage();

  console.log("🔐 Navigating to Google Ads...");
  try {
    await page.goto("https://ads.google.com", {
      waitUntil: "networkidle",
      timeout: CONFIG.timeout,
    });
  } catch (e) {
    console.log("   Navigation completed with: " + e.message.split("\n")[0]);
  }

  // Handle Google consent/cookie page
  try {
    const consentUrl = page.url();
    if (consentUrl.includes("consent.google.com")) {
      console.log("   Handling cookie consent page...");
      const acceptSelectors = [
        'button:has-text("Accept all")',
        'button:has-text("Alle akzeptieren")',
        'button:has-text("Reject all")',
        'button:has-text("Alle ablehnen")',
      ];
      for (const selector of acceptSelectors) {
        try {
          const el = page.locator(selector).first();
          if (await el.isVisible({ timeout: 3000 })) {
            await el.click();
            console.log("   ✅ Accepted cookies");
            await page.waitForTimeout(3000);
            await page.waitForLoadState("networkidle").catch(() => {});
            break;
          }
        } catch {}
      }
    }
  } catch {}

  // Check if already on a Google Ads dashboard page
  try {
    const url = page.url();
    if (url.includes("ads.google.com/aw/")) {
      console.log("✅ Already logged in.");
      return page;
    }
  } catch {}

  // Need to login
  console.log("");
  console.log("⚠️  LOGIN REQUIRED");
  console.log("   Please log in manually in the browser window.");
  console.log("   The script will continue automatically after login.");
  console.log("");

  // Wait for any tab to reach Google Ads (handles new tab from MCC selector)
  const adsPage = await waitForAdsPage(context);

  // Wait for page to fully load - use setTimeout to avoid page-closed errors
  await new Promise((r) => setTimeout(r, 5000));
  try {
    await adsPage.waitForLoadState("networkidle");
  } catch {}

  console.log("✅ Login successful!");
  try {
    console.log("   URL: " + adsPage.url());
  } catch {}
  return adsPage;
}

// ============================================================
// DASHBOARD DOWNLOAD
// ============================================================

async function openDashboard(page, context) {
  console.log(`📊 Opening dashboard: ${CONFIG.dashboardName} (ID: ${CONFIG.dashboardId})`);

  // Extract auth params from any alive page
  let authParams = {};
  for (const p of context.pages()) {
    try {
      const url = p.url();
      if (url.includes("ads.google.com")) {
        const parsed = new URL(url);
        for (const key of ["ocid", "ascid", "euid", "__u", "uscid", "__c", "authuser"]) {
          if (parsed.searchParams.has(key)) {
            authParams[key] = parsed.searchParams.get(key);
          }
        }
        if (Object.keys(authParams).length > 0) break;
      }
    } catch {}
  }

  console.log("   Auth params:", JSON.stringify(authParams));

  const dashboardUrl = new URL("https://ads.google.com/aw/dashboards/view");
  for (const [key, val] of Object.entries(authParams)) {
    dashboardUrl.searchParams.set(key, val);
  }
  dashboardUrl.searchParams.set("dashboardId", CONFIG.dashboardId);
  const targetUrl = dashboardUrl.toString();
  console.log("   Target URL:", targetUrl);

  // Navigate to dashboards list, then click into the specific dashboard
  // This is more reliable than direct URL which sometimes shows the list anyway
  const listUrl = new URL("https://ads.google.com/aw/dashboards");
  for (const [key, val] of Object.entries(authParams)) {
    listUrl.searchParams.set(key, val);
  }

  try {
    console.log("   Navigating to dashboards list...");
    await page.goto(listUrl.toString(), { waitUntil: "networkidle", timeout: CONFIG.timeout });
    await page.waitForTimeout(5000);

    // Click the dashboard name to open it
    console.log(`   Clicking "${CONFIG.dashboardName}"...`);
    await page.locator(`text="${CONFIG.dashboardName}"`).first().click();
    await page.waitForTimeout(10000);
    await page.waitForLoadState("networkidle").catch(() => {});
    console.log("   URL after click:", page.url());

    // Verify: wait for the download icon (only present on dashboard view, not list)
    const hasDownload = await page.locator('[aria-label="Download"], [aria-label="Herunterladen"]').first().isVisible({ timeout: 10000 }).catch(() => false);
    if (hasDownload) {
      console.log("   ✅ Dashboard loaded");
      return page;
    }

    // If download icon not found, take screenshot and try waiting more
    console.log("   Download icon not found yet, waiting longer...");
    await page.waitForTimeout(10000);
    const retry = await page.locator('[aria-label="Download"], [aria-label="Herunterladen"]').first().isVisible({ timeout: 10000 }).catch(() => false);
    if (retry) {
      console.log("   ✅ Dashboard loaded (after extra wait)");
      return page;
    }
  } catch (e) {
    console.log("   Navigation failed:", e.message.split("\n")[0]);
  }

  console.log("   ❌ Failed to load dashboard");
  try {
    await page.screenshot({ path: path.join(CONFIG.downloadDir, "dashboards-debug.png") });
  } catch {}
  return null;
}

async function downloadDashboardToGDrive(page) {
  console.log("📥 Downloading dashboard to Google Drive...");
  const screenshotDir = CONFIG.downloadDir;

  // Wait for dashboard content to render
  console.log("   Waiting for dashboard data to render...");
  try {
    await Promise.race([
      page.locator('text="Auktionsdaten"').first().waitFor({ state: "visible", timeout: 30000 }),
      page.locator('text="Auction"').first().waitFor({ state: "visible", timeout: 30000 }),
    ]);
    console.log("   Dashboard data visible");
  } catch {
    console.log("   Dashboard data selector not found, continuing anyway...");
  }
  await page.waitForTimeout(3000);

  // Dismiss the X button on notification banners (only the X close icon, nothing else)
  try {
    const xBtn = page.locator('button[aria-label="Close"], button[aria-label="Schließen"]').first();
    if (await xBtn.isVisible({ timeout: 2000 })) {
      await xBtn.click();
      console.log("   Dismissed notification banner");
      await page.waitForTimeout(1000);
    }
  } catch {}

  await page.screenshot({ path: path.join(screenshotDir, "step0-dashboard.png") });
  console.log("   Screenshot: step0-dashboard.png");

  // Step 1: Click the download icon
  const downloadTriggerSelectors = [
    '[aria-label="Download"]',
    '[aria-label="Herunterladen"]',
  ];

  let triggerClicked = false;
  for (const selector of downloadTriggerSelectors) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 3000 })) {
        await el.click();
        triggerClicked = true;
        console.log(`   Clicked download trigger: ${selector}`);
        await page.waitForTimeout(2000);
        break;
      }
    } catch {}
  }

  if (!triggerClicked) {
    await page.screenshot({ path: path.join(screenshotDir, "no-trigger-debug.png") });
    throw new Error("Could not find download button on dashboard");
  }

  // Screenshot after clicking download icon - should show format dropdown
  await page.screenshot({ path: path.join(screenshotDir, "step1-after-trigger.png") });
  console.log("   Screenshot: step1-after-trigger.png");

  // Step 2: Select Google Sheets from the format dropdown
  let formatClicked = false;
  for (const selector of [
    '[role="menuitem"]:has-text("Google Sheets")',
    'text="Google Sheets"',
  ]) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 5000 })) {
        await el.click();
        formatClicked = true;
        console.log(`   Selected Google Sheets via: ${selector}`);
        await page.waitForTimeout(3000);
        break;
      }
    } catch {}
  }

  if (!formatClicked) {
    await page.screenshot({ path: path.join(screenshotDir, "step2-no-format.png") });
    throw new Error("Could not select Google Sheets format from dropdown");
  }

  // Screenshot after selecting format - should show dialog
  await page.screenshot({ path: path.join(screenshotDir, "step2-after-format.png") });
  console.log("   Screenshot: step2-after-format.png");

  // Step 3: Wait for the download dialog
  // Try multiple detection strategies - the dialog has a filename input and a Download button
  let dialogVisible = false;
  for (let attempt = 0; attempt < 3 && !dialogVisible; attempt++) {
    if (attempt > 0) {
      console.log(`   Dialog not found, retry ${attempt}...`);
      await page.waitForTimeout(3000);
    }
    try {
      await Promise.race([
        page.locator('text="Download to Google Sheets"').first().waitFor({ state: "visible", timeout: 10000 }),
        page.locator('text="In Google Sheets herunterladen"').first().waitFor({ state: "visible", timeout: 10000 }),
        page.locator('text="File name"').first().waitFor({ state: "visible", timeout: 10000 }),
        page.locator('text="Dateiname"').first().waitFor({ state: "visible", timeout: 10000 }),
        page.locator('input[aria-label="File name"], input[aria-label="Dateiname"]').first().waitFor({ state: "visible", timeout: 10000 }),
      ]);
      dialogVisible = true;
    } catch {}
  }

  const timestamp = new Date().toISOString().split("T")[0];
  const filename = `${CONFIG.dashboardName}_${timestamp}`;

  if (!dialogVisible) {
    console.log("   No download dialog detected - taking screenshot...");
    await page.screenshot({ path: path.join(screenshotDir, "step3-no-dialog.png") });
    throw new Error("Download dialog did not appear");
  }

  console.log("   Download dialog appeared");
  await page.screenshot({ path: path.join(screenshotDir, "step3-dialog.png") });
  console.log("   Screenshot: step3-dialog.png");

  // Step 4: Fill in the filename
  try {
    const filenameInput = page.locator('input[aria-label="Dateiname"], input[aria-label="File name"], input[type="text"]').first();
    if (await filenameInput.isVisible({ timeout: 5000 })) {
      await filenameInput.click({ clickCount: 3 });
      await filenameInput.fill(filename);
      console.log(`   Filename: ${filename}`);
      await page.waitForTimeout(1000);
    }
  } catch {
    console.log("   Using default filename");
  }

  // Screenshot BEFORE clicking Download
  await page.screenshot({ path: path.join(screenshotDir, "step4-before-download.png") });
  console.log("   Screenshot: step4-before-download.png");

  // Step 5: Click the Download/Herunterladen button
  let confirmClicked = false;

  // Use getByRole('button') for precise targeting — avoids clicking the dialog title
  for (const name of ["Download", "Herunterladen"]) {
    try {
      const btn = page.getByRole("button", { name, exact: true });
      if (await btn.isVisible({ timeout: 3000 })) {
        await btn.click();
        confirmClicked = true;
        console.log(`   Clicked "${name}" button via getByRole`);
        break;
      }
    } catch {}
  }

  if (!confirmClicked) {
    await page.screenshot({ path: path.join(screenshotDir, "step5-no-button.png") });
    throw new Error("Could not click the Download button in dialog");
  }

  // Screenshot AFTER clicking Download
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(screenshotDir, "step5-after-download.png") });
  console.log("   Screenshot: step5-after-download.png");

  // Step 6: Wait for the success toast (EN or DE)
  let toastFound = false;
  try {
    await Promise.race([
      page.locator('text="Report downloaded to Sheets"').first().waitFor({ state: "visible", timeout: 30000 }),
      page.locator('text="Bericht wurde in Google Sheets heruntergeladen"').first().waitFor({ state: "visible", timeout: 30000 }),
    ]);
    toastFound = true;
    console.log("   ✅ Saved to Google Drive!");
  } catch {
    console.log("   ⚠️  No success toast detected after 30s");
    await page.screenshot({ path: path.join(screenshotDir, "step6-no-toast.png") });
  }

  console.log(`   ✅ Done: ${filename} (toast: ${toastFound})`);
  return filename;
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

  const filename = await downloadDashboardToGDrive(dashPage);

  console.log(`\n${"=".repeat(50)}`);
  console.log("📋 SUMMARY");
  console.log(`${"=".repeat(50)}`);
  console.log(`Saved to Google Drive: ${filename}`);
  console.log(`Folder: Auction Insight`);
  return filename;
}

async function main() {
  const once = process.argv.includes("--once");

  console.log("🚀 Google Ads Auction Insights Scraper");
  console.log("=======================================\n");
  console.log(`   MCC Account: ${CONFIG.mccAccountId}`);
  console.log(`   Dashboard:   ${CONFIG.dashboardName}`);
  console.log(`   Format:      ${CONFIG.downloadFormat.toUpperCase()}`);
  console.log(`   Mode:        ${once ? "single run" : "weekly (every 7 days)"}\n`);

  await ensureDirs();
  const context = await launchBrowser();

  try {
    // First run — may require manual login
    await runOnce(context);

    if (once) return;

    // Schedule weekly repeats, keeping browser alive
    while (true) {
      const nextRun = new Date(Date.now() + WEEK_MS);
      console.log(`\n⏰ Next run scheduled: ${nextRun.toISOString()}`);
      await new Promise((r) => setTimeout(r, WEEK_MS));

      console.log(`\n${"=".repeat(50)}`);
      console.log(`🔄 Weekly run: ${new Date().toISOString()}`);
      console.log(`${"=".repeat(50)}\n`);

      try {
        await runOnce(context);
      } catch (err) {
        console.error(`\n❌ Weekly run failed: ${err.message}`);
        console.log("   Will retry at next scheduled time.");
        try {
          const pages = context.pages();
          const activePage = pages[pages.length - 1];
          if (activePage) {
            await activePage.screenshot({
              path: path.join(CONFIG.downloadDir, "error-screenshot.png"),
            });
          }
        } catch {}
      }
    }
  } catch (err) {
    console.error(`\n❌ Fatal error: ${err.message}`);
    console.log("\nTaking screenshot for debugging...");
    try {
      const pages = context.pages();
      const activePage = pages[pages.length - 1];
      if (activePage) {
        await activePage.screenshot({
          path: path.join(CONFIG.downloadDir, "error-screenshot.png"),
        });
        console.log("   Screenshot saved to error-screenshot.png");
      }
    } catch {}
  } finally {
    await context.close();
  }
}

// ============================================================
// LOGIN-ONLY MODE (npm run login)
// ============================================================

async function loginOnly() {
  console.log("🔐 Google Ads - Login Mode");
  console.log("==========================\n");
  console.log("A browser window will open. Please log in to Google Ads manually.");
  console.log("Your session will be saved for future scraper runs.\n");

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

const isLoginOnly = process.argv.includes("--login-only");

if (isLoginOnly) {
  loginOnly().catch(console.error);
} else {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
