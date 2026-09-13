/** Screenshot a running page. Dev tool. node scripts/shot.mjs <url> <out.png> [w] [h] */
import { chromium } from "playwright";
import { resolve } from "node:path";

const [, , url, out, w = "1400", h = "900"] = process.argv;
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const res = await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
console.log("status", res?.status());
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.waitForTimeout(600);
await page.screenshot({ path: resolve(out), fullPage: true });
await browser.close();
if (errors.length) console.log("page errors:", errors);
console.log("shot ->", out);
