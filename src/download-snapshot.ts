#! /usr/bin/env node
import { chromium, devices, Page } from "playwright-core";
import * as logger from "winston";
import { Command } from "commander";
import { createHmac } from "crypto";

function totpFromOtpauth(otpauthUrl: string): string {
  const url = new URL(otpauthUrl);
  const raw = url.searchParams.get("secret")!.toUpperCase().replace(/=+$/, "");
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, val = 0;
  const keyBytes: number[] = [];
  for (const c of raw) {
    val = (val << 5) | alpha.indexOf(c);
    bits += 5;
    if (bits >= 8) { keyBytes.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  const key = new Uint8Array(keyBytes);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const counterBuf = new Uint8Array(8);
  new DataView(counterBuf.buffer).setBigUint64(0, BigInt(counter), false);
  const hmac = Array.from(createHmac("sha1", key).update(counterBuf).digest());
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3]) % 1_000_000;
  return String(code).padStart(6, "0");
}

// How long to wait for today's snapshot to become downloadable. NationBuilder
// has never taken more than a couple of minutes; past this, fail and let the
// Cloud Run job's retries start over rather than wait on a stuck snapshot.
const SNAPSHOT_DEADLINE_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 10_000;
// If today's row hasn't appeared this many polls after clicking Start, assume
// the click didn't register and click again, up to MAX_START_ATTEMPTS times.
const POLLS_BEFORE_RESTART = 3;
const MAX_START_ATTEMPTS = 3;

/* Log where the browser ended up, so a failure in Cloud Run is diagnosable. */
async function logPageState(page: Page) {
  try {
    logger.error(`Failed on ${page.url()} (title: ${await page.title()})`);
    const text = await page.locator("body").innerText({ timeout: 5000 });
    logger.error(`Visible page text: ${text.substring(0, 2000)}`);
  } catch (error) {
    logger.error(`Could not capture page state: ${error}`);
  }
}

/* accept a usernmae, password, and nationbuilder url */
async function download_snapshot(
  username: string,
  password: string,
  getOtp: (() => string) | undefined,
  nationbuilder_url: string,
  outputDir: string,
  proxy?: string
) {
  const browser = await chromium.launch(
    proxy ? { proxy: { server: proxy } } : {}
  );
  try {
    const desktop = devices["Desktop Chrome HiDPI"];
    const context = await browser.newContext({
      ...desktop,
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles',
    });
    // In Cloud Run, traffic goes over a Tailscale DERP relay to a residential
    // exit node, which is too slow for Playwright's 30s default.
    context.setDefaultTimeout(90_000);
    context.setDefaultNavigationTimeout(120_000);
    const page = await context.newPage();
    try {
      await take_snapshot(page, username, password, getOtp, nationbuilder_url, outputDir);
    } catch (error) {
      await logPageState(page);
      throw error;
    }
  } finally {
    // close the browser to terminate the session
    await browser.close();
  }
}

async function take_snapshot(
  page: Page,
  username: string,
  password: string,
  getOtp: (() => string) | undefined,
  nationbuilder_url: string,
  outputDir: string
) {
  logger.info(`Navigating to ${nationbuilder_url}`);

  await page.goto(nationbuilder_url);
  logger.info(`Page title: ${await page.title()}`);
  logger.info(`Page content starts with: ${(await page.content()).substring(0, 500)}`);
  await page.getByLabel("Email").click();
  await page.getByLabel("Email").fill(username);
  await page.getByLabel("Email").press("Tab");
  await page.getByRole('textbox', { name: "Password" }).fill(password);
  logger.info("Logging in.");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  if (getOtp) {
    logger.info("Sending OTP code.");
    await page.getByRole("button", { name: "Google Authenticator or similar" }).click();
    // Generate the code only now, so a slow login can't carry it into the
    // next 30-second TOTP window.
    await page.getByLabel("one-time code").fill(getOtp());
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  }

  // Wait for the login flow to hand back to NationBuilder before navigating
  // away, so we don't interrupt it before the session cookie is set.
  const adminHost = new URL(nationbuilder_url).hostname;
  await page.waitForURL(
    (url) => url.hostname === adminHost && url.pathname.startsWith("/admin")
  );
  logger.info("Logged in, navigating to database snapshot page.");
  await page.goto(new URL("/admin/backups", nationbuilder_url).toString());

  // compute string that includes today's date only - excluding time
  const snapshotSignature = `Data Committee Snapshot ${new Date().toISOString().split("T")[0]
    }`;
  const snapshotRows = page.locator(
    `table > tbody > tr:has-text("${snapshotSignature}")`
  );
  // .first() in case a repeated Start click produced two rows for today.
  const downloadButton = snapshotRows
    .getByRole("link", { name: "download" })
    .first();

  // Give an existing row for today a moment to render.
  await snapshotRows.first().waitFor({ timeout: 5000 }).catch(() => { });
  if ((await snapshotRows.count()) > 0) {
    logger.info(`Snapshot "${snapshotSignature}" found.`);
  }

  // refresh page until download button appears on the snapshot row,
  // (re)starting the snapshot if its row is missing
  const deadline = Date.now() + SNAPSHOT_DEADLINE_MS;
  let startAttempts = 0;
  let pollsSinceStart = POLLS_BEFORE_RESTART; // start at once if the row is missing
  while (!(await downloadButton.isVisible())) {
    if ((await snapshotRows.count()) > 0) {
      logger.info(`Waiting for '${snapshotSignature}' to complete.`);
    } else if (pollsSinceStart >= POLLS_BEFORE_RESTART) {
      if (startAttempts >= MAX_START_ATTEMPTS) {
        throw new Error(
          `Snapshot row did not appear after ${startAttempts} attempts to start it`
        );
      }
      logger.info(
        startAttempts === 0
          ? `Expected snapshot "${snapshotSignature}" not found, creating new snapshot.`
          : `Snapshot "${snapshotSignature}" still not listed; starting it again.`
      );
      await page.getByLabel("Comment").fill(snapshotSignature);
      await page.getByRole("button", { name: "Start database snapshot" }).click();
      startAttempts++;
      pollsSinceStart = 0;
    } else {
      logger.info(`Waiting for '${snapshotSignature}' to be listed.`);
    }
    pollsSinceStart++;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timeout: Download button did not appear within ${SNAPSHOT_DEADLINE_MS / 60_000} minutes`
      );
    }
    await page.waitForTimeout(POLL_INTERVAL_MS);
    await page.reload(); // Refresh the page
  }

  // start download
  logger.info(`Downloading '${snapshotSignature}' to ${outputDir}`);
  const downloadPromise = page.waitForEvent("download");
  await downloadButton.click();
  const download = await downloadPromise;

  // specify the file path and save the file

  await download.saveAs(outputDir + "/" + download.suggestedFilename());
  logger.info(`Download finshed.`);
}

async function main(
  username: string,
  password: string,
  getOtp: (() => string) | undefined,
  nationbuilder_url: string,
  outputDir: string,
  proxy?: string
) {
  logger.configure({
    level: "info",
    transports: [new logger.transports.Console()],
  });

  await download_snapshot(username, password, getOtp, nationbuilder_url, outputDir, proxy);
}

const program = new Command();
program
  .name("download-snapshot")
  .requiredOption("-u, --username <username>", "Nationbuilder username")
  .requiredOption(
    "-p, --password_environment_var <password_environment_var>",
    "Name of environment variable to read password from"
  )
  .option("-t, --otp <otp>", "TOTP one-time password")
  .option(
    "--otpauth_environment_var <otpauth_environment_var>",
    "Name of environment variable containing otpauth:// URL for TOTP generation"
  )
  .option("--proxy <server>", "Proxy server URL for Playwright")
  .requiredOption(
    "-n, --nationbuilder_url <nationbuilder_url>",
    "URL of your nationbuilder admin login page"
  )
  .requiredOption("-o, --output_dir <output_dir>", "Output directory")
  .action((options) => {
    const password = process.env[options.password_environment_var];
    if (password === undefined) {
      throw new Error(
        `Environment variable ${options.password_environment_var} is not set`
      );
    }
    const otpauthUrl = options.otpauth_environment_var
      ? process.env[options.otpauth_environment_var]
      : undefined;
    const getOtp = options.otp
      ? () => options.otp as string
      : otpauthUrl
        ? () => totpFromOtpauth(otpauthUrl)
        : undefined;
    main(
      options.username,
      password,
      getOtp,
      options.nationbuilder_url,
      options.output_dir,
      options.proxy
    );
  });

program.parse();
