/** Screenshot one demo dinosaur large, to inspect the composite. Dev tool. */
import { chromium } from "playwright";
const [, , out = "dino.png", url = "http://localhost:3000/screen?demo=1"] = process.argv;
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(3500);
await page.screenshot({ path: out, clip: { x: 40, y: 300, width: 760, height: 400 } });
await browser.close();
console.log("zoom ->", out);
