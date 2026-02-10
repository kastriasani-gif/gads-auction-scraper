const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

// ============================================================
// CONFIGURATION - Edit these values
// ============================================================
const CONFIG = {
  // MCC Account IDs to scrape (format: "xxx-xxx-xxxx")
  accounts: [
    // "612-310-3619",  // Example: your account from the screenshot
    // "123-456-7890",  // Add more accounts here
  ],

  // Which level to download auction insights
  // Options: "campaign", "account"
  level: "campaign",

  // Date range for the report
  // Options: "LAST_7_DAYS", "LAST_30_DAYS", "LAST_MONTH", "THIS_MONTH", "CUSTOM"
  dateRange: "LAST_7_DAYS",

  // Download directory
  downloadDir: path.join(__dirname, "downloads"),

  // Browser state directory (keeps you logged in between runs)
  userDataDir: path.join(__dirname, "browser-data"),

  // Headless mode (set to false for first run to login manually)
  headless: false,

  // Slow down actions (ms) - helps avoid detection
  slowMo: 500,

  // Timeout for page loads (ms)
  timeout: 60000,
};

// ============================================================
// SCRAPER
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
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  return context;
}

async function login(page) {
  console.log("🔐 Navigating to Google Ads...");
  await page.goto("https://ads.google.com", {
    waitUntil: "networkidle",
    timeout: CONFIG.timeout,
  });

  // Check if already logged in
  const url = page.url();
  if (url.includes("accounts.google.com")) {
    console.log("");
    console.log("⚠️  LOGIN REQUIRED");
    console.log("   Please log in manually in the browser window.");
    console.log("   The script will continue automatically after login.");
    console.log("");

    // Wait for redirect back to Google Ads after manual login
    await page.waitForURL("**/ads.google.com/**", {
      timeout: 300000, // 5 minutes to login
    });

    console.log("✅ Login successful!");
  } else {
    console.log("✅ Already logged in.");
  }

  // Wait for the page to fully load
  await page.waitForTimeout(3000);
}

async function navigateToAccount(page, accountId) {
  const cleanId = accountId.replace(/-/g, "");
  const url = `https://ads.google.com/aw/overview?ocid=${cleanId}`;

  console.log(`📂 Navigating to account ${accountId}...`);
  await page.goto(url, {
    waitUntil: "networkidle",
    timeout: CONFIG.timeout,
  });
  await page.waitForTimeout(3000);
}

async function downloadAuctionInsightsForAccount(page, accountId) {
  const cleanId = accountId.replace(/-/g, "");
  const timestamp = new Date().toISOString().split("T")[0];

  if (CONFIG.level === "account") {
    // Account-level: go to Campaigns > Auction Insights
    return await downloadFromCampaignsPage(page, accountId, timestamp);
  } else {
    // Campaign-level: iterate through campaigns
    return await downloadPerCampaign(page, accountId, timestamp);
  }
}

async function downloadFromCampaignsPage(page, accountId, timestamp) {
  const cleanId = accountId.replace(/-/g, "");

  // Navigate to Campaigns page
  const campaignsUrl = `https://ads.google.com/aw/campaigns?ocid=${cleanId}`;
  console.log(`   📊 Opening Campaigns page...`);
  await page.goto(campaignsUrl, {
    waitUntil: "networkidle",
    timeout: CONFIG.timeout,
  });
  await page.waitForTimeout(3000);

  // Select all campaigns using the checkbox
  try {
    // Click the "select all" checkbox in the table header
    const selectAllCheckbox = await page.locator(
      'material-checkbox[aria-label*="Select all"], ' +
      'th material-checkbox, ' +
      '.table-header material-checkbox, ' +
      '[aria-label="Select all rows"]'
    ).first();
    await selectAllCheckbox.click();
    await page.waitForTimeout(1000);
    console.log(`   ☑️  Selected all campaigns`);
  } catch (e) {
    console.log(`   ⚠️  Could not select all campaigns automatically.`);
    console.log(`   → Please select campaigns manually, then press Enter in the terminal.`);
    await waitForUserInput();
  }

  // Open Auction Insights
  return await clickAuctionInsightsAndDownload(page, accountId, timestamp, "all-campaigns");
}

async function downloadPerCampaign(page, accountId, timestamp) {
  const cleanId = accountId.replace(/-/g, "");

  // Navigate to Campaigns page
  const campaignsUrl = `https://ads.google.com/aw/campaigns?ocid=${cleanId}`;
  await page.goto(campaignsUrl, {
    waitUntil: "networkidle",
    timeout: CONFIG.timeout,
  });
  await page.waitForTimeout(3000);

  // Get list of campaign names
  const campaigns = await page.evaluate(() => {
    const rows = document.querySelectorAll(
      'table tbody tr, .campaign-table tr'
    );
    const names = [];
    rows.forEach((row) => {
      const nameEl = row.querySelector(
        '[data-field="campaign"] a, .campaign-name a, td:nth-child(2) a'
      );
      if (nameEl) {
        names.push(nameEl.textContent.trim());
      }
    });
    return names;
  });

  console.log(`   Found ${campaigns.length} campaigns`);
  const results = [];

  for (const campaignName of campaigns) {
    try {
      console.log(`   📊 Processing campaign: ${campaignName}`);

      // Navigate back to campaigns page
      await page.goto(campaignsUrl, {
        waitUntil: "networkidle",
        timeout: CONFIG.timeout,
      });
      await page.waitForTimeout(2000);

      // Find and select the campaign checkbox
      const row = await page.locator(`tr:has(a:text("${campaignName}"))`).first();
      const checkbox = await row.locator("material-checkbox").first();
      await checkbox.click();
      await page.waitForTimeout(1000);

      const result = await clickAuctionInsightsAndDownload(
        page,
        accountId,
        timestamp,
        campaignName.replace(/[^a-zA-Z0-9]/g, "_")
      );
      results.push(result);
    } catch (err) {
      console.log(`   ❌ Error processing campaign "${campaignName}": ${err.message}`);
    }
  }

  return results;
}

async function clickAuctionInsightsAndDownload(page, accountId, timestamp, label) {
  try {
    // Look for "Auction insights" button/link in the action bar
    // Google Ads shows this after selecting campaigns
    const auctionInsightsSelectors = [
      'text="Auction insights"',
      'text="Auktionsdaten"', // German UI
      '[aria-label="Auction insights"]',
      '[aria-label="Auktionsdaten"]',
      'a:has-text("Auction insights")',
      'a:has-text("Auktionsdaten")',
      'button:has-text("Auction insights")',
      'button:has-text("Auktionsdaten")',
    ];

    let clicked = false;
    for (const selector of auctionInsightsSelectors) {
      try {
        const el = page.locator(selector).first();
        if (await el.isVisible({ timeout: 3000 })) {
          await el.click();
          clicked = true;
          console.log(`   🔍 Opened Auction Insights`);
          break;
        }
      } catch {}
    }

    if (!clicked) {
      // Try the three-dot menu / "More" button
      console.log(`   🔍 Trying via segment/more menu...`);
      const moreButton = page.locator(
        'button:has-text("More"), button:has-text("Mehr"), [aria-label="More actions"]'
      ).first();
      if (await moreButton.isVisible({ timeout: 3000 })) {
        await moreButton.click();
        await page.waitForTimeout(1000);

        for (const selector of auctionInsightsSelectors) {
          try {
            const el = page.locator(selector).first();
            if (await el.isVisible({ timeout: 2000 })) {
              await el.click();
              clicked = true;
              break;
            }
          } catch {}
        }
      }
    }

    if (!clicked) {
      throw new Error("Could not find Auction Insights button");
    }

    // Wait for the Auction Insights page to load
    await page.waitForTimeout(5000);
    await page.waitForLoadState("networkidle");

    // Click the download button
    const downloadSelectors = [
      '[aria-label="Download"]',
      '[aria-label="Herunterladen"]',
      'button:has-text("Download")',
      'button:has-text("Herunterladen")',
      'material-icon:has-text("file_download")',
      '[icon="file_download"]',
      '.download-button',
    ];

    let downloadClicked = false;
    for (const selector of downloadSelectors) {
      try {
        const el = page.locator(selector).first();
        if (await el.isVisible({ timeout: 3000 })) {
          // Set up download listener before clicking
          const downloadPromise = page.waitForEvent("download", {
            timeout: 30000,
          });
          await el.click();
          await page.waitForTimeout(1000);

          // Check if there's a format selection dialog
          const csvOption = page.locator(
            'text="CSV", text=".csv", [value="csv"]'
          ).first();
          try {
            if (await csvOption.isVisible({ timeout: 2000 })) {
              await csvOption.click();
              await page.waitForTimeout(500);

              // Click the final download/confirm button
              const confirmBtn = page.locator(
                'button:has-text("Download"), button:has-text("Herunterladen")'
              ).first();
              if (await confirmBtn.isVisible({ timeout: 2000 })) {
                await confirmBtn.click();
              }
            }
          } catch {}

          // Wait for the download
          const download = await downloadPromise;
          const filename = `auction_insights_${accountId}_${label}_${timestamp}.csv`;
          const filepath = path.join(CONFIG.downloadDir, filename);
          await download.saveAs(filepath);

          console.log(`   ✅ Downloaded: ${filename}`);
          downloadClicked = true;
          break;
        }
      } catch {}
    }

    if (!downloadClicked) {
      throw new Error("Could not find download button");
    }

    // Navigate back
    await page.goBack();
    await page.waitForTimeout(2000);

    return { accountId, label, success: true };
  } catch (err) {
    console.log(`   ❌ Download failed for ${label}: ${err.message}`);
    return { accountId, label, success: false, error: err.message };
  }
}

function waitForUserInput() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("🚀 Google Ads Auction Insights Scraper");
  console.log("=======================================\n");

  if (CONFIG.accounts.length === 0) {
    console.log("⚠️  No accounts configured!");
    console.log('   Edit CONFIG.accounts in scraper.js to add your account IDs.\n');
    console.log('   Example:');
    console.log('   accounts: ["612-310-3619", "123-456-7890"],\n');

    // Interactive mode: ask for account ID
    console.log("   Or enter an account ID now (format: xxx-xxx-xxxx):");
    const accountId = await new Promise((resolve) => {
      process.stdin.resume();
      process.stdin.once("data", (data) => {
        process.stdin.pause();
        resolve(data.toString().trim());
      });
    });

    if (accountId) {
      CONFIG.accounts.push(accountId);
    } else {
      process.exit(1);
    }
  }

  await ensureDirs();
  const context = await launchBrowser();
  const page = await context.newPage();

  try {
    await login(page);

    const allResults = [];

    for (const accountId of CONFIG.accounts) {
      console.log(`\n${"=".repeat(50)}`);
      console.log(`Account: ${accountId}`);
      console.log(`${"=".repeat(50)}\n`);

      await navigateToAccount(page, accountId);
      const results = await downloadAuctionInsightsForAccount(page, accountId);
      allResults.push({ accountId, results });
    }

    // Summary
    console.log(`\n${"=".repeat(50)}`);
    console.log("📋 SUMMARY");
    console.log(`${"=".repeat(50)}`);
    console.log(`Downloads saved to: ${CONFIG.downloadDir}`);

    const files = fs.readdirSync(CONFIG.downloadDir).filter((f) => f.endsWith(".csv"));
    console.log(`Total CSV files: ${files.length}`);
    files.forEach((f) => console.log(`  📄 ${f}`));
  } catch (err) {
    console.error(`\n❌ Fatal error: ${err.message}`);
    console.log("\nTaking screenshot for debugging...");
    await page.screenshot({
      path: path.join(CONFIG.downloadDir, "error-screenshot.png"),
    });
  } finally {
    await context.close();
  }
}

main().catch(console.error);
