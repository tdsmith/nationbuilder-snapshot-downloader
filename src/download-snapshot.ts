#! /usr/bin/env node
import { chromium, devices } from "playwright-core";
import { expect, Locator } from "@playwright/test";
import * as logger from "winston";
import { Command } from "commander";

/* accept a usernmae, password, and nationbuilder url */
async function download_snapshot(
  username: string,
  password: string,
  otp: string,
  nationbuilder_url: string,
  outputDir: string
) {
  const browser = await chromium.launch();
  const desktop = devices["Desktop Chrome HiDPI"];
  const context = await browser.newContext({
    ...desktop,
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
  });
  const page = await context.newPage();

  logger.info(`Navigating to ${nationbuilder_url}`);

  await page.goto(nationbuilder_url);
  logger.info(`Page title: ${await page.title()}`);
  logger.info(`Page content starts with: ${(await page.content()).substring(0, 500)}`);
  await page.getByLabel("Email").click();
  await page.getByLabel("Email").fill(username);
  await page.getByLabel("Email").press("Tab");
  await page.getByRole('textbox', {name: "Password"}).fill(password);
  logger.info("Logging in.");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  if (otp) {
    logger.info("Sending OTP code.");
    await page.getByRole("button", { name: "Google Authenticator or similar" }).click();
    await page.getByLabel("one-time code").fill(otp);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  }
  logger.info("Logged in, navigating to database snapshot page.");
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("link", { name: "Database" }).click();

  // compute string that includes today's date only - excluding time
  const snapshotSignature = `Data Committee Snapshot ${
    new Date().toISOString().split("T")[0]
  }`;
  const snapshotTrLocator = `table > tbody > tr:has-text("${snapshotSignature}")`;

  // if tr with row containing snapshotSignature does not exist in 5 seconds, create a new snapshot
  const test = await page.locator(snapshotTrLocator).isVisible();
  try {
    await expect(page.locator(snapshotTrLocator)).toBeVisible({
      timeout: 5000,
    });
    logger.info(`Snapshot "${snapshotSignature}" found.`);
  } catch (error) {
    logger.info(
      `Expected snapshot "${snapshotSignature}" not found, creating new snapshot.`
    );
    await page.getByLabel("Comment").click();
    await page.getByLabel("Comment").fill(snapshotSignature);
    await page.getByRole("button", { name: "Start database snapshot" }).click();
    await page.waitForTimeout(10000); // Wait for 10 seconds to allow page to refresh (flakey)
  }

  // refresh page until download button appears on the snapshot row
  let timeout = 0;
  let timeStep = 10000;
  var downloadButton: Locator | undefined;
  while (true) {
    downloadButton = await page
      .locator(snapshotTrLocator)
      .getByRole("link", { name: "download" });
    const isVisible = await downloadButton.isVisible();
    if (isVisible) {
      break; // Exit the loop if download button is found
    }
    logger.info(`Waiting for '${snapshotSignature}' to complete.`);
    timeout += timeStep;
    if (timeout >= 600000) {
      throw new Error(
        "Timeout: Download button did not appear within 10 minutes"
      );
    }
    await page.waitForTimeout(timeStep); // Wait for 10 seconds
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

  // close the browser to terminate the session
  await browser.close();
}

async function main(
  username: string,
  password: string,
  otp: string,
  nationbuilder_url: string,
  outputDir: string
) {
  logger.configure({
    level: "info",
    transports: [new logger.transports.Console()],
  });

  await download_snapshot(username, password, otp, nationbuilder_url, outputDir);
}

const program = new Command();
program
  .name("download-snapshot")
  .requiredOption("-u, --username <username>", "Nationbuilder Username")
  .requiredOption(
    "-p, --password_environment_var <password_environment_var>",
    "Name of environment variable to read password from"
  )
  .option(
    "-t, --otp <otp>",
    "TOTP one-time password"
  )
  .requiredOption(
    "-n, --nationbuilder_url <nationbuilder_url>",
    "URL of your nationbuilder admin login page"
  )
  .requiredOption("-o, --output_dir <output_dir>", "output_dir")
  .action((options) => {
    const password = process.env[options.password_environment_var];
    // ensure password is not undefined
    if (password === undefined) {
      throw new Error(
        `Environment variable ${options.password_environment_var} is not set`
      );
    }

    main(
      options.username,
      password,
      options.otp,
      options.nationbuilder_url,
      options.output_dir
    );
  });

program.parse();
