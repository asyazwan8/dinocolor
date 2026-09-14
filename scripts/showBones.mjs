/** Draw the bone ownership polygons over the artwork, to check they follow it. Dev tool. */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const [, , slug = "triceratops", out = "bones.png"] = process.argv;
const svg = readFileSync(resolve(`assets/dino/${slug}.svg`), "utf8");
const src = /data-artwork="([^"]+)"/.exec(svg)[1];
const art = `data:image/png;base64,${readFileSync(resolve(`public${src}`)).toString("base64")}`;

const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
await page.setContent(`<style>html,body{margin:0;background:#fff}</style>${svg}`, {
  waitUntil: "load",
});
const parts = await page.evaluate(() =>
  [...document.querySelectorAll("#parts > polygon")].map((el) => ({
    id: el.id.replace(/^part-/, ""),
    points: el.getAttribute("points"),
    pivot: el.dataset.pivot,
    z: Number(el.dataset.z),
  })),
);

const hues = ["#e0453a", "#e88a1e", "#c9b826", "#3fa64d", "#2f8fd0", "#7a54c8", "#d052a0", "#4aa79a"];
const layers = parts
  .map((p, i) => {
    const [px, py] = p.pivot.split(",");
    return `<polygon points="${p.points}" fill="${hues[i % hues.length]}" fill-opacity="0.26"
              stroke="${hues[i % hues.length]}" stroke-width="3"/>
            <circle cx="${px}" cy="${py}" r="9" fill="${hues[i % hues.length]}" stroke="#000" stroke-width="2"/>
            <text x="${px}" y="${Number(py) - 16}" font="12px monospace" font-size="18"
              text-anchor="middle" fill="#000" stroke="#fff" stroke-width="4"
              paint-order="stroke">${p.id}</text>`;
  })
  .join("");

const scale = 800 / 896;
await page.setContent(
  `<style>html,body{margin:0;background:#fff}</style>
   <div style="position:relative;width:1200px;height:800px">
     <img src="${art}" style="position:absolute;left:${(1200 - 1216 * scale) / 2}px;top:0;
          width:${1216 * scale}px;height:800px">
     <svg style="position:absolute;inset:0" width="1200" height="800" viewBox="0 0 1200 800">${layers}</svg>
   </div>`,
  { waitUntil: "load" },
);
await page.waitForTimeout(250);
await page.screenshot({ path: resolve(out) });
await browser.close();
console.log("bones ->", out);
