/**
 * Drive the real /scan page with a fake camera.
 *
 * The other end-to-end scripts exercise the pipeline through the tuning harness,
 * which proves the maths but not the page a child actually touches. This plays a
 * photograph into Chromium's fake capture device and walks the real flow: aim, watch
 * the viewfinder go green, press the shutter, check the preview, press send.
 *
 *   node scripts/makeFakeCam.mjs photo.png /tmp/cam.y4m
 *   node scripts/e2eScan.mjs /tmp/cam.y4m [baseUrl]
 */
import { chromium } from "playwright";
import { resolve } from "node:path";

const args = process.argv.slice(2);
/**
 * Simulate a device with no WebP encoder, which is how this flow first broke on a
 * real phone: toDataURL cannot report failure, so an unsupported type comes back as
 * PNG and the relay refuses it.
 */
const noWebp = args.includes("--no-webp");
const [clip, base = "http://localhost:3000"] = args.filter((a) => !a.startsWith("--"));
if (!clip) {
  console.error("usage: node scripts/e2eScan.mjs <clip.y4m> [baseUrl]");
  process.exit(1);
}

const OUT = process.env.SHOT_DIR ?? ".";
const SESSION = "scantest";

const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-video-capture=${resolve(clip)}`,
  ],
});

const context = await browser.newContext({
  viewport: { width: 420, height: 860 },
  permissions: ["camera"],
});
if (noWebp) {
  await context.addInitScript(() => {
    const real = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (type, ...rest) {
      // Exactly what a canvas without the encoder does: ignore the request, give PNG.
      if (type === "image/webp") return real.call(this, "image/png");
      return real.call(this, type, ...rest);
    };
  });
}

const page = await context.newPage();
page.on("pageerror", (e) => console.log("  [page error]", String(e).slice(0, 200)));
if (noWebp) console.log("  simulating a device with no WebP encoder");

const step = async (name) => {
  await page.screenshot({ path: `${OUT}/scan-${name}.png` });
  console.log(`  captured scan-${name}.png`);
};

await page.goto(`${base}/scan?s=${SESSION}`, { waitUntil: "networkidle" });
await step("1-idle");

await page.getByRole("button", { name: "Start camera" }).click();

// Wait for the viewfinder to report a usable sheet rather than sleeping blindly.
const shutter = page.getByRole("button", { name: "Take photo" });
await shutter.waitFor({ state: "visible", timeout: 15000 });
await page.waitForFunction(
  () => document.body.innerText.includes("take the photo"),
  undefined,
  { timeout: 20000 },
);
console.log("  viewfinder locked on");
await step("2-aiming");

const started = Date.now();
await shutter.click();
await page.getByRole("button", { name: "Send it" }).waitFor({ timeout: 20000 });
console.log(`  shutter -> preview in ${Date.now() - started}ms`);
await step("3-preview");

const sent = Date.now();
await page.getByRole("button", { name: "Send it" }).click();
await page.waitForFunction(
  () => document.body.innerText.includes("in the valley"),
  undefined,
  { timeout: 20000 },
);
console.log(`  send -> confirmed in ${Date.now() - sent}ms`);
await step("4-sent");

console.log(`  ${await page.locator("h2").first().innerText()}`);
await browser.close();
console.log("scan flow complete");
