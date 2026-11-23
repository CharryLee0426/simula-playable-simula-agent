// Render the figure sources (HTML) in this folder to 2x PNGs in docs/figures/.
//   node docs/figures/src/render.cjs [name ...]      (needs the `playwright` npm package and its Chromium)
const { chromium } = require("playwright");
const { readdirSync } = require("node:fs");
const { join } = require("node:path");
(async () => {
  const want = process.argv.slice(2);
  const files = readdirSync(__dirname).filter((f) => f.endsWith(".html") && (!want.length || want.includes(f.replace(/\.html$/, ""))));
  const browser = await chromium.launch();
  for (const f of files) {
    const page = await browser.newPage({ viewport: { width: 1480, height: 900 }, deviceScaleFactor: 2 });
    await page.goto("file://" + join(__dirname, f));
    await page.waitForTimeout(300);
    // figures made of screenshots are much smaller as JPEG
    const photo = ["highlights", "perception"].includes(f.replace(/\.html$/, ""));
    const out = join(__dirname, "..", f.replace(/\.html$/, photo ? ".jpg" : ".png"));
    await (await page.$(".fig")).screenshot(photo ? { path: out, type: "jpeg", quality: 90 } : { path: out });
    console.log("rendered", out);
    await page.close();
  }
  await browser.close();
})();
